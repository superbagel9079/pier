#!/usr/bin/env python3
# subject: tmux-driven test suite for pier-picker.py: proves listing, navigation, creation, filtering, search, clone, rename, sort, launching (direct and in tmux) and quit on a real terminal.
# verified: v4.20, 2026-10-16: all passed on the Debian host (/tmp noexec there: see runnable_tmp).
# tech: python, tmux, curses, git, pi
#
# Run: python3 -B pier-picker-tests.py
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
APP = HERE / "pier-picker.py"
SOCKET = "pier-picker-tests"
PI_SOCKET = "pier-picker-tests-pi"
SESSION = "s"
ROWS, COLS = 45, 100

FAILURES = []


def runnable_tmp():
    """Where the suite makes its fake homes. Its fake pi must run from there: a hardened
    VM often mounts /tmp noexec, and every test starting pi then failed with "pi not
    found on PATH" (which() checks that a file can be run). Then a folder of the
    user's home is used instead."""
    tmp = tempfile.gettempdir()
    try:
        noexec = bool(os.statvfs(tmp).f_flag & os.ST_NOEXEC)
    except (OSError, AttributeError):
        noexec = False
    if not noexec:
        return
    folder = Path.home() / ".cache" / "pier-picker-tests"
    folder.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(folder)
    print(f"{tmp} is mounted noexec: the tests work in {folder}")


runnable_tmp()


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
    work = tempfile.mkdtemp(prefix="pier-picker-")
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
    """Pi's arguments as asked, without the extensions Pier gives each Pi it starts (the
    conversation tracker, the git tools)."""
    return re.sub(r"^(?:--extension \S+pier-(?:session|git)\.ts ?)+", "", args)


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

    work = tempfile.mkdtemp(prefix="pier-picker-unit-")
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
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    (main_git / "worktrees" / "w" / "gitdir").write_text(f"{home / 'elsewhere' / '.git'}\n")
    check("git jail: another folder's worktree adds nothing",
          picker(f"print(m.git_jail_folders({str(project)!r}))") == str([str(project)]))
    (main_git / "worktrees" / "w" / "gitdir").write_text(f"{project / '.git'}\n")
    check("git jail: a worktree gets its main repository's .git",
          picker(f"print(m.git_jail_folders({str(project)!r}))") == str([str(project), str(main_git)]))
    (project / ".git").write_text(f"gitdir: {main_git}\n")
    check("git jail: another repository's own .git adds nothing",
          picker(f"print(m.git_jail_folders({str(project)!r}))") == str([str(project)]))
    pushed = picker(f"m.own_repository({str(project)!r})")
    check("broker: no push or pull for a .git naming another repository", "another repository" in pushed, pushed)
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
    incoming = home / ".local" / "state" / "pier-picker" / "incoming"
    check("upload-dir: nothing left in the private folder", not incoming.exists() or not any(incoming.iterdir()))

    # The old name: its folders move to the new one, a link stays behind.
    shutil.rmtree(home / ".local" / "state" / "pier-picker", ignore_errors=True)
    (home / ".config" / "pi-dir-picker").mkdir(parents=True)
    (home / ".config" / "pi-dir-picker" / "config.toml").write_text("recent_count = 3\n")
    (home / ".local" / "state" / "pi-dir-picker").mkdir(parents=True)
    (home / ".local" / "state" / "pi-dir-picker" / "labels.json").write_text("{}")
    subprocess.run([sys.executable, "-B", str(APP), "--api", "version"], env=env, capture_output=True, timeout=30)
    check("old name: the config moves",
          (home / ".config" / "pier-picker" / "config.toml").read_text() == "recent_count = 3\n"
          if (home / ".config" / "pier-picker" / "config.toml").exists() else False)
    check("old name: the state moves, a link stays",
          (home / ".local" / "state" / "pier-picker" / "labels.json").exists()
          and (home / ".local" / "state" / "pi-dir-picker").is_symlink())
    cleanup(str(work))


