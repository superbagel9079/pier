#!/usr/bin/env python3
# subject: TUI directory picker browsing the home directory (non-hidden directories only) that launches Pi in the chosen directory, inside tmux so Pi survives a dropped SSH connection.
# verified: v4.4, 2026-10-13: picker logic, restore points (real git), several Pis per project and the watch stream checked on Windows (python 3.14, curses stubbed, tmux faked); the tmux suite (pi-dir-picker-tests.py) still has to be run on the Debian host.
# tech: python, curses, git, tmux, pi
#
# Standard library only.
# Evidence is produced by pi-dir-picker-tests.py, which drives this program through a real pty.
#
# Files:
#   ~/.config/pi-dir-picker/config.toml      optional settings, see DEFAULTS
#   ~/.local/state/pi-dir-picker/state.json  recent projects and the sort order
#   ~/.local/state/pi-dir-picker/picker.log  what happened, see "logging"
#   ~/.local/state/pi-dir-picker/checkpoints/ restore points of the projects, see "restore points"
#   ~/.local/state/pi-dir-picker/tmux.conf   the config of Pi's tmux server, see tmux_conf
# Environment:
#   PI_BIN                 path of the pi executable when it is not found on PATH
#   PI_PICKER_TMUX_SOCKET  tmux socket holding the Pi sessions (the tests use their own)
#   DEVBOX_LOG=debug       also log every read the desktop client makes
#   DEVBOX_REQUEST         the client's id for the call, written in the log next to its own

import collections
import curses
import hashlib
import json
import locale
import os
import queue
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import sys
import threading
import time
import traceback
import unicodedata
import uuid

try:
    import fcntl
except ImportError:  # Windows, where only the logic checks run: no locking
    fcntl = None

try:
    import tomllib
except ImportError:  # python < 3.11: the config file is ignored, with a message
    tomllib = None

VERSION = "4.14"
SCRIPT = os.path.realpath(__file__)

DEFAULTS = {
    "start": "~",                      # directory shown first, inside the home directory
    "ignore": [],                      # directory names never listed nor searched
    "search_depth": 4,                 # levels below home that f searches
    "pi_command": ["pi"],              # program and arguments; a string is split like a shell
    "continue_args": ["--continue"],   # added by c: continue Pi's last session
    "resume_args": ["--resume"],       # added by r: choose one of Pi's saved sessions
    "tmux": True,                      # run Pi in tmux so it survives a dropped connection
    "recent_count": 8,                 # recent projects listed at the top of home, 0 hides them
    "preview": True,                   # side panel when the terminal is wide enough
    "sandbox": True,                   # run Pi in bubblewrap: it only sees its project, see sandbox_argv
    "sandbox_read": [],                # extra paths Pi may read in the sandbox, e.g. ["~/docs"]
    "sandbox_write": [],               # extra paths Pi may also write in the sandbox
    "checkpoints": True,               # save the project before each prompt, to undo what Pi did
    "track_sessions": True,            # Pi tells Pier which conversation it holds (an extension Pier gives it)
}

# One path segment: starts with a letter or a digit (no hidden directory, no name that
# reads as an option), then letters, digits, "_", "." or "-". Accented letters allowed.
NAME_RE = re.compile(r"[^\W_][\w.-]*")
NAME_MAX_BYTES = 255

# Only URLs git treats as remote, plus file:// for local mirrors. A leading dash is
# refused on top of the "--" given to git clone.
CLONE_URL_RE = re.compile(r"(?:https?|ssh|git|file)://\S+|[\w.-]+@[\w.-]+:\S+")

# A repository's own config can name a program that git status runs: core.fsmonitor.
# It is switched off here. Clean filters declared in .git/config can still run; see
# git_status.
GIT_OPTIONS = ["--no-optional-locks", "-c", "core.fsmonitor=false"]
GIT_TIMEOUT = 5

# Under an SSH RemoteCommand the PATH is the bare system one. These are appended,
# never prepended, so the user's own PATH wins.
# Where a user's own programs live, first: what you installed for yourself wins over a
# copy installed for everyone, as your ~/.profile would order it (an SSH command does not
# read it). /usr/local/bin last, for systems whose PATH lacks it.
USER_PATH = ("~/.npm-global/bin", "~/.local/bin", "~/bin", "~/.bun/bin")
SYSTEM_PATH = ("/usr/local/bin",)
EXTRA_PATH = USER_PATH + SYSTEM_PATH

TMUX_SOCKET = os.environ.get("PI_PICKER_TMUX_SOCKET", "pi-dir-picker")
INSTALLERS = (
    ("apt-get", ["apt-get", "install", "-y", "tmux"]),
    ("dnf", ["dnf", "install", "-y", "tmux"]),
    ("pacman", ["pacman", "-S", "--noconfirm", "tmux"]),
    ("zypper", ["zypper", "--non-interactive", "install", "tmux"]),
    ("apk", ["apk", "add", "tmux"]),
)

SEARCH_SKIP = {"node_modules", "__pycache__", "venv", "env", "target", "dist", "build", "vendor"}
SEARCH_LIMIT = 20000
SEARCH_SHOWN = 200
RECENT_KEPT = 50
PROJECT_MARKERS = ("AGENTS.md", "CLAUDE.md", ".pi", "README.md")

# Below this many rows the logo is dropped; below this many columns, the preview.
BANNER_MIN_ROWS = 30
PREVIEW_MIN_COLS = 110

# Plain ASCII: renders the same whatever the terminal's encoding.
LOGO = [
    "         ''",
    "'||''|,  ||",
    " ||  ||  ||",
    " ||..|' .||.",
    " ||",
    ".||",
]
LOGO_BASELINE = 3

HELP = [
    ("up/down  pgup/pgdn  home/end", "move"),
    ("right  enter", "open the directory"),
    ("left  backspace", "go up"),
    ("p", "start pi in the selected directory"),
    ("P", "start pi in the current directory"),
    ("N", "start another pi in the selection, in a new conversation"),
    ("c", "continue pi's last session in the selection"),
    ("r", "choose one of pi's saved sessions"),
    ("x", "stop the pis running in the selection"),
    ("/", "filter this directory"),
    ("f", "find a directory anywhere under ~"),
    ("n", "new directory"),
    ("g", "git clone here"),
    ("R", "rename the selection"),
    ("t", "sort by name or by recent activity"),
    ("s", "shell in the selection"),
    ("q  esc", "quit (esc first clears a filter or a search)"),
]

# Python sets LC_CTYPE from the environment at startup, so this is the terminal's.
ENCODING = locale.getpreferredencoding(False) or "ascii"
UNICODE = "utf" in ENCODING.lower()
ELLIPSIS = "…" if UNICODE else "~"
AHEAD = "↑" if UNICODE else "+"
BEHIND = "↓" if UNICODE else "-"

HELP_NOTES = [
    "[pi]  a pi runs there in tmux: p goes back to it, ctrl-b d inside it returns here",
    f"main*  {AHEAD}2 {BEHIND}1   branch, uncommitted changes, commits ahead and behind upstream",
]

ENTER = ("\n", "\r", curses.KEY_ENTER)
BACKSPACE = ("\x7f", "\x08", curses.KEY_BACKSPACE)
ESCAPE = "\x1b"
CTRL_C = "\x03"
CTRL_L = "\x0c"
CTRL_U = "\x15"


# --- config and state ------------------------------------------------------------------

def config_path(home):
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(base, "pi-dir-picker", "config.toml")


def load_config(home):
    """(config, warning). Unknown keys and wrong types are reported; defaults stand in."""
    config = {key: list(value) if isinstance(value, list) else value for key, value in DEFAULTS.items()}
    path = config_path(home)
    if not os.path.isfile(path):
        return config, None
    if tomllib is None:
        return config, "config.toml ignored: reading it needs python 3.11 or newer"
    try:
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return config, f"config.toml ignored: {exc}"
    problems = []
    for key, value in data.items():
        if key not in DEFAULTS:
            problems.append(f"unknown key {key}")
            continue
        if key in ("pi_command", "continue_args", "resume_args") and isinstance(value, str):
            value = shlex.split(value)
        default = DEFAULTS[key]
        if isinstance(default, bool) != isinstance(value, bool) or not isinstance(value, type(default)):
            problems.append(f"{key} should be a {type(default).__name__}")
            continue
        if isinstance(value, list) and not all(isinstance(item, str) for item in value):
            problems.append(f"{key} should list strings")
            continue
        config[key] = value
    if not config["pi_command"]:
        config["pi_command"] = ["pi"]
        problems.append("pi_command is empty")
    return config, ("config.toml: " + "; ".join(problems)) if problems else None


def state_path(home):
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(base, "pi-dir-picker", "state.json")


def load_state(home):
    try:
        with open(state_path(home), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    recent = data.get("recent")
    recent = [p for p in recent if isinstance(p, str)] if isinstance(recent, list) else []
    sort = data.get("sort") if data.get("sort") in ("name", "activity") else "name"
    return {"recent": recent, "sort": sort}


def save_state(home, state):
    """Atomic write, readable by the owner only: the paths say what you work on."""
    path = state_path(home)
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, indent=1)
        os.replace(tmp, path)
    except OSError:
        pass


# --- logging -------------------------------------------------------------------------
#
# One line per event, in ~/.local/state/pi-dir-picker/picker.log, readable by its owner
# only:
#   2026-10-12T14:32:01.123Z INFO  api.paste-image pid=4242 req=7f3a-12 ms=41 saved=...
# Times are UTC, like Pier's own log, so the two read side by side; req is the id
# Pier gave the call. A crash adds its traceback on the lines below, indented. The
# reads Pier makes every few seconds are debug lines, written only with
# DEVBOX_LOG=debug. Logging never breaks anything: when the disk is full or the home is
# read-only, lines are lost and that is all. Passwords never come here, and what is
# typed into Pi is logged as its length only.

LOG_MAX_BYTES = 1024 * 1024
LOG_KEEP = 3  # picker.log, picker.log.1, picker.log.2
LOG_LEVELS = {"error": 0, "warn": 1, "info": 2, "debug": 3}
LOG_LEVEL = LOG_LEVELS["debug" if os.environ.get("DEVBOX_LOG") == "debug" else "info"]
LOG_REQUEST = re.sub(r"[^A-Za-z0-9_.-]", "", os.environ.get("DEVBOX_REQUEST", ""))[:40]


def log_path():
    return os.path.join(os.path.dirname(state_path(home_dir())), "picker.log")


def log_value(value):
    """value as one token: bare when it is simple, else quoted like a JSON string."""
    if isinstance(value, (list, tuple, dict)):
        value = json.dumps(value, ensure_ascii=False)
    text = str(value)
    if text and text.isprintable() and not re.search(r'[\s"=\\]', text):
        return text
    return json.dumps(text, ensure_ascii=False)


def log_stamp(now=None):
    now = time.time() if now is None else now
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now % 1 * 1000):03d}Z"


def log(level, event, trace=None, **fields):
    """Append one event; trace (a traceback) goes on the following lines, indented."""
    if LOG_LEVELS[level] > LOG_LEVEL:
        return
    try:
        parts = [log_stamp(), level.upper().ljust(5), event, f"pid={os.getpid()}"]
        if LOG_REQUEST:
            parts.append(f"req={LOG_REQUEST}")
        parts += [f"{key}={log_value(value)}" for key, value in fields.items() if value is not None]
        line = " ".join(parts) + "\n"
        if trace:
            line += "".join(f"    {row}\n" for row in trace.rstrip("\n").splitlines())
        log_write(log_path(), line.encode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - see above: never let a log line fail the program
        pass


def log_write(path, data):
    """Append data to path, rotating it past LOG_MAX_BYTES. Several API calls run at
    once: the lock makes one of them rotate, and the others then write to the new file."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    for _ in range(3):
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                current = os.stat(path)
            except OSError:
                continue  # rotated away meanwhile: open the new one
            if not os.path.samestat(current, os.fstat(fd)):
                continue
            if current.st_size and current.st_size + len(data) > LOG_MAX_BYTES:
                if os.name == "nt":  # Windows renames no open file (only the checks run there)
                    os.close(fd)
                    fd = None
                for n in range(LOG_KEEP - 1, 0, -1):
                    older = f"{path}.{n - 1}" if n > 1 else path
                    if os.path.exists(older):
                        os.replace(older, f"{path}.{n}")
                continue  # this fd is the rotated file now
            os.write(fd, data)
            return
        finally:
            if fd is not None:
                os.close(fd)


def log_tail(lines):
    """The last lines of the log, older files included when the current one is short."""
    lines = max(1, min(int(lines), 5000))
    path = log_path()
    rows = []
    for name in [path] + [f"{path}.{n}" for n in range(1, LOG_KEEP)]:
        try:
            with open(name, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - 400 * lines))
                chunk = handle.read().decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        if size > 400 * lines and chunk:
            chunk = chunk[1:]  # cut in the middle of a line
        rows = chunk + rows
        if len(rows) >= lines:
            break
    return rows[-lines:]


# --- filesystem and git ----------------------------------------------------------------

def home_dir():
    return os.path.realpath(os.path.expanduser("~"))


def within(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def list_dirs(path, ignore=()):
    """Non-hidden subdirectories of path, sorted case-insensitively.

    Symlinks are skipped: following one could lead out of the home directory.
    """
    out = []
    try:
        it = os.scandir(path)
    except OSError:
        return out
    with it:
        for entry in it:
            if entry.name.startswith(".") or entry.name in ignore:
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    out.append(entry.name)
            except OSError:
                continue
    out.sort(key=str.casefold)
    return out


def walk_dirs(root, depth, ignore=(), limit=SEARCH_LIMIT):
    """Subdirectories of root down to depth levels, shallowest first."""
    skip = SEARCH_SKIP | set(ignore)
    found, pending = [], collections.deque([(root, 0)])
    while pending:
        path, level = pending.popleft()
        for name in list_dirs(path, skip):
            child = os.path.join(path, name)
            found.append(child)
            if len(found) >= limit:
                return found
            if level + 1 < depth:
                pending.append((child, level + 1))
    return found


def is_enterable(path):
    return os.access(path, os.R_OK | os.X_OK)


def activity(path):
    """Last change worth sorting on: the directory itself, or git's index for a repository."""
    stamps = []
    for candidate in (path, os.path.join(path, ".git", "index")):
        try:
            stamps.append(os.stat(candidate).st_mtime)
        except OSError:
            pass
    return max(stamps, default=0.0)


def git_dir(path):
    """The repository's git directory: .git itself, or where a .git file points (worktree, submodule)."""
    dot = os.path.join(path, ".git")
    if os.path.isdir(dot):
        return dot
    try:
        with open(dot, encoding="utf-8", errors="replace") as handle:
            first = handle.readline().strip()
    except OSError:
        return None
    if first.startswith("gitdir:"):
        return os.path.normpath(os.path.join(path, first[7:].strip()))
    return None


def git_branch(path):
    """Branch name, or short sha when detached, or None when not a repository."""
    directory = git_dir(path)
    if directory is None:
        return None
    try:
        with open(os.path.join(directory, "HEAD"), encoding="utf-8", errors="replace") as handle:
            head = handle.read().strip()
    except OSError:
        return None
    if head.startswith("ref:"):
        ref = head[4:].strip()
        return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
    return head[:7] or None


# Where the user's session bus and systemd sockets live, hidden in the sandboxes (when
# the system has it: a missing folder would make bwrap fail).
RUN_USER_HIDDEN = ("--tmpfs", "/run/user") if os.path.isdir("/run/user") else ()


def git_jail(path):
    """bwrap arguments that run git on path's repository with nothing else: the
    repository read-only, the rest of home hidden, no network, no way out. A project's
    .git/config is Pi's to write (filters, hooks would run commands); in here they can
    only read the project. None without bwrap."""
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    directory = git_dir(path)
    top = os.path.realpath(os.path.dirname(directory) if directory else path)
    home = os.path.realpath(home_dir())
    args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
            "--tmpfs", "/home", *RUN_USER_HIDDEN]
    if not within(home, "/home"):
        args += ["--tmpfs", home]
    args += ["--ro-bind", top, top, "--unshare-all", "--die-with-parent", "--new-session", "--"]
    return args


def git_run(path, *args):
    """stdout of a git command in path, or None when it fails. Run in git_jail when
    bwrap is there (always, sandbox or not: it costs a few milliseconds)."""
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C",
               GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    for key in ("DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"):
        env.pop(key, None)
    jail = git_jail(path) or []
    try:
        result = subprocess.run(
            [*jail, "git", *GIT_OPTIONS, "-C", path, *args],
            stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=GIT_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout if result.returncode == 0 else None


def git_status(path):
    """{"dirty", "ahead", "behind"} from one git status, or None when git cannot tell.

    git status reads the repository's config, which Pi can write: it runs in git_jail
    (see git_run), where a filter declared there can only read the repository.
    """
    out = git_run(path, "status", "--porcelain=v2", "--branch")
    if out is None:
        return None
    info = {"dirty": False, "ahead": 0, "behind": 0}
    for line in out.decode("utf-8", "replace").splitlines():
        if line.startswith("# branch.ab "):
            parts = line.split()
            try:
                info["ahead"], info["behind"] = int(parts[2].lstrip("+")), int(parts[3].lstrip("-"))
            except (IndexError, ValueError):
                pass
        elif line and not line.startswith("#"):
            info["dirty"] = True
    return info


def readme_lines(path, count=8):
    try:
        names = sorted(os.listdir(path))
    except OSError:
        return []
    for name in names:
        full = os.path.join(path, name)
        if name.lower().startswith("readme") and os.path.isfile(full):
            try:
                with open(full, encoding="utf-8", errors="replace") as handle:
                    text = handle.read(4096)
            except OSError:
                return []
            lines = (line.strip().lstrip("#").strip() for line in text.splitlines())
            return [line for line in lines if line][:count]
    return []


def preview_info(path):
    """What the side panel shows about a directory: last commits, Pi files, README start."""
    info = {
        "markers": [m for m in PROJECT_MARKERS if os.path.exists(os.path.join(path, m))],
        "commits": [],
        "readme": readme_lines(path),
    }
    if git_dir(path):
        out = git_run(path, "log", "-3", "--format=%ct%x09%s") or b""
        for line in out.decode("utf-8", "replace").splitlines():
            stamp, _, subject = line.partition("\t")
            if stamp.isdigit():
                info["commits"].append((int(stamp), subject))
    return info


class Background:
    """probe(path) computed on a background thread, so drawing never waits for git.

    Results are cached per path until forget(). request() supersedes earlier requests:
    leaving a directory drops the queued work for it. changed is set when a result lands.
    """

    def __init__(self, probe, changed):
        self._probe = probe
        self._lock = threading.Lock()
        self._results = {}
        self._queue = queue.Queue()
        self._generation = 0
        self._epoch = 0
        self.changed = changed
        threading.Thread(target=self._work, daemon=True).start()

    def request(self, paths):
        with self._lock:
            self._generation += 1
            generation, epoch = self._generation, self._epoch
            missing = [p for p in paths if p not in self._results]
        for path in missing:
            self._queue.put((generation, epoch, path))

    def get(self, path):
        """The probe's result, or None while unknown."""
        return self._results.get(path)

    def forget(self):
        with self._lock:
            self._epoch += 1
            self._results.clear()

    def _work(self):
        while True:
            generation, epoch, path = self._queue.get()
            with self._lock:
                stale = generation != self._generation or epoch != self._epoch or path in self._results
            if stale:
                continue
            value = self._probe(path)
            with self._lock:
                if epoch != self._epoch:
                    continue
                self._results[path] = value
            self.changed.set()


def valid_name(name):
    """A new directory name: one segment, no slash, no leading dot or dash, not empty."""
    return bool(NAME_RE.fullmatch(name)) and len(name.encode("utf-8")) <= NAME_MAX_BYTES


def valid_clone_url(url):
    return not url.startswith("-") and bool(CLONE_URL_RE.fullmatch(url))


def clone_name(url):
    """The directory git clone creates for url: the last segment, without .git."""
    tail = re.split(r"[/:]", url.rstrip("/"))[-1]
    return tail[:-4] if tail.endswith(".git") else tail


def match_score(needle, hay):
    """Search ranking, lower is better; None when hay lacks needle's characters in order.

    Both are casefolded. A hit in the last segment beats a hit in the parents, a
    contiguous hit beats a scattered one, a short path beats a long one.
    """
    base = hay.rsplit(os.sep, 1)[-1]
    if base.startswith(needle):
        return (0, len(hay))
    if needle in base:
        return (1, len(hay))
    if needle in hay:
        return (2, len(hay))
    pos, last, gaps = -1, -1, 0
    for ch in needle:
        pos = hay.find(ch, pos + 1)
        if pos < 0:
            return None
        if last >= 0:
            gaps += pos - last - 1
        last = pos
    return (3, gaps, len(hay))


# --- processes -------------------------------------------------------------------------

def child_env(home):
    env = dict(os.environ)
    dirs = [d for d in env.get("PATH", "").split(os.pathsep) if d]
    mine = [os.path.expanduser(d) for d in USER_PATH]
    mine = [d for d in mine if os.path.isdir(d)]
    dirs = mine + [d for d in dirs if d not in mine]
    for extra in SYSTEM_PATH:
        if os.path.isdir(extra) and extra not in dirs:
            dirs.append(extra)
    env["PATH"] = os.pathsep.join(dirs)
    return env


def read_hindsight_key(home):
    """(key or None, warning or None). The warning flags a key file others can read."""
    path = os.path.join(home, ".pi", "hindsight.key")
    try:
        with open(path, encoding="utf-8") as handle:
            mode = os.fstat(handle.fileno()).st_mode
            key = handle.read().strip()
    except OSError:
        return None, None
    warning = None
    if mode & 0o077:
        warning = "~/.pi/hindsight.key is readable by other users: chmod 600 ~/.pi/hindsight.key"
    return key or None, warning


def pi_argv(config, env):
    """The command starting Pi, resolved to an absolute path, or None when Pi is missing."""
    command = list(config["pi_command"])
    exe = os.environ.get("PI_BIN") or shutil.which(command[0], path=env.get("PATH"))
    return [exe, *command[1:]] if exe else None


def sandbox_wanted(config):
    """The sandbox setting, which PI_PICKER_SANDBOX=0 turns off (the tests use it)."""
    return config["sandbox"] and os.environ.get("PI_PICKER_SANDBOX", "1") != "0"


def top_of(path, home):
    """The directory right under home that contains path: ~/.nvm for ~/.nvm/v22/bin/node.
    Under ~/.local, ~/.config or ~/.cache one level more (~/.local/bin, ~/.local/lib):
    those hold the picker's own state and other programs' settings."""
    parts = os.path.relpath(path, home).split(os.sep)
    depth = 2 if parts[0] in (".local", ".config", ".cache") and len(parts) > 1 else 1
    return os.path.join(home, *parts[:depth])


# Folders Pi never gets read-write, even when asked to run there: they hold keys, the
# picker, its state and settings. Their parents (home itself) are refused too.
SANDBOX_REFUSED = ("~/.ssh", "~/.gnupg", "~/.config", "~/.local", "~/bin", "~/.pi")


def pi_refusal(project, home, config=None):
    """Why Pi cannot be started in project with the current settings, or None."""
    config = config or load_config(home)[0]
    return sandbox_refusal(project, home) if sandbox_wanted(config) else None


def openable(path, home, config=None):
    """A folder that can be offered as a project: Pi may run there."""
    return pi_refusal(path, home, config) is None


def sandbox_refusal(project, home):
    """Why Pi must not run sandboxed with project read-write, or None."""
    real = os.path.realpath(project)
    for path in SANDBOX_REFUSED:
        guarded = os.path.realpath(os.path.join(home, path[2:]))
        if within(guarded, real) or within(real, guarded):
            return (f"Pi cannot run in {pretty_path(real, home)}: its sandbox would give it "
                    f"{pretty_path(guarded, home)}. Choose a project folder.")
    return None


def sandbox_argv(argv, project, home, config, env):
    """argv wrapped in bubblewrap, or None when bwrap is missing.

    Inside, Pi sees the whole system read-only, and of the home directory only:
      - the project, read-write (shared folders are mounted inside it, in .pi-shared);
      - ~/.pi, read-write: Pi's own sessions, settings and credentials;
      - the directories Pi and node run from, read-only (npm, nvm or bun installs);
      - ~/.gitconfig and ~/.config/git, read-only, so commits carry your name;
      - what the config adds in sandbox_read and sandbox_write.
    The rest of home (other projects, ~/.ssh, ...) is an empty directory. Pi's
    processes get their own process namespace: they cannot see or signal the
    others. The network stays: Pi has to reach its model.
    """
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    mounts = {}  # path -> "ro" | "rw"; rw wins when listed twice
    for exe in (argv[0], shutil.which("node", path=env.get("PATH"))):
        if not exe:
            continue
        for candidate in (exe, os.path.realpath(exe)):
            if within(candidate, home) and candidate != home:
                mounts.setdefault(top_of(candidate, home), "ro")
    for extra in EXTRA_PATH:
        extra = os.path.expanduser(extra)
        if within(extra, home) and extra != home and os.path.isdir(extra):
            mounts.setdefault(top_of(extra, home), "ro")
    for name in (".gitconfig", ".config/git"):
        mounts.setdefault(os.path.join(home, name), "ro")
    for path in config["sandbox_read"]:
        mounts.setdefault(os.path.realpath(os.path.expanduser(path)), "ro")
    for path in [project, os.path.join(home, ".pi"), *config["sandbox_write"]]:
        mounts[os.path.realpath(os.path.expanduser(path))] = "rw"
    # --dev: a /dev of its own (the user's other terminals, /dev/pts, stay out of
    # reach); /run/user: the user's session bus and systemd would start programs
    # outside the sandbox.
    args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
            "--tmpfs", "/tmp", "--tmpfs", "/home", *RUN_USER_HIDDEN]
    if not within(home, "/home"):
        args += ["--tmpfs", home]
    args += ["--dir", home]
    # Parents before children, so a read-write project inside a read-only folder
    # stays writable.
    for path in sorted(mounts, key=lambda m: (m.count(os.sep), m)):
        if os.path.exists(path):
            args += ["--bind" if mounts[path] == "rw" else "--ro-bind", path, path]
    args += ["--unshare-pid", "--unshare-ipc", "--die-with-parent", "--chdir", project, "--", *argv]
    return args


