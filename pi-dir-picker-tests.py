#!/usr/bin/env python3
# subject: tmux-driven test suite for pi-dir-picker.py: proves listing, navigation, creation, filtering, search, clone, rename, sort, launching (direct and in tmux) and quit on a real terminal.
# verified: v3, 2026-10-11: not yet run; run it on the Debian host before relying on it.
# tech: python, tmux, curses, git, pi
#
# Run: python3 -B pi-dir-picker-tests.py
# Exit 0 when everything passes, 1 when an assertion fails, 2 when tmux is absent.
#
# tmux is the ground truth, not a hand-written parser. A first version replayed the
# pty byte stream into a grid; curses redraws incrementally and the replay invented
# stale rows that a real terminal never shows. tmux IS a terminal, so its pane content
# settles the question. tmux is a test-only dependency.
#
# Note for whoever edits this later: curses calls keypad(True), which emits smkx and
# puts the terminal in application cursor mode. tmux send-keys names keys directly, so
# the suite does not care about SS3 against CSI, which is exactly the fragility removed.
#
# Isolation: every session gets its own HOME, no XDG_* overrides, no PI_BIN, and its
# own tmux socket for Pi sessions. Every test that presses p, P or c installs a fake pi
# first: on the Pi VM the real one is on PATH and must never be started by the suite.
#
# The picker runs inside the suite's tmux, so it sees $TMUX and starts Pi directly.
# The tmux-mode test unsets TMUX to exercise the persistent sessions.

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE / "pi-dir-picker.py"
SOCKET = "pi-dir-picker-tests"
PI_SOCKET = "pi-dir-picker-tests-pi"
SESSION = "s"
ROWS, COLS = 45, 100

FAILURES = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + ("" if ok else f"   {detail}"))
    if not ok:
        FAILURES.append(name)


def tmux(*args, socket=SOCKET):
    return subprocess.run(["tmux", "-L", socket, *args], capture_output=True, text=True)


def capture(attrs=False):
    args = ["capture-pane", "-p", "-t", SESSION]
    if attrs:
        args.insert(2, "-e")
    return tmux(*args).stdout


def send(*keys, literal=False):
    tmux("send-keys", "-t", SESSION, *(["-l"] if literal else []), *keys)


def has_session():
    return tmux("has-session", "-t", SESSION).returncode == 0


def tmux_available():
    try:
        return subprocess.run(["tmux", "-V"], capture_output=True).returncode == 0
    except OSError:
        return False


def home_fixture(home):
    for name in ("alpha", "beta", ".hidden", "a-repo"):
        (home / name).mkdir()
    (home / "alpha" / "sub").mkdir()
    (home / "a-repo" / ".git").mkdir()
    (home / "a-repo" / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (home / "notes.txt").write_text("x\n")


def write_pi(home, body):
    script = home.parent / "bin" / "pi"
    script.write_text("#!/bin/sh\n" + body)
    script.chmod(0o755)


def fake_pi(home):
    """A stand-in for pi that records where it ran and with which arguments, then exits."""
    home_fixture(home)
    write_pi(home, 'pwd > "$HOME/pi-ran.txt"\necho "$@" > "$HOME/pi-args.txt"\n')


def slow_pi(home):
    """A stand-in for pi that keeps running, and records the Hindsight key it was given."""
    home_fixture(home)
    (home / ".pi").mkdir()
    (home / ".pi" / "hindsight.key").write_text("secret-test-key\n")
    (home / ".pi" / "hindsight.key").chmod(0o600)
    write_pi(home, 'pwd > "$HOME/pi-ran.txt"\necho "$HINDSIGHT_API_KEY" > "$HOME/pi-key.txt"\nsleep 60\n')


def git_fixture(home):
    """A real repository with an untracked file, so git status reports it dirty."""
    home_fixture(home)
    repo = home / "dirty-repo"
    subprocess.run(["git", "init", "-q", "-b", "work", str(repo)], check=True)
    (repo / "new.txt").write_text("x\n")


def activity_fixture(home):
    home_fixture(home)
    later = time.time() + 1000
    os.utime(home / "beta", (later, later))


def session(keys, fixture=home_fixture, use_tmux=False):
    """Fresh tmux session and sandbox per call. keys is a list of ("key"|"text", value)."""
    work = tempfile.mkdtemp(prefix="pi-dir-picker-")
    home = Path(work) / "home"
    home.mkdir()
    bin_dir = Path(work) / "bin"
    bin_dir.mkdir()
    if fixture:
        fixture(home)
    # The picker resolves symlinks in HOME (/tmp can be one): compare against that.
    home = Path(os.path.realpath(home))

    unset = "-u XDG_CONFIG_HOME -u XDG_STATE_HOME -u PI_BIN" + (" -u TMUX" if use_tmux else "")
    tmux("kill-server")
    tmux("kill-server", socket=PI_SOCKET)
    tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS),
         f"env {unset} HOME={home} PATH={bin_dir}:$PATH PI_PICKER_TMUX_SOCKET={PI_SOCKET} PI_PICKER_SANDBOX=0 "
         f"{sys.executable} -B {APP}")
    time.sleep(1.2)

    screens = [capture()]
    for kind, value in keys:
        send(value, literal=(kind == "text"))
        time.sleep(0.35)
        screens.append(capture())
    return home, screens, work