def checkpoint_test():
    """Restore points around a real --exec-pi: a fake Pi writes its session as Pi does
    (the file of a new session appears with the first answer) and changes a file; the
    API then lists the points and puts the file back."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    check("checkpoints: the state before restoring is kept", (api("checkpoints", str(project)).get("points") or [{}])[0].get("reason") == "before-restore")
    log = (home / ".local" / "state" / "pier-picker" / "picker.log").read_text() if (home / ".local" / "state" / "pier-picker" / "picker.log").exists() else ""
    check("log: pi start and exit, the restore", "pi.start" in log and "pi.exit" in log and "checkpoint.restore" in log, log[-600:])
    shutil.rmtree(work, ignore_errors=True)


GIT_BROKER_SCRIPT = r'''
import importlib.util, json, os, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
spec = importlib.util.spec_from_file_location("pier_picker", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
home = m.home_dir()
proj = os.path.join(home, "proj")
os.makedirs(proj, exist_ok=True)
calls, prs, issues, reviews = [], [], {}, {}
import re as _re

class Forge(BaseHTTPRequestHandler):
    """A GitHub as small as the picker needs: pull requests, issues with labels,
    reviews, a diff, branches (those of the local bare repository standing for it)."""
    def log_message(self, *a): pass
    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def text(self, data):
        body = data.encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def body(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
    def do_GET(self):
        calls.append(("GET", self.path, self.headers.get("Authorization")))
        path = self.path.split("?")[0]
        if path == "/user": return self.reply(200, {"login": "leo"})
        if path == "/repos/leo/demo": return self.reply(200, {"default_branch": "main"})
        if path == "/repos/leo/demo/branches":
            names = subprocess.run(["git", "--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"],
                                   capture_output=True, text=True).stdout.split()
            # The remote stands for a repository that already has its main branch: pushing
            # main is then refused (only a still empty repository takes it).
            return self.reply(200, [{"name": n} for n in (names or ["main"])])
        if path == "/repos/leo/demo/collaborators": return self.reply(200, [{"login": "leo"}, {"login": "alex"}])
        hit = _re.fullmatch(r"/repos/leo/demo/pulls/(\d+)(/reviews)?", path)
        if hit:
            n = int(hit.group(1))
            if hit.group(2): return self.reply(200, reviews.get(n, []))
            if "diff" in (self.headers.get("Accept") or ""): return self.text("diff --git a/b.txt b/b.txt\n+b\n")
            return self.reply(200, prs[n - 1])
        if path == "/repos/leo/demo/pulls": return self.reply(200, prs)
        hit = _re.fullmatch(r"/repos/leo/demo/issues/(\d+)", path)
        if hit: return self.reply(200, issues[int(hit.group(1))])
        if path == "/repos/leo/demo/issues":
            return self.reply(200, [i for i in issues.values() if any(l["name"] == "pi-task" for l in i["labels"])])
        if "check-runs" in path: return self.reply(200, {"check_runs": []})
        self.reply(404, {"message": "Not Found"})
    def do_POST(self):
        body = self.body()
        calls.append(("POST", self.path, body))
        path = self.path.split("?")[0]
        if path == "/repos/leo/demo/issues":
            n = 100 + len(issues)
            issues[n] = {"number": n, "title": body.get("title"), "body": body.get("body"), "state": "open", "user": {"login": "leo"},
                         "labels": [{"name": l} for l in body.get("labels", [])], "assignees": [], "html_url": f"https://x/{n}"}
            return self.reply(201, issues[n])
        hit = _re.fullmatch(r"/repos/leo/demo/issues/(\d+)/(labels|assignees|comments)", path)
        if hit:
            n, what = int(hit.group(1)), hit.group(2)
            if n in issues and what == "labels": issues[n]["labels"] += [{"name": l} for l in body["labels"]]
            if n in issues and what == "assignees": issues[n]["assignees"] = [{"login": a} for a in body["assignees"]]
            if n <= len(prs) and what == "labels": prs[n - 1].setdefault("labels", []).extend({"name": l} for l in body["labels"])
            return self.reply(200, {})
        hit = _re.fullmatch(r"/repos/leo/demo/pulls/(\d+)/(reviews|requested_reviewers)", path)
        if hit:
            n = int(hit.group(1))
            if hit.group(2) == "reviews": reviews.setdefault(n, []).append({"user": {"login": "leo"}, "state": body["event"]})
            else: prs[n - 1]["requested_reviewers"] = [{"login": r} for r in body["reviewers"]]
            return self.reply(200, {})
        pr = {"number": len(prs) + 1, "title": body.get("title"), "state": "open", "head": {"ref": body.get("head"), "sha": "x"},
              "base": {"ref": body.get("base")}, "user": {"login": "alex"}}
        prs.append(pr); self.reply(201, pr)
    def do_DELETE(self):
        calls.append(("DELETE", self.path, None))
        hit = _re.fullmatch(r"/repos/leo/demo/issues/(\d+)/labels/(.+)", self.path)
        if hit and int(hit.group(1)) in issues:
            issue = issues[int(hit.group(1))]
            issue["labels"] = [l for l in issue["labels"] if l["name"] != hit.group(2)]
        self.reply(200, {})
    def do_PUT(self):
        body = self.body()
        calls.append(("PUT", self.path, body)); self.reply(200, {"merged": True})

server = HTTPServer(("127.0.0.1", 0), Forge)
threading.Thread(target=server.serve_forever, daemon=True).start()
m.forge_api_base = lambda kind, url: f"http://127.0.0.1:{server.server_address[1]}"
remote = os.path.join(home, "remote.git")
subprocess.run(["git", "init", "-q", "--bare", "-b", "main", remote], check=True)
m.clone_url = lambda forge, repo: remote
out = {}
m.api_forge_add(home, "github", "https://github.com", b"tok-secret")
out["forges_mode"] = oct(os.stat(m.forges_path(home)).st_mode & 0o777)
fid = m.load_forges(home)[0]["id"]
m.api_repo_link(home, proj, fid, "leo/demo")
git = lambda *a: subprocess.run(["git", "-C", proj, "-c", "user.email=t@t", "-c", "user.name=t", *a], check=True, capture_output=True, text=True).stdout
open(os.path.join(proj, "a.txt"), "w").write("a")
git("add", "."); git("commit", "-qm", "one"); git("checkout", "-qb", "pi/work")
open(os.path.join(proj, "b.txt"), "w").write("b")
git("add", "."); git("commit", "-qm", "two")
broker = object.__new__(m.GitBroker); broker.project = os.path.realpath(proj); broker.home = home
def tried(request):
    try:
        return broker.answer(request)
    except m.ApiError as exc:
        return {"error": str(exc)}
out["push_main"] = "error" in tried({"op": "push", "branch": "main"})
out["push_other"] = "error" in tried({"op": "push", "branch": "feature"})
out["push_pi"] = tried({"op": "push", "branch": "pi/work"}).get("pushed")
out["remote_branches"] = subprocess.run(["git", "--git-dir", remote, "branch"], capture_output=True, text=True).stdout.split()
out["pr"] = tried({"op": "open_pr", "branch": "pi/work", "title": "Work"}).get("number")
asked = tried({"op": "request_merge", "number": 1})
held = next((a["args"] for a in m.load_approvals(home) if a["id"] == asked.get("asked")), {})
out["merge_bound"] = held.get("sha") == "x" and held.get("title") == "Work" and held.get("head") == "pi/work" and held.get("repo") == "leo/demo"
out["merged_before"] = any(c[0] == "PUT" for c in calls)
m.api_approval_answer(home, asked["asked"], "yes")
out["merged_after"] = any(c[0] == "PUT" for c in calls)
out["merged_at_commit"] = [c[2] for c in calls if c[0] == "PUT"][-1].get("sha") == "x"
try:
    m.api_approval_answer(home, asked["asked"], "yes"); out["answered_twice"] = False
except m.ApiError as exc:
    out["answered_twice"] = "no longer waiting" in str(exc)
# A commit pushed to the pull request after Pi asked: the approval merges nothing.
moved = tried({"op": "request_merge", "number": 1})
prs[0]["head"]["sha"] = "y"
puts = sum(1 for c in calls if c[0] == "PUT")
try:
    m.api_approval_answer(home, moved["asked"], "yes"); out["moved_refused"] = False
except m.ApiError as exc:
    out["moved_refused"] = "changed since" in str(exc) and sum(1 for c in calls if c[0] == "PUT") == puts
# Asked while another answer is being carried out (a merge is a round trip): none is lost.
slow = tried({"op": "request_merge", "number": 1})
real_merge = m.merge_pr
m.merge_pr = lambda *a, **k: (time.sleep(1.0), real_merge(*a, **k))[1]
answering = threading.Thread(target=m.api_approval_answer, args=(home, slow["asked"], "yes"))
answering.start()
time.sleep(0.3)
meanwhile = m.ask_approval(home, broker.project, "lab", {"machine": "gpu", "op": "lab_run", "command": "true", "what": "run: true"}, "")
answering.join(10)
m.merge_pr = real_merge
states = {a["id"]: a["state"] for a in m.load_approvals(home)}
out["none_lost"] = states.get(meanwhile["id"]) == "pending" and states.get(slow["asked"]) == "done"
if states.get(meanwhile["id"]) == "pending":
    m.api_approval_answer(home, meanwhile["id"], "no")
out["mode_default"] = (m.repo_link(home, broker.project) or {}).get("mode")
# A repository asked for: the account it would be made on is in the request.
other = os.path.join(home, "other")
os.makedirs(other, exist_ok=True)
elsewhere = object.__new__(m.GitBroker); elsewhere.project = os.path.realpath(other); elsewhere.home = home
made = elsewhere.answer({"op": "create_repo", "name": "fresh", "description": "for the tests"})
held = next((a["args"] for a in m.load_approvals(home) if a["id"] == made["asked"]), {})
out["repo_account_shown"] = held.get("account") == "leo" and held.get("forge_kind") == "github" and held.get("description") == "for the tests"
m.api_approval_answer(home, made["asked"], "no")
m.api_repo_settings(home, proj, "auto", "squash")
second = tried({"op": "open_pr", "branch": "pi/work", "title": "Again"}).get("number")
merged = tried({"op": "request_merge", "number": second})
out["auto_merged"] = merged.get("merged") == second and [c[2] for c in calls if c[0] == "PUT"][-1] == {"merge_method": "squash", "sha": "x"}
m.api_repo_settings(home, proj, "local", "merge")
out["local_push"] = "error" in tried({"op": "push", "branch": "pi/work"})
out["local_pr"] = "error" in tried({"op": "open_pr", "branch": "pi/work", "title": "No"})
try:
    m.api_repo_settings(home, proj, "anything", "merge"); out["bad_setting"] = False
except m.ApiError:
    out["bad_setting"] = True
m.api_repo_settings(home, proj, "ask", "merge")
# The team: tasks, reviews between Pis, a handoff.
made = tried({"op": "create_task", "title": "Write the changelog", "body": "every release"})
number = made.get("created")
out["task_listed"] = [t["number"] for t in tried({"op": "list_tasks"}).get("tasks", [])] == [number]
out["task_claimed"] = tried({"op": "claim_task", "number": number}).get("branch") == f"pi/task-{number}"
out["task_twice"] = "already taken" in tried({"op": "claim_task", "number": number}).get("error", "")
tried({"op": "release_task", "number": number, "done": True})
out["task_released"] = not tried({"op": "get_task", "number": number}).get("taken", True)
out["diff"] = "diff --git" in tried({"op": "pr_diff", "number": 1}).get("diff", "")
out["review_asked"] = tried({"op": "request_review", "number": 1, "reviewer": "alex"}).get("asked") == "alex"
out["review_self"] = "error" in tried({"op": "request_review", "number": 1, "reviewer": "leo"})
waiting = tried({"op": "review_pr", "number": 1, "verdict": "approve", "body": "Looks right."})
held = next((a["args"] for a in m.load_approvals(home) if a["id"] == waiting.get("asked")), {})
out["review_waits"] = "asked" in waiting and not reviews.get(1) and held.get("sha") == "y" and held.get("body") == "Looks right."
m.api_approval_answer(home, waiting["asked"], "yes")
out["review_posted"] = [r["state"] for r in reviews.get(1, [])] == ["APPROVE"]
m.api_repo_settings(home, proj, "auto", "merge")
tried({"op": "review_pr", "number": 1, "verdict": "comment", "body": "Again."})
tried({"op": "review_pr", "number": 1, "verdict": "comment", "body": "Third."})
out["review_rounds"] = "human decides" in tried({"op": "review_pr", "number": 1, "verdict": "comment", "body": "Fourth."}).get("error", "")
m.api_repo_settings(home, proj, "ask", "merge")
out["prompt_fixed"] = "#7" in m.agent_prompt("review", 7)
try:
    m.agent_prompt("shell", 7); out["prompt_kinds"] = False
except m.ApiError:
    out["prompt_kinds"] = True
session_dir = m.session_dir(os.path.realpath(proj)); os.makedirs(session_dir, exist_ok=True)
conversation = os.path.join(session_dir, "2026-10-26T10-00-00-000Z_x.jsonl")
open(conversation, "w").write(json.dumps({"type": "session", "cwd": "/home/someone/proj"}) + "\n" + json.dumps({"type": "message"}) + "\n")
given = m.api_handoff_give(home, proj, conversation, "alex", "the tests are left")
out["handoff_branch"] = given["given"].startswith("pi-handoff/alex/leo-") and given["branch"] == "pi/work"
forges = m.private_json(m.forges_path(home)); forges["forges"][0]["login"] = "alex"; m.save_private_json(m.forges_path(home), forges)
out["handoff_waiting"] = any(w["kind"] == "handoff" for w in m.api_team(home, proj)["waiting"])
taken = m.api_handoff_take(home, proj, given["given"])
header = json.loads(open(taken["session"]).readline())
out["handoff_taken"] = taken["from"] == "leo" and taken["note"] == "the tests are left" and header["cwd"] == os.path.realpath(proj)
out["handoff_deleted"] = given["given"] not in subprocess.run(["git", "--git-dir", remote, "branch"], capture_output=True, text=True).stdout
forges["forges"][0]["login"] = "leo"; m.save_private_json(m.forges_path(home), forges)
out["pull"] = tried({"op": "pull"}).get("into")
out["origin"] = git("branch", "-r").split()
out["token_sent"] = any(c[2] == "Bearer tok-secret" for c in calls if c[0] == "GET")
out["token_in_log"] = "tok-secret" in open(m.log_path()).read()
print(json.dumps(out))
'''


def worktree_test():
    """Two Pis in a git project, with real tmux: the second works in a worktree of its own,
    on its branch, and its untouched worktree goes once they are stopped."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
    home = Path(os.path.realpath(work / "home"))
    project = home / "repo"
    project.mkdir(parents=True)
    git = lambda *a: subprocess.run(["git", "-C", str(project), "-c", "user.email=t@t", "-c", "user.name=t", *a],
                                    check=True, capture_output=True, text=True).stdout
    git("init", "-q", "-b", "main")
    (project / "a.txt").write_text("a")
    git("add", ".")
    git("commit", "-qm", "one")
    tools = home / ".local" / "bin"
    tools.mkdir(parents=True)
    fake = tools / "pi"
    fake.write_text('#!/bin/sh\npwd > "$HOME/pwd-$PI_PICKER_SLOT"\nsleep 60\n')
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
        "print(json.dumps([first, second]))\n"
    )
    tmux("kill-server", socket=PI_SOCKET)
    run = subprocess.run([sys.executable, "-B", "-c", script], capture_output=True, text=True, env=env, timeout=30)
    try:
        first, second = json.loads(run.stdout)
    except ValueError:
        check("worktrees: two Pis start", False, run.stdout[-300:] + run.stderr[-600:])
        cleanup(str(work))
        return
    time.sleep(2.0)
    read = lambda slot: (home / f"pwd-{slot}").read_text().strip() if (home / f"pwd-{slot}").exists() else "nothing"
    tree = project / ".pi-worktrees" / second[0]
    check("worktrees: the first Pi works in the folder", read(first[0]) == str(project), read(first[0]))
    check("worktrees: the second in a worktree of its own", read(second[0]) == str(tree), read(second[0]))
    branch = subprocess.run(["git", "-C", str(tree), "branch", "--show-current"], capture_output=True, text=True).stdout.strip()
    check("worktrees: on a pi/agent-2 branch", branch.startswith("pi/agent-2-"), branch)
    check("worktrees: what is given to Pi reachable", (tree / ".pi-images").is_symlink())
    check("worktrees: the project's git status stays clean", git("status", "--porcelain").strip() == "", git("status", "--porcelain"))
    subprocess.run([sys.executable, "-B", str(APP), "--api", "stop", str(project), ""], env=env, capture_output=True, timeout=30)
    time.sleep(1.0)
    check("worktrees: an untouched one goes when the Pis stop", not tree.exists() and "pi/agent-2" not in git("branch"),
          (tree.exists(), git("branch")))
    tmux("kill-server", socket=PI_SOCKET)
    cleanup(str(work))


