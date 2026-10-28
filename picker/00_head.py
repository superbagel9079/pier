#!/usr/bin/env python3
# subject: TUI directory picker browsing the home directory (non-hidden directories only) that launches Pi in the chosen directory, inside tmux so Pi survives a dropped SSH connection.
# verified: v4.20, 2026-10-16: the tmux suite (pier-picker-tests.py) passes entirely on the Debian host, sandbox, network and link protections included.
# tech: python, curses, git, tmux, pi
#
# Standard library only.
# Evidence is produced by pier-picker-tests.py, which drives this program through a real pty.
#
# Files:
#   ~/.config/pier-picker/config.toml      optional settings, see DEFAULTS
#   ~/.local/state/pier-picker/state.json  recent projects and the sort order
#   ~/.local/state/pier-picker/picker.log  what happened, see "logging"
#   ~/.local/state/pier-picker/checkpoints/ restore points of the projects, see "restore points"
#   ~/.local/state/pier-picker/tmux.conf   the config of Pi's tmux server, see tmux_conf
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
import socket
import signal
import stat
import struct
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

VERSION = "4.41"
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
    "network_limit": True,             # in the sandbox, Pi reaches only NETWORK_ALLOW and network_allow
    "network_allow": [],               # more places Pi may reach: "host", "host:port", ".domain" (any below)
    "git_tools": True,                 # Pi gets git tools for the forge (push, pull requests), through the picker
    "worktrees": True,                 # a second Pi in a git project works in a worktree of its own (.pi-worktrees)
}

# Where Pi may connect, in its sandbox, when network_limit is on (see NetProxy): its
# model providers, npm and GitHub (packages, git over https). The rest is refused and
# logged (net.blocked): add what you need to network_allow in config.toml.
NETWORK_ALLOW = (
    ".anthropic.com", "claude.ai",          # Claude, Claude Max sign-in
    "openrouter.ai", ".openrouter.ai",
    "api.deepseek.com",
    "registry.npmjs.org", ".npmjs.org",     # pi install npm:..., pi update
    "github.com", ".github.com", ".githubusercontent.com",
    "pypi.org", "files.pythonhosted.org",
)

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

# The picker was called pi-dir-picker. Its folders are moved to the new name the first
# time it runs (see migrate_old_name); its tmux server keeps the old name for as long
# as it runs, so that the Pis started before are still found.
OLD_NAME = "pi-dir-picker"


def tmux_socket():
    if os.environ.get("PI_PICKER_TMUX_SOCKET"):
        return os.environ["PI_PICKER_TMUX_SOCKET"]
    folder = os.path.join(os.environ.get("TMUX_TMPDIR") or "/tmp", f"tmux-{os.getuid()}") if hasattr(os, "getuid") else ""
    return OLD_NAME if folder and os.path.exists(os.path.join(folder, OLD_NAME)) else "pier-picker"


TMUX_SOCKET = tmux_socket()
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