SANDBOX_MISSING = ("bubblewrap is not installed, and Pi is set to run in a sandbox. "
                   "Install it (sudo apt install bubblewrap), "
                   "or set sandbox = false in ~/.config/pi-dir-picker/config.toml")


def tmux_cmd(*args):
    return ["tmux", "-L", TMUX_SOCKET, *args]


def session_name(path, home):
    """tmux session for Pi in path: readable, and unique through a hash of the full path."""
    rel = os.path.relpath(path, home) if within(path, home) else path
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", rel.replace(os.sep, "_")).strip("-_")[:40] or "home"
    digest = hashlib.sha1(os.fsencode(path)).hexdigest()[:6]
    return f"pi-{slug}-{digest}"


def run_quiet(argv, env=None):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _ignore_signal(signum, frame):
    """Installed in the picker while a child runs. A handler, not SIG_IGN: exec resets
    handlers to the default in the child, whereas an ignored signal stays ignored."""


def ignore_terminal_signals():
    """Install _ignore_signal for Ctrl-C, Ctrl-\\ and Ctrl-Z; returns what to restore."""
    return {sig: signal.signal(sig, _ignore_signal)
            for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP)}


def restore_signals(previous):
    for sig, handler in previous.items():
        signal.signal(sig, handler)


def wait_child(proc):
    """Wait for proc. A child stopped by Ctrl-Z is resumed: under a RemoteCommand there
    is no shell to resume it, the session would hang."""
    while True:
        try:
            _, status = os.waitpid(proc.pid, os.WUNTRACED)
        except ChildProcessError:
            return proc.wait()
        if os.WIFSTOPPED(status):
            os.kill(proc.pid, signal.SIGCONT)
            continue
        proc.returncode = os.waitstatus_to_exitcode(status)
        return proc.returncode


def pause_for_enter(prompt="press Enter to go back to the picker "):
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        sys.stdin.readline()
    except (OSError, ValueError):
        pass


def sync_size():
    """Tell curses about a resize that happened while the child owned the terminal."""
    try:
        size = os.get_terminal_size(sys.__stdout__.fileno())
        curses.resizeterm(size.lines, size.columns)
    except (OSError, ValueError, AttributeError, curses.error):
        pass


def exec_pi(path, extra):
    """Entry point inside a tmux session: run Pi in path with the Hindsight key.

    The key is read here rather than passed on tmux's command line, where any user
    could read it in the process list. A failure at startup holds the pane open so the
    error can be read; otherwise the session would vanish before the attach.
    """
    home = home_dir()
    config, _ = load_config(home)
    env = child_env(home)
    key, _ = read_hindsight_key(home)
    if key:
        env["HINDSIGHT_API_KEY"] = key
    argv = pi_argv(config, env)
    if argv is None:
        print("pi not found on PATH: install it or set PI_BIN")
        log("error", "pi.missing", project=path, path=env.get("PATH"))
        pause_for_enter("press Enter to close ")
        return 1
    pi_exe = argv[0]
    slot = os.environ.get("PI_PICKER_SLOT")
    tracked = []
    if slot and config["track_sessions"]:
        extension = pier_extension()
        if extension:
            tracked = ["--extension", extension]
            env["PIER_STATE"] = pier_state_path(slot)
            try:
                os.remove(env["PIER_STATE"])  # what an earlier Pi of that name said
            except OSError:
                pass
    plain = argv + list(extra)
    argv = argv + tracked + list(extra)
    if sandbox_wanted(config):
        refusal = sandbox_refusal(path, home)
        if refusal:
            print(refusal)
            log("error", "pi.sandbox-refused", project=path)
            pause_for_enter("press Enter to close ")
            return 1
        for key in ("DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"):
            env.pop(key, None)
        # Refuse rather than run unconfined: a sandbox that silently goes away
        # protects nothing.
        argv = sandbox_argv(argv, os.path.realpath(path), home, config, env)
        plain = sandbox_argv(plain, os.path.realpath(path), home, config, env)
        if argv is None:
            print(SANDBOX_MISSING)
            log("error", "pi.sandbox-missing", project=path)
            pause_for_enter("press Enter to close ")
            return 1
    project = os.path.realpath(path)
    watcher = None
    if config["checkpoints"]:
        # Saved before Pi starts, so that whatever it does first can be undone.
        if not os.path.isdir(checkpoint_store(project)):
            print("Pier: saving the project's first restore point (only the first one takes a while)...", flush=True)
        try:
            checkpoint_create(project, "start", "Pi started")
        except Exception as exc:  # noqa: BLE001 - Pi starts anyway, without restore points
            log("warn", "checkpoint.start-failed", project=project, err=str(exc))
            print(f"Pier: no restore point for this session ({exc})")
        file = extra[extra.index("--session") + 1] if "--session" in extra[:-1] else None
        watcher = PromptWatcher(project, file, os.environ.get("PI_PICKER_SLOT"))
        watcher.start()
    log("info", "pi.start", project=project, sandbox=sandbox_wanted(config), args=list(extra), pi=pi_exe)
    previous = ignore_terminal_signals()
    started = time.monotonic()
    try:
        status = wait_child(subprocess.Popen(argv, cwd=path, env=env))
        if status and tracked and time.monotonic() - started < 2:
            # Likely a Pi too old for --extension: once more without it.
            log("warn", "pi.without-extension", project=project, status=status)
            env.pop("PIER_STATE", None)
            status = wait_child(subprocess.Popen(plain, cwd=path, env=env))
    except OSError as exc:
        print(f"cannot run pi: {exc.strerror or exc}")
        log("error", "pi.cannot-run", project=project, err=str(exc))
        status = 1
    if watcher:
        watcher.stop()
    if env.get("PIER_STATE"):
        try:
            os.remove(env["PIER_STATE"])
        except OSError:
            pass
    seconds = round(time.monotonic() - started, 1)
    log("warn" if status else "info", "pi.exit", project=project, status=status, seconds=seconds)
    if status and seconds < 3:
        print(f"pi exited with status {status}")
        pause_for_enter("press Enter to close ")
    restore_signals(previous)
    return status if isinstance(status, int) and status >= 0 else 1


# --- tmux sessions -------------------------------------------------------------------------

def add_recent(state, path):
    recent = [p for p in state["recent"] if p != path]
    state["recent"] = [path] + recent[:RECENT_KEPT - 1]


_PI_SESSIONS = [0.0, None]  # (when, answer): the watch asks for several parts in one go
PI_SESSIONS_FRESH = 0.5


def forget_pi_sessions():
    """After starting, stopping or relabelling a Pi: the next pi_sessions asks tmux."""
    _PI_SESSIONS[1] = None


def pi_sessions():
    """The tmux sessions holding a Pi, by name: {"name", "path", "attached",
    "last_attached", "file", "working"}. "file" is the session file of that Pi, when
    known (see PIER_EXTENSION, PromptWatcher): a project can run several Pis, each in
    its own conversation. Asked to tmux at most every half second.

    Empty when tmux is missing or runs no session.
    """
    now = time.monotonic()
    if _PI_SESSIONS[1] is None or now - _PI_SESSIONS[0] >= PI_SESSIONS_FRESH:
        _PI_SESSIONS[0], _PI_SESSIONS[1] = now, read_pi_sessions()
    sessions = {}
    for name, info in _PI_SESSIONS[1].items():
        said = pier_state(name)  # what Pi says, read every time: small files, and it moves
        sessions[name] = dict(info, file=(said and said["file"]) or info["file"],
                              working=said["working"] if said else None)
    return sessions


def read_pi_sessions():
    if not shutil.which("tmux"):
        return {}
    fmt = "#{session_name}\t#{session_attached}\t#{session_last_attached}\t#{@pi-file}\t#{session_path}"
    try:
        result = subprocess.run(tmux_cmd("list-sessions", "-F", fmt), stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, errors="surrogateescape", timeout=2)
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    sessions = {}
    for line in result.stdout.splitlines():
        parts = line.split("\t", 4)
        if len(parts) != 5:
            continue
        name, attached, last, file, path = parts
        sessions[name] = {
            "name": name,
            "path": path,
            "attached": attached not in ("", "0"),
            "last_attached": int(last) if last.isdigit() else 0,
            "file": file or None,  # what tmux recorded; what Pi says wins (see pi_sessions)
        }
    return sessions


def project_pis(sessions, project):
    """The Pis running in project, the one used last first."""
    pis = [s for s in sessions.values() if s["path"] == project]
    pis.sort(key=lambda s: (s["attached"], s["last_attached"]), reverse=True)
    return pis


def slot_number(name, project, home):
    """1 for the first Pi of a project (its tmux session is session_name), n for "name-n"."""
    base = session_name(project, home)
    rest = name[len(base) + 1:] if name.startswith(base + "-") else ""
    return int(rest) if rest.isdigit() else 1


def free_slot(project, home, sessions):
    base = session_name(project, home)
    if base not in sessions:
        return base
    n = 2
    while f"{base}-{n}" in sessions:
        n += 1
    return f"{base}-{n}"


def new_session_file(project):
    """A path for a new conversation, named the way Pi names its own. Pi creates the
    file there (at its first answer) when given --session with a path that does not
    exist: so the picker knows which file each Pi writes."""
    folder = session_dir(project)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime(now)) + f"-{int(now % 1 * 1000):03d}Z"
    return os.path.join(folder, f"{stamp}_{uuid.uuid4()}.jsonl")


def session_file_in(project, file):
    """file, checked to be a conversation of project (existing or not)."""
    full = os.path.realpath(file)
    if os.path.dirname(full) != os.path.realpath(session_dir(project)) or not full.endswith(".jsonl"):
        raise ApiError(f"not a Pi session of this project: {file}")
    return full


def pi_file(pi, project, count):
    """The session file of a running Pi: known, else (a lone Pi) the newest one."""
    if pi.get("file"):
        return pi["file"]
    return latest_session_file(project) if count == 1 else None


def pi_infos(project, home, pis):
    infos = []
    for pi in pis:
        file = pi_file(pi, project, len(pis))
        working = pi.get("working")
        infos.append({"slot": pi["name"], "n": slot_number(pi["name"], project, home), "file": file,
                      "attached": pi["attached"], "last_attached": pi["last_attached"],
                      "working": working if working is not None else bool(file) and session_working(file)})
    return infos


def open_pi(project, extra, env, home, width, height):
    """(tmux session, started): the Pi of project that extra asks for.

      []                  the Pi used last there, or a new one
      ["--new"]           a new Pi, in a new conversation
      ["--slot", NAME]    that running Pi
      ["--continue"]      the latest conversation: its Pi if one runs it, else a new Pi on it
      ["--session", FILE] the same for that conversation
      anything else       a new Pi with those arguments (--resume...)
    """
    refusal = pi_refusal(project, home)
    if refusal:
        # Said now, before tmux: started, Pi would only print it in a pane nobody sees.
        raise ApiError(refusal)
    sessions = pi_sessions()
    pis = project_pis(sessions, project)
    extra = list(extra)
    if not extra and pis:
        return pis[0]["name"], False
    if extra[:1] == ["--slot"]:
        names = [p["name"] for p in pis]
        if len(extra) != 2 or extra[1] not in names:
            raise ApiError("that Pi is not running any more")
        return extra[1], False
    if not extra or extra == ["--new"]:
        extra = ["--session", new_session_file(project)]
    elif extra == ["--continue"]:
        latest = latest_session_file(project)
        extra = ["--session", latest or new_session_file(project)]
    if extra[:1] == ["--session"]:
        if len(extra) != 2:
            raise ApiError("--session takes one session file")
        extra = ["--session", session_file_in(project, extra[1])]
        for pi in pis:
            if pi_file(pi, project, len(pis)) == extra[1]:
                return pi["name"], False
    for _ in range(4):
        name = free_slot(project, home, sessions)
        if start_pi_session(project, extra, env, home, width, height, name):
            return name, True
        # Another call took that name meanwhile: look again.
        forget_pi_sessions()
        sessions = pi_sessions()
    raise ApiError("tmux could not start the session")


def api_stop(home, path, slot):
    """Stop the Pis of a project, or one of them. Their conversations stay saved."""
    project = resolve_inside(home, path)
    pis = [p for p in project_pis(pi_sessions(), project) if not slot or p["name"] == slot]
    if not pis:
        raise ApiError("no Pi runs there")
    for pi in pis:
        run_quiet(tmux_cmd("kill-session", "-t", f"={pi['name']}"))
        forget_pi_sessions()
    return {"project": project, "stopped": len(pis)}


def start_pi_session(path, extra, env, home, width, height, name=None):
    """A detached tmux session running Pi in path, styled to stay discreet. False on failure.
    PI_PICKER_SLOT tells --exec-pi its session name, to record its conversation there."""
    name = name or session_name(path, home)
    command = [sys.executable, SCRIPT, "--exec-pi", path, *extra]
    # -f: a server started here reads Pier's config, not ~/.tmux.conf (see tmux_conf).
    conf = write_tmux_conf(load_config(home)[0])
    if not run_quiet(tmux_cmd("-f", conf, "new-session", "-d", "-s", name, "-c", path, "-e", f"PI_PICKER_SLOT={name}",
                              "-x", str(width), "-y", str(height), *command), env):
        log("error", "tmux.new-session-failed", project=path, session=name)
        return False
    log("info", "tmux.new-session", project=path, session=name, size=f"{width}x{height}")
    forget_pi_sessions()
    tmux_server_options(env, load_config(home)[0])
    label = pretty_path(path, home).replace("#", "##")
    n = slot_number(name, path, home)
    if n > 1:
        label += f"  #{n}".replace("#", "##")
    config, _ = load_config(home)
    if sandbox_wanted(config):
        label += "  [sandbox]"
    # The rest of the bar's look is global, in tmux_conf: only the project is per session.
    run_quiet(tmux_cmd("set-option", "-t", f"={name}", "status-left", f" pi  {label} "), env)
    if extra[:1] == ["--session"] and len(extra) == 2:
        set_pi_file(name, extra[1])
    return True


def tmux_conf(config):
    """The config of this tmux server, which only runs Pi sessions. It is the server's
    own: a server started by the picker reads it instead of ~/.tmux.conf (whose bindings,
    colours or messages would surprise), and it is read again at every attach, so that
    a server started earlier gets it too.

    Pier does not go through tmux's screen: its Pi tabs use control mode (see
    attach_control), and scroll, select and copy in Pier itself. This config is for
    the other way in, a plain `ssh` with the picker in a terminal:
    - extended keys: without them tmux turns Shift+Enter and Ctrl+Enter into Enter, and
      Pi warns about it. csi-u needs tmux 3.5; older ones keep their default quietly.
    - mouse: the wheel scrolls back through Pi's history (kept by tmux), a drag selects
      and copies.
    - set-clipboard: what is copied in tmux, or by Pi, reaches the terminal's clipboard
      (OSC 52).
    - colours: only the terminal's 16, never fixed ones. The bar is the palette's grey
      on no background: it follows the terminal's theme.
    """
    lines = [
        "# Written by pi-dir-picker for the tmux server of Pi's sessions (see tmux_conf there).",
        "# Rewritten at each start. ~/.tmux.conf is not read by this server.",
        "set -s extended-keys on",
        "set -sq extended-keys-format csi-u",
        "set -s set-clipboard on",
        "set -s escape-time 10",
        "set -su terminal-overrides[90]",
        "set -g mouse on",
        "set -g history-limit 20000",
        "",
        "# Colours from the terminal's palette: the bar follows its theme.",
        'set -g status-style "bg=default,fg=brightblack"',
        'set -g message-style "bg=default,fg=yellow"',
        'set -g message-command-style "bg=default,fg=yellow"',
        'set -g mode-style "bg=brightblack,fg=default"',
        'set -gq copy-mode-position-style "bg=default,fg=brightblack"',
        'set -g status-left-length 80',
        'set -g status-right " ctrl-b d: detach, pi keeps running "',
        "set -g status-right-length 60",
        'set -g window-status-format ""',
        'set -g window-status-current-format ""',
        "",
    ]
    return "\n".join(lines)


def write_tmux_conf(config):
    """The config file, written when it changed; its path."""
    conf = os.path.join(os.path.dirname(state_path(home_dir())), "tmux.conf")
    text = tmux_conf(config)
    try:
        with open(conf, encoding="utf-8") as handle:
            if handle.read() == text:
                return conf
    except OSError:
        pass
    os.makedirs(os.path.dirname(conf), mode=0o700, exist_ok=True)
    with open(conf, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return conf


def tmux_server_options(env, config):
    """Applies tmux_conf to the running server, and resets the look older pickers set
    per session, so that every session follows it."""
    conf = write_tmux_conf(config)
    run_quiet(tmux_cmd("source-file", "-q", conf), env)
    for name in pi_sessions():
        for option in ("status-style", "status-right", "status-right-length", "window-status-format",
                       "window-status-current-format", "status-left-length"):
            run_quiet(tmux_cmd("set-option", "-u", "-t", f"={name}", option), env)


def set_pi_file(slot, file):
    """Record in tmux which conversation the Pi of a session writes."""
    run_quiet(tmux_cmd("set-option", "-t", f"={slot}", "@pi-file", file))
    forget_pi_sessions()


# --- what each Pi says about itself -------------------------------------------------------
#
# Pi switches conversations by itself (/new, /resume, /fork), and the file of a new one
# only appears at its first answer: from outside, which conversation a Pi holds can only
# be guessed. So the Pis started here get a small extension (--extension, nothing is
# installed in Pi's settings) that writes, at every change, which conversation it holds
# and whether it works, to ~/.pi/pier/pis/<tmux session>.json. ~/.pi because the sandbox
# lets Pi write there and nowhere else outside the project.

PIER_EXTENSION = """// Written by Pier (pi-dir-picker): tells Pier which conversation this Pi holds and
// whether it is working. Loaded with --extension by the picker only; it writes one small
// file, PIER_STATE, and nothing else.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default function (pi: any) {
  const target = process.env.PIER_STATE;
  if (!target) return;
  let file: string | null = null;
  let working = false;
  const write = () => {
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ file, working, pid: process.pid, at: Date.now() / 1000 }));
      renameSync(tmp, target);
    } catch {
      // Pier falls back to guessing
    }
  };
  pi.on("session_start", async (_event: any, ctx: any) => {
    file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    working = false;
    write();
  });
  pi.on("agent_start", async () => { working = true; write(); });
  pi.on("agent_end", async () => { working = false; write(); });
  pi.on("agent_settled", async () => { working = false; write(); });
  pi.on("session_shutdown", async () => { working = false; write(); });
}
"""


def pier_dir():
    return os.path.join(home_dir(), ".pi", "pier")


def pier_state_path(slot):
    return os.path.join(pier_dir(), "pis", f"{slot}.json")


def pier_extension():
    """The extension's file, written when missing or different; None when it cannot be."""
    path = os.path.join(pier_dir(), "pier-session.ts")
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if read_text(path) == PIER_EXTENSION and not os.path.islink(path):
            return path
        atomic_write(path, PIER_EXTENSION, os.path.join(home_dir(), ".pi"), 0o644)
        return path
    except (OSError, ApiError) as exc:
        log("warn", "pier.extension-failed", err=str(exc))
        return None


def pier_state(slot):
    """What the Pi of a tmux session last said: {"file", "working"}, or None (no word
    from it: an older Pi, or one started before Pier gave the extension)."""
    try:
        with open(pier_state_path(slot), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    file = data.get("file") if isinstance(data.get("file"), str) else None
    if file and not said_file_ok(file):
        file = None
    return {"file": file, "working": bool(data.get("working"))}


def said_file_ok(file):
    """A path Pi wrote in its state file: a .jsonl in Pi's sessions folder, no control
    characters (it goes to tmux and to the lists), a regular file when it exists."""
    if len(file) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in file) or not file.endswith(".jsonl"):
        return False
    real = os.path.realpath(file)
    if not within(real, os.path.realpath(os.path.join(agent_dir(), "sessions"))):
        return False
    return not os.path.lexists(real) or os.path.isfile(real)


# --- restore points ----------------------------------------------------------------------
#
# The project is saved when Pi starts, when it is given a prompt, and when it stops
# working: a restore point. Going back to one puts every file as it was then, files
# created since included (they are removed), or only the files chosen.
#
# They live outside the project, in a git repository of their own per project under
# ~/.local/state/pi-dir-picker/checkpoints. The project's own git, if any, is never
# touched, and Pi cannot reach them: its sandbox hides that folder. git stores each
# version of a file once, so a restore point costs only what changed. That repository
# reads no configuration but its own: no hook, filter or fsmonitor of yours runs.
#
# Saved is what git would see: files your .gitignore leaves out (build output,
# node_modules, .env) are not, nor what Pier gave the project (.pi-images, .pi-files,
# .pi-shared), nor any file over 50 MB.
#
# When a prompt arrives, Pi has written it to its session file before asking its model,
# which leaves the second or more the model takes to save. The first prompt of a new
# session is the exception: Pi creates the file with its first answer, as its tools
# start. That prompt is attached to the point saved just before (when Pi started, or
# finished its previous work), which holds the files as they were.

CHECKPOINT_DIR = "checkpoints"
CHECKPOINT_KEEP = 50
CHECKPOINT_FILE_MAX = 50 * 1024 * 1024
CHECKPOINT_TOTAL_MAX = 1024 * 1024 * 1024
CHECKPOINT_TIMEOUT = 120
CHECKPOINT_POLL = 0.3
CHECKPOINT_GC_EVERY = 25
CHECKPOINT_EXCLUDE = ("/.pi-images/", "/.pi-files/", "/.pi-shared/", "/.pi/devbox-history/",
                      "node_modules/", "__pycache__/", ".venv/", ".mypy_cache/", ".pytest_cache/")
# Points that only mark time passing: one with the same files as the point before it
# replaces it, so that every point in the list is a different state.
CHECKPOINT_MERGEABLE = ("start", "prompt", "idle")
CHECKPOINT_LABELS = {"start": "Pi started", "idle": "Pi finished working", "manual": "saved by you"}


def checkpoint_store(project):
    base = os.path.join(os.path.dirname(state_path(home_dir())), CHECKPOINT_DIR)
    return os.path.join(base, session_name(project, home_dir()) + ".git")


def checkpoint_env(project):
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_DIR=checkpoint_store(project), GIT_WORK_TREE=project,
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C",
               GIT_AUTHOR_NAME="devbox", GIT_AUTHOR_EMAIL="devbox@localhost",
               GIT_COMMITTER_NAME="devbox", GIT_COMMITTER_EMAIL="devbox@localhost")
    return env