def git_broker_test():
    """The git broker on the real system: pushes through git's jail and the mirror, pull
    requests and a merge only once approved, against a made-up forge (a local server)
    and a local bare repository standing for the remote."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
    home = Path(os.path.realpath(work / "home"))
    home.mkdir()
    script = work / "broker.py"
    script.write_text(GIT_BROKER_SCRIPT)
    env = {k: v for k, v in os.environ.items() if k not in ("XDG_CONFIG_HOME", "XDG_STATE_HOME")}
    env["HOME"] = str(home)
    run = subprocess.run([sys.executable, "-B", str(script), str(APP)], env=env, capture_output=True, text=True, timeout=120)
    try:
        out = json.loads(run.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        check("git broker runs", False, run.stdout[-400:] + run.stderr[-800:])
        cleanup(str(work))
        return
    check("git: the forge token file is private", out["forges_mode"] == "0o600", out)
    check("git: main and other branches refused", out["push_main"] and out["push_other"], out)
    check("git: a pi/ branch pushed through the mirror", out["push_pi"] == "pi/work" and "pi/work" in out["remote_branches"], out)
    check("git: a pull request opened", out["pr"] == 1, out)
    check("git: no merge before the user approves", not out["merged_before"] and out["merged_after"], out)
    check("git: a merge request holds its pull request and commit, merged at that commit", out["merge_bound"] and out["merged_at_commit"], out)
    check("git: an answered request cannot be answered again", out["answered_twice"], out)
    check("git: a pull request changed after Pi asked is not merged", out["moved_refused"], out)
    check("git: a request asked while another is answered is not lost", out["none_lost"], out)
    check("git: a repository asked for says which account it goes to", out["repo_account_shown"], out)
    check("git: a repository asks to merge by default", out["mode_default"] == "ask", out)
    check("git: set to merge itself, Pi merges with the chosen method", out["auto_merged"], out)
    check("git: set to local work, nothing is pushed", out["local_push"] and out["local_pr"], out)
    check("git: an unknown setting refused", out["bad_setting"], out)
    check("git: pull fills origin/*", "origin/pi/work" in out["origin"], out)
    check("git: the token used, never logged", out["token_sent"] and not out["token_in_log"], out)
    check("team: a task made, listed, taken once, released", out["task_listed"] and out["task_claimed"] and out["task_twice"] and out["task_released"], out)
    check("team: a pull request's diff read", out["diff"], out)
    check("team: a review asked of a colleague, never of oneself", out["review_asked"] and out["review_self"], out)
    check("team: a review waits for approval, then is posted", out["review_waits"] and out["review_posted"], out)
    check("team: at most 3 reviews by one account", out["review_rounds"], out)
    check("team: Pi's prompt from fixed words only", out["prompt_fixed"] and out["prompt_kinds"], out)
    check("team: a conversation given with its branch", out["handoff_branch"] and out["handoff_waiting"], out)
    check("team: taken over here, its branch deleted", out["handoff_taken"] and out["handoff_deleted"], out)
    cleanup(str(work))


LABS_SCRIPT = r"""
import importlib.util, json, os, subprocess, sys, threading, time
spec = importlib.util.spec_from_file_location("pier_picker", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
home = m.home_dir()
proj = os.path.realpath(os.path.join(home, "proj"))
os.makedirs(os.path.join(proj, ".pi-files"), exist_ok=True)
open(os.path.join(proj, "a.txt"), "w").write("hello lab")
open(os.path.join(proj, ".pi-files", "given.txt"), "w").write("not for the lab")
secret = os.path.join(home, "secret.txt")
open(secret, "w").write("never copied")
os.symlink(secret, os.path.join(proj, "link-out"))
out = {}
def tried(f, *a, **k):
    try:
        return f(*a, **k)
    except m.ApiError as exc:
        return {"error": str(exc)}
out["off_by_default"] = "labs are off" in tried(m.lab_answer, home, proj, {"op": "lab_list"}).get("error", "")
out["bad_setting"] = "error" in tried(m.api_labs_settings, home, json.dumps({"network": "everywhere"}))
m.api_labs_settings(home, json.dumps({"enabled": True}))
out["bad_machine"] = "error" in tried(m.api_machine_add, home, "box", "evil;host", "22", "leo", "auto")
out["machine_added"] = "ssh-ed25519" in m.api_machine_add(home, "box", "127.0.0.1", "22", "leo", "auto")["public_key"]
# The machine stands in a local folder: ssh is replaced by a shell there.
remote = os.path.join(home, "remote")
os.makedirs(remote)
m.ssh_argv = lambda machine, command=None, tty=False: ["sh", "-c", command.replace("~", remote)]
pushed = m.lab_answer(home, proj, {"op": "lab_push", "lab": "box"})
landed = os.path.join(remote, "pier-lab")
out["push_files"] = open(os.path.join(landed, "a.txt")).read() == "hello lab"
out["push_skips_given"] = not os.path.exists(os.path.join(landed, ".pi-files"))
out["push_link_stays_link"] = os.path.islink(os.path.join(landed, "link-out"))
ran = m.lab_answer(home, proj, {"op": "lab_run", "lab": "box", "command": "cat a.txt; echo oops >&2; exit 3"})
out["run"] = ran["stdout"] == "hello lab" and "oops" in ran["stderr"] and ran["exit"] == 3
open(os.path.join(landed, "result.txt"), "w").write("42")
pulled = m.lab_answer(home, proj, {"op": "lab_pull", "lab": "box", "path": "result.txt"})
out["pull"] = open(os.path.join(proj, pulled["into"], "result.txt")).read() == "42"
journal = m.api_lab_journal(home)["journal"]
out["journal"] = any(j.get("command", "").startswith("cat a.txt") and j.get("exit") == 3 for j in journal)
# A machine set to ask: nothing runs before the user approves.
m.api_machine_add(home, "careful", "127.0.0.1", "22", "leo", "ask")
answer = {}
worker = threading.Thread(target=lambda: answer.update(tried(m.lab_answer, home, proj, {"op": "lab_run", "lab": "careful", "command": "echo approved > done.txt"})))
worker.start()
asked = None
for _ in range(50):
    asked = next((a for a in m.load_approvals(home) if a.get("kind") == "lab" and a.get("state") == "pending"), None)
    if asked:
        break
    time.sleep(0.1)
out["waits"] = asked is not None and not os.path.exists(os.path.join(remote, "pier-lab", "done.txt"))
out["approval_holds_command"] = (asked or {}).get("args", {}).get("command") == "echo approved > done.txt" and \
    (asked or {}).get("args", {}).get("where") == "leo@127.0.0.1:22"
m.api_approval_answer(home, asked["id"], "yes")
worker.join(10)
out["approved_runs"] = answer.get("exit") == 0 and os.path.exists(os.path.join(remote, "pier-lab", "done.txt"))
# What the user could not read whole is refused before it is asked: too long, or hidden characters.
out["ask_long_refused"] = "at most" in tried(m.lab_answer, home, proj, {"op": "lab_run", "lab": "careful", "command": "true" + " " * 5000}).get("error", "")
out["ask_hidden_refused"] = "would not see" in tried(m.lab_answer, home, proj, {"op": "lab_run", "lab": "careful", "command": "echo a‮"}).get("error", "")
# Unanswered: the request leaves the list, a late click approves nothing.
m.LAB_APPROVAL_WAIT = 1
late = tried(m.lab_answer, home, proj, {"op": "lab_run", "lab": "careful", "command": "touch late.txt"})
m.LAB_APPROVAL_WAIT = 600
left = [a for a in m.load_approvals(home) if (a.get("args") or {}).get("command") == "touch late.txt"]
out["expired"] = "ten minutes" in late.get("error", "") and bool(left) and left[-1]["state"] == "expired"
# The journal keeps the whole command.
whole = "echo " + "x" * 600
m.lab_answer(home, proj, {"op": "lab_run", "lab": "box", "command": whole})
out["journal_whole"] = any(j.get("command") == whole for j in m.api_lab_journal(home)["journal"])
answer.clear()
worker = threading.Thread(target=lambda: answer.update(tried(m.lab_answer, home, proj, {"op": "lab_run", "lab": "careful", "command": "touch refused.txt"})))
worker.start()
for _ in range(50):
    asked = next((a for a in m.load_approvals(home) if a.get("kind") == "lab" and a.get("state") == "pending"), None)
    if asked:
        break
    time.sleep(0.1)
m.api_approval_answer(home, asked["id"], "no")
worker.join(10)
out["refused"] = "refused" in answer.get("error", "") and not os.path.exists(os.path.join(remote, "pier-lab", "refused.txt"))
out["other_project"] = "error" in tried(m.lab_answer, home, proj, {"op": "lab_reset", "lab": "nothing"})
m.api_machine_add(home, "gpu-box", "127.0.0.1", "22", "leo", "auto", "GPU box:\n never touch /data")
seen = {x["name"]: x for x in m.lab_answer(home, proj, {"op": "lab_list"})["machines"]}
out["machine_described"] = seen.get("gpu-box", {}).get("description") == "GPU box: never touch /data"
m.api_lab_edit(home, "gpu-box", "cuda-box", "CUDA 12")
names = {n: v.get("description") for n, v in m.load_labs(home)["machines"].items()}
out["machine_renamed"] = names.get("cuda-box") == "CUDA 12" and "gpu-box" not in names
out["rename_taken"] = "error" in tried(m.api_lab_edit, home, "cuda-box", "box", "")
usable, why, kvm = m.incus_state()
out["incus"] = usable
out["no_host_said"] = "no lab host" in tried(m.lab_answer, home, proj, {"op": "lab_create"}).get("error", "")
out["bad_host"] = "error" in tried(m.api_host_add, home, "box2", "evil;host", "22", "leo", "")
out["vlan_setting"] = "error" not in tried(m.api_labs_settings, home, json.dumps({"network": "vlan", "vlan_network": "pier-labs-test"}))
if usable:
    m.api_host_local(home, "1")
    out["vlan_missing_said"] = "not there" in tried(m.lab_answer, home, proj, {"op": "lab_create"}).get("error", "")
m.api_labs_settings(home, json.dumps({"network": "open"}))
if usable:
    # One error is reported, not thrown: the checks above still count, and no lab stays.
    try:
        made = m.lab_answer(home, proj, {"op": "lab_create", "name": "pier-test", "description": "for the tests"})
        out["lab_on_host"] = made.get("host") == "pi-vm"
        out["lab_described"] = made.get("description") == "for the tests"
        out["lab_snapshots"] = made.get("snapshots")
        m.lab_answer(home, proj, {"op": "lab_push", "lab": made["lab"]})
        ran = m.lab_answer(home, proj, {"op": "lab_run", "lab": made["lab"], "command": "cat a.txt && id -u"})
        out["lab_runs_as_root"] = ran["stdout"].split() == ["hello", "lab0"]
        m.lab_answer(home, proj, {"op": "lab_reset", "lab": made["lab"]})
        gone = m.lab_answer(home, proj, {"op": "lab_run", "lab": made["lab"], "command": "test -e a.txt"})
        out["lab_reset"] = gone["exit"] != 0
        listed = m.lab_answer(home, proj, {"op": "lab_list"})
        out["networks_listed"] = any(n.get("kind_label", "").startswith("the internet") for n in listed.get("networks", []))
        out["hosts_listed"] = [h["name"] for h in listed.get("hosts", [])] == ["pi-vm"]
        out["unknown_network"] = "no network" in tried(m.lab_answer, home, proj, {"op": "lab_create", "name": "pier-x", "networks": ["nope"]}).get("error", "")
        cut = m.lab_answer(home, proj, {"op": "lab_create", "name": "pier-cut", "networks": []})
        nics = m.lab_answer(home, proj, {"op": "lab_run", "lab": cut["lab"], "command": "ls /sys/class/net"})
        out["lab_cut"] = nics["stdout"].split() == ["lo"]
        m.lab_answer(home, proj, {"op": "lab_destroy", "lab": cut["lab"]})
        # Another lab host, over SSH: ssh is stood in by a local shell here, so the commands
        # Pier would send there run against this Incus.
        m.api_host_add(home, "far", "127.0.0.1", "22", "leo", "a host over SSH")
        far = m.lab_answer(home, proj, {"op": "lab_create", "name": "pier-far", "host": "far"})
        said = m.lab_answer(home, proj, {"op": "lab_run", "lab": "pier-far", "command": "echo 'far away'"})
        out["remote_host"] = far.get("host") == "far" and said["stdout"].strip() == "far away"
        out["host_busy"] = "destroy them first" in tried(m.api_host_remove, home, "far").get("error", "")
        out["unknown_host"] = "no lab host" in tried(m.lab_answer, home, proj, {"op": "lab_create", "name": "pier-y", "host": "nowhere"}).get("error", "")
        m.lab_answer(home, proj, {"op": "lab_destroy", "lab": "pier-far"})
        m.api_host_remove(home, "far")
        m.api_lab_edit(home, made["lab"], "pier-test2", "renamed")
        back = m.lab_answer(home, proj, {"op": "lab_run", "lab": "pier-test2", "command": "true"})
        out["lab_renamed"] = back["exit"] == 0 and "pier-test2" in m.load_labs(home)["labs"]
        m.lab_answer(home, proj, {"op": "lab_destroy", "lab": "pier-test2"})
        out["lab_destroyed"] = not m.load_labs(home)["labs"]
    except Exception as exc:
        out["lab_error"] = f"{type(exc).__name__}: {exc}"
        for leftover in ("pier-pier-test", "pier-pier-test2", "pier-pier-cut", "pier-pier-far"):
            subprocess.run(["incus", "delete", "--force", leftover], capture_output=True)
else:
    m.api_host_local(home, "1")
    out["no_incus_said"] = "Incus" in tried(m.lab_answer, home, proj, {"op": "lab_create"}).get("error", "") or bool(why)
print(json.dumps(out))
"""


def labs_test():
    """Labs: off by default; on a machine (a local folder standing for it), the project
    copied without what was given to Pi nor what its links point to, commands run and
    journaled, files brought back, an approval awaited; with Incus there, a real lab."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
    home = Path(os.path.realpath(work / "home"))
    home.mkdir()
    script = work / "labs.py"
    script.write_text(LABS_SCRIPT)
    env = {k: v for k, v in os.environ.items() if k not in ("XDG_CONFIG_HOME", "XDG_STATE_HOME")}
    env["HOME"] = str(home)
    run = subprocess.run([sys.executable, "-B", str(script), str(APP)], env=env, capture_output=True, text=True, timeout=900)
    try:
        out = json.loads(run.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        check("labs run", False, run.stdout[-400:] + run.stderr[-800:])
        cleanup(str(work))
        return
    check("labs: off until turned on, bad settings refused", out["off_by_default"] and out["bad_setting"], out)
    check("labs: a machine added with Pier's key, a bad host refused", out["machine_added"] and out["bad_machine"], out)
    check("labs: the project copied, without what was given to Pi", out["push_files"] and out["push_skips_given"], out)
    check("labs: a link is copied as a link, never what it points to", out["push_link_stays_link"], out)
    check("labs: a command runs, with its output and exit code", out["run"], out)
    check("labs: a file brought back into .pi-files", out["pull"], out)
    check("labs: every command journaled", out["journal"], out)
    check("labs: a machine set to ask waits for the approval", out["waits"] and out["approved_runs"], out)
    check("labs: the approval holds the whole command, and where it runs", out["approval_holds_command"], out)
    check("labs: on a machine that asks, a command too long or with hidden characters is refused",
          out["ask_long_refused"] and out["ask_hidden_refused"], out)
    check("labs: an unanswered request goes, a late click approves nothing", out["expired"], out)
    check("labs: the journal keeps the whole command", out["journal_whole"], out)
    check("labs: a refused command does not run", out["refused"], out)
    check("labs: an unknown lab refused", out["other_project"], out)
    check("labs: the network set to a VLAN", out["vlan_setting"], out)
    check("labs: no lab host, no lab; a bad host refused", out["no_host_said"] and out["bad_host"], out)
    if out.get("incus"):
        check("labs: without the VLAN's Incus network, making a lab says why", out["vlan_missing_said"], out)
    check("labs: a machine's description reaches Pi, on one line", out["machine_described"], out)
    check("labs: a machine renamed and described again, a taken name refused", out["machine_renamed"] and out["rename_taken"], out)
    if out.get("incus"):
        how = "a snapshot" if out.get("lab_snapshots") else "a rebuild (no snapshots in this Incus project)"
        check("labs: Pi makes a lab on the default host", out.get("lab_on_host") and out.get("hosts_listed"), out.get("lab_error") or out)
        check("labs: Incus lab made, project inside, root", out.get("lab_runs_as_root"), out.get("lab_error") or out)
        check("labs: a lab on another host, over SSH (stood in)", out.get("remote_host"), out.get("lab_error") or out)
        check("labs: a host with labs is not removed, an unknown host refused", out.get("host_busy") and out.get("unknown_host"), out.get("lab_error") or out)
        check(f"labs: reset goes back to the clean state, by {how}", out.get("lab_reset"), out.get("lab_error") or out)
        check("labs: a lab described at its making, renamed, still running", out.get("lab_described") and out.get("lab_renamed"), out.get("lab_error") or out)
        check("labs: Pi sees the networks, an unknown one refused", out.get("networks_listed") and out.get("unknown_network"), out.get("lab_error") or out)
        check("labs: a lab on no network has none", out.get("lab_cut"), out.get("lab_error") or out)
        check("labs: destroyed", out.get("lab_destroyed"), out.get("lab_error") or out)
    else:
        check("labs: without Incus, making a lab says why", out["no_incus_said"], out)
    cleanup(str(work))


def resources_test():
    """Setup's list of what Pi loads: packages with their version, skills, prompts, MCP
    servers, from a made-up agent dir and project; nothing is run."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    (project / ".pi" / "mcp.json").write_text('{"mcpServers": {"github": {}}}')
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

    # Managing them: on and off as `pi config` writes it, local skills, a package's skill.
    pkg = agent / "npm" / "node_modules" / "pi-hindsight"
    (pkg / "skills" / "recall").mkdir(parents=True)
    (pkg / "skills" / "recall" / "SKILL.md").write_text("---\nname: recall\n---\n")

    def api(*args, data=None):
        run = subprocess.run([sys.executable, "-B", str(APP), "--api", *args], input=data, env=env,
                             capture_output=True, timeout=30)
        try:
            return json.loads(run.stdout)
        except ValueError:
            return {"error": run.stdout.decode(errors="replace") + run.stderr.decode(errors="replace")}

    listed = api("resources", str(project))
    names = {(s["name"], s["source"]): s for s in listed.get("skills", [])}
    check("resources: local and package skills, loaded", names.get(("notes", None), {}).get("enabled")
          and names.get(("recall", "npm:pi-hindsight"), {}).get("enabled"), listed)
    api("toggle-resource", "user", str(project), "skills", "npm:pi-hindsight", "skills/recall/SKILL.md", "0")
    api("toggle-resource", "project", str(project), "skills", "", "skills/notes/SKILL.md", "0")
    settings = json.loads((agent / "settings.json").read_text())
    check("resources: a package's skill off, as pi config writes it",
          {"source": "npm:pi-hindsight", "skills": ["-skills/recall/SKILL.md"]} in settings.get("packages", []), settings)
    check("resources: a local skill off, in the project's settings",
          json.loads((project / ".pi" / "settings.json").read_text()).get("skills") == ["-skills/notes/SKILL.md"])
    listed = api("resources", str(project))
    check("resources: both listed off", not any(s["enabled"] for s in listed.get("skills", [])), listed.get("skills"))
    made = api("skill-new", "user", str(project), "my-skill", "does things")
    check("skills: a new one from the template", (agent / "skills" / "my-skill" / "SKILL.md").read_text().startswith("---\nname: my-skill")
          if (agent / "skills" / "my-skill" / "SKILL.md").exists() else False, made)
    check("skills: a bad name refused", "error" in api("skill-new", "user", str(project), "Bad Name", ""))
    api("skill-write", "user", str(project), "my-skill", data=b"---\nname: my-skill\n---\nnew\n")
    check("skills: saved", api("skill-read", "user", str(project), "my-skill").get("text", "").endswith("new\n"))
    binned = api("skill-delete", "user", str(project), "my-skill")
    check("skills: put in the bin, recoverable", not (agent / "skills" / "my-skill").exists()
          and Path(binned.get("kept", "/nonexistent")).joinpath("SKILL.md").exists(), binned)
    import io
    import tarfile
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as tar:
        for name, body in (("Shared Skill/SKILL.md", b"---\nname: shared\n---\n"), ("Shared Skill/notes.md", b"x")):
            info = tarfile.TarInfo(name)
            info.size = len(body)
            tar.addfile(info, io.BytesIO(body))
    imported = api("skill-import", "project", str(project), "Shared Skill", data=archive.getvalue())
    check("skills: imported under the name it declares", (project / ".pi" / "skills" / "shared" / "notes.md").exists(), imported)

    # pi install, run by the picker: a fake pi records what it was asked.
    tools = home / ".local" / "bin"
    tools.mkdir(parents=True)
    (tools / "pi").write_text('#!/bin/sh\necho "$@" > "$HOME/.pi/pi-args.txt"\n')
    (tools / "pi").chmod(0o755)
    env2 = dict(env, PATH=f"{tools}:/usr/bin:/bin", PI_PICKER_SANDBOX="0")
    subprocess.run([sys.executable, "-B", str(APP), "--pi-package", "install", str(project), "npm:pi-review"],
                   stdin=subprocess.DEVNULL, env=env2, capture_output=True, timeout=30)
    args = (home / ".pi" / "pi-args.txt").read_text().strip() if (home / ".pi" / "pi-args.txt").exists() else "nothing"
    check("packages: pi install -l for a project", args == "install -l npm:pi-review", args)
    refused = subprocess.run([sys.executable, "-B", str(APP), "--pi-package", "install", "user", "npm:x;rm"],
                             stdin=subprocess.DEVNULL, env=env2, capture_output=True, text=True, timeout=30)
    check("packages: a source that is not one refused", refused.returncode == 2, refused.stdout[-200:])
    cleanup(work)


def multi_pi_test():
    """Two Pis in one project, in real tmux: each in its own conversation (recorded in
    tmux as @pi-file), both listed by the API, stopped one at a time."""
    work = Path(tempfile.mkdtemp(prefix="pier-picker-"))
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
    git_broker_test()
    labs_test()
    worktree_test()

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