def cleanup(work):
    tmux("kill-server")
    tmux("kill-server", socket=PI_SOCKET)
    shutil.rmtree(work, ignore_errors=True)


def selected(attrs):
    found = re.findall(r"\x1b\[7m(.*?)\x1b\[0m", attrs)
    return found[0].strip() if found else "(none)"


def rows(screen):
    return [line.strip() for line in screen.splitlines()]


def path_row(screen):
    """The current path: the only row that starts with '/' (the logo above it does not)."""
    for content in rows(screen):
        if content.startswith("/"):
            return content
    return "(no path row)"


def read(path):
    return path.read_text().strip() if path.is_file() else f"{path.name} missing"


def without_extension(args):
    """Pi's arguments as asked, without the extension Pier gives each Pi it starts."""
    return re.sub(r"^--extension \S+pier-session\.ts ?", "", args)


def unit_tests():
    spec = importlib.util.spec_from_file_location("picker", APP)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    check("valid_name accepts proj-1", module.valid_name("proj-1"))
    check("valid_name accepts accents", module.valid_name("projet-été"))
    check("valid_name rejects a path", not module.valid_name("a/b"))
    check("valid_name rejects hidden", not module.valid_name(".x"))
    check("valid_name rejects a leading dash", not module.valid_name("-rf"))
    check("valid_name rejects empty", not module.valid_name(""))
    check("valid_name rejects traversal", not module.valid_name("../evil"))
    check("valid_name rejects a trailing newline", not module.valid_name("a\n"))

    check("clone url: https", module.valid_clone_url("https://github.com/u/r.git"))
    check("clone url: scp form", module.valid_clone_url("git@github.com:u/r.git"))
    check("clone url: rejects an option", not module.valid_clone_url("--upload-pack=x"))
    check("clone url: rejects ext::", not module.valid_clone_url("ext::sh -c x"))
    check("clone name", module.clone_name("git@github.com:u/blog.git") == "blog")

    check("clean masks control characters", module.clean("a\x1b[2Jb\n") == "a?[2Jb?")
    check("clean survives undecodable bytes", "�" in module.clean(os.fsdecode(b"x\xff")))
    check("fit counts wide characters", module.text_width(module.fit("日本語日本語", 5)) <= 5)
    check("search prefers the last segment",
          module.match_score("blog", "blog") < module.match_score("blog", "blog-old/x"))
    check("search matches scattered letters", module.match_score("bv2", "clients/blog-v2") is not None)

    work = tempfile.mkdtemp(prefix="pi-dir-picker-unit-")
    root = Path(work)
    (root / "b").mkdir()
    (root / "A").mkdir()
    (root / ".hidden").mkdir()
    (root / "file.txt").write_text("x")
    check("list_dirs hides dotfiles", module.list_dirs(str(root)) == ["A", "b"],
          module.list_dirs(str(root)))
    tree = root / "repo"
    (tree / ".git").mkdir(parents=True)
    (tree / ".git" / "HEAD").write_text("ref: refs/heads/feature/x\n")
    check("git_branch keeps the full branch name", module.git_branch(str(tree)) == "feature/x",
          module.git_branch(str(tree)))
    check("git_branch on a plain dir", module.git_branch(str(root / "b")) is None)
    linked = root / "worktree"
    linked.mkdir()
    (root / "gitdir").mkdir()
    (root / "gitdir" / "HEAD").write_text("ref: refs/heads/wt\n")
    (linked / ".git").write_text("gitdir: ../gitdir\n")
    check("git_branch follows a .git file", module.git_branch(str(linked)) == "wt",
          module.git_branch(str(linked)))
    shutil.rmtree(work, ignore_errors=True)


def back_to_back_children():
    """Two children with nothing drawn between them, as when tmux gets installed and Pi
    starts right after: endwin used to fail the second time and crash the picker."""
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = work / "home"
    home.mkdir()
    done = work / "done.txt"
    script = work / "twice.py"
    script.write_text(
        "import curses, importlib.util\n"
        f"spec = importlib.util.spec_from_file_location('picker', {str(APP)!r})\n"
        "m = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(m)\n"
        "def go(scr):\n"
        "    p = m.Picker(scr, m.home_dir(), 0, dict(m.DEFAULTS, tmux=False))\n"
        "    env = m.child_env(p.home)\n"
        "    p.run_child(['true'], p.home, env, 'one')\n"
        "    p.run_child(['true'], p.home, env, 'two')\n"
        "curses.wrapper(go)\n"
        f"open({str(done)!r}, 'w').write('ok')\n"
    )
    tmux("kill-server")
    tmux("new-session", "-d", "-s", SESSION, "-x", str(COLS), "-y", str(ROWS),
         f"env -u XDG_CONFIG_HOME -u XDG_STATE_HOME HOME={home} {sys.executable} -B {script}; sleep 5")
    time.sleep(2.0)
    check("two children in a row do not crash", done.is_file(), capture()[-600:])
    cleanup(str(work))