def remove_inside(project, rel):
    """Remove project/rel, walking down folder by folder without following links: a
    folder swapped for a link meanwhile stops it. True when removed or already gone."""
    parts = [p for p in rel.split("/") if p]
    if not parts or any(p in (".", "..") for p in parts):
        return False
    if os.unlink not in os.supports_dir_fd:  # not Linux: the plain way
        try:
            os.remove(os.path.join(project, *parts))
        except FileNotFoundError:
            pass
        except OSError:
            return False
        return True
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(project, flags)
    try:
        for part in parts[:-1]:
            try:
                nxt = os.open(part, flags, dir_fd=fd)
            except FileNotFoundError:
                return True
            except OSError:
                return False  # a link, or not a folder
            os.close(fd)
            fd = nxt
        try:
            os.unlink(parts[-1], dir_fd=fd)
        except FileNotFoundError:
            pass
        except OSError:
            return False
        return True
    finally:
        os.close(fd)


def checkpoint_git(project, *args, stdin=None, unreadable_ok=False):
    """stdout of git on the project's restore points; ApiError when it fails.
    unreadable_ok: `add --ignore-errors` exits 1 when some file could not be read (a
    root-owned one): those are skipped, the rest is saved."""
    argv = ["git", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false",
            "-c", f"core.hooksPath={os.devnull}", "-c", "gc.auto=0", "-c", "core.quotepath=false",
            "-c", "core.untrackedCache=false", "-c", "core.longpaths=true", *args]
    try:
        result = subprocess.run(argv, cwd=project, input=stdin if stdin is not None else b"",
                                capture_output=True, env=checkpoint_env(project), timeout=CHECKPOINT_TIMEOUT)
    except FileNotFoundError:
        raise ApiError("git is missing on the VM: restore points need it (sudo apt install git)")
    except subprocess.TimeoutExpired:
        raise ApiError(f"git {args[0]} took more than {CHECKPOINT_TIMEOUT} s: the project is too big for restore points")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        if unreadable_ok and result.returncode == 1 and all(
                l.startswith(("error: open(", "error: unable to index", "warning:", "fatal: adding files failed"))
                for l in detail):
            log("warn", "checkpoint.unreadable", project=project, files=len([l for l in detail if l.startswith("error:")]))
            return result.stdout
        raise ApiError(f"git {args[0]} failed: {detail[-1] if detail else result.returncode}")
    return result.stdout


class CheckpointLock:
    """One operation at a time on a project's restore points: Pi's watcher saving one
    while Pier lists or restores would collide on git's index."""

    def __init__(self, project):
        self.path = checkpoint_store(project) + ".lock"
        self.fd = None

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        if fcntl:
            deadline = time.monotonic() + CHECKPOINT_TIMEOUT
            while True:
                try:
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError:
                    if time.monotonic() > deadline:
                        os.close(self.fd)
                        raise ApiError("the restore points of this project are busy: try again")
                    time.sleep(0.1)
        return self

    def __exit__(self, *exc):
        os.close(self.fd)


def checkpoint_init(project):
    store = checkpoint_store(project)
    if not os.path.isfile(os.path.join(store, "HEAD")):
        os.makedirs(store, mode=0o700, exist_ok=True)
        checkpoint_git(project, "init", "-q")
        log("info", "checkpoint.init", project=project, store=store)
    # A lock left by a git that was killed would block every later point.
    lock = os.path.join(store, "index.lock")
    try:
        if time.time() - os.stat(lock).st_mtime > 600:
            os.remove(lock)
            log("warn", "checkpoint.stale-lock", project=project)
    except OSError:
        pass
    os.makedirs(os.path.join(store, "info"), exist_ok=True)
    with open(os.path.join(store, "info", "exclude"), "w", encoding="utf-8") as handle:
        handle.write("# written by pi-dir-picker: never saved in restore points\n")
        handle.write("".join(f"{pattern}\n" for pattern in CHECKPOINT_EXCLUDE))


def checkpoint_snapshot(project):
    """(tree, skipped): the project's files now, as a git tree, and the files too big
    to be saved. The private index is left matching it."""
    checkpoint_init(project)
    listed = checkpoint_git(project, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    names = [n for n in listed.split(b"\0") if n]
    big, total = [], 0
    root = os.fsencode(project)
    for name in names:
        try:
            st = os.lstat(os.path.join(root, name))
        except OSError:
            continue
        if stat_regular(st) and st.st_size > CHECKPOINT_FILE_MAX:
            big.append(name)
        else:
            total += st.st_size
    if total > CHECKPOINT_TOTAL_MAX:
        raise ApiError(f"the project holds {total // 2**20} MB of files git would track, more than the "
                       f"{CHECKPOINT_TOTAL_MAX // 2**20} MB restore points are made for: ignore the big ones in .gitignore")
    if names:
        if big:  # a file grown past the limit: out of the index, not kept at its old size
            checkpoint_git(project, "rm", "--cached", "--ignore-unmatch", "-q", "--pathspec-from-file=-",
                           "--pathspec-file-nul", stdin=b"".join(b":(literal)" + name + b"\0" for name in big))
        spec = b".\0" + b"".join(b":(exclude,literal)" + name + b"\0" for name in big)
        checkpoint_git(project, "add", "-A", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul",
                       stdin=spec, unreadable_ok=True)
    else:
        checkpoint_git(project, "read-tree", "--empty")
    tree = checkpoint_git(project, "write-tree").decode().strip()
    return tree, [n.decode("utf-8", "replace") for n in big]


def stat_regular(st):
    return (st.st_mode & 0o170000) == 0o100000


def checkpoint_list(project):
    """Restore points, newest first."""
    if not os.path.isfile(os.path.join(checkpoint_store(project), "HEAD")):
        return []
    out = checkpoint_git(project, "for-each-ref", "--sort=-refname",
                         "--format=%(refname)%00%(objectname)%00%(tree)%00%(contents:subject)", "refs/devbox/")
    points = []
    for row in out.decode("utf-8", "replace").splitlines():
        fields = row.split("\0")
        if len(fields) != 4:
            continue
        ref, commit, tree, subject = fields
        ident = ref.rsplit("/", 1)[-1]
        try:
            meta = json.loads(subject)
        except ValueError:
            meta = {}
        if not isinstance(meta, dict) or not ident.isdigit():
            continue
        points.append({"id": ident, "at": int(ident) / 1e9, "ref": ref, "commit": commit, "tree": tree,
                       "reason": meta.get("reason", "manual"), "label": meta.get("label", ""),
                       "prompts": [p for p in meta.get("prompts", []) if isinstance(p, str)],
                       "session": meta.get("session"), "skipped": meta.get("skipped", 0)})
    return points


def checkpoint_commit(project, tree, meta):
    message = json.dumps(meta, ensure_ascii=False).encode("utf-8") + b"\n"
    commit = checkpoint_git(project, "commit-tree", tree, stdin=message).decode().strip()
    ident = f"{time.time_ns():020d}"
    checkpoint_git(project, "update-ref", f"refs/devbox/{ident}", commit)
    return ident


def checkpoint_create(project, reason, label="", session=None, keep=None):
    """Save the project now. A point of the same files as the latest one, when both only
    mark time (start, prompt, idle), replaces it and takes over its prompts."""
    started = time.monotonic()
    with CheckpointLock(project):
        tree, skipped = checkpoint_snapshot(project)
        points = checkpoint_list(project)
        latest = points[0] if points else None
        prompts = [label] if reason == "prompt" and label else []
        replaced = None
        if latest and latest["tree"] == tree and reason in CHECKPOINT_MERGEABLE and latest["reason"] in CHECKPOINT_MERGEABLE:
            replaced = latest
            prompts = (prompts + latest["prompts"])[:20]
            if reason == "idle" and latest["reason"] == "prompt":
                # Nothing changed during that prompt: the point keeps saying "before it".
                reason, label = latest["reason"], latest["label"]
        meta = {"reason": reason, "label": (label or CHECKPOINT_LABELS.get(reason, ""))[:200],
                "prompts": prompts, "session": session, "skipped": len(skipped)}
        ident = checkpoint_commit(project, tree, meta)
        doomed = ([replaced] if replaced else []) + points[CHECKPOINT_KEEP - (0 if replaced else 1):]
        doomed = [p for p in doomed if p and p["ref"] != keep]
        if doomed:
            checkpoint_git(project, "update-ref", "--stdin",
                           stdin="".join(f"delete {p['ref']}\n" for p in doomed if p).encode())
            if not keep:  # a restore needs its point's files: no pruning now
                checkpoint_gc(project, len(doomed))
    log("info", "checkpoint.create", project=project, id=ident, reason=reason, replaced=bool(replaced),
        skipped=len(skipped) or None, ms=int((time.monotonic() - started) * 1000))
    return {"id": ident, "tree": tree, "reason": reason, "skipped": skipped}


def checkpoint_relabel(project, label, session=None):
    """Attach a prompt to the latest point, when it came in too late for its own (see above)."""
    with CheckpointLock(project):
        points = checkpoint_list(project)
        if not points or points[0]["reason"] not in CHECKPOINT_MERGEABLE:
            return None
        latest = points[0]
        meta = {"reason": "prompt", "label": label[:200], "prompts": ([label] + latest["prompts"])[:20],
                "session": session or latest["session"], "skipped": latest["skipped"]}
        ident = checkpoint_commit(project, latest["tree"], meta)
        checkpoint_git(project, "update-ref", "-d", latest["ref"])
    log("info", "checkpoint.relabel", project=project, id=ident)
    return ident


def checkpoint_gc(project, deleted):
    """Drop the files only old points held, every CHECKPOINT_GC_EVERY deletions."""
    counter = os.path.join(checkpoint_store(project), "devbox-deleted")
    try:
        with open(counter, encoding="utf-8") as handle:
            count = int(handle.read().strip() or 0)
    except (OSError, ValueError):
        count = 0
    count += deleted
    if count >= CHECKPOINT_GC_EVERY:
        count = 0
        try:
            checkpoint_git(project, "gc", "--prune=now", "--quiet")
            log("info", "checkpoint.gc", project=project)
        except ApiError as exc:  # the point itself is made: only the cleanup waits
            log("warn", "checkpoint.gc-failed", project=project, err=str(exc))
    with open(counter, "w", encoding="utf-8") as handle:
        handle.write(str(count))


def checkpoint_changes(project, old_tree, new_tree):
    """[{"path", "change"}]: what is different now from a point. "created" exists now and
    did not then, "deleted" is the other way round."""
    out = checkpoint_git(project, "diff-tree", "-r", "-z", "--no-renames", "--name-status", old_tree, new_tree)
    fields = out.split(b"\0")
    changes = []
    for status, name in zip(fields[0::2], fields[1::2]):
        if not status:
            continue
        kind = {"A": "created", "D": "deleted"}.get(status[:1].decode(), "modified")
        changes.append({"path": name.decode("utf-8", "surrogateescape"), "change": kind})
    return changes


def checkpoint_point(project, ident):
    if not re.fullmatch(r"\d{1,20}", ident or ""):
        raise ApiError(f"not a restore point: {ident}")
    for point in checkpoint_list(project):
        if point["id"] == ident:
            return point
    raise ApiError("this restore point no longer exists (only the last 50 are kept)")


def prompt_text(raw):
    """The text of a user message of Pi's session, on one line, without images."""
    try:
        message = json.loads(raw).get("message") or {}
    except (ValueError, AttributeError):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
        if not text.strip() and any(isinstance(b, dict) and b.get("type") == "image" for b in content):
            text = "(an image)"
    else:
        text = ""
    return " ".join(text.split())[:200]


class PromptWatcher(threading.Thread):
    """Runs beside Pi (in --exec-pi): a restore point for each prompt it is given, and
    one when it stops working. Reads only what Pi appends to its session file.

    With several Pis in a project, each watcher follows its own Pi's conversation: the
    file given with --session, or, when Pi switches (/new, /resume) or was not given
    one, the newest file of the project that no other running Pi holds. It records that
    file in tmux (@pi-file), where Pier reads which Pi writes what."""

    def __init__(self, project, file=None, slot=None):
        super().__init__(daemon=True)
        self.project = project
        self.file = file
        self.slot = slot
        self.started = time.time()
        self.next_claim = 0.0
        self.halt = threading.Event()
        self.offsets = {}
        folder = session_dir(project)
        try:
            for name in os.listdir(folder):
                if name.endswith(".jsonl"):
                    full = os.path.join(folder, name)
                    self.offsets[full] = os.path.getsize(full)
        except OSError:
            pass
        self.working = False

    def stop(self):
        self.halt.set()
        self.join(timeout=CHECKPOINT_TIMEOUT)

    def run(self):
        while not self.halt.wait(CHECKPOINT_POLL):
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - Pi keeps working without the next point
                log("warn", "checkpoint.watch-failed", project=self.project, err=f"{type(exc).__name__}: {exc}",
                    trace=traceback.format_exc())
                self.halt.wait(5)

    def own_file(self):
        if not self.slot:
            return latest_session_file(self.project)
        said = pier_state(self.slot)
        if said and said["file"]:
            if said["file"] != self.file:
                log("info", "pi.session-file", project=self.project, slot=self.slot, file=said["file"],
                    previous=self.file, said=True)
                self.file = said["file"]
                set_pi_file(self.slot, self.file)
            return self.file if os.path.exists(self.file) else None
        now = time.monotonic()
        if now < self.next_claim:
            return self.file
        self.next_claim = now + 2
        others = {p["file"] for p in project_pis(pi_sessions(), self.project) if p["name"] != self.slot}
        folder = session_dir(self.project)
        try:
            names = [os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".jsonl")]
        except OSError:
            names = []
        fresh = [f for f in names if f != self.file and f not in others and os.path.getmtime(f) >= self.started]
        newest = max(fresh, key=os.path.getmtime, default=None)
        mine = os.path.getmtime(self.file) if self.file and os.path.exists(self.file) else 0
        if newest and os.path.getmtime(newest) > mine:
            log("info", "pi.session-file", project=self.project, slot=self.slot, file=newest, previous=self.file)
            self.file = newest
            set_pi_file(self.slot, newest)
        return self.file if self.file and os.path.exists(self.file) else None

    def tick(self):
        session = self.own_file()
        if session is None:
            return
        size = os.path.getsize(session)
        start = self.offsets.get(session, 0)  # a file that appeared since Pi started: all of it is new
        if size < start:
            start = 0
        if size == start:
            return
        with open(session, "rb") as handle:
            handle.seek(start)
            chunk = handle.read(size - start)
        end = chunk.rfind(b"\n")
        if end < 0:
            return  # a line still being written
        self.offsets[session] = start + end + 1
        lines = chunk[:end].split(b"\n")
        for i, raw in enumerate(lines):
            if b'"role":"user"' not in raw:
                continue
            label = prompt_text(raw) or "(a message)"
            answered = any(b'"role":"assistant"' in later for later in lines[i + 1:])
            name = os.path.basename(session)
            if answered:
                checkpoint_relabel(self.project, label, name)
            else:
                checkpoint_create(self.project, "prompt", label, name)
            break  # the state before the first of them is what matters
        working = session_working(session)
        if self.working and not working:
            checkpoint_create(self.project, "idle", session=os.path.basename(session))
        self.working = working


def api_checkpoints(home, path, config):
    project = resolve_inside(home, path)
    points = checkpoint_list(project) if shutil.which("git") else []
    for point in points:
        point.pop("ref")
        point.pop("commit")
    return {"project": project, "label": pretty_path(project, home), "enabled": bool(config["checkpoints"]),
            "git": bool(shutil.which("git")), "points": points, "keep": CHECKPOINT_KEEP}


def api_checkpoint(home, path, label):
    project = resolve_inside(home, path)
    made = checkpoint_create(project, "manual", label.strip()[:200] or CHECKPOINT_LABELS["manual"])
    return {"project": project, "id": made["id"], "skipped": made["skipped"]}


def api_checkpoint_diff(home, path, ident, file):
    """What changed since a restore point: the list of files, or one file's diff."""
    project = resolve_inside(home, path)
    with CheckpointLock(project):
        point = checkpoint_point(project, ident)
        now, _ = checkpoint_snapshot(project)
        changes = checkpoint_changes(project, point["tree"], now)
        diff = None
        if file:
            rel = file.replace(os.sep, "/")
            out = checkpoint_git(project, "diff", "--no-color", "--no-ext-diff", "--no-textconv", point["tree"], now,
                                 "--", f":(literal){rel}")
            diff = out[:DIFF_MAX_BYTES].decode("utf-8", "replace")
    return {"project": project, "id": ident, "label": point["label"], "reason": point["reason"], "at": point["at"],
            "changes": changes[:2000], "total": len(changes), "file": file or None, "diff": diff}


def api_restore(home, path, ident, files):
    """Put the project back as it was at a restore point: all of it, or the files named.
    The current state is saved first, as a restore point of its own."""
    project = resolve_inside(home, path)
    point = checkpoint_point(project, ident)
    if any(p["working"] for p in pi_infos(project, home, project_pis(pi_sessions(), project))):
        raise ApiError("Pi is working in this project: wait until it stops (or press Escape in Pi), then restore")
    when = time.strftime("%H:%M", time.localtime(point["at"]))
    safety = checkpoint_create(project, "before-restore", f"before going back to {when}", keep=point["ref"])
    with CheckpointLock(project):
        changes = checkpoint_changes(project, point["tree"], safety["tree"])
        if files:
            wanted = {f.replace(os.sep, "/") for f in files}
            changes = [c for c in changes if c["path"] in wanted]
        removed = []
        for change in changes:
            if change["change"] != "created":
                continue
            full = os.path.join(project, *change["path"].split("/"))
            if not within(os.path.realpath(os.path.dirname(full)), project) or os.path.isdir(full) and not os.path.islink(full):
                continue
            if not remove_inside(project, change["path"]):
                continue
            removed.append(change["path"])
            parent = os.path.dirname(full)
            while parent != project and within(parent, project):
                try:
                    os.rmdir(parent)  # only when empty
                except OSError:
                    break
                parent = os.path.dirname(parent)
        back = [c["path"] for c in changes if c["change"] != "created"]
        if back:
            spec = b"".join(b":(literal)" + os.fsencode(p) + b"\0" for p in back)
            checkpoint_git(project, "checkout", point["commit"], "--pathspec-from-file=-", "--pathspec-file-nul", stdin=spec)
    log("info", "checkpoint.restore", project=project, id=ident, restored=len(back), removed=len(removed),
        only=len(files) or None, safety=safety["id"])
    return {"project": project, "id": ident, "restored": len(back), "removed": len(removed), "safety": safety["id"]}


# --- desktop client API --------------------------------------------------------------------
#
# The desktop client never opens a port: it runs this program over SSH, with the
# user's own SSH setup (keys, bastion), and reads one JSON object on stdout.
#   --api version | projects | ls DIR | shares
#   --api paste-image [DIR]         image bytes on stdin, saved and typed into Pi
#   --api paste-file NAME [DIR]     any file on stdin, saved and typed into Pi
#   --api type TEXT [DIR]           typed into Pi's prompt, never sent
#   --api share-prepare NAME [DIR] | share-stop MOUNT
#   --api activity DIR              what the project's Pi read, modified, is doing now, cost
#   --api diff FILE DIR             git diff of FILE, and the edits Pi made to it
#   --api remove PATH               delete an image, file or folder copy sent earlier
#   --api contexts                  what was given to every project's Pi
#   --api clear DIR                 delete a project's images, files and folder copies
#   --api upload-dir NAME [DIR]     a folder as a tar stream on stdin, copied into .pi-files
#   --api handoff MOUNT ro|rw       Hand off: a live share becomes a copy at the same place
#   --download PATH                 a handed-off or copied folder, as a tar stream on stdout
#   --api setup DIR                 what Pi reads at startup, its texts, sessions, interruption
#   --api write-text DIR WHICH      instructions | append | system, text on stdin, with history
#   --api log [LINES]               the end of this program's log
#   --api checkpoints DIR           the project's restore points
#   --api checkpoint DIR [LABEL]    save one now
#   --api checkpoint-diff DIR ID [FILE]  what changed since a point: the files, or one diff
#   --api restore DIR ID [FILE...]  put the project (or the files) back as it was at a point
#   --api stop DIR [SLOT]           stop the Pis of a project, or one
#   --api watch                     stays open: what changes, as JSON lines; see api_watch
#   --share-serve MOUNT ro|rw       sshfs in passive mode, fed by the client
#   --attach DIR [PI ARGS]          start or join the Pi of DIR, in the client's terminal
#   --attach-control DIR [PI ARGS]  the same in tmux's control mode, for Pier's Pi tabs
# Errors come back as {"api": N, "error": "..."} with exit status 1. API_VERSION
# changes when a reply changes shape, so an old client can tell.

