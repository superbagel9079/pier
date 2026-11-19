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
import hashlib
import json
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

VERSION = "4.74"
SCRIPT = os.path.realpath(__file__)

DEFAULTS = {
    "pi_command": ["pi"],              # program and arguments; a string is split like a shell
    "tmux": True,                      # run Pi in tmux so it survives a dropped connection
    "recent_count": 8,                 # recent projects listed at the top of home, 0 hides them
    "sandbox": True,                   # run Pi in bubblewrap: it only sees its project, see sandbox_argv
    "sandbox_read": [],                # extra paths Pi may read in the sandbox, e.g. ["~/docs"]
    "sandbox_write": [],               # extra paths Pi may also write in the sandbox
    "checkpoints": True,               # save the project before each prompt, to undo what Pi did
    "track_sessions": True,            # Pi tells Pier which conversation it holds (an extension Pier gives it)
    "network_limit": True,             # in the sandbox, Pi reaches only NETWORK_ALLOW and network_allow
    "network_allow": [],               # more places Pi may reach: "host", "host:port", ".domain" (any below)
    "network_off": [],                 # places of NETWORK_ALLOW or network_allow turned off (kept in the list)
    "git_tools": True,                 # Pi gets git tools for the forge (push, pull requests), through the picker
    "worktrees": True,                 # a second Pi in a git project works in a worktree of its own (.pi-worktrees)
    "workers": True,                   # a Pi may start worker Pis (once the user approves), see workers
    "helpers": True,                   # a Pi may consult read-only helpers (scout, reviewer...), see workers
    "workers_max": 4,                  # at most that many workers at once per orchestrator
    "orchestrator_model": "",          # the orchestrator's model ("provider/id", "sonnet:high"); "" Pi's default
    "worker_model": "",                # the workers' model by default; "" Pi's default
    "worker_models": [],               # the models an orchestrator may choose for a worker, besides worker_model
    "helper_model": "",                # the read-only helpers' model by default (see consult); "" Pi's default
    "image_model": "",                 # the model that reads images for a Pi (look_at); "" none
}

# Where Pi may connect in its sandbox when network_limit is on: model providers, npm,
# GitHub. The rest is refused and logged (net.blocked): add hosts to network_allow.
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

# A repository's own config can name a program git status runs (core.fsmonitor): off here.
# Clean filters in .git/config can still run; see git_status.
GIT_OPTIONS = ["--no-optional-locks", "-c", "core.fsmonitor=false"]
GIT_TIMEOUT = 5

# Under an SSH RemoteCommand PATH is the bare system one: these are appended, never
# prepended, so the user's PATH wins. User bins first; /usr/local/bin last.
USER_PATH = ("~/.npm-global/bin", "~/.local/bin", "~/bin", "~/.bun/bin")
SYSTEM_PATH = ("/usr/local/bin",)
EXTRA_PATH = USER_PATH + SYSTEM_PATH

# Renamed from pi-dir-picker: folders move on first run (see migrate_old_name); the tmux
# server keeps the old name while it runs, so earlier Pis are still found.
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

RECENT_KEPT = 50