def sandbox_test():
    """Pi really started in bubblewrap: it can work in its project and nowhere else."""
    if not shutil.which("bwrap"):
        print("  skip sandbox test: bubblewrap is not installed (sudo apt install bubblewrap)")
        return
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = Path(os.path.realpath(work / "home"))
    project = home / "work" / "proj"
    project.mkdir(parents=True)
    (home / "secret.txt").write_text("private\n")
    (home / "other-project").mkdir()
    (home / ".pi").mkdir()
    tools = home / ".local" / "bin"
    tools.mkdir(parents=True)
    # The fake pi records what it could do; it lives in ~/.local/bin, which the
    # sandbox exposes read-only like a real npm install.
    fake = tools / "pi"
    fake.write_text(
        "#!/bin/sh\n"
        'cat "$HOME/secret.txt" > secret.out 2>&1 || echo denied > secret.out\n'
        'ls "$HOME/other-project" > other.out 2>&1 && echo visible >> other.out || echo hidden > other.out\n'
        # The sandbox's home is a throwaway tmpfs: writing there succeeds but never
        # reaches the real home. The system itself is read-only.
        'echo ok > "$HOME/escape.txt" 2>/dev/null\n'
        'echo ok > /usr/local/escape.txt 2>/dev/null && echo escaped > escape.out || echo blocked > escape.out\n'
        'echo written > inside.out\n'
        'touch "$HOME/.pi/state" && echo pi-state-ok > pistate.out\n'
        # The filter against typing into the terminal (TIOCSTI) is loaded, /run is hidden
        # (system sockets), and names still resolve.
        "grep '^Seccomp:' /proc/self/status | tr -d ' \\t' > seccomp.out\n"
        'if [ -e /run/user ] || [ -e /run/dbus ]; then echo visible > run.out; else echo hidden > run.out; fi\n'
        'cat /etc/resolv.conf > /dev/null 2>&1 && echo ok > resolv.out || echo unreadable > resolv.out\n'
        # The network: nothing directly, the proxy refuses what is not allowed.
        'echo "$HTTPS_PROXY" > proxy.out\n'
        "python3 -c 'import socket,sys; sys.exit(socket.socket().connect_ex((\"1.1.1.1\", 443)) == 0)' "
        '&& echo blocked > direct.out || echo open > direct.out\n'
        "python3 -c 'import socket; s = socket.create_connection((\"127.0.0.1\", 3128), timeout=5); "
        's.sendall(b\"CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n\"); print(s.recv(100).split()[1].decode())\' '
        '> proxied.out 2>&1\n'
    )
    fake.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_BIN", "PI_PICKER_SANDBOX")}
    env.update(HOME=str(home), PATH=f"{tools}:/usr/bin:/bin")
    run = subprocess.run([sys.executable, "-B", str(APP), "--exec-pi", str(project)],
                         stdin=subprocess.DEVNULL, capture_output=True, text=True, env=env, timeout=30)
    out = lambda name: (project / name).read_text().strip() if (project / name).exists() else f"{name} missing"
    detail = run.stdout[-300:] + run.stderr[-300:]
    check("sandbox: pi runs and writes in its project", out("inside.out") == "written", detail)
    check("sandbox: the rest of home is hidden", out("secret.out") != "private" and out("other.out") == "hidden",
          (out("secret.out"), out("other.out")))
    check("sandbox: nothing written outside the project", out("escape.out") == "blocked" and not (home / "escape.txt").exists(),
          out("escape.out"))
    check("sandbox: ~/.pi stays writable for pi's own state", out("pistate.out") == "pi-state-ok", out("pistate.out"))
    check("sandbox: the TIOCSTI filter is loaded", out("seccomp.out") == "Seccomp:2", out("seccomp.out"))
    check("sandbox: /run is hidden", out("run.out") == "hidden", out("run.out"))
    check("sandbox: /etc/resolv.conf still readable", out("resolv.out") == "ok", out("resolv.out"))
    if "network not limited" in run.stdout:
        print("  skip network checks: " + run.stdout.split("network not limited", 1)[1].splitlines()[0])
    else:
        check("network: the proxy is given to Pi", out("proxy.out") == "http://127.0.0.1:3128", out("proxy.out"))
        check("network: no direct connection", out("direct.out") == "blocked", out("direct.out"))
        check("network: a host not allowed is refused", out("proxied.out") == "403", out("proxied.out"))
    shutil.rmtree(work, ignore_errors=True)