API_VERSION = 11
IMAGE_DIR = ".pi-images"
IMAGE_MAX_BYTES = 20 * 1024 * 1024
FILES_DIR = ".pi-files"
FILE_MAX_BYTES = 50 * 1024 * 1024
SHARE_DIR = ".pi-shared"
LS_LIMIT = 2000


class ApiError(Exception):
    pass


def image_kind(data):
    """File extension for the image formats Pi's models read, or None."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def resolve_inside(home, path):
    """path (absolute, ~/..., or relative to home) as a real directory under home."""
    full = os.path.realpath(os.path.join(home, os.path.expanduser(path))) if path else home
    if not within(full, home) or not os.path.isdir(full):
        raise ApiError(f"not a directory under your home: {path}")
    return full


def project_info(path, home, sessions):
    pis = pi_infos(path, home, project_pis(sessions, path)) if sessions else []
    return {
        "path": path,
        "label": pretty_path(path, home),
        "branch": git_branch(path),
        "running": bool(pis),
        "attached": any(p["attached"] for p in pis),
        # Only for running Pis: the client notices working -> idle and notifies.
        "working": any(p["working"] for p in pis),
        "pis": pis,
    }


def latest_session(sessions, home):
    """The Pi in use: attached right now, else the one attached most recently."""
    candidates = [s for s in sessions.values() if within(s["path"], home)]
    return max(candidates, key=lambda s: (s["attached"], s["last_attached"]), default=None)


def api_version(home, config):
    return {
        "version": VERSION,
        "tmux": bool(shutil.which("tmux")),
        "pi": pi_argv(config, child_env(home)) is not None,
    }


def api_projects(home, config):
    """Recent projects, and the projects where a Pi runs, the one in use first."""
    state = load_state(home)
    sessions = pi_sessions()
    recent = [p for p in state["recent"] if within(p, home) and os.path.isdir(p) and openable(p, home, config)]
    running = []
    for pi in sorted(sessions.values(), key=lambda s: (s["attached"], s["last_attached"]), reverse=True):
        if within(pi["path"], home) and pi["path"] not in running:
            running.append(pi["path"])
    return {
        "home": home,
        "recent": [project_info(p, home, sessions) for p in recent[:max(config["recent_count"], 0)]],
        "running": [project_info(p, home, sessions) for p in running],
    }


def target_project(home, target, sessions):
    """(project, Pi or None): the named project and its Pi used last, else the Pi in use."""
    if target:
        project = resolve_inside(home, target)
        pis = project_pis(sessions, project)
        return project, pis[0] if pis else None
    session = latest_session(sessions, home)
    if session is None:
        raise ApiError("no pi is running: start one, or name the project")
    return session["path"], session


def atomic_write(path, text, root, mode=0o600):
    """Write path (text or bytes) through a fresh temporary file renamed over it. path's
    folder must really be inside root: a folder Pi replaced by a link elsewhere is
    refused. The rename replaces a link at path itself, never what it points to."""
    folder = os.path.dirname(path)
    if not within(os.path.realpath(folder), os.path.realpath(root)):
        raise ApiError(f"refusing to write outside {pretty_path(root, home_dir())}: {os.path.basename(path)}")
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".pier-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(text.encode("utf-8") if isinstance(text, str) else text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def create_new(path, text, mode=0o644):
    """Create path with text if it does not exist; a link there is not followed."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    return True


def safe_folder(project, rel):
    """project/rel created, and checked to be really inside the project (Pi could have
    replaced it with a link to elsewhere)."""
    folder = os.path.join(project, rel)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    if os.path.islink(folder) or not within(os.path.realpath(folder), os.path.realpath(project)):
        raise ApiError(f"{rel} in the project is a link to elsewhere: remove it")
    return folder


def ignored_dir(project, name):
    """project/name, created with its own .gitignore so nothing in it gets committed."""
    folder = safe_folder(project, name)
    create_new(os.path.join(folder, ".gitignore"), "*\n")
    return folder


def type_into_pi(pi, text):
    """Type text into the prompt of a running Pi. Never presses Enter."""
    text = "".join(ch for ch in text if ch.isprintable())
    # send-keys takes a pane: "=name:" is the session's active pane, "=" makes the
    # match exact. Without the colon, tmux reads the target as a window name.
    return run_quiet(tmux_cmd("send-keys", "-t", f"={pi['name']}:", "-l", text))


def save_new(folder, filename, data):
    saved = os.path.join(folder, filename)
    fd = os.open(saved, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    return saved


def stamp():
    return f"{time.strftime('%Y%m%d-%H%M%S')}-{os.urandom(2).hex()}"


def safe_name(name, fallback):
    """A file or folder name from another system, reduced to one harmless segment."""
    base = re.split(r"[\\/]", name)[-1]
    base = re.sub(r"[^\w.-]+", "-", unicodedata.normalize("NFC", base)).strip("-.")
    return base[:100] or fallback


def delivered(project, home, saved, reference, session):
    typed = session is not None and type_into_pi(session, reference + " ")
    return {"saved": saved, "project": project, "label": pretty_path(project, home),
            "reference": reference, "running": session is not None, "typed": typed}


def api_paste_image(home, target, data):
    """Save an image in a project's .pi-images and type its @reference into that
    project's Pi, so it is attached to the next message.

    Without a target, the project is the one whose Pi is in use. The folder holds its
    own .gitignore: pasted screenshots never end up in a commit by accident.
    """
    if len(data) > IMAGE_MAX_BYTES:
        raise ApiError(f"image larger than {IMAGE_MAX_BYTES // (1024 * 1024)} MB")
    kind = image_kind(data)
    if kind is None:
        raise ApiError("not a PNG, JPEG, GIF or WebP image")
    project, session = target_project(home, target, pi_sessions())
    filename = f"{stamp()}.{kind}"
    saved = save_new(ignored_dir(project, IMAGE_DIR), filename, data)
    return delivered(project, home, saved, f"@{IMAGE_DIR}/{filename}", session)


def api_paste_file(home, name, target, data):
    """Any file, saved in the project's .pi-files and referenced in its Pi."""
    if len(data) > FILE_MAX_BYTES:
        raise ApiError(f"file larger than {FILE_MAX_BYTES // (1024 * 1024)} MB")
    project, session = target_project(home, target, pi_sessions())
    filename = f"{stamp()}-{safe_name(name, 'file')}"
    saved = save_new(ignored_dir(project, FILES_DIR), filename, data)
    return delivered(project, home, saved, f"@{FILES_DIR}/{filename}", session)


def api_type(home, text, target, slot=""):
    sessions = pi_sessions()
    project, session = target_project(home, target, sessions)
    if slot:
        session = next((p for p in project_pis(sessions, project) if p["name"] == slot), None)
    if session is None:
        raise ApiError("no pi runs in that project")
    return {"project": project, "label": pretty_path(project, home), "typed": type_into_pi(session, text)}


def json_safe(text):
    """JSON readers reject the lone surrogates that undecodable file names become."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def api_ls(home, path):
    """One directory of a project, files included, for the client's tree. Skips .git."""
    folder = resolve_inside(home, path)
    entries = []
    try:
        it = os.scandir(folder)
    except OSError as exc:
        raise ApiError(f"cannot list {pretty_path(folder, home)}: {exc.strerror}")
    with it:
        for entry in it:
            if entry.name == ".git" or not json_safe(entry.name):
                continue
            try:
                link = entry.is_symlink()
                is_dir = entry.is_dir(follow_symlinks=False)
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            entries.append({"name": entry.name, "path": entry.path,
                            "kind": "link" if link else "dir" if is_dir else "file",
                            "size": info.st_size, "mtime": int(info.st_mtime),
                            "hidden": entry.name.startswith(".")})
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].casefold()))
    truncated = len(entries) > LS_LIMIT
    return {"path": folder, "label": pretty_path(folder, home),
            "entries": entries[:LS_LIMIT], "truncated": truncated}


def mounted_shares(home):
    """sshfs mounts made for sharing, under some project's .pi-shared."""
    shares = []
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return shares
    for line in lines:
        fields = line.split()
        if len(fields) < 3 or fields[2] != "fuse.sshfs":
            continue
        # /proc/mounts escapes spaces and a few others as octal: \040.
        mount = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), fields[1])
        if within(mount, home) and f"/{SHARE_DIR}/" in mount:
            shares.append(mount)
    return shares


def mounted_paths():
    """Every mount point, from /proc/mounts: no stat on them (a dead or stalled FUSE
    mount answers a stat with an error, or not at all)."""
    try:
        with open("/proc/mounts", encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()
    except OSError:
        return set()
    return {re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), line.split()[1]) for line in lines if len(line.split()) > 1}


def is_mounted(path, mounts=None):
    return os.path.realpath(path) in (mounts if mounts is not None else mounted_paths())


def share_mountpoint(home, mount):
    """mount, checked to be a share folder this API created, under home."""
    full = os.path.realpath(mount)
    if not within(full, home) or os.path.basename(os.path.dirname(full)) != SHARE_DIR:
        raise ApiError(f"not a share folder: {mount}")
    return full


def api_shares(home):
    return {"shares": [{"mountpoint": m, "label": pretty_path(m, home)} for m in mounted_shares(home)],
            "sshfs": bool(shutil.which("sshfs"))}


def api_share_prepare(home, name, target):
    """An empty folder in the project's .pi-shared, to mount a shared folder on."""
    project, session = target_project(home, target, pi_sessions())
    if not shutil.which("sshfs"):
        raise ApiError("sshfs is missing on the VM: sudo apt install sshfs")
    shared = ignored_dir(project, SHARE_DIR)
    base = safe_name(name, "share")
    slug, n = base, 1
    mounts = mounted_paths()
    while is_mounted(os.path.join(shared, slug), mounts) or (
            os.path.isdir(os.path.join(shared, slug)) and os.listdir(os.path.join(shared, slug))):
        n += 1
        slug = f"{base}-{n}"
    mount = os.path.join(shared, slug)
    os.makedirs(mount, mode=0o700, exist_ok=True)
    return {"mountpoint": mount, "relative": f"{SHARE_DIR}/{slug}", "project": project,
            "label": pretty_path(project, home), "running": session is not None}


def api_share_stop(home, mount):
    mount = share_mountpoint(home, mount)
    stopped = True
    if is_mounted(mount):
        tool = shutil.which("fusermount3") or shutil.which("fusermount")
        stopped = bool(tool) and run_quiet([tool, "-u", "-z", mount])
    if stopped:
        try:
            os.rmdir(mount)
        except OSError:
            pass
    return {"mountpoint": mount, "stopped": stopped}


def share_serve(mount, mode):
    """--share-serve MOUNT ro|rw: mount the client's folder on MOUNT with sshfs.

    sshfs runs in passive mode: it speaks SFTP over this SSH channel's stdin and
    stdout, and the client answers from the shared folder. Nothing listens on the
    network; when the client stops or the connection drops, sshfs exits and unmounts.
    """
    home = home_dir()
    try:
        mount = share_mountpoint(home, mount)
    except ApiError as exc:
        print(exc, file=sys.stderr)
        return 1
    # dir_cache=no: the VM sees files created or deleted on the laptop at once.
    options = ["passive", f"uid={os.getuid()}", f"gid={os.getgid()}", "noatime", "dir_cache=no"]
    if mode != "rw":
        options.append("ro")
    log("info", "share.serve", mount=mount, mode=mode)
    try:
        os.execvp("sshfs", ["sshfs", "-f", "-o", ",".join(options), "devbox:/", mount])
    except OSError as exc:
        log("error", "share.serve-failed", mount=mount, err=str(exc))
        print(f"cannot run sshfs: {exc}", file=sys.stderr)
        return 1


# --- agent activity --------------------------------------------------------------------
#
# Pi appends every message of a session to a JSONL file as it happens: an assistant
# message lists its tool calls (name, arguments), and each call's result follows when
# the tool is done. A call without a result yet is therefore running right now.

# Tools that touch one file, given as arguments["path"].
FILE_TOOLS = {"read": "read", "edit": "modify", "write": "modify"}
ACTIVITY_EVENTS = 40


def session_dir(project):
    """Where Pi keeps the sessions of project (its getDefaultSessionDir)."""
    agent = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home_dir(), ".pi", "agent")
    safe = "--" + re.sub(r"[/\\:]", "-", project.lstrip("/\\")) + "--"
    return os.path.join(os.path.expanduser(agent), "sessions", safe)


def latest_session_file(project):
    folder = session_dir(project)
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".jsonl")]
    except OSError:
        return None
    paths = [os.path.join(folder, n) for n in names]
    return max(paths, key=lambda f: os.stat(f).st_mtime, default=None)


_GIT_CHANGES = {}  # project -> (when, index stat, changes)
GIT_CHANGES_FRESH = 3.0


def git_changes(project):
    """{relative path: two-letter git status} for the project's work tree. Asked to git
    at most every 3 seconds per project, unless git's index changed (a commit, an add)."""
    directory = git_dir(project)
    try:
        index = os.stat(os.path.join(directory, "index")).st_mtime_ns if directory else None
    except OSError:
        index = None
    cached = _GIT_CHANGES.get(project)
    now = time.monotonic()
    if cached and cached[1] == index and now - cached[0] < GIT_CHANGES_FRESH:
        return dict(cached[2])
    changes = read_git_changes(project)
    remember(_GIT_CHANGES, project, (now, index, changes), 64)
    return dict(changes)


def read_git_changes(project):
    out = git_run(project, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if out is None:
        return {}
    changes = {}
    records = out.decode("utf-8", "replace").split("\0")
    i = 0
    while i < len(records) and len(changes) < 500:
        record = records[i]
        i += 1
        if len(record) < 4:
            continue
        code, path = record[:2], record[3:]
        if code[0] in "RC":
            i += 1  # the original name follows a rename or copy
        changes[path] = code.strip() or code
    return changes


def project_relative(project, path):
    full = os.path.normpath(path if os.path.isabs(path) else os.path.join(project, path))
    return os.path.relpath(full, project) if within(full, project) else full


_SESSIONS = {}  # path -> (identity, offset, tail, (calls, finished, usage, last)): see read_session
_TAIL = 64       # bytes before the offset that must be unchanged to go on from there


def remember(cache, key, value, limit):
    """cache[key] = value, the least recently stored going past limit entries."""
    cache.pop(key, None)
    cache[key] = value
    while len(cache) > limit:
        cache.pop(next(iter(cache)))


def read_session(path):
    """Tool calls, their results, token usage and the last turn of a Pi session file.

    User messages are never parsed: they can carry big base64 images, and nothing in
    them is needed. Pi appends to a session file: in a process that reads it again and
    again (the watch), only what was added since is parsed. A file replaced, shortened
    or rewritten in place (Pi rewrites one when it migrates it) is read again from the
    start: the bytes just before where reading stopped must be the same as then.
    """
    st = os.stat(path)
    identity = (st.st_dev, st.st_ino)
    cached = _SESSIONS.get(path)
    if cached and cached[0] == identity and cached[1] <= st.st_size and session_tail(path, cached[1]) == cached[2]:
        offset, state = cached[1], cached[3]
        calls, finished, usage = dict(state[0]), dict(state[1]), dict(state[2])
        usage["days"] = {day: list(v) for day, v in usage.get("days", {}).items()}
        last = state[3]
    else:
        offset = 0
        calls, finished = {}, {}
        usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0, "turns": 0, "model": None,
                 "days": {}}
        last = None  # "user", "toolResult", or the stop reason of the last assistant message
    with open(path, "rb") as handle:
        handle.seek(offset)
        for raw in handle:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read with the next one
            offset += len(raw)
            if b'"role":"user"' in raw:
                last = "user"
                usage["turns"] += 1
                continue
            if b'"role":"assistant"' not in raw and b'"role":"toolResult"' not in raw:
                continue
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            message = entry.get("message") if isinstance(entry, dict) else None
            if not isinstance(message, dict):
                continue
            if message.get("role") == "assistant":
                last = message.get("stopReason")
                add_usage(usage, message.get("usage"))
                add_day(usage, entry.get("timestamp"), message.get("usage"))
                usage["model"] = message.get("model") or usage["model"]
                for block in message.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "toolCall":
                        args = block.get("arguments") if isinstance(block.get("arguments"), dict) else {}
                        calls[block.get("id")] = {"tool": block.get("name"), "args": compact_args(args),
                                                  "at": entry.get("timestamp")}
            elif message.get("role") == "toolResult":
                last = "toolResult"
                finished[message.get("toolCallId")] = bool(message.get("isError"))
                add_usage(usage, message.get("usage"))  # tools that run a model themselves
    remember(_SESSIONS, path, (identity, offset, session_tail(path, offset), (dict(calls), dict(finished), dict(usage), last)), 48)
    return calls, finished, usage, last


def compact_args(args):
    """What the lists show of a tool call: its path, the start of its command."""
    out = {}
    if isinstance(args.get("path"), str):
        out["path"] = args["path"]
    if isinstance(args.get("command"), str):
        out["command"] = args["command"][:500]
    return out


def session_edits(session):
    """The writes and edits of a session file with their whole arguments, and which
    tool calls finished (with an error or not): for api_diff, read once per diff."""
    calls, finished = {}, {}
    with open(session, "rb") as handle:
        for raw in handle:
            if b'"role":"toolResult"' in raw:
                found = re.search(rb'"toolCallId":"([^"]+)"', raw)
                if found:
                    finished[found.group(1).decode("utf-8", "replace")] = b'"isError":true' in raw
                continue
            if b'"role":"assistant"' not in raw or b'"toolCall"' not in raw:
                continue
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            message = entry.get("message") if isinstance(entry, dict) else None
            for block in (message or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "toolCall" and block.get("name") in ("edit", "write"):
                    args = block.get("arguments") if isinstance(block.get("arguments"), dict) else {}
                    calls[block.get("id")] = {"tool": block.get("name"), "args": args, "at": entry.get("timestamp")}
    return calls, finished


def session_tail(path, offset):
    try:
        with open(path, "rb") as handle:
            handle.seek(max(0, offset - _TAIL))
            return handle.read(min(offset, _TAIL))
    except OSError:
        return None


def add_usage(total, usage):
    if not isinstance(usage, dict):
        return
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            total[key] += value
    cost = usage.get("cost")
    if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)):
        total["cost"] += cost["total"]


def add_day(total, timestamp, usage):
    """Tokens and cost per day (UTC, "2026-10-13"), for the project's totals."""
    if not isinstance(usage, dict) or not isinstance(timestamp, str) or len(timestamp) < 10:
        return
    tokens = sum(v for k, v in usage.items() if k in ("input", "output", "cacheRead", "cacheWrite") and isinstance(v, (int, float)))
    cost = usage.get("cost")
    cost = cost.get("total") if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)) else 0
    day = total["days"].setdefault(timestamp[:10], [0, 0.0])
    day[0] += tokens
    day[1] += cost


def busy(last, calls, finished):
    """Pi is working when a tool runs, or a model answer is due."""
    return any(c not in finished for c in calls) or last in ("user", "toolResult", "toolUse")


_WORKING = {}  # session file -> ((size, mtime), working): the watch asks every second


def session_working(session):
    """Whether the Pi writing a session file is working, from the end of the file only:
    cheap enough to ask for every running Pi every second."""
    if not session:
        return False
    try:
        st = os.stat(session)
    except OSError:
        return False
    key = (st.st_size, st.st_mtime_ns)
    cached = _WORKING.get(session)
    if cached and cached[0] == key:
        return cached[1]
    working = session_working_now(session)
    remember(_WORKING, session, (key, working), 256)
    return working


def session_working_now(session):
    try:
        with open(session, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - 256 * 1024))
            tail = handle.read().split(b"\n")
    except OSError:
        return False
    for raw in reversed(tail):
        if b'"role":"toolResult"' in raw:
            return True  # results came in, the model answers next
        if b'"role":"user"' in raw:
            return True
        if b'"role":"assistant"' in raw:
            try:
                message = json.loads(raw).get("message", {})
            except (ValueError, AttributeError):
                return False
            return message.get("stopReason") == "toolUse"
    return False


def chosen_session(project, home, file):
    """(session file, the project's running Pis): the file asked for, else the one of
    the Pi used last there, else the newest."""
    pis = pi_infos(project, home, project_pis(pi_sessions(), project))
    if file:
        return session_file_in(project, file), pis
    return next((p["file"] for p in pis if p["file"]), None) or latest_session_file(project), pis


def api_activity(home, path, file=""):
    """What a Pi of the project read and modified, what it is doing now, and what it
    cost: the conversation asked for, or the one of the Pi used last."""
    project = resolve_inside(home, path)
    session, pis = chosen_session(project, home, file)
    if session and not os.path.exists(session):
        session = None  # a new Pi: its file comes with its first answer
    result = {"project": project, "label": pretty_path(project, home), "session": None, "file": session,
              "pis": pis, "working": False, "files": {}, "events": [], "git": git_changes(project), "usage": None}
    if session is None:
        return result
    calls, finished, usage, last = read_session(session)
    files = {}
    events = []
    for call_id, call in calls.items():
        running = call_id not in finished
        failed = finished.get(call_id, False)
        kind = FILE_TOOLS.get(call["tool"])
        target = call["args"].get("path") if isinstance(call["args"].get("path"), str) else None
        if kind and target:
            rel = project_relative(project, target)
            f = files.setdefault(rel, {"reads": 0, "edits": 0, "reading": False, "modifying": False,
                                       "read": False, "modified": False, "error": False, "at": None})
            f["at"] = call["at"]
            if kind == "read":
                f["reading"] = f["reading"] or running
                if not running and not failed:
                    f["reads"] += 1
                    f["read"] = True
            else:
                f["modifying"] = f["modifying"] or running
                if not running and not failed:
                    f["edits"] += 1
                    f["modified"] = True
            f["error"] = failed
        command = call["args"].get("command")
        label = target if target else (command if isinstance(command, str) else "")
        events.append({"tool": call["tool"], "target": label[:300], "at": call["at"],
                       "state": "running" if running else "error" if failed else "done"})
    for f in files.values():
        f["state"] = ("modifying" if f["modifying"] else "reading" if f["reading"]
                      else "modified" if f["modified"] else "read" if f["read"] else "error")
    result.update(session=os.path.basename(session), files=files, usage=usage,
                  events=events[-ACTIVITY_EVENTS:][::-1], working=busy(last, calls, finished))
    return result


DIFF_MAX_BYTES = 300 * 1024
EDIT_TEXT_MAX = 4000


def api_diff(home, file, path, conversation=""):
    """A file's changes: git's diff when the project is a repository, and the edits Pi
    made to it according to its session (all there is outside git)."""
    project = resolve_inside(home, path)
    full = os.path.realpath(os.path.join(project, file))
    if not within(full, project):
        raise ApiError(f"not in the project: {file}")
    rel = os.path.relpath(full, project)
    diff, untracked = None, False
    if git_run(project, "rev-parse", "--is-inside-work-tree") is not None:
        status = git_changes(project).get(rel.replace(os.sep, "/"))  # git always writes /
        if status == "??":
            untracked = True
            try:
                with open(full, "rb") as handle:
                    data = handle.read(DIFF_MAX_BYTES)
                diff = "".join(f"+{line}\n" for line in data.decode("utf-8", "replace").splitlines())
            except OSError:
                diff = None
        else:
            # No external diff program, no textconv: both are configurable per
            # repository and would run arbitrary commands.
            out = git_run(project, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--", rel)
            if out is None:  # no commit yet
                out = git_run(project, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--", rel)
            diff = None if out is None else out[:DIFF_MAX_BYTES].decode("utf-8", "replace")
    edits = []
    session, _ = chosen_session(project, home, conversation)
    if session is not None and os.path.exists(session):
        calls, finished = session_edits(session)
        for call_id, call in calls.items():
            if call["tool"] not in ("edit", "write") or not isinstance(call["args"].get("path"), str):
                continue
            if project_relative(project, call["args"]["path"]) != rel:
                continue
            state = "running" if call_id not in finished else "error" if finished[call_id] else "done"
            if call["tool"] == "write":
                content = call["args"].get("content")
                edits.append({"tool": "write", "at": call["at"], "state": state,
                              "content": content[:EDIT_TEXT_MAX] if isinstance(content, str) else ""})
            else:
                changes = []
                for change in call["args"].get("edits") or []:
                    if isinstance(change, dict):
                        changes.append({"old": str(change.get("oldText", ""))[:EDIT_TEXT_MAX],
                                        "new": str(change.get("newText", ""))[:EDIT_TEXT_MAX]})
                edits.append({"tool": "edit", "at": call["at"], "state": state, "changes": changes})
    return {"file": rel, "project": project, "diff": diff, "untracked": untracked, "edits": edits[-20:]}


COPY_MAX_BYTES = 500 * 1024 * 1024
COPY_MAX_MEMBERS = 50000


def entry_info(path):
    try:
        info = os.stat(path)
    except OSError:
        return None
    return {"name": os.path.basename(path), "path": path, "size": info.st_size, "mtime": int(info.st_mtime)}


_FOLDER_SIZES = {}  # path -> (when, (total, count))


def folder_size(path, limit=20000):
    """Total size and number of files of a folder copy (counted up to `limit` files),
    walked again at most every 30 seconds."""
    cached = _FOLDER_SIZES.get(path)
    if cached and time.monotonic() - cached[0] < 30:
        return cached[1]
    result = walk_size(path, limit)
    _FOLDER_SIZES[path] = (time.monotonic(), result)
    return result


def walk_size(path, limit):
    total, count = 0, 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            count += 1
            if count > limit:
                return total, count
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total, count


def project_context(project, home, sessions):
    """Everything given to a project's Pi: images, files, folder copies, shares."""
    context = {"project": project, "label": pretty_path(project, home),
               "running": bool(project_pis(sessions, project)),
               "images": [], "files": [], "copies": [], "shares": []}
    images = os.path.join(project, IMAGE_DIR)
    files = os.path.join(project, FILES_DIR)
    shared = os.path.join(project, SHARE_DIR)
    for folder, key in ((images, "images"), (files, "files")):
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for name in names:
            if name == ".gitignore" or not json_safe(name):
                continue
            full = os.path.join(folder, name)
            if os.path.islink(full):
                continue
            info = entry_info(full)
            if info is None:
                continue
            if os.path.isdir(full):
                info["size"], info["count"] = folder_size(full)
                context["copies"].append(info)
            else:
                context[key].append(info)
    try:
        with os.scandir(shared) as listing:
            # d_type only: a mount point is never stat'ed (see mounted_paths)
            names = sorted(e.name for e in listing if e.is_dir(follow_symlinks=False))
    except OSError:
        names = []
    mounts = mounted_paths()
    marks = handoff_marks(shared) if names else {}
    for name in names:
        full = os.path.join(shared, name)
        if name.startswith(".") or not json_safe(name):
            continue
        mark = marks.get(name)
        context["shares"].append({"name": name, "mountpoint": full, "relative": f"{SHARE_DIR}/{name}",
                                  "mounted": is_mounted(full, mounts),
                                  "handed_off": mark.get("mode") if isinstance(mark, dict) else None})
    return context


def api_contexts(home, config):
    """The context of every project worth showing: where a Pi runs, and recent ones
    that hold something."""
    sessions = pi_sessions()
    state = load_state(home)
    projects = [s["path"] for s in sessions.values() if within(s["path"], home)]
    for path in state["recent"]:
        if path not in projects and within(path, home) and os.path.isdir(path):
            projects.append(path)
    contexts = []
    for project in projects[:40]:
        context = project_context(project, home, sessions)
        if context["running"] or any(context[k] for k in ("images", "files", "copies", "shares")):
            contexts.append(context)
    return {"contexts": contexts, "sshfs": bool(shutil.which("sshfs"))}


def api_remove(home, path):
    """Delete something sent earlier: a file in .pi-images or .pi-files, a folder copied
    into .pi-files, or a handed-off copy in .pi-shared. Never anything else."""
    full = os.path.realpath(path)
    parent = os.path.basename(os.path.dirname(full))
    if parent == SHARE_DIR and within(full, home):
        shared = os.path.dirname(full)
        name = os.path.basename(full)
        with marks_lock(shared):
            marks = handoff_marks(shared)
            if name not in marks or is_mounted(full) or not os.path.isdir(full):
                raise ApiError(f"not a handed-off copy: {path}")
            writable_tree(full)
            shutil.rmtree(full)
            del marks[name]
            save_handoff_marks(shared, marks)
        return {"removed": full}
    if not within(full, home) or parent not in (IMAGE_DIR, FILES_DIR) or os.path.basename(full) == ".gitignore":
        raise ApiError(f"not something sent: {path}")
    if os.path.isdir(full) and parent == FILES_DIR:
        if any(within(m, full) for m in mounted_paths()):
            raise ApiError(f"a folder is mounted inside {path}: stop that share first")
        shutil.rmtree(full)
    elif os.path.isfile(full):
        os.remove(full)
    else:
        raise ApiError(f"not something sent: {path}")
    return {"removed": full}


def api_clear(home, path):
    """Delete every image, file and folder copy given to a project (not the shares)."""
    project = resolve_inside(home, path)
    context = project_context(project, home, {})
    removed = []
    for item in context["images"] + context["files"] + context["copies"]:
        try:
            removed.append(api_remove(home, item["path"])["removed"])
        except (ApiError, OSError):
            pass
    return {"project": project, "removed": removed}


HANDOFF_MARKS = ".handed-off.json"


def handoff_marks(shared):
    """{folder name: {"mode", "at"}} for the shares of a project's .pi-shared that were
    handed off: their folder now holds a copy instead of a mount."""
    try:
        with open(os.path.join(shared, HANDOFF_MARKS), encoding="utf-8") as handle:
            marks = json.load(handle)
    except (OSError, ValueError):
        return {}
    return marks if isinstance(marks, dict) else {}


def save_handoff_marks(shared, marks):
    atomic_write(os.path.join(shared, HANDOFF_MARKS), json.dumps(marks), shared)


def extract_tar(stream, dest):
    """Extract a tar stream into dest with tarfile's "data" filter and the size caps.
    Returns the number of members."""
    import tarfile
    total, count = 0, 0
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            count += 1
            total += max(member.size, 0)
            if count > COPY_MAX_MEMBERS or total > COPY_MAX_BYTES:
                raise ApiError(f"folder too big to copy (over {COPY_MAX_BYTES // (1024 * 1024)} MB "
                               f"or {COPY_MAX_MEMBERS} files)")
            archive.extract(member, dest, filter="data")
    return count


def read_only_tree(path):
    """Removes write permission everywhere under path: a read-only share stays read-only
    once it is a copy."""
    for root, dirs, files in os.walk(path, topdown=False):
        for name in files + dirs:
            full = os.path.join(root, name)
            if not os.path.islink(full):
                os.chmod(full, os.lstat(full).st_mode & ~0o222)
    os.chmod(path, os.stat(path).st_mode & ~0o222)


def writable_tree(path):
    for root, dirs, files in os.walk(path):
        os.chmod(root, os.stat(root).st_mode | 0o700)
        for name in files:
            full = os.path.join(root, name)
            if not os.path.islink(full):
                os.chmod(full, os.lstat(full).st_mode | 0o600)


def api_handoff(home, mount, mode, stream):
    """Hand off: the live share at mount becomes a copy at the same place.

    The copy is unpacked next to the mount first; then the share is unmounted and the
    copy renamed onto its path, so Pi, possibly in the middle of a task, keeps finding
    the same files at the same paths. A read-only share becomes a read-only copy.
    """
    mount = share_mountpoint(home, mount)
    shared = os.path.dirname(mount)
    name = os.path.basename(mount)
    staging = os.path.join(shared, f".handoff-{name}-{stamp()}")
    os.makedirs(staging, mode=0o700)
    try:
        count = extract_tar(stream, staging)
        entries = os.listdir(staging)
        # Pier packs the folder under its own name: unpack that level away.
        inner = os.path.join(staging, entries[0]) if len(entries) == 1 and os.path.isdir(os.path.join(staging, entries[0])) else staging
        if is_mounted(mount):
            tool = shutil.which("fusermount3") or shutil.which("fusermount")
            if not tool or not run_quiet([tool, "-u", "-z", mount]):
                raise ApiError("could not unmount the share")
        if os.path.isdir(mount):
            os.rmdir(mount)
        os.rename(inner, mount)
    except (ApiError, OSError, Exception) as exc:
        writable_tree(staging) if os.path.isdir(staging) else None
        shutil.rmtree(staging, ignore_errors=True)
        raise ApiError(str(exc)) if not isinstance(exc, ApiError) else exc
    if os.path.isdir(staging):
        shutil.rmtree(staging, ignore_errors=True)
    if mode != "rw":
        read_only_tree(mount)
    with marks_lock(shared):
        marks = handoff_marks(shared)
        marks[name] = {"mode": "rw" if mode == "rw" else "ro", "at": int(time.time())}
        save_handoff_marks(shared, marks)
    project = os.path.dirname(shared)
    return {"mountpoint": mount, "project": project, "label": pretty_path(project, home),
            "relative": f"{SHARE_DIR}/{name}", "count": count}


def download_tar(home, path):
    """--download PATH: a handed-off copy or a folder copy, as a tar stream on stdout."""
    import tarfile
    full = os.path.realpath(path)
    parent = os.path.basename(os.path.dirname(full))
    if not within(full, home) or parent not in (SHARE_DIR, FILES_DIR) or is_mounted(full) or not os.path.isdir(full):
        print(f"not a copy that can be downloaded: {path}", file=sys.stderr)
        return 1
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        archive.add(full, arcname=os.path.basename(full))
    return 0


def api_upload_dir(home, name, target, stream):
    """Receive a folder as a tar stream into .pi-files/<stamp>-<name>, then mention it.

    tarfile's "data" filter refuses what a hostile archive could do: absolute paths,
    "..", links pointing outside, device files, setuid bits. Size and number of files
    are capped while reading, before anything big lands on disk.
    """
    import tarfile
    project, session = target_project(home, target, pi_sessions())
    folder = ignored_dir(project, FILES_DIR)
    dest = os.path.join(folder, f"{stamp()}-{safe_name(name, 'folder')}")
    os.makedirs(dest, mode=0o700)
    try:
        count = extract_tar(stream, dest)
    except ApiError as exc:
        shutil.rmtree(dest, ignore_errors=True)
        raise ApiError(f"{exc}: share it live instead")
    except Exception as exc:  # noqa: BLE001 - nothing half-made stays
        shutil.rmtree(dest, ignore_errors=True)
        raise ApiError(f"{type(exc).__name__}: {exc}" if not isinstance(exc, (tarfile.TarError, OSError)) else str(exc))
    relative = f"{FILES_DIR}/{os.path.basename(dest)}"
    typed = session is not None and type_into_pi(session, relative + "/ ")
    return {"saved": dest, "project": project, "label": pretty_path(project, home),
            "reference": relative + "/", "running": session is not None, "typed": typed, "count": count}


# --- project setup ---------------------------------------------------------------------
#
# Mirrors Pi's resource loader: a global context file in the agent dir, then the first
# of AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD in every directory from / down to the
# project. .pi/SYSTEM.md and .pi/APPEND_SYSTEM.md only count once the project is
# trusted (~/.pi/agent/trust.json, nearest entry wins); otherwise Pi uses the global
# ones in the agent dir.

CONTEXT_NAMES = ("AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
TEXT_MAX_BYTES = 256 * 1024
HISTORY_KEEP = 10
HISTORY_DIR = os.path.join(".pi", "devbox-history")
EDITABLE = {"instructions": None, "append": os.path.join(".pi", "APPEND_SYSTEM.md"),
            "system": os.path.join(".pi", "SYSTEM.md")}


def agent_dir():
    return os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home_dir(), ".pi", "agent"))


def context_file_in(directory):
    for name in CONTEXT_NAMES:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            return path
    return None


def read_text(path, limit=TEXT_MAX_BYTES):
    try:
        with open(path, "rb") as handle:
            return handle.read(limit).decode("utf-8", "replace")
    except OSError:
        return None


def startup_files(project, home):
    """What Pi loads as context at startup, in its order."""
    files = []
    seen = set()
    global_file = context_file_in(agent_dir())
    if global_file:
        files.append({"path": global_file, "label": pretty_path(global_file, home), "scope": "global"})
        seen.add(global_file)
    chain = []
    current = project
    while True:
        found = context_file_in(current)
        if found and found not in seen:
            chain.insert(0, {"path": found, "label": pretty_path(found, home) if within(found, home) else found,
                             "scope": "project" if current == project else "parent"})
            seen.add(found)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    files.extend(chain)
    for f in files:
        try:
            f["size"] = os.path.getsize(f["path"])
        except OSError:
            f["size"] = 0
    return files


def trust_decision(project):
    """True, False, or None (never decided), as Pi reads ~/.pi/agent/trust.json."""
    try:
        with open(os.path.join(agent_dir(), "trust.json"), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    current = os.path.realpath(project)
    while True:
        value = data.get(current)
        if value is True or value is False:
            return value
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def editable_path(project, which):
    if which not in EDITABLE:
        raise ApiError(f"unknown text: {which}")
    if which == "instructions":
        return context_file_in(project) or os.path.join(project, "AGENTS.md")
    return os.path.join(project, EDITABLE[which])


def history_entries(project, which):
    folder = os.path.join(project, HISTORY_DIR)
    try:
        names = sorted((n for n in os.listdir(folder) if n.startswith(which + "-") and n.endswith(".md")), reverse=True)
    except OSError:
        return []
    entries = []
    for name in names[:HISTORY_KEEP]:
        path = os.path.join(folder, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = (st.st_size, st.st_mtime_ns)
        cached = _HISTORY.get(path)
        if not cached or cached[0] != key:
            cached = (key, read_text(path, 64 * 1024) or "")
            remember(_HISTORY, path, cached, 512)
        entries.append({"path": path, "at": int(st.st_mtime), "text": cached[1]})
    return entries


_HISTORY = {}  # history file -> ((size, mtime), text)


def first_prompt(session):
    """The first thing the user asked in a session file, for a readable list."""
    try:
        with open(session, "rb") as handle:
            for raw in handle:
                if b'"role":"user"' not in raw:
                    continue
                if len(raw) > 200 * 1024:
                    return "(an image)"
                content = json.loads(raw).get("message", {}).get("content")
                if isinstance(content, str):
                    return content.strip()[:200]
                if isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    return (" ".join(texts).strip() or "(an image)")[:200]
                return ""
    except (OSError, ValueError, AttributeError):
        return ""
    return ""


_NAMES = {}  # session file -> (identity, offset, name, tail): only what Pi appended is read again
NAME_SCAN_COLD = 4 * 1024 * 1024


def session_name_of(session):
    """The name given in Pi (/name), the last one. A file Pi appends to is read from
    where the last reading stopped, in big blocks searched for the marker only."""
    marker = b'"type":"session_info"'
    try:
        st = os.stat(session)
    except OSError:
        return None
    identity = (st.st_dev, st.st_ino)
    cached = _NAMES.get(session)
    if cached and cached[0] == identity and cached[1] <= st.st_size and session_tail(session, cached[1]) == cached[3]:
        offset, name = cached[1], cached[2]
    else:
        # Cold: a big conversation (images) is searched near its end only, where a
        # name given lately is; reading hundreds of MB would stall the watch.
        offset, name = max(0, st.st_size - NAME_SCAN_COLD), None
    try:
        with open(session, "rb") as handle:
            handle.seek(offset)
            rest = b""
            while True:
                block = handle.read(1 << 20)
                if not block:
                    break
                data = rest + block
                end = data.rfind(b"\n") + 1  # whole lines only; the rest waits for the next block
                lines, rest = data[:end], data[end:]
                at = lines.find(marker)
                while at >= 0:
                    start = lines.rfind(b"\n", 0, at) + 1
                    stop = lines.find(b"\n", at)
                    try:
                        info = json.loads(lines[start:stop])
                        if isinstance(info, dict) and info.get("type") == "session_info" and "name" in info:
                            name = info["name"] or None
                    except ValueError:
                        pass
                    at = lines.find(marker, stop)
                offset += len(lines)
    except OSError:
        return name
    remember(_NAMES, session, (identity, offset, name, session_tail(session, offset)), 4000)
    return name


# Names and categories given in Pier to conversations: Pier's own, in
# ~/.local/state/pi-dir-picker/labels.json (Pi's files are not touched).

LABEL_MAX = 80


def labels_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "labels.json")


def load_labels(home):
    data = read_json_file(labels_path(home))
    return data if isinstance(data, dict) else {}


def api_label(home, path, file, title, category):
    project = resolve_inside(home, path)
    file = label_key(project, file)
    with labels_lock(home):
        labels = load_labels(home)
        entry = dict(labels.get(file) or {}, title=title.strip()[:LABEL_MAX], category=category.strip()[:LABEL_MAX])
        store_label(labels, file, entry)
        save_labels(home, labels, file)
    log("info", "session.label", project=project, file=os.path.basename(file), category=entry["category"])
    return {"file": file, **entry}


def label_key(project, file):
    """A conversation of project, checked, named the way the lists name it."""
    full = session_file_in(project, file)
    return os.path.join(session_dir(project), os.path.basename(full))


class file_lock:
    """One process at a time between enter and exit, on a lock file of the picker's own
    (never in a folder Pi can write)."""

    def __init__(self, path):
        self.path = path
        self.handle = None

    def __enter__(self):
        try:
            import fcntl
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            self.handle = open(self.path, "a")
            fcntl.flock(self.handle, fcntl.LOCK_EX)
        except (ImportError, OSError):
            self.handle = None
        return self

    def __exit__(self, *exc):
        if self.handle:
            self.handle.close()  # closing releases the lock
        return False


def labels_lock(home):
    """Two calls at once (a pin here, an archive there) must not lose one."""
    return file_lock(labels_path(home) + ".lock")


def marks_lock(shared):
    name = hashlib.sha1(os.fsencode(os.path.realpath(shared))).hexdigest()[:16]
    return file_lock(os.path.join(os.path.dirname(state_path(home_dir())), "locks", f"marks-{name}.lock"))


def store_label(labels, file, entry):
    """Keeps an entry only while it says something."""
    if any(entry.get(k) for k in ("title", "category", "pinned", "archived")):
        labels[file] = entry
    else:
        labels.pop(file, None)


def api_mark(home, path, file, what, value):
    """Pins a conversation (kept on top) or archives it (hidden from the lists, still
    searchable): `mark PROJECT FILE pinned|archived 1|0`."""
    if what not in ("pinned", "archived") or value not in ("0", "1"):
        raise ApiError("mark takes pinned or archived, and 1 or 0")
    project = resolve_inside(home, path)
    file = label_key(project, file)
    with labels_lock(home):
        labels = load_labels(home)
        entry = dict(labels.get(file) or {})
        entry[what] = value == "1"
        if entry[what] and what == "archived":
            entry["pinned"] = False
        store_label(labels, file, entry)
        save_labels(home, labels, file)
    log("info", "session.mark", project=project, file=os.path.basename(file), what=what, value=value)
    return {"file": file, what: entry[what]}


def save_labels(home, labels, file):
    # Forgotten conversations go: a label lives as long as its file.
    labels = {f: v for f, v in labels.items() if os.path.exists(f) or f == file}
    target = labels_path(home)
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    tmp = f"{target}.{os.getpid()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(labels, handle, indent=1)
    os.replace(tmp, target)


_SESSION_INFO = {}  # path -> ((size, mtime), info): a session file is read again only when it changed


def project_sessions(project, limit=200):
    folder = session_dir(project)
    files = []
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                if entry.name.endswith(".jsonl"):
                    try:
                        files.append((entry.path, entry.stat()))
                    except OSError:
                        pass
    except OSError:
        return []
    files.sort(key=lambda f: f[1].st_mtime, reverse=True)
    return [session_info(path, st) for path, st in files[:limit]]


def session_info(path, st):
    """A conversation for the lists: name, first question, and its token use (files up
    to 8 MB), read again only when the file changed."""
    key = (st.st_size, st.st_mtime_ns)
    cached = _SESSION_INFO.get(path)
    if cached and cached[0] == key:
        return dict(cached[1])
    first = cached[1] if cached else None
    info = {"path": path, "file": os.path.basename(path), "modified": int(st.st_mtime),
            "name": session_name_of(path),
            # The first prompt does not change once there is one.
            "prompt": first["prompt"] if first and first["prompt"] else first_prompt(path), "usage": None}
    if st.st_size <= 8 * 1024 * 1024:
        try:
            _, _, usage, _ = read_session(path)
            info["usage"] = usage
        except OSError:
            pass
    remember(_SESSION_INFO, path, (key, info), 4000)
    return dict(info)


# What Pi loads besides itself, read from where Pi looks (nothing is run):
# - packages: "packages" in settings.json (npm:name, git:…, or a path), installed in
#   <agent dir>/npm or git for the user's, <project>/.pi/npm or git for a project's;
# - extensions, skills and prompt templates: their folders, in the agent dir and in the
#   project's .pi, plus the paths in settings.json;
# - MCP servers: ~/.pi/agent/mcp.json and the project's .pi/mcp.json (Pi 1.x connects
#   them itself; `pi mcp add`), with whether each is enabled.
# A project's .pi only counts once the project is trusted: Setup says so next to it.

RESOURCE_KINDS = ("extensions", "skills", "prompts")
RESOURCE_MAX = 100


def read_json_file(path):
    """A JSON file, comment lines allowed; None when missing or unreadable."""
    if not os.path.isfile(path):
        return None
    text = read_text(path) or ""
    for attempt in (text, re.sub(r"(?m)^\s*//.*$", "", text)):
        try:
            return json.loads(attempt)
        except ValueError:
            continue
    return None


def package_folder(spec, base):
    if spec.startswith("npm:"):
        name = spec[4:]
        at = name.rfind("@")
        return os.path.join(base, "npm", "node_modules", name[:at] if at > 0 else name)
    if spec.startswith(("git:", "http://", "https://", "ssh://", "git@")):
        return None  # where Pi clones it is its own business: version unknown here
    path = os.path.expanduser(spec)
    return path if os.path.isabs(path) else os.path.join(base, path)


def package_info(entry, base, scope):
    spec = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
    if not isinstance(spec, str) or not spec:
        return None
    info = {"source": spec, "scope": scope, "version": None, "description": None, "installed": None}
    folder = package_folder(spec, base)
    if folder:
        info["installed"] = os.path.isdir(folder)
        manifest = read_json_file(os.path.join(folder, "package.json")) or {}
        if isinstance(manifest, dict):
            info["version"] = manifest.get("version") if isinstance(manifest.get("version"), str) else None
            description = manifest.get("description")
            info["description"] = description[:200] if isinstance(description, str) else None
    return info


def folder_items(folder, kind):
    try:
        names = sorted(os.listdir(folder))[:RESOURCE_MAX]
    except OSError:
        return []
    items = []
    for name in names:
        if name.startswith("."):
            continue
        path = os.path.join(folder, name)
        if kind == "skills" and not os.path.isfile(os.path.join(path, "SKILL.md")):
            continue
        if kind == "prompts" and not name.endswith(".md"):
            continue
        if kind == "extensions" and os.path.isfile(path) and not name.endswith((".ts", ".js", ".mjs")):
            continue
        items.append(name[:-3] if kind == "prompts" else name)
    return items


MCP_FILES = (("user", "{agent}/mcp.json"), ("project", "{project}/.pi/mcp.json"))


def pi_resources(project, home):
    agent = agent_dir()
    places = (("user", agent, read_json_file(os.path.join(agent, "settings.json"))),
              ("project", os.path.join(project, ".pi"), read_json_file(os.path.join(project, ".pi", "settings.json"))))
    out = {"packages": [], "extensions": [], "skills": [], "prompts": [], "mcp": [], "model": {}}
    for scope, base, settings in places:
        settings = settings if isinstance(settings, dict) else {}
        for entry in settings.get("packages") or []:
            info = package_info(entry, base, scope)
            if info:
                out["packages"].append(info)
        for kind in RESOURCE_KINDS:
            for name in folder_items(os.path.join(base, kind), kind):
                out[kind].append({"name": name, "scope": scope, "from": pretty_path(os.path.join(base, kind), home)})
            for path in settings.get(kind) or []:
                if isinstance(path, str):
                    out[kind].append({"name": path, "scope": scope, "from": "settings.json"})
        for key in ("defaultProvider", "defaultModel", "defaultThinkingLevel"):
            if isinstance(settings.get(key), str):
                out["model"][key] = settings[key]
    for scope, pattern in MCP_FILES:
        path = pattern.format(agent=agent, project=project)
        config = read_json_file(path)
        servers = config.get("mcpServers") if isinstance(config, dict) else None
        if not isinstance(servers, dict):
            continue
        for name, server in list(servers.items())[:RESOURCE_MAX]:
            server = server if isinstance(server, dict) else {}
            kind = "http" if server.get("url") else "stdio" if server.get("command") else None
            description = server.get("description") if isinstance(server.get("description"), str) else None
            out["mcp"].append({"name": name, "scope": scope, "from": pretty_path(path, home), "kind": kind,
                               "enabled": server.get("enabled") is not False, "description": description})
    versions = pi_versions_soon(home, [p["source"] for p in out["packages"]])
    out["pi"] = versions.get("pi")
    for info in out["packages"]:
        info["latest"] = versions.get(info["source"])
    return out


# Every conversation of every project, for the Conversations tab: Pi's sessions folder
# holds one folder per project; the project is the "cwd" of a session's first line.
# Light on purpose: no token counts (Setup has them, project by project).

_FOLDER_PROJECT = {}  # sessions folder -> project path (a folder never changes project)
# The most recent conversations, over all projects, come with their token use (the
# others with their name and first question only): what the lists show first.
CONVERSATIONS_WITH_USAGE = 300
_SUMMARY = {}         # session file -> ((size, mtime), summary)
CONVERSATIONS_MAX = 2000


def sessions_root():
    return os.path.join(agent_dir(), "sessions")


def folder_project(folder):
    if folder in _FOLDER_PROJECT:
        return _FOLDER_PROJECT[folder]
    project = None
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".jsonl"))
    except OSError:
        names = []
    for name in names[:3]:
        try:
            with open(os.path.join(folder, name), "rb") as handle:
                header = json.loads(handle.readline(64 * 1024))
            if isinstance(header, dict) and isinstance(header.get("cwd"), str):
                project = header["cwd"]
                break
        except (OSError, ValueError):
            continue
    if project:
        _FOLDER_PROJECT[folder] = project
    return project