def hardening_test():
    """What the picker reads or deletes outside the sandbox, in places Pi can write:
    links there never lead it elsewhere."""
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = Path(os.path.realpath(work / "home"))
    project = home / "proj"
    (project / ".pi-files" / "copy" / "ro").mkdir(parents=True)
    (home / ".pi").mkdir()
    secret = home / "secret.txt"
    secret.write_text("private\n")
    env = {k: v for k, v in os.environ.items() if k not in ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR")}
    env["HOME"] = str(home)

    def picker(code):
        script = ("import importlib.util, json, os, sys\n"
                  f"spec = importlib.util.spec_from_file_location('picker', {str(APP)!r})\n"
                  "m = importlib.util.module_from_spec(spec)\n"
                  "spec.loader.exec_module(m)\n" + code)
        run = subprocess.run([sys.executable, "-B", "-c", script], env=env, capture_output=True, text=True, timeout=30)
        return run.stdout.strip() + run.stderr.strip()[-300:]

    # The Hindsight key: a link put in its place is not read.
    key = home / ".pi" / "hindsight.key"
    key.symlink_to(secret)
    check("hindsight key: a link is not followed", picker(f"print(m.read_hindsight_key({str(home)!r})[0])") == "None")
    key.unlink()
    key.write_text("k-123\n")
    key.chmod(0o600)
    check("hindsight key: the file itself is read", picker(f"print(m.read_hindsight_key({str(home)!r})[0])") == "k-123")

    # Setup: an AGENTS.md leading out of the project is neither shown nor kept in history.
    (project / "AGENTS.md").symlink_to(secret)
    setup = subprocess.run([sys.executable, "-B", str(APP), "--api", "setup", str(project)],
                           env=env, capture_output=True, text=True, timeout=30)
    shown = json.loads(setup.stdout or "{}").get("texts", {}).get("instructions", {}).get("text")
    check("setup: a link out of the project is not read", shown == "", setup.stdout[-300:] + setup.stderr[-300:])
    subprocess.run([sys.executable, "-B", str(APP), "--api", "write-text", str(project), "instructions"],
                   input="new instructions\n", env=env, capture_output=True, text=True, timeout=30)
    history = project / ".pi" / "devbox-history"
    kept = "".join(p.read_text() for p in history.glob("*.md")) if history.is_dir() else ""
    check("setup: saving keeps nothing of the link's target", "private" not in kept and secret.read_text() == "private\n", kept)
    check("setup: saving replaces the link with the file",
          not (project / "AGENTS.md").is_symlink() and (project / "AGENTS.md").read_text() == "new instructions\n")
    inner = home / "proj2"
    inner.mkdir()
    (inner / "CLAUDE.md").write_text("inside\n")
    (inner / "AGENTS.md").symlink_to("CLAUDE.md")
    check("setup: a link inside the project is still read",
          picker(f"print(m.read_text({str(inner / 'AGENTS.md')!r}, root={str(inner)!r}))") == "inside")

    # Removing: a read-only copy goes; a folder on the way swapped for a link stops it.
    (project / ".pi-files" / "copy" / "ro" / "f").write_text("x")
    (project / ".pi-files" / "copy" / "ro").chmod(0o500)
    removed = picker(f"print(json.dumps(m.api_remove({str(home)!r}, {str(project / '.pi-files' / 'copy')!r})))")
    check("remove: a copy with read-only folders goes", not (project / ".pi-files" / "copy").exists(), removed)
    outside = home / "outside"
    (outside / "keep").mkdir(parents=True)
    (outside / "keep" / "f").write_text("keep")
    shutil.rmtree(project / ".pi-files")
    (project / ".pi-files").symlink_to(outside)
    walked = picker(f"m.remove_entry({str(home)!r}, {str(project / '.pi-files' / 'keep')!r})")
    check("remove: never through a link on the way", (outside / "keep" / "f").exists() and "Error" in walked, walked)

    # Writing: a folder swapped for a link leading out is refused, nothing lands there.
    wrote = picker(f"m.save_new({str(project / '.pi-files')!r}, 'x.png', b'data', {str(project)!r})")
    check("write: never through a link out of the project", not (outside / "x.png").exists() and "Error" in wrote, wrote)
    (project / ".pi-files").unlink()

    # A FIFO left where the picker reads does not block it.
    fifo = project / "AGENTS.md"
    fifo.unlink()
    os.mkfifo(fifo)
    began = time.monotonic()
    blocked = picker(f"print(m.read_text({str(fifo)!r}, root={str(project)!r}))")
    check("read: a FIFO is not waited on", blocked == "None" and time.monotonic() - began < 10, blocked)
    fifo.unlink()

    # The git jail: the project only, unless its .git file names a real git folder.
    (project / ".git").write_text(f"gitdir: {home / '.ssh'}\n")
    (home / ".ssh").mkdir()
    (home / ".ssh" / "HEAD").write_text("ref: refs/heads/main\n")
    check("git jail: a .git file naming ~/.ssh adds nothing",
          picker(f"print(m.git_jail_folders({str(project)!r}))") == str([str(project)]))
    main_git = home / "main" / ".git"
    (main_git / "worktrees" / "w").mkdir(parents=True)
    (main_git / "HEAD").write_text("ref: refs/heads/main\n")
    (main_git / "worktrees" / "w" / "HEAD").write_text("ref: refs/heads/w\n")
    (main_git / "worktrees" / "w" / "commondir").write_text("../..\n")
    (project / ".git").write_text(f"gitdir: {main_git / 'worktrees' / 'w'}\n")
    check("git jail: a worktree gets its main repository's .git",
          picker(f"print(m.git_jail_folders({str(project)!r}))") == str([str(project), str(main_git)]))
    (project / ".git").unlink()

    # A folder copy is unpacked out of Pi's reach, then moved into .pi-files.
    import io
    import tarfile
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        info = tarfile.TarInfo("mock/a.txt")
        info.size = 5
        tar.addfile(info, io.BytesIO(b"hello"))
    upload = subprocess.run([sys.executable, "-B", str(APP), "--api", "upload-dir", "mock", str(project)],
                            input=archive.getvalue(), env=env, capture_output=True, timeout=30)
    saved = json.loads(upload.stdout or b"{}").get("saved") or ""
    check("upload-dir: the copy lands in .pi-files",
          saved.startswith(str(project / ".pi-files")) and (Path(saved) / "mock" / "a.txt").read_text() == "hello",
          upload.stdout[-300:] + upload.stderr[-300:])
    incoming = home / ".local" / "state" / "pi-dir-picker" / "incoming"
    check("upload-dir: nothing left in the private folder", not incoming.exists() or not any(incoming.iterdir()))
    cleanup(str(work))


def checkpoint_test():
    """Restore points around a real --exec-pi: a fake Pi writes its session as Pi does
    (the file of a new session appears with the first answer) and changes a file; the
    API then lists the points and puts the file back."""
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = Path(os.path.realpath(work / "home"))
    project = home / "proj"
    project.mkdir(parents=True)
    (project / "notes.txt").write_text("original\n")
    tools = home / ".local" / "bin"
    tools.mkdir(parents=True)
    line = lambda entry: json.dumps(entry, separators=(",", ":"))
    user1 = line({"type": "message", "message": {"role": "user", "content": "rewrite the notes"}})
    tool = line({"type": "message", "message": {"role": "assistant", "stopReason": "toolUse",
                                                "content": [{"type": "toolCall", "id": "c1", "name": "write", "arguments": {"path": "notes.txt"}}]}})
    result = line({"type": "message", "message": {"role": "toolResult", "toolCallId": "c1"}})
    stop = line({"type": "message", "message": {"role": "assistant", "stopReason": "stop", "content": []}})
    user2 = line({"type": "message", "message": {"role": "user", "content": "now add a title"}})
    fake = tools / "pi"
    fake.write_text(
        "#!/bin/sh\n"
        'd="$HOME/.pi/agent/sessions/--$(pwd | sed \'s|^/||; s|/|-|g\')--"\n'
        'mkdir -p "$d"\n'
        f"printf '%s\\n' '{{\"type\":\"session\"}}' '{user1}' '{tool}' > \"$d/s.jsonl\"\n"
        "echo rewritten > notes.txt\n"
        f"printf '%s\\n' '{result}' '{stop}' >> \"$d/s.jsonl\"\n"
        "sleep 1.5\n"
        f"printf '%s\\n' '{user2}' >> \"$d/s.jsonl\"\n"
        "sleep 1.5\n"
        "echo '# Title' >> notes.txt\n"
        f"printf '%s\\n' '{stop}' >> \"$d/s.jsonl\"\n"
        "sleep 1.5\n"
    )
    fake.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_BIN")}
    env.update(HOME=str(home), PATH=f"{tools}:/usr/bin:/bin", PI_PICKER_SANDBOX="0", PI_PICKER_TMUX_SOCKET=PI_SOCKET)
    subprocess.run([sys.executable, "-B", str(APP), "--exec-pi", str(project)],
                   stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=60)

    def api(*args):
        run = subprocess.run([sys.executable, "-B", str(APP), "--api", *args], capture_output=True, env=env, timeout=60)
        try:
            return json.loads(run.stdout)
        except ValueError:
            return {"error": run.stdout.decode(errors="replace") + run.stderr.decode(errors="replace")}

    points = api("checkpoints", str(project)).get("points", [])
    labels = [p["label"] for p in points]
    check("checkpoints: one point per state, newest first",
          labels[:2] == ["Pi finished working", "now add a title"] and labels[-1] == "rewrite the notes", labels)
    first = points[-1]["id"] if points else ""
    diff = api("checkpoint-diff", str(project), first)
    check("checkpoints: what changed since the first", [c["path"] for c in diff.get("changes", [])] == ["notes.txt"], diff)
    restored = api("restore", str(project), first)
    check("checkpoints: the file is back", (project / "notes.txt").read_text() == "original\n", restored)
    check("checkpoints: the state before restoring is kept", api("checkpoints", str(project)).get("points", [{}])[0].get("reason") == "before-restore")
    log = (home / ".local" / "state" / "pi-dir-picker" / "picker.log").read_text() if (home / ".local" / "state" / "pi-dir-picker" / "picker.log").exists() else ""
    check("log: pi start and exit, the restore", "pi.start" in log and "pi.exit" in log and "checkpoint.restore" in log, log[-600:])
    shutil.rmtree(work, ignore_errors=True)


def resources_test():
    """Setup's list of what Pi loads: packages with their version, skills, prompts, MCP
    servers, from a made-up agent dir and project; nothing is run."""
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = Path(os.path.realpath(work / "home"))
    agent = home / ".pi" / "agent"
    project = home / "proj"
    (agent / "npm" / "node_modules" / "pi-hindsight").mkdir(parents=True)
    (agent / "npm" / "node_modules" / "pi-hindsight" / "package.json").write_text('{"version": "0.4.2"}')
    (agent / "settings.json").write_text('{\n  // comment\n  "packages": ["npm:pi-hindsight", "npm:gone"], "defaultModel": "m"\n}')
    (agent / "prompts").mkdir()
    (agent / "prompts" / "review.md").write_text("x")
    (project / ".pi" / "skills" / "notes").mkdir(parents=True)
    (project / ".pi" / "skills" / "notes" / "SKILL.md").write_text("x")
    (project / ".mcp.json").write_text('{"mcpServers": {"github": {}}}')
    env = {k: v for k, v in os.environ.items() if k not in ("PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME")}
    env["HOME"] = str(home)
    out = subprocess.run([sys.executable, "-B", str(APP), "--api", "setup", str(project)],
                         env=env, capture_output=True, text=True, timeout=30)
    try:
        r = json.loads(out.stdout)["resources"]
    except (ValueError, KeyError):
        check("setup lists what Pi loads", False, out.stdout[-300:] + out.stderr[-300:])
        cleanup(work)
        return
    packages = {p["source"]: p for p in r["packages"]}
    check("a package with its version", packages.get("npm:pi-hindsight", {}).get("version") == "0.4.2", r["packages"])
    check("a package not installed says so", packages.get("npm:gone", {}).get("installed") is False, r["packages"])
    check("skills, prompts and MCP servers",
          [s["name"] for s in r["skills"]] == ["notes"] and [p["name"] for p in r["prompts"]] == ["review"]
          and [m["name"] for m in r["mcp"]] == ["github"], r)
    check("the default model", r["model"].get("defaultModel") == "m", r["model"])
    cleanup(work)


def multi_pi_test():
    """Two Pis in one project, in real tmux: each in its own conversation (recorded in
    tmux as @pi-file), both listed by the API, stopped one at a time."""
    work = Path(tempfile.mkdtemp(prefix="pi-dir-picker-"))
    home = Path(os.path.realpath(work / "home"))
    project = home / "proj"
    project.mkdir(parents=True)
    tools = home / ".local" / "bin"
    tools.mkdir(parents=True)
    fake = tools / "pi"
    fake.write_text('#!/bin/sh\necho "$@" >> "$HOME/pi-args.txt"\nsleep 60\n')
    fake.chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "PI_BIN")}
    env.update(HOME=str(home), PATH=f"{tools}:/usr/bin:/bin", PI_PICKER_SANDBOX="0", PI_PICKER_TMUX_SOCKET=PI_SOCKET)
    script = (
        "import importlib.util, json\n"
        f"spec = importlib.util.spec_from_file_location('picker', {str(APP)!r})\n"
        "m = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(m)\n"
        "home = m.home_dir()\n"
        "env = m.child_env(home)\n"
        f"first = m.open_pi({str(project)!r}, [], env, home, 80, 24)\n"
        f"second = m.open_pi({str(project)!r}, ['--new'], env, home, 80, 24)\n"
        f"again = m.open_pi({str(project)!r}, [], env, home, 80, 24)\n"
        "print(json.dumps([first, second, again]))\n"
    )
    run = subprocess.run([sys.executable, "-B", "-c", script], capture_output=True, text=True, env=env, timeout=30)
    try:
        first, second, again = json.loads(run.stdout)
    except ValueError:
        check("two Pis start", False, run.stdout[-300:] + run.stderr[-600:])
        shutil.rmtree(work, ignore_errors=True)
        return
    check("two Pis: each in its own tmux session", first[1] and second[1] and first[0] != second[0], (first, second))
    check("no argument joins a running one", not again[1] and again[0] in (first[0], second[0]), again)
    time.sleep(1.0)

    def api(*args):
        out = subprocess.run([sys.executable, "-B", str(APP), "--api", *args], capture_output=True, env=env, timeout=30)
        try:
            return json.loads(out.stdout)
        except ValueError:
            return {"error": out.stdout.decode(errors="replace") + out.stderr.decode(errors="replace")}

    running = api("projects").get("running", [])
    pis = running[0]["pis"] if running else []
    files = [pi["file"] for pi in pis]
    check("the API lists both, each with its conversation", len(pis) == 2 and all(files) and len(set(files)) == 2, pis)
    raw = (home / "pi-args.txt").read_text().splitlines() if (home / "pi-args.txt").exists() else []
    check("each Pi was given Pier's extension", len(raw) == 2 and all(a.startswith("--extension ") for a in raw), raw)
    args = [without_extension(a) for a in raw]
    check("each Pi was given its own session file", len(args) == 2 and all(a.startswith("--session ") for a in args), args)
    check("stop one", api("stop", str(project), second[0]).get("stopped") == 1)
    running = api("projects").get("running", [])
    check("the other runs on", len(running) == 1 and [p["slot"] for p in running[0]["pis"]] == [first[0]], running)
    check("stop the rest", api("stop", str(project)).get("stopped") == 1 and api("projects").get("running") == [])
    shutil.rmtree(work, ignore_errors=True)