def session_summary(path, st):
    key = (st.st_size, st.st_mtime_ns)
    cached = _SUMMARY.get(path)
    if cached and cached[0] == key:
        return dict(cached[1])
    first = cached[1] if cached else None
    summary = {"path": path, "modified": int(st.st_mtime) // 60 * 60, "name": session_name_of(path),
               "prompt": first["prompt"] if first and first["prompt"] else first_prompt(path)}
    remember(_SUMMARY, path, (key, summary), 4000)
    return dict(summary)


def api_conversations(home):
    root = sessions_root()
    labels = load_labels(home)
    pis = pi_sessions()
    try:
        folders = [os.path.join(root, n) for n in os.listdir(root)]
    except OSError:
        folders = []
    found = {}  # project -> [(path, stat)]
    # A session without its project in its first line (an older Pi): matched by its
    # folder's name with the recent projects and those where a Pi runs.
    known = {session_dir(p): p for p in [*load_state(home)["recent"], *(pi["path"] for pi in pis.values())]}
    for folder in folders:
        project = folder_project(folder) or known.get(folder)
        if not project or not within(project, home) or not os.path.isdir(project):
            continue
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if entry.name.endswith(".jsonl"):
                        try:
                            found.setdefault(project, []).append((entry.path, entry.stat()))
                        except OSError:
                            pass
        except OSError:
            continue
    every = sorted(((f[1].st_mtime, project) for project, files in found.items() for f in files), reverse=True)
    cut = every[CONVERSATIONS_MAX - 1][0] if len(every) > CONVERSATIONS_MAX else None
    usage_from = every[CONVERSATIONS_WITH_USAGE - 1][0] if len(every) > CONVERSATIONS_WITH_USAGE else None
    projects = []
    total = 0
    for project in set(found) | {p["path"] for p in pis.values() if within(p["path"], home)}:
        files = sorted(found.get(project, []), key=lambda f: f[1].st_mtime, reverse=True)
        infos = pi_infos(project, home, project_pis(pis, project))
        # Which conversation each Pi holds, as Setup sees it (a lone Pi without a known
        # file holds the newest one).
        here = {i["file"]: i for i in infos if i["file"]}
        sessions = []
        for path, st in files:
            if cut is not None and st.st_mtime < cut:
                break
            if usage_from is None or st.st_mtime >= usage_from:
                summary = session_info(path, st)
                summary["modified"] = summary["modified"] // 60 * 60
            else:
                summary = dict(session_summary(path, st), usage=None)
            label = labels.get(path) or {}
            pi = here.get(path)
            summary.update(title=label.get("title") or None, category=label.get("category") or None,
                           pinned=bool(label.get("pinned")), archived=bool(label.get("archived")),
                           slot=pi["slot"] if pi else None, working=bool(pi and pi.get("working")))
            sessions.append(summary)
        total += len(sessions)
        running = [p for p in pis.values() if p["path"] == project]
        if not os.path.isdir(project):
            continue
        if sessions or running:
            # Interrupted: the last conversation was mid-work and no Pi runs it (the VM
            # restarted, Pi was killed): it can be taken up where it stopped.
            last = sessions[0] if sessions else None
            interrupted = last["path"] if last and not last["slot"] and session_working(last["path"]) else None
            projects.append({"project": project, "label": pretty_path(project, home), "running": len(running),
                             "modified": sessions[0]["modified"] if sessions else 0, "sessions": sessions,
                             "pis": infos, "interrupted": interrupted})
    projects.sort(key=lambda p: (p["running"] > 0, p["modified"]), reverse=True)
    return {"projects": projects, "truncated": cut is not None}


# Pi's version and the newest one, and the newest version of each npm package. Asked to
# npm's registry from the VM, at most every 6 hours (an hour after a failure); the
# answer is kept in ~/.local/state/pi-dir-picker/versions.json.

PI_NPM = "@earendil-works/pi-coding-agent"
VERSIONS_FRESH = 6 * 3600
VERSIONS_RETRY = 3600


def versions_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "versions.json")


def npm_latest(name):
    import urllib.request
    url = "https://registry.npmjs.org/" + name.replace("/", "%2F") + "/latest"
    with urllib.request.urlopen(url, timeout=3) as answer:
        data = json.loads(answer.read(1024 * 1024))
    version = data.get("version") if isinstance(data, dict) else None
    return version if isinstance(version, str) else None


def installed_pi_version(home):
    config, _ = load_config(home)
    argv = pi_argv(config, child_env(home))
    if not argv:
        return None
    try:
        out = subprocess.run([*argv, "--version"], capture_output=True, text=True, timeout=10,
                             stdin=subprocess.DEVNULL, env=child_env(home))
    except (OSError, subprocess.SubprocessError):
        return None
    found = re.search(r"\d+\.\d+\.\d+[\w.-]*", out.stdout + out.stderr)
    return found.group(0) if found else None


def pi_program_key(home):
    """What changes when Pi is updated: its program file, resolved, and its time."""
    config, _ = load_config(home)
    argv = pi_argv(config, child_env(home))
    if not argv:
        return None
    try:
        real = os.path.realpath(argv[0])
        return [real, os.stat(real).st_mtime_ns]
    except OSError:
        return None


def pi_versions(home, sources):
    """{"pi": {"version", "latest"}, "npm:name": latest, ...}. npm is asked at most every
    6 hours per name (an hour after a failure); Pi's own version only when its program
    changed. The cache file is written only when something in it changed."""
    path = versions_path(home)
    cache = read_json_file(path)
    cache = cache if isinstance(cache, dict) else {}
    before = json.dumps(cache, sort_keys=True)
    now = time.time()

    def stale(entry):
        if not isinstance(entry, dict) or not isinstance(entry.get("checked"), (int, float)):
            return True
        return now - entry["checked"] >= (VERSIONS_FRESH if entry.get("latest") else VERSIONS_RETRY)

    def ask(name, entry):
        try:
            return {"latest": npm_latest(name), "checked": now}
        except (OSError, ValueError) as exc:
            log("debug", "versions.failed", name=name, err=str(exc))
            return {"latest": (entry or {}).get("latest") if isinstance(entry, dict) else None, "checked": now}

    pi = cache.get("pi") if isinstance(cache.get("pi"), dict) else {}
    key = pi_program_key(home)
    unknown = key and not pi.get("version") and now - pi.get("version_checked", 0) >= VERSIONS_RETRY
    if key != pi.get("program") or "version" not in pi or unknown:
        pi = dict(pi, version=installed_pi_version(home), program=key, version_checked=now)
    if stale(pi):
        pi.update(ask(PI_NPM, pi))
    packages = cache.get("packages") if isinstance(cache.get("packages"), dict) else {}
    for source in sources:
        if source.startswith("npm:") and "@" not in source[5:] and stale(packages.get(source)):  # pinned ones never move
            packages[source] = ask(source[4:], packages.get(source))
    cache = {"pi": pi, "packages": packages}
    if json.dumps(cache, sort_keys=True) != before:
        try:
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(cache, handle)
            os.replace(tmp, path)
        except OSError:
            pass
    out = {source: (entry or {}).get("latest") for source, entry in packages.items() if isinstance(entry, dict)}
    out["pi"] = {"version": pi.get("version"), "latest": pi.get("latest")}
    return out


_VERSIONS_ASKING = threading.Lock()


def pi_versions_soon(home, sources):
    """pi_versions without waiting on the network: the cached answer now, and a refresh
    in the background (one at a time) that the next look picks up."""
    if _VERSIONS_ASKING.acquire(blocking=False):
        def refresh():
            try:
                pi_versions(home, sources)
            except Exception as exc:  # noqa: BLE001 - versions are a nicety
                log("warn", "versions.refresh-failed", err=f"{type(exc).__name__}: {exc}")
            finally:
                _VERSIONS_ASKING.release()
        threading.Thread(target=refresh, daemon=True).start()
    cache = read_json_file(versions_path(home))
    cache = cache if isinstance(cache, dict) else {}
    packages = cache.get("packages") if isinstance(cache.get("packages"), dict) else {}
    out = {source: (entry or {}).get("latest") for source, entry in packages.items() if isinstance(entry, dict)}
    pi = cache.get("pi") if isinstance(cache.get("pi"), dict) else {}
    out["pi"] = {"version": pi.get("version"), "latest": pi.get("latest")}
    return out


def forget_versions(home):
    try:
        os.remove(versions_path(home))
    except OSError:
        pass


PI_UPDATE_TARGET = re.compile(r"(npm:|git:|https://)[A-Za-z0-9@/._:+~-]{1,200}")

# When Pi was installed by root (`sudo npm install -g`, in /usr/local), it cannot update
# itself and says which npm command would. That command, and only one of that shape
# (npm, a prefix, install -g, plain options, Pi's own package at a version), may be run
# with sudo once the user says yes; sudo asks for the password in this terminal.
NPM_SELF_UPDATE = re.compile(
    r"npm --prefix (/usr|/usr/local|/opt/[\w.-]+) install -g((?: --ignore-scripts| --min-release-age=\d+)*) "
    + re.escape(PI_NPM) + r"@\d+\.\d+\.\d+(?:-[\w.]+)?")


def suggested_self_update(output):
    """The npm command Pi suggests when it cannot update itself, checked; else None."""
    found = re.search(r"Update it yourself with:\s*(npm [^\r\n]+(?:\r?\n[^\r\n]+)?)", output)
    if not found:
        return None
    command = " ".join(found.group(1).split())  # the terminal may have wrapped it
    match = NPM_SELF_UPDATE.match(command)
    return command[:match.end()] if match else None


def pi_update(args):
    """--pi-update [--all | --extensions | SOURCE]: `pi update` in a terminal of Pier, then
    the versions are asked again."""
    home = home_dir()
    config, _ = load_config(home)
    env = child_env(home)
    argv = pi_argv(config, env)
    if argv is None:
        print("pi not found on PATH: install it or set PI_BIN")
        return 1
    if len(args) > 1 or (args and args[0] not in ("--all", "--extensions") and not PI_UPDATE_TARGET.fullmatch(args[0])):
        print("usage: --pi-update [--all | --extensions | SOURCE]")
        return 2
    command = [*argv, "update", *args]
    print("$ pi update " + " ".join(args), flush=True)
    log("info", "pi.update", args=list(args))
    output = []
    try:
        child = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, errors="replace", bufsize=1)
        for text in child.stdout:  # shown as it comes, and kept to read Pi's advice
            sys.stdout.write(text)
            sys.stdout.flush()
            output.append(text)
        status = child.wait()
    except OSError as exc:
        print(f"cannot run pi: {exc}")
        status = 1
    log("warn" if status else "info", "pi.update-done", args=list(args), status=status)
    fix = suggested_self_update("".join(output)) if status and args[:1] != ["--extensions"] else None
    if fix and shutil.which("sudo"):
        print(f"\nPi is installed for all users (by root): updating it needs sudo.\n  sudo {fix}")
        sys.stdout.write("Run it now? sudo asks for your password here. [y/N] ")
        sys.stdout.flush()
        try:
            answer = sys.stdin.readline().strip().lower()
        except (OSError, ValueError):
            answer = ""
        if answer in ("y", "yes", "o", "oui"):
            log("info", "pi.update-sudo", command=fix)
            status = subprocess.call(["sudo", *shlex.split(fix)], env=env)
            log("warn" if status else "info", "pi.update-sudo-done", status=status)
    forget_versions(home)
    print("\n" + ("done" if not status else f"pi update failed (status {status})")
          + ". Running Pis keep their version until they restart.")
    pause_for_enter("press Enter to close ")
    return status


def api_setup(home, path):
    project = resolve_inside(home, path)
    pis = pi_infos(project, home, project_pis(pi_sessions(), project))
    texts = {}
    for which in EDITABLE:
        target = editable_path(project, which)
        text = read_text(target) if os.path.isfile(target) else None
        texts[which] = {"path": target, "name": os.path.relpath(target, project), "exists": text is not None,
                        "text": text or "", "history": history_entries(project, which)}
    for which, name in (("append", "APPEND_SYSTEM.md"), ("system", "SYSTEM.md")):
        texts[which]["global"] = os.path.isfile(os.path.join(agent_dir(), name))
    # The conversations themselves are in the Conversations part (api_conversations):
    # Setup only says how many.
    try:
        conversations = sum(1 for n in os.listdir(session_dir(project)) if n.endswith(".jsonl"))
    except OSError:
        conversations = 0
    return {
        "project": project, "label": pretty_path(project, home), "running": bool(pis), "pis": pis,
        "conversations": conversations,
        "startup": startup_files(project, home), "trusted": trust_decision(project),
        "texts": texts, "resources": pi_resources(project, home),
    }


def api_write_text(home, path, which, data):
    """Save one of the project's texts for Pi, keeping the previous version in
    .pi/devbox-history. An empty append or system text deletes the file, so Pi falls
    back to the global one."""
    project = resolve_inside(home, path)
    if len(data) > TEXT_MAX_BYTES:
        raise ApiError(f"text larger than {TEXT_MAX_BYTES // 1024} KB")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError("the text is not UTF-8")
    target = editable_path(project, which)
    if not within(os.path.realpath(os.path.dirname(target)), project):
        raise ApiError("refusing to write outside the project")
    previous = read_text(target) if os.path.isfile(target) else None
    if previous is not None and previous != text:
        history = safe_folder(project, HISTORY_DIR)
        create_new(os.path.join(history, ".gitignore"), "*\n")
        # Nanoseconds, zero-padded: names sort in saving order even within one second.
        create_new(os.path.join(history, f"{which}-{time.time_ns():020d}.md"), previous, 0o600)
        old = sorted((n for n in os.listdir(history) if n.startswith(which + "-")), reverse=True)
        for name in old[HISTORY_KEEP:]:
            os.remove(os.path.join(history, name))
    if not text.strip() and which != "instructions":
        if os.path.isfile(target):
            os.remove(target)
        return {"saved": None, "removed": target}
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, text, project, 0o644)
    return {"saved": target}


# Reads Pier repeats every few seconds: logged only at debug level, unless they fail.
API_READS = {"version", "projects", "ls", "shares", "activity", "diff", "contexts",
             "setup", "log", "checkpoints", "checkpoint-diff"}
# Fields of a reply worth a place in the log line.
API_LOGGED = ("saved", "removed", "reference", "count", "mountpoint", "stopped", "id", "restored", "safety", "typed")


def api_log_fields(command, rest):
    """The arguments of a call, for the log: what is typed into Pi only as its length."""
    if command == "type":
        return {"chars": len(rest[0]) if rest else 0, "target": rest[1] if len(rest) > 1 else None}
    return {"args": [a[:200] for a in rest]} if rest else {}


def stdin_bytes(limit):
    return sys.stdin.buffer.read(limit + 1)


# Every API command: (home, config, a = the arguments, padded with "") -> reply.
API_COMMANDS = {
    "version": lambda home, config, a: api_version(home, config),
    "projects": lambda home, config, a: api_projects(home, config),
    "ls": lambda home, config, a: api_ls(home, a[0]),
    "paste-image": lambda home, config, a: api_paste_image(home, a[0], stdin_bytes(IMAGE_MAX_BYTES)),
    "paste-file": lambda home, config, a: api_paste_file(home, a[0], a[1], stdin_bytes(FILE_MAX_BYTES)),
    "type": lambda home, config, a: api_type(home, a[0], a[1], a[2]),
    "shares": lambda home, config, a: api_shares(home),
    "share-prepare": lambda home, config, a: api_share_prepare(home, a[0], a[1]),
    "share-stop": lambda home, config, a: api_share_stop(home, a[0]),
    "activity": lambda home, config, a: api_activity(home, a[0], a[1]),
    "diff": lambda home, config, a: api_diff(home, a[0], a[1], a[2]),
    "remove": lambda home, config, a: api_remove(home, a[0]),
    "contexts": lambda home, config, a: api_contexts(home, config),
    "clear": lambda home, config, a: api_clear(home, a[0]),
    "setup": lambda home, config, a: api_setup(home, a[0]),
    "write-text": lambda home, config, a: api_write_text(home, a[0], a[1], stdin_bytes(TEXT_MAX_BYTES)),
    "handoff": lambda home, config, a: api_handoff(home, a[0], a[1], sys.stdin.buffer),
    "upload-dir": lambda home, config, a: api_upload_dir(home, a[0], a[1], sys.stdin.buffer),
    "log": lambda home, config, a: {"lines": log_tail(a[0] or 500), "path": log_path()},
    "checkpoints": lambda home, config, a: api_checkpoints(home, a[0], config),
    "checkpoint": lambda home, config, a: api_checkpoint(home, a[0], a[1]),
    "checkpoint-diff": lambda home, config, a: api_checkpoint_diff(home, a[0], a[1], a[2]),
    "restore": lambda home, config, a: api_restore(home, a[0], a[1], [f for f in a[2:] if f]),
    "stop": lambda home, config, a: api_stop(home, a[0], a[1]),
    "label": lambda home, config, a: api_label(home, a[0], a[1], a[2], a[3]),
    "mark": lambda home, config, a: api_mark(home, a[0], a[1], a[2], a[3]),
    "conversations": lambda home, config, a: api_conversations(home),
}


def clean_json(value):
    """JSON text without lone surrogates (a file name that is not UTF-8): those become a
    question mark, the rest of the answer stays readable."""
    text = json.dumps(value, sort_keys=True)
    if "\\ud" not in text:  # the usual case: nothing to clean
        return text
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8", "replace").decode("utf-8")


def run_api(args):
    home = home_dir()
    config, warning = load_config(home)
    command, rest = (args[0], args[1:]) if args else ("?", [])
    if command == "watch":
        return api_watch(home, config)
    started = time.monotonic()
    try:
        if command not in API_COMMANDS:
            raise ApiError(f"unknown command: {command}" if args else "missing command")
        result = API_COMMANDS[command](home, config, rest + [""] * 4)
    except (ApiError, OSError, ValueError) as exc:
        log("warn", f"api.{command}", ms=api_ms(started), err=str(exc), **api_log_fields(command, rest))
        print(json.dumps({"api": API_VERSION, "error": str(exc)}))
        return 1
    except Exception as exc:  # noqa: BLE001 - a bug: logged with its traceback, reported in one line
        log("error", f"api.{command}", trace=traceback.format_exc(), ms=api_ms(started),
            err=f"{type(exc).__name__}: {exc}", **api_log_fields(command, rest))
        print(json.dumps({"api": API_VERSION, "error": f"the picker failed ({type(exc).__name__}: {exc}); "
                                                     f"the details are in {pretty_path(log_path(), home)}"}))
        return 1
    level = "debug" if command in API_READS else "info"
    log(level, f"api.{command}", ms=api_ms(started), **api_log_fields(command, rest),
        **{key: result[key] for key in API_LOGGED if key in result and not isinstance(result[key], (dict, list))})
    result["api"] = API_VERSION
    if warning:
        result["warning"] = warning
    try:
        print(clean_json(result))
    except BrokenPipeError:  # Pier went away: the action is done anyway
        pass
    return 0


# --- watch: one connection that tells what changes ---------------------------------------
#
# --api watch stays open for as long as Pier is connected. Pier writes on its stdin
# what it wants to follow, one JSON object per line, for example
#   {"projects": true, "activity": {"project": "/home/leo/work", "file": null},
#    "setup": "/home/leo/work", "checkpoints": null, "contexts": true, "log": false}
# (a key left out keeps its value; {"poke": true} refreshes everything now). The picker
# answers with a line each time one of them changes, and only then:
#   {"kind": "activity", "for": {...}, "data": {...the same reply as --api activity...}}
#   {"kind": "log", "lines": [...]}            new lines of this program's log
#   {"kind": "setup", "for": "...", "error": "..."}
# It replaces Pier asking every few seconds, each time over a new SSH command: a
# running Pi is seen within a second, and nothing is sent while nothing changes. It
# ends when its stdin closes, that is, when Pier disconnects.

WATCH_TICK = 1.0
# The longest a part goes without being looked at again; most also look at what they
# read (file sizes and times) and refresh as soon as that moves.
WATCH_EVERY = {"projects": 1, "contexts": 4, "activity": 3, "setup": 15, "checkpoints": 10, "log": 1,
               "conversations": 10}
# The shortest a part waits between two rebuilds even when its inputs move (a working
# Pi writes its session file several times a second).
WATCH_MIN = {"setup": 3, "conversations": 5, "checkpoints": 2}


def watch_signature(kind, value, home):
    """What a part depends on, cheap to read: when it moves, the part is refreshed now."""
    def stat(path):
        try:
            st = os.stat(path)
            return st.st_size, st.st_mtime_ns
        except OSError:
            return None
    if kind == "activity" and isinstance(value, dict):
        project = value.get("project") or ""
        return stat(value.get("file") or latest_session_file(project) or ""), stat(session_dir(project))
    if kind == "setup":
        folder = session_dir(value)
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            names = []
        texts = [stat(os.path.join(value, n)) for n in ("AGENTS.md", "CLAUDE.md", ".pi", os.path.join(".pi", "devbox-history"))]
        said = (stat(os.path.join(pier_dir(), "pis")), stat(versions_path(home)))
        # How many conversations, not their sizes: a working Pi does not move Setup.
        return sum(1 for n in names if n.endswith(".jsonl")), texts, said
    if kind == "conversations":
        root = sessions_root()
        try:
            folders = sorted(os.listdir(root))
        except OSError:
            folders = []
        pis = sorted((n, p["path"], p.get("file")) for n, p in pi_sessions().items())
        return ([(n, stat(os.path.join(root, n))) for n in folders], stat(os.path.join(pier_dir(), "pis")),
                stat(labels_path(home)), pis)
    if kind == "checkpoints":
        store = checkpoint_store(value)
        return stat(os.path.join(store, "refs", "devbox")), stat(os.path.join(store, "packed-refs"))
    if kind == "log":
        return stat(log_path())
    return None


def watch_part(kind, value, home, config):
    if kind == "projects":
        return api_projects(home, config)
    if kind == "contexts":
        return api_contexts(home, config)
    if kind == "activity":
        return api_activity(home, value.get("project") or "", value.get("file") or "")
    if kind == "setup":
        return api_setup(home, value)
    if kind == "checkpoints":
        return api_checkpoints(home, value, config)
    if kind == "conversations":
        return api_conversations(home)
    raise ApiError(f"unknown part: {kind}")