def main():
    if not tmux_available():
        print("tmux is required for these tests (Debian: apt install tmux)")
        return 2

    print("=" * 72, "\nUNIT\n", "=" * 72, sep="")
    unit_tests()

    print("=" * 72, "\nTERMINAL\n", "=" * 72, sep="")
    home, screens, work = session([])
    print(screens[0])
    text = screens[0]
    check("lists directories", all(x in text for x in ("alpha/", "beta/", "a-repo/")))
    check("hides dot directories", ".hidden" not in text)
    check("lists no files", "notes.txt" not in text)
    check("shows the git branch", "main" in text)
    check("path row shows home", path_row(text) == str(home), path_row(text))
    attrs = capture(attrs=True)
    check("something is selected", selected(attrs) != "(none)", selected(attrs))
    check("grey used for secondary text", "\x1b[90m" in attrs or "\x1b[2m" in attrs)
    send("q")
    time.sleep(0.5)
    check("q quits", not has_session())
    cleanup(work)

    home, screens, work = session([("key", "Down")])
    check("arrow key moves the selection", selected(capture(attrs=True)).startswith("alpha/"),
          selected(capture(attrs=True)))
    cleanup(work)

    home, screens, work = session([("key", "Down"), ("key", "Right")])
    check("right opens the directory", path_row(screens[-1]) == f"{home}/alpha", path_row(screens[-1]))
    cleanup(work)

    home, screens, work = session([("key", "Down"), ("key", "Right"), ("key", "Left")])
    check("left returns to home", path_row(screens[-1]) == str(home), path_row(screens[-1]))
    check("left reselects the directory it came from",
          selected(capture(attrs=True)).startswith("alpha/"), selected(capture(attrs=True)))
    cleanup(work)

    home, screens, work = session([("text", "/"), ("text", "bet")])
    check("filter narrows the list while typing",
          "beta/" in screens[-1] and "alpha/" not in screens[-1], screens[-1][:300])
    cleanup(work)

    home, screens, work = session([("text", "/"), ("text", "alp"), ("key", "Enter")])
    check("filter is kept after Enter",
          "alpha/" in screens[-1] and "beta/" not in screens[-1], screens[-1][:300])
    send("Right")
    time.sleep(0.4)
    inside = capture()
    check("filter is cleared when entering a directory",
          path_row(inside) == f"{home}/alpha" and "sub/" in inside and "filter:" not in inside,
          inside[:300])
    cleanup(work)

    home, screens, work = session([("text", "/"), ("text", "alp"), ("key", "Enter"), ("key", "Escape")])
    check("escape clears the filter instead of quitting",
          has_session() and "beta/" in screens[-1], screens[-1][:300])
    cleanup(work)

    home, screens, work = session([("text", "f"), ("text", "sub")])
    check("f finds a nested directory", "alpha/sub/" in screens[-1], screens[-1][:600])
    send("Enter")
    time.sleep(0.3)
    send("Right")
    time.sleep(0.4)
    check("opening a search result goes there", path_row(capture()) == f"{home}/alpha/sub",
          path_row(capture()))
    cleanup(work)

    home, screens, work = session([("text", "n"), ("text", "newproj"), ("key", "Enter")])
    check("n creates the directory", (home / "newproj").is_dir())
    check("the new directory is listed and selected",
          selected(capture(attrs=True)).startswith("newproj/"), selected(capture(attrs=True)))
    cleanup(work)

    home, screens, work = session([("text", "n"), ("text", "../evil"), ("key", "Enter")])
    check("invalid name creates nothing", not (home.parent / "evil").exists())
    check("invalid name says why", "invalid name" in screens[-1], screens[-1][-400:])
    cleanup(work)

    home, screens, work = session([("key", "Down"), ("text", "R"), ("key", "C-u"),
                                   ("text", "gamma"), ("key", "Enter")])
    check("R renames the selection", (home / "gamma").is_dir() and not (home / "alpha").exists())
    cleanup(work)

    home, screens, work = session([("text", "t")], fixture=activity_fixture)
    shown = screens[-1]
    check("t sorts by activity", 0 <= shown.find("beta/") < shown.find("alpha/"), shown[:600])
    cleanup(work)

    home, screens, work = session([("text", "?")])
    check("? shows the keys", "find a directory anywhere" in screens[-1], screens[-1][:400])
    send("x")
    time.sleep(0.4)
    check("any key leaves the help", "up/down move" in capture(), capture()[-300:])
    cleanup(work)

    if shutil.which("git"):
        def clone_fixture(home):
            home_fixture(home)
            source = home.parent / "src"
            subprocess.run(["git", "init", "-q", "-b", "main", str(source)], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=t", "-c", "user.email=t@t",
                            "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        home, screens, work = session([("text", "g")], fixture=clone_fixture)
        send(f"file://{os.path.realpath(home.parent / 'src')}", literal=True)
        send("Enter")
        time.sleep(2.5)
        check("g clones a repository", (home / "src" / ".git").is_dir(), capture()[-400:])
        check("the clone is selected", selected(capture(attrs=True)).startswith("src/"),
              selected(capture(attrs=True)))
        cleanup(work)

        home, screens, work = session([], fixture=git_fixture)
        time.sleep(1.0)
        check("dirty repository gets a star", "work*" in capture(), capture()[:600])
        cleanup(work)
    else:
        print("  skip clone and dirty star tests: git is not installed")

    home, screens, work = session([("text", "p")], fixture=fake_pi)
    time.sleep(0.6)
    check("p runs pi in the selected directory", read(home / "pi-ran.txt") == str(home / "a-repo"),
          read(home / "pi-ran.txt"))
    after = capture()
    check("the directory becomes a recent project at the top", "~/a-repo/" in after, after[:600])
    cleanup(work)

    home, screens, work = session([("text", "c")], fixture=fake_pi)
    time.sleep(0.6)
    check("c continues the last session", without_extension(read(home / "pi-args.txt")) == "--continue",
          read(home / "pi-args.txt"))
    cleanup(work)

    home, screens, work = session([("text", "P")], fixture=fake_pi)
    time.sleep(0.6)
    picker = capture()
    check("P runs pi in the current directory", read(home / "pi-ran.txt") == str(home),
          read(home / "pi-ran.txt"))
    check("the picker survives pi exiting", has_session() and "up/down move" in picker,
          picker[:200])
    send("q")
    time.sleep(0.5)
    check("q still quits after pi ran", not has_session())
    cleanup(work)

    home, screens, work = session([("text", "p")], fixture=slow_pi, use_tmux=True)
    time.sleep(1.5)
    check("tmux mode runs pi in the selected directory", read(home / "pi-ran.txt") == str(home / "a-repo"),
          read(home / "pi-ran.txt"))
    check("pi gets the hindsight key", read(home / "pi-key.txt") == "secret-test-key",
          read(home / "pi-key.txt"))
    send("C-b")
    send("d")
    time.sleep(0.8)
    detached = capture()
    check("detaching comes back to the picker", "up/down move" in detached, detached[:400])
    check("the running pi is marked", "[pi]" in detached, detached[:600])

    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "XDG_CONFIG_HOME", "XDG_STATE_HOME")}
    env.update(HOME=str(home), PI_PICKER_TMUX_SOCKET=PI_SOCKET)
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    api = subprocess.run([sys.executable, "-B", str(APP), "--api", "paste-image"], input=png,
                         capture_output=True, env=env)
    try:
        reply = json.loads(api.stdout)
    except ValueError:
        reply = {"error": api.stdout.decode(errors="replace") + api.stderr.decode(errors="replace")}
    saved = Path(reply.get("saved", "/nonexistent"))
    check("api paste-image saves into the running project",
          saved.parent == home / "a-repo" / ".pi-images" and saved.read_bytes() == png, reply)
    time.sleep(0.3)
    inner = tmux("list-sessions", "-F", "#{session_name}", socket=PI_SOCKET).stdout.split()
    pane = tmux("capture-pane", "-p", "-t", inner[0], socket=PI_SOCKET).stdout if inner else ""
    check("api paste-image types the reference into pi",
          reply.get("typed") and reply.get("reference", "?") in pane, (reply, pane[-300:]))
    projects = json.loads(subprocess.run([sys.executable, "-B", str(APP), "--api", "projects"],
                                         capture_output=True, env=env).stdout)
    check("api projects lists the running pi",
          [p["label"] for p in projects.get("running", [])] == ["~/a-repo"], projects)

    send("x")
    time.sleep(0.3)
    send("y")
    time.sleep(0.8)
    check("x stops it", "[pi]" not in capture() and "pi stopped" in capture(), capture()[-400:])
    cleanup(work)

    home, screens, work = session([("text", "s"), ("text", "exit"), ("key", "Enter")])
    time.sleep(0.5)
    back = capture()
    check("s opens a shell and comes back", has_session() and "up/down move" in back, back[:200])
    cleanup(work)

    back_to_back_children()
    sandbox_test()
    hardening_test()
    checkpoint_test()
    multi_pi_test()
    resources_test()

    home, screens, work = session([])
    send("Escape")
    time.sleep(0.5)
    check("escape quits", not has_session())
    cleanup(work)

    home, screens, work = session([])
    send("C-c")
    time.sleep(0.5)
    check("ctrl-c quits", not has_session())
    cleanup(work)

    print("=" * 72, "\nASSERTIONS\n", "=" * 72, sep="")
    print("\n" + ("ALL PASSED" if not FAILURES else f"FAILED: {FAILURES}"))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