def api_watch(home, config, stdin=None, stdout=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    inbox = queue.Queue()

    def read():
        try:
            for line in stdin:
                inbox.put(line)
        except (OSError, ValueError):
            pass
        inbox.put(None)

    threading.Thread(target=read, daemon=True).start()
    started = time.monotonic()
    want = {"projects": True}
    sent, due, marks, ran = {}, {}, {}, {}
    log_offset = None
    log("info", "watch.start")

    def emit(message, text=None):
        stdout.write((text or json.dumps(message)) + "\n")
        stdout.flush()

    def take(line):
        nonlocal log_offset
        try:
            message = json.loads(line)
        except ValueError:
            log("warn", "watch.bad-line", line=line[:200])
            return
        if not isinstance(message, dict):
            return
        if message.pop("poke", False):
            for table in (sent, due, marks, ran):
                table.clear()
        for kind, value in message.items():
            if kind not in WATCH_EVERY:
                continue
            want[kind] = value
            for table in (sent, due, marks, ran):
                table.pop(kind, None)
            if kind == "log":
                log_offset = None
        log("debug", "watch.want", want=want)

    try:
        while True:
            now = time.monotonic()
            for kind, value in list(want.items()):
                if not value:
                    continue
                if kind == "log":
                    try:
                        log_offset = watch_log(emit, log_offset)
                    except OSError as exc:  # rotated meanwhile, unreadable: next tick
                        log_offset = None
                        log("debug", "watch.log-failed", err=str(exc))
                    continue
                try:
                    signature = watch_signature(kind, value, home)
                except Exception as exc:  # noqa: BLE001 - a bad value sent for one part
                    signature = f"failed: {exc}"
                if now < due.get(kind, 0) and marks.get(kind, "?") == signature:
                    continue
                if now - ran.get(kind, -1e9) < WATCH_MIN.get(kind, 0):
                    continue  # moved again too soon: rebuilt at a later tick
                ran[kind] = now
                due[kind] = now + WATCH_EVERY[kind]
                marks[kind] = signature
                try:
                    message = {"kind": kind, "for": value, "data": watch_part(kind, value, home, config)}
                except (ApiError, OSError, ValueError) as exc:
                    message = {"kind": kind, "for": value, "error": str(exc)}
                except Exception as exc:  # noqa: BLE001 - one part failing leaves the others
                    log("error", f"watch.{kind}", trace=traceback.format_exc(), err=f"{type(exc).__name__}: {exc}")
                    message = {"kind": kind, "for": value, "error": f"the picker failed ({type(exc).__name__}: {exc})"}
                text = clean_json(message)
                if sent.get(kind) != text:
                    sent[kind] = text
                    emit(message, text)
            try:
                line = inbox.get(timeout=WATCH_TICK)
            except queue.Empty:
                continue
            while line is not None:
                take(line)
                try:
                    line = inbox.get_nowait()
                except queue.Empty:
                    break
            if line is None:
                break
    except (BrokenPipeError, KeyboardInterrupt):
        pass
    log("info", "watch.end", seconds=int(time.monotonic() - started))
    return 0


def watch_log(emit, offset):
    """New lines of the log since offset (None: from its end, they were read already)."""
    path = log_path()
    try:
        size = os.path.getsize(path)
    except OSError:
        return offset
    if offset is None or size < offset:
        return size if offset is None else 0
    if size == offset:
        return offset
    with open(path, "rb") as handle:
        handle.seek(offset)
        chunk = handle.read(size - offset)
    end = chunk.rfind(b"\n")
    if end < 0:
        return offset
    lines = chunk[:end].decode("utf-8", "replace").splitlines()
    # The watch's own lines would echo forever.
    lines = [line for line in lines if " watch." not in line]
    if lines:
        emit({"kind": "log", "lines": lines})
    return offset + end + 1


def attach_control(path, extra):
    """--attach-control DIR [ARGS]: the Pi that --attach would open (see open_pi),
    joined in tmux's control mode, for Pier's Pi tabs. tmux keeps Pi alive but draws
    nothing: Pier receives Pi's own output and renders it, so Pi's history lands in
    Pier's scrollback (through tmux's screen it never would). No pseudo-terminal, no
    pause: errors go to stderr, which Pier shows."""
    home = home_dir()
    config, _ = load_config(home)
    try:
        project = resolve_inside(home, path)
    except ApiError as exc:
        print(exc, file=sys.stderr)
        return 1
    if not shutil.which("tmux"):
        print("tmux is missing on the VM, and Pier runs Pi in it: sudo apt install tmux", file=sys.stderr)
        return 1
    state = load_state(home)
    add_recent(state, project)
    save_state(home, state)
    env = child_env(home)
    try:
        name, fresh = open_pi(project, extra, env, home, 120, 40)
    except ApiError as exc:
        print(exc, file=sys.stderr)
        log("warn", "attach-control.failed", project=project, err=str(exc))
        return 1
    tmux_server_options(env, config)
    log("info", "attach-control", project=project, slot=name, started=fresh, args=list(extra) or None)
    os.execvpe("tmux", tmux_cmd("-C", "attach-session", "-t", f"={name}"), env)


def api_ms(started):
    return int((time.monotonic() - started) * 1000)


def attach(path, extra):
    """Start or join the Pi of path in tmux, replacing this process with the attach.

    For the desktop client, which opens a terminal on "ssh -t vm pi-pick --attach DIR":
    detaching or quitting Pi ends the SSH session and closes that window.
    """
    home = home_dir()
    config, _ = load_config(home)
    try:
        project = resolve_inside(home, path)
    except ApiError as exc:
        print(exc, file=sys.stderr)
        pause_for_enter("press Enter to close ")
        return 1
    state = load_state(home)
    add_recent(state, project)
    save_state(home, state)
    if not config["tmux"] or not shutil.which("tmux"):
        if extra[:1] == ["--slot"]:
            print("without tmux, only one Pi runs, in this terminal", file=sys.stderr)
            pause_for_enter("press Enter to close ")
            return 1
        return exec_pi(project, [] if list(extra) == ["--new"] else extra)
    env = child_env(home)
    size = shutil.get_terminal_size((100, 30))
    try:
        name, fresh = open_pi(project, extra, env, home, size.columns, size.lines)
    except ApiError as exc:
        print(exc, file=sys.stderr)
        log("warn", "attach.failed", project=project, err=str(exc))
        pause_for_enter("press Enter to close ")
        return 1
    tmux_server_options(env, config)
    log("info", "attach", project=project, slot=name, started=fresh, args=list(extra) or None)
    os.execvpe("tmux", tmux_cmd("attach-session", "-t", f"={name}"), env)


# --- text ------------------------------------------------------------------------------

def clean(text):
    """Printable form of a name: undecodable bytes and control characters become visible marks."""
    try:
        raw = text.encode("utf-8", "surrogateescape")
    except UnicodeEncodeError:
        raw = text.encode("utf-8", "replace")
    text = raw.decode("utf-8", "replace")
    return "".join(ch if ch.isprintable() else "?" for ch in text)


def pretty_path(path, home):
    rel = os.path.relpath(path, home)
    return "~" if rel == "." else "~/" + clean(rel)


def char_width(ch):
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def text_width(text):
    return sum(map(char_width, text))


def fit(text, width):
    """text cut to at most width terminal cells; an ellipsis marks the cut."""
    if width <= 0:
        return ""
    if text_width(text) <= width:
        return text
    out, used = [], 0
    for ch in text:
        w = char_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return "".join(out) + ELLIPSIS


def fit_left(text, width):
    """Like fit, but keeps the end of text: for paths, the last segments matter."""
    if width <= 0:
        return ""
    if text_width(text) <= width:
        return text
    out, used = [], 0
    for ch in reversed(text):
        w = char_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return ELLIPSIS + "".join(reversed(out))


def ago(stamp, now=None):
    seconds = max(0, (now or time.time()) - stamp)
    for unit, size in (("y", 31536000), ("mo", 2592000), ("d", 86400), ("h", 3600), ("min", 60)):
        if seconds >= size:
            return f"{int(seconds // size)}{unit} ago"
    return "just now"


def put(scr, y, x, text, attr=0, width=None):
    """addstr that clips to the window and never raises."""
    h, w = scr.getmaxyx()
    if not (0 <= y < h and 0 <= x < w):
        return
    room = w - x if width is None else min(width, w - x)
    text = fit(text, room)
    if not UNICODE:
        text = text.encode(ENCODING, "replace").decode(ENCODING)
    try:
        scr.addstr(y, x, text, attr)
    except curses.error:
        pass  # writing the bottom-right cell raises after drawing it


def show_cursor(visible):
    try:
        curses.curs_set(1 if visible else 0)
    except curses.error:
        pass


# --- picker ----------------------------------------------------------------------------

class Entry:
    """A listed row. kind: "parent" (..), "dir" (in cwd), "recent", "found" (search)."""

    __slots__ = ("kind", "path", "name", "label", "enterable", "branch", "activity")

    def __init__(self, kind, path, label, enterable=True, branch=None, stamp=0.0):
        self.kind = kind
        self.path = path
        self.name = os.path.basename(path)
        self.label = label
        self.enterable = enterable
        self.branch = branch
        self.activity = stamp

    @property
    def is_parent(self):
        return self.kind == "parent"


def make_entry(kind, path, label):
    return Entry(kind, path, label, is_enterable(path), git_branch(path), activity(path))


class Picker:
    def __init__(self, stdscr, start, grey, config, warning=None):
        self.scr = stdscr
        self.grey = grey
        self.config = config
        self.ignore = set(config["ignore"])
        self.home = home_dir()
        self.state = load_state(self.home)
        self.changed = threading.Event()
        self.git = Background(git_status, self.changed)
        self.previews = Background(preview_info, self.changed)
        self.cwd = self.home
        self.filter = ""
        self.search = None        # the query while the search results are listed, else None
        self.typing = None        # "filter" or "search" while keystrokes go to the query
        self.index = None         # every directory under home, built when f is first used
        self.running = {}         # project -> how many Pis run there
        self.tmux_declined = False
        self.message = warning or ""
        self.entries = []         # every subdirectory of cwd
        self.view = []            # the listed rows
        self.sel = 0              # index into view
        self.offset = 0
        self.rows = 1
        self.goto(start)

    # navigation

    def has_parent(self):
        return self.cwd != self.home and within(self.cwd, self.home)

    def parent(self):
        return os.path.dirname(self.cwd) or os.sep

    def pretty(self, path):
        return pretty_path(path, self.home)

    def load(self):
        # Folders Pi may not run in (~/bin, where the picker is; ~/.ssh...) are not shown:
        # nothing to start there by mistake.
        self.entries = [make_entry("dir", os.path.join(self.cwd, name), clean(name))
                        for name in list_dirs(self.cwd, self.ignore)
                        if openable(os.path.join(self.cwd, name), self.home, self.config)]
        self.running = self.tmux_sessions()

    def recent_entries(self):
        out = []
        for path in self.state["recent"]:
            if len(out) >= self.config["recent_count"]:
                break
            if within(path, self.home) and os.path.isdir(path) and openable(path, self.home, self.config):
                out.append(make_entry("recent", path, self.pretty(path)))
        return out

    def sorted_entries(self):
        if self.state["sort"] == "activity":
            return sorted(self.entries, key=lambda e: -e.activity)
        return self.entries

    def search_results(self):
        needle = (self.search or "").casefold()
        if not needle:
            return []
        self.ensure_index()
        scored = []
        for path, hay, label in self.index:
            score = match_score(needle, hay)
            if score is not None and openable(path, self.home, self.config):
                scored.append((score, path, label))
        scored.sort(key=lambda item: item[0])
        return [make_entry("found", path, label) for _, path, label in scored[:SEARCH_SHOWN]]

    def ensure_index(self):
        if self.index is not None:
            return
        self.message = "searching your directories..."
        self.draw()
        self.message = ""
        self.index = []
        for path in walk_dirs(self.home, self.config["search_depth"], self.ignore):
            rel = os.path.relpath(path, self.home)
            self.index.append((path, rel.casefold(), clean(rel)))

    def apply_filter(self, select=None):
        """Rebuild view. select is a path to keep selected; otherwise the first row after '..'."""
        if self.search is not None:
            head, items = [], self.search_results()
        else:
            needle = self.filter.casefold()
            pool = (self.recent_entries() if self.cwd == self.home else []) + self.sorted_entries()
            items = [e for e in pool if needle in e.label.casefold()]
            head = [Entry("parent", self.parent(), "..")] if self.has_parent() else []
        self.view = head + items
        self.git.request([e.path for e in items if e.branch is not None])
        for index, entry in enumerate(self.view):
            if not entry.is_parent and entry.path == select:
                self.sel = index
                return
        self.sel = len(head) if items else 0

    def goto(self, path, select=None):
        path = os.path.realpath(path)
        if not within(path, self.home) or not os.path.isdir(path):
            path = self.home
        self.cwd = path
        self.filter = ""
        self.search = None
        self.typing = None
        self.offset = 0
        self.load()
        self.apply_filter(select)

    def go_up(self):
        if self.has_parent():
            self.goto(self.parent(), select=self.cwd)

    def reload(self):
        """Re-read everything after Pi, a shell or git, which may have changed anything."""
        self.git.forget()
        self.previews.forget()
        self.index = None
        path = self.cwd
        while not os.path.isdir(path) and path != self.home:
            path = os.path.dirname(path)
        if path != self.cwd:
            self.goto(path)
            return
        current = self.current()
        self.load()
        self.apply_filter(current.path if current and not current.is_parent else None)

    def current(self):
        if not self.view:
            return None
        self.sel = max(0, min(self.sel, len(self.view) - 1))
        return self.view[self.sel]

    def keep_path(self):
        current = self.current()
        return current.path if current and not current.is_parent else None

    def selected_dir(self):
        """The highlighted directory when Pi can start in it, else None ('..' is not a project)."""
        entry = self.current()
        if entry is None or entry.is_parent or not entry.enterable:
            return None
        return entry

    def move(self, delta):
        if self.view:
            self.sel = max(0, min(len(self.view) - 1, self.sel + delta))

    def open_current(self):
        entry = self.current()
        if entry is None:
            return
        if entry.is_parent:
            self.go_up()
        elif entry.enterable:
            self.goto(entry.path)
        else:
            self.message = f"cannot open {entry.label}: permission denied"

    def leave_query(self):
        """Esc: drop the filter or the search and go back to the plain listing."""
        keep = self.keep_path() if self.search is None else None
        self.filter = ""
        self.search = None
        self.typing = None
        self.apply_filter(keep)

    # pi and tmux

    def remember(self, path):
        add_recent(self.state, path)
        save_state(self.home, self.state)

    def tmux_sessions(self):
        if not self.config["tmux"] or os.environ.get("TMUX"):
            return {}
        return dict(collections.Counter(s["path"] for s in pi_sessions().values()))

    def is_running(self, path):
        return self.running.get(path, 0) > 0

    def tmux_mode(self):
        """True: run Pi in tmux. False: run it directly. None: the user cancelled.

        Inside tmux already, the picker itself survives a disconnect and Pi with it.
        """
        if not self.config["tmux"] or os.environ.get("TMUX"):
            return False
        if shutil.which("tmux"):
            return True
        if self.tmux_declined:
            return False
        answer = self.choose("tmux is missing, pi stops if the connection drops.  "
                             "i install it   enter run without   esc cancel")
        if answer == "i":
            self.install_tmux()
            return True if shutil.which("tmux") else None
        if answer == "enter":
            self.tmux_declined = True
            return False
        return None

    def install_tmux(self):
        """Install tmux with the system's package manager, in the foreground: sudo asks
        for the password itself, the picker never sees it."""
        for tool, argv in INSTALLERS:
            if shutil.which(tool):
                break
        else:
            self.message = "no known package manager: install tmux yourself"
            return
        if os.geteuid() != 0:
            if not shutil.which("sudo"):
                self.message = f"sudo is missing: as root, run {shlex.join(argv)}"
                return
            argv = ["sudo", *argv]
        self.run_child(argv, self.home, child_env(self.home), "install", pause="always",
                       announce=f"installing tmux: {shlex.join(argv)}")
        if shutil.which("tmux"):
            self.message = "tmux installed"

    def launch_pi(self, path, extra=()):
        env = child_env(self.home)
        argv = pi_argv(self.config, env)
        if argv is None:
            self.message = "pi not found on PATH: install it or set PI_BIN"
            return
        if sandbox_wanted(self.config) and not shutil.which("bwrap"):
            self.message = SANDBOX_MISSING
            return
        mode = self.tmux_mode()
        if mode is None:
            return
        self.remember(path)
        key, warning = read_hindsight_key(self.home)
        if mode:
            self.pi_in_tmux(path, list(extra), env)
        else:
            if list(extra) == ["--new"]:
                extra = []  # without tmux, one Pi at a time, in this terminal
            # The same entry point as in tmux: sandbox, key and restore points in one place.
            # It reports its own startup errors, hence no pause here.
            self.run_child([sys.executable, SCRIPT, "--exec-pi", path, *extra], path, env, "pi", pause="never")
        if warning and not self.message:
            self.message = warning

    def pi_in_tmux(self, path, extra, env):
        """Attach to the Pi already running in path, or start one in a new tmux session.

        Detaching (ctrl-b d) comes back to the picker and leaves Pi running; quitting Pi
        ends the session and comes back too.
        """
        h, w = self.scr.getmaxyx()
        try:
            name, fresh = open_pi(path, extra, env, self.home, w, h)
        except ApiError as exc:
            self.message = str(exc)
            return
        if extra and not fresh:
            self.message = "a pi already runs that conversation: attached to it"
        tmux_server_options(env, self.config)
        if os.environ.get("DEVBOX_REQUEST"):
            # Inside Pier: Pi opens in a Pier tab, which shows it through tmux's
            # control mode, history included. The request is an OSC sequence that only
            # Pier's picker tab acts on; the picker stays here.
            n = slot_number(name, path, self.home)
            request = json.dumps({"project": path, "label": self.pretty(path), "slot": name, "n": n})
            os.write(sys.stdout.fileno(), f"\x1b]7770;open-pi;{request}\x07".encode())
            self.message = f"pi opened in a Pier tab: {self.pretty(path)}" + (f" #{n}" if n > 1 else "")
            self.running = self.tmux_sessions()
            return
        self.run_child(tmux_cmd("attach-session", "-t", f"={name}"), path, env, "tmux", pause="error")

    def stop_pi(self):
        target = self.selected_dir()
        path = target.path if target else self.cwd
        count = self.running.get(path, 0)
        if not count:
            self.message = "no pi running there"
            return
        what = "the pi" if count == 1 else f"the {count} pis"
        answer = self.choose(f"stop {what} in {self.pretty(path)}? unsaved work is lost.  y yes   other key no")
        if answer != "y":
            return
        for pi in project_pis(pi_sessions(), path):
            run_quiet(tmux_cmd("kill-session", "-t", f"={pi['name']}"), child_env(self.home))
            forget_pi_sessions()
        self.running = self.tmux_sessions()
        self.message = "pi stopped" if count == 1 else f"{count} pis stopped"

    def launch_shell(self, path):
        shell = os.environ.get("SHELL") or "/bin/sh"
        self.run_child([shell], path, child_env(self.home), "shell")

    def run_child(self, argv, path, env, name, pause="quick", announce=None):
        """Run argv in path with the whole terminal, then come back to the picker.

        Not exec: replacing the process would close the SSH session when the child quits.
        curses hands the terminal over and takes it back, hence endwin/reset_prog_mode.
        The working directory is fixed before the child starts: Pi reads its project
        config, resources and memory at startup and keys its Hindsight bank on it.

        pause: "quick" holds the screen when the child fails within 3 seconds (a startup
        error to read), "error" when it fails at all, "always" in every case, "never" never.
        """
        if curses.isendwin():
            # Two children in a row with nothing drawn between them (tmux installed,
            # then Pi): curses still counts the terminal as handed over, and endwin
            # fails when called twice. A refresh takes it back first.
            self.scr.refresh()
        curses.def_prog_mode()
        curses.endwin()
        previous = ignore_terminal_signals()
        status, error = None, None
        try:
            if announce:
                print(announce, file=sys.stderr)
            started = time.monotonic()
            try:
                status = wait_child(subprocess.Popen(argv, cwd=path, env=env))
            except OSError as exc:
                error = f"cannot run {name}: {exc.strerror or exc}"
            failed = bool(error or status)
            quick = time.monotonic() - started < 3
            log("warn" if failed else "debug", f"child.{name}", status=status, err=error,
                seconds=round(time.monotonic() - started, 1))
            if pause == "always" or (failed and pause != "never" and (pause == "error" or quick)):
                if failed:
                    print(error or f"{name} exited with status {status}", file=sys.stderr)
                pause_for_enter()
        finally:
            restore_signals(previous)
            curses.reset_prog_mode()
            sync_size()
            self.scr.clear()
            self.scr.refresh()
        if error:
            self.message = error
        elif status:
            self.message = f"{name} exited with status {status}"
        self.reload()

    # directory actions

    def new_dir(self):
        name = self.ask("new dir: ")
        if name is None:
            return
        name = unicodedata.normalize("NFC", name.strip())
        if not name:
            return
        if not valid_name(name):
            self.message = "invalid name: letters, digits, . _ - only, starting with a letter or digit"
            return
        path = os.path.join(self.cwd, name)
        if os.path.isdir(path):
            self.message = f"{name} already exists"
        else:
            try:
                os.mkdir(path)
            except OSError as exc:
                self.message = f"cannot create {name}: {exc.strerror or exc}"
                return
            self.index = None
            self.message = f"created {name}, p launches pi in it"
        self.filter = ""
        self.load()
        self.apply_filter(select=path)

    def clone(self):
        url = self.ask("git clone ")
        if url is None or not url.strip():
            return
        url = url.strip()
        if not valid_clone_url(url):
            self.message = "not a git url: https://, ssh://, git://, file:// or user@host:path"
            return
        name = clone_name(url)
        if not valid_name(name):
            self.message = f"cannot name a directory after {url}"
            return
        target = os.path.join(self.cwd, name)
        if os.path.lexists(target):
            self.message = f"{name} already exists"
            return
        self.run_child(["git", "clone", "--", url, name], self.cwd, child_env(self.home),
                       "git clone", pause="error", announce=f"git clone {url}")
        if os.path.isdir(target):
            self.message = f"cloned {name}, p launches pi in it"
            self.filter = ""
            self.search = None
            self.apply_filter(select=target)

    def rename(self):
        entry = self.selected_dir()
        if entry is None:
            self.message = "select a directory to rename"
            return
        if self.is_running(entry.path):
            self.message = f"a pi runs in {entry.name}: stop it first (x)"
            return
        new = self.ask("rename to: ", entry.name)
        if new is None:
            return
        new = unicodedata.normalize("NFC", new.strip())
        if not new or new == entry.name:
            return
        if not valid_name(new):
            self.message = "invalid name: letters, digits, . _ - only, starting with a letter or digit"
            return
        target = os.path.join(os.path.dirname(entry.path), new)
        if os.path.lexists(target):
            self.message = f"{new} already exists"
            return
        try:
            os.rename(entry.path, target)
        except OSError as exc:
            self.message = f"cannot rename: {exc.strerror or exc}"
            return
        prefix = entry.path + os.sep
        self.state["recent"] = [target + p[len(entry.path):] if p == entry.path or p.startswith(prefix) else p
                                for p in self.state["recent"]]
        save_state(self.home, self.state)
        self.index = None
        self.message = f"renamed to {new}; pi's memory bank stays under the old name"
        self.load()
        self.apply_filter(select=target)

    def toggle_sort(self):
        self.state["sort"] = "activity" if self.state["sort"] == "name" else "name"
        save_state(self.home, self.state)
        self.message = "sorted by recent activity" if self.state["sort"] == "activity" else "sorted by name"
        self.apply_filter(self.keep_path())

    def start_search(self):
        self.search = ""
        self.typing = "search"
        self.offset = 0
        self.ensure_index()
        self.apply_filter()

    # prompts

    def ask(self, label, initial=""):
        """Line editor under the path. Returns the text, or None on Escape."""
        buf = initial
        while True:
            key = self.wait_key((label, buf))
            if key in ENTER:
                return buf
            if key in (ESCAPE, CTRL_C):
                return None
            if key in BACKSPACE:
                buf = buf[:-1]
            elif key == CTRL_U:
                buf = ""
            elif isinstance(key, str) and key.isprintable() and len(buf) < 1024:
                buf += key

    def choose(self, prompt):
        """One key answering prompt: "enter", a character, or None for Escape."""
        while True:
            key = self.wait_key((prompt, ""))
            if key == curses.KEY_RESIZE:
                continue
            if key in ENTER:
                return "enter"
            if key in (ESCAPE, CTRL_C):
                return None
            return key if isinstance(key, str) else None

    def show_help(self):
        drawn = False
        while True:
            if not drawn:
                self.draw_help()
                drawn = True
            key = self.read_key()
            if key == curses.KEY_RESIZE:
                drawn = False
            elif key is not None:
                return

    # drawing

    def input_line(self):
        if self.typing == "filter":
            return ("filter: ", self.filter)
        if self.typing == "search":
            return ("find: ", self.search)
        return None

    def draw(self, input_line=None):
        self.changed.clear()
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 10 or w < 40:
            put(scr, 0, 0, "terminal too small", 0, w - 1)
            show_cursor(False)
            scr.refresh()
            return
        if h >= BANNER_MIN_ROWS:
            top = self.draw_banner(w)
        else:
            top = 1
            put(scr, 0, 2, "pi dir picker", curses.A_BOLD, w - 4)

        width = w - 4
        title = f"find in {self.pretty(self.home)}" if self.search is not None else clean(self.cwd)
        put(scr, top, 2, fit_left(title, width))
        cursor = None
        if input_line:
            label, text = input_line
            shown = fit_left(text, width - text_width(label) - 1)
            put(scr, top + 1, 2, label + shown, 0, width)
            cursor = (top + 1, min(2 + text_width(label) + text_width(shown), w - 3))
        elif self.search is not None:
            put(scr, top + 1, 2, f"find: {self.search}", self.grey, width)
        elif self.filter:
            put(scr, top + 1, 2, f"filter: {self.filter}", self.grey, width)

        list_top = top + 2
        self.rows = max(1, h - 3 - list_top)
        list_w = int(w * 0.55) if self.config["preview"] and w >= PREVIEW_MIN_COLS else w
        self.draw_list(list_top, list_w)
        if list_w < w:
            self.draw_preview(list_top, list_w + 1, w - list_w - 3)
        self.draw_footer(h, w)
        if cursor:
            show_cursor(True)
            scr.move(*cursor)
        else:
            show_cursor(False)
        scr.refresh()

    def draw_banner(self, w):
        logo_w = max(text_width(line) for line in LOGO)
        x = max(2, (w - logo_w) // 2)
        for i, line in enumerate(LOGO):
            put(self.scr, 1 + i, x, line, curses.A_BOLD, w - 2 - x)
        # The version sits on the baseline, the row where the letters end.
        put(self.scr, 1 + LOGO_BASELINE, x + logo_w + 1, f"v{VERSION}", curses.A_BOLD, w - 3 - x - logo_w)
        subtitle = "dir picker"
        put(self.scr, 1 + len(LOGO), max(2, (w - len(subtitle)) // 2), subtitle, self.grey)
        return len(LOGO) + 3

    def git_text(self, entry):
        if not entry.branch:
            return ""
        text = clean(entry.branch)
        status = self.git.get(entry.path)
        if status:
            if status["dirty"]:
                text += "*"
            if status["ahead"]:
                text += f" {AHEAD}{status['ahead']}"
            if status["behind"]:
                text += f" {BEHIND}{status['behind']}"
        return text

    def draw_list(self, list_top, lw):
        scr, rows = self.scr, self.rows
        if self.sel < self.offset:
            self.offset = self.sel
        elif self.sel >= self.offset + rows:
            self.offset = self.sel - rows + 1
        self.offset = max(0, min(self.offset, len(self.view) - rows))

        for i, entry in enumerate(self.view[self.offset:self.offset + rows]):
            y = list_top + i
            index = self.offset + i
            text = "../" if entry.is_parent else entry.label + ("" if entry.label.endswith("/") else "/")
            count = 0 if entry.is_parent else self.running.get(entry.path, 0)
            running = "" if not count else "[pi]" if count == 1 else f"[pi {count}]"
            git = "" if entry.is_parent else fit(self.git_text(entry), (lw - 4) // 3)
            tail_w = text_width(running) + text_width(git) + (2 if running and git else 0)
            text = fit(text, lw - 4 - (tail_w + 2 if tail_w else 0))
            if index == self.sel:
                line = " " + text
                for part in (running, git):
                    if part:
                        line += "  " + part
                line += " " * max(0, lw - 2 - text_width(line))
                put(scr, y, 1, line, curses.A_REVERSE, lw - 2)
                continue
            attr = 0 if entry.is_parent or entry.enterable else self.grey
            put(scr, y, 2, text, attr, lw - 4)
            x = 4 + text_width(text)
            if running:
                put(scr, y, x, running, curses.A_BOLD, lw - 2 - x)
                x += text_width(running) + 2
            if git:
                put(scr, y, x, git, self.grey, lw - 2 - x)

        listed = len(self.view) - (1 if self.view and self.view[0].is_parent else 0)
        if not listed:
            if self.search is not None:
                note = (f"type to find a directory under ~ ({self.config['search_depth']} levels deep)"
                        if not self.search else "nothing found")
            elif self.entries:
                note = "(nothing matches the filter)"
            else:
                note = "(no directories here, n creates one)"
            put(scr, list_top + len(self.view), 2, note, self.grey, lw - 4)
        if self.offset > 0:
            put(scr, list_top, lw - 2, AHEAD if UNICODE else "^", self.grey)
        if self.offset + rows < len(self.view):
            put(scr, list_top + rows - 1, lw - 2, BEHIND if UNICODE else "v", self.grey)

    def draw_preview(self, top, x, width):
        entry = self.current()
        if entry is None or entry.is_parent:
            return
        self.previews.request([entry.path])
        info = self.previews.get(entry.path)
        lines = [(clean(entry.name) + "/", curses.A_BOLD), (self.pretty(entry.path), self.grey)]
        if entry.activity:
            lines.append((f"changed {ago(entry.activity)}", self.grey))
        lines.append(("", 0))
        if self.is_running(entry.path):
            count = self.running.get(entry.path, 0)
            lines.append(("[pi] running: p goes back to it, x stops it" if count == 1 else
                          f"[pi {count}] running: p goes back to the last used, x stops them", curses.A_BOLD))
        if entry.branch:
            detail = f"branch {clean(entry.branch)}"
            status = self.git.get(entry.path)
            if status:
                if status["dirty"]:
                    detail += ", uncommitted changes"
                if status["ahead"] or status["behind"]:
                    detail += f", {status['ahead']} ahead {status['behind']} behind"
            lines.append((detail, 0))
        if info is None:
            lines.append((ELLIPSIS, self.grey))
        else:
            for stamp, subject in info["commits"]:
                lines.append((f"{ago(stamp):>10}  {clean(subject)}", self.grey))
            if info["markers"]:
                lines += [("", 0), ("   ".join(info["markers"]), 0)]
            if info["readme"]:
                lines.append(("", 0))
                lines += [(clean(line), self.grey) for line in info["readme"]]
        for i, (text, attr) in enumerate(lines[:self.rows]):
            put(self.scr, top + i, x, text, attr, width)

    def draw_footer(self, h, w):
        scr = self.scr
        entry = self.current()
        if self.message:
            put(scr, h - 3, 2, self.message, curses.A_BOLD, w - 4)
        else:
            listed = len(self.view) - (1 if self.view and self.view[0].is_parent else 0)
            if self.search is not None:
                count = f"{listed} found"
            elif self.filter:
                count = f"{listed} shown"
            else:
                count = f"{len(self.entries)} dirs"
            if self.state["sort"] == "activity" and self.search is None:
                count += ", by activity"
            detail = f"{count}   {clean(entry.path)}" if entry else count
            put(scr, h - 3, 2, detail, self.grey, w - 4)

        can_open = entry is not None and (entry.is_parent or entry.enterable)
        has_target = self.selected_dir() is not None
        # (text, enabled, priority): on a narrow terminal the highest priorities go first.
        if self.typing:
            segments = [
                ("type to " + ("filter" if self.typing == "filter" else "find"), True, 0),
                ("up/down move", len(self.view) > 1, 3),
                ("right open", can_open, 2),
                ("enter keep", True, 1),
                ("esc clear", True, 1),
            ]
        else:
            segments = [
                ("up/down move", len(self.view) > 1, 7),
                ("enter open", can_open, 3),
                ("left up", self.has_parent() or self.search is not None, 6),
                ("p pi", has_target, 1),
                ("P here", True, 4),
                ("c continue", has_target, 5),
                ("/ filter", True, 5),
                ("f find", True, 4),
            ]
            if self.filter or self.search is not None:
                segments.append(("esc back", True, 2))
            segments += [("? help", True, 0), ("q quit", True, 0)]
        room = w - 4
        kept = set()
        for index in sorted(range(len(segments)), key=lambda i: segments[i][2]):
            cost = len(segments[index][0]) + (2 if kept else 0)
            if cost <= room:
                kept.add(index)
                room -= cost
        x = 2
        for index, (text, enabled, _) in enumerate(segments):
            if index in kept:
                put(scr, h - 2, x, text, 0 if enabled else self.grey)
                x += len(text) + 2

    def draw_help(self):
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        put(scr, 1, 2, "keys", curses.A_BOLD)
        key_w = max(len(k) for k, _ in HELP) + 3
        y = 3
        for keys, what in HELP:
            put(scr, y, 4, keys, curses.A_BOLD, w - 6)
            put(scr, y, 4 + key_w, what, 0, w - 6 - key_w)
            y += 1
        y += 1
        for note in HELP_NOTES:
            put(scr, y, 4, note, self.grey, w - 6)
            y += 1
        put(scr, y + 1, 4, f"settings: {self.pretty(config_path(self.home))}", self.grey, w - 6)
        put(scr, h - 2, 2, "any key to go back", self.grey, w - 4)
        show_cursor(False)
        scr.refresh()

    # input

    def read_key(self):
        try:
            return self.scr.get_wch()
        except curses.error:
            return None  # timeout

    def wait_key(self, input_line=None):
        """Draw, then wait for a key, redrawing whenever background results come in."""
        self.draw(input_line)
        checked = time.monotonic()
        while True:
            key = self.read_key()
            if key is not None:
                return key
            redraw = self.changed.is_set()
            # Pis start and stop elsewhere too (a Pier tab, Setup, Ctrl+D in Pi): the
            # [pi] marks follow, checked every 2 s while no key comes.
            if time.monotonic() - checked > 2:
                checked = time.monotonic()
                running = self.tmux_sessions()
                if running != self.running:
                    self.running = running
                    redraw = True
            if redraw:
                self.draw(input_line)

    def run(self):
        while True:
            key = self.wait_key(self.input_line())
            if key == curses.KEY_RESIZE:
                continue
            self.message = ""
            if key == CTRL_C:
                return
            if self.typing:
                self.typing_key(key)
            elif self.normal_key(key):
                return

    def typing_key(self, key):
        attr = "filter" if self.typing == "filter" else "search"
        text = getattr(self, attr)
        if key in ENTER:
            self.typing = None
        elif key == ESCAPE:
            self.leave_query()
        elif key in BACKSPACE:
            if text:
                setattr(self, attr, text[:-1])
                self.apply_filter()
            elif attr == "filter":
                self.typing = None
            else:
                self.leave_query()
        elif key == CTRL_U:
            setattr(self, attr, "")
            self.apply_filter()
        elif key == curses.KEY_UP:
            self.move(-1)
        elif key == curses.KEY_DOWN:
            self.move(1)
        elif key == curses.KEY_PPAGE:
            self.move(-self.rows)
        elif key == curses.KEY_NPAGE:
            self.move(self.rows)
        elif key == curses.KEY_RIGHT:
            self.open_current()
        elif key == curses.KEY_LEFT:
            if self.search is not None:
                self.leave_query()
            else:
                self.go_up()
        elif isinstance(key, str) and key.isprintable():
            setattr(self, attr, text + key)
            self.apply_filter()

    def normal_key(self, key):
        """Handle one key outside query typing. True means quit."""
        target = self.selected_dir()
        if key in (curses.KEY_UP, "k"):
            self.move(-1)
        elif key in (curses.KEY_DOWN, "j"):
            self.move(1)
        elif key == curses.KEY_PPAGE:
            self.move(-self.rows)
        elif key == curses.KEY_NPAGE:
            self.move(self.rows)
        elif key == curses.KEY_HOME:
            self.sel = 0
        elif key == curses.KEY_END:
            self.sel = max(0, len(self.view) - 1)
        elif key in (curses.KEY_RIGHT, "l") or key in ENTER:
            self.open_current()
        elif key in (curses.KEY_LEFT, "h") or key in BACKSPACE:
            if self.search is not None:
                self.leave_query()
            else:
                self.go_up()
        elif key in ("p", "c", "r", "N"):
            if target is None:
                self.message = "select a directory first (P starts pi here)"
            else:
                extra = {"p": [], "N": ["--new"], "c": self.config["continue_args"], "r": self.config["resume_args"]}[key]
                self.launch_pi(target.path, extra)
        elif key == "P":
            self.launch_pi(self.cwd)
        elif key == "x":
            self.stop_pi()
        elif key == "s":
            self.launch_shell(target.path if target else self.cwd)
        elif key == "n":
            self.new_dir()
        elif key == "g":
            self.clone()
        elif key == "R":
            self.rename()
        elif key == "t":
            self.toggle_sort()
        elif key == "/":
            if self.search is not None:
                self.leave_query()
            self.typing = "filter"
        elif key == "f":
            self.start_search()
        elif key == "?":
            self.show_help()
        elif key == CTRL_L:
            self.scr.clear()
        elif key == ESCAPE:
            if not self.filter and self.search is None:
                return True
            self.leave_query()
        elif key == "q":
            return True
        return False


def main(stdscr, start, config, warning):
    # raw: Ctrl-C and Ctrl-Z reach the picker as keys. As signals, Ctrl-C would kill
    # it with a traceback and Ctrl-Z would stop it with no shell to resume it.
    curses.raw()
    stdscr.keypad(True)
    stdscr.timeout(150)
    show_cursor(False)
    grey = curses.A_DIM
    if curses.has_colors():
        curses.start_color()
        try:
            curses.use_default_colors()
        except curses.error:
            pass
        if curses.COLORS >= 16:
            curses.init_pair(1, 8, -1)
            grey = curses.color_pair(1)
    Picker(stdscr, start, grey, config, warning).run()


def resolve_start(argv, config):
    """The directory given on the command line, else the configured one, kept inside home."""
    home = home_dir()
    for candidate in (argv[1] if len(argv) > 1 else None, config["start"]):
        if not candidate:
            continue
        candidate = os.path.realpath(os.path.expanduser(candidate))
        if os.path.isdir(candidate) and within(candidate, home):
            return candidate
    return home


USAGE = """usage: pi-dir-picker.py [DIR]
       pi-dir-picker.py --attach DIR [PI ARGS]
       pi-dir-picker.py --api COMMAND [ARGS]   (see the desktop client API section)

Pick a directory under your home and start Pi in it. Press ? inside for the keys.
--attach and --api serve the desktop client over SSH.
Settings: ~/.config/pi-dir-picker/config.toml"""


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--exec-pi":
        sys.exit(exec_pi(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 2 and sys.argv[1] == "--api":
        sys.exit(run_api(sys.argv[2:]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--download":
        sys.exit(download_tar(home_dir(), sys.argv[2]))
    if len(sys.argv) >= 4 and sys.argv[1] == "--share-serve":
        sys.exit(share_serve(sys.argv[2], sys.argv[3]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--attach":
        sys.exit(attach(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--attach-control":
        sys.exit(attach_control(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 2 and sys.argv[1] == "--pi-update":
        sys.exit(pi_update(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(USAGE)
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "--version":
        print(VERSION)
        sys.exit(0)
    # ncurses waits ESCDELAY after a lone Escape before delivering it, one second by
    # default: Escape to quit feels broken. 100 ms still reassembles an arrow sequence
    # that arrives split, and quits promptly.
    os.environ.setdefault("ESCDELAY", "100")
    loaded, problem = load_config(home_dir())
    try:
        curses.wrapper(main, resolve_start(sys.argv, loaded), loaded, problem)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        log("error", "picker.crash", trace=traceback.format_exc(), err=f"{type(exc).__name__}: {exc}")
        raise
