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
    """(key or None, warning or None). The warning flags a key file others can read.

    ~/.pi is Pi's to write: a link put there in place of the key would make the picker,
    outside the sandbox, read any file and hand it to Pi. Only a plain file is read."""
    path = os.path.join(home, ".pi", "hindsight.key")
    fd = open_regular(path, follow=False)
    if fd is None:
        if os.path.islink(path):
            log("warn", "hindsight.key-refused", why="a link, not a file")
        return None, None
    try:
        with os.fdopen(fd, "rb") as handle:
            mode = os.fstat(handle.fileno()).st_mode
            key = handle.read(4096).decode("utf-8", "replace").strip()
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


def private_folders(home):
    """What no read-only mount of the sandbox may hold: the picker's state (the labs' key,
    the approvals, other projects' restore points, the brokers' sockets: connect() works
    on a read-only mount), its settings (the forges' tokens), the keys."""
    return [os.path.realpath(p) for p in (os.path.dirname(state_path(home)), os.path.dirname(config_path(home)),
                                          os.path.join(home, ".ssh"), os.path.join(home, ".gnupg"))]


def program_folder(path, home):
    """The folder to mount read-only for a program under home: the one right under home
    holding it (top_of), or, when that one also holds a private folder (node from fnm,
    in ~/.local/state), only the program's own installation (the folder above its bin).
    None when even that holds one."""
    private = private_folders(home)
    holds = lambda folder: any(within(p, folder) for p in private)
    top = top_of(path, home)
    if not holds(top):
        return top
    folder = os.path.dirname(path)
    if os.path.basename(folder) == "bin":
        folder = os.path.dirname(folder)
    return folder if within(folder, home) and folder != home and not holds(folder) else None


# Folders Pi never gets read-write, even when asked to run there: they hold keys, the
# picker, its state and settings. Their parents (home itself) are refused too.
SANDBOX_REFUSED = ("~/.ssh", "~/.gnupg", "~/.config", "~/.local", "~/bin", "~/.pi")


def pi_refusal(project, home, config=None):
    """Why Pi cannot be started in project with the current settings, or None."""
    config = config or load_config(home)[0]
    return sandbox_refusal(project, home) if sandbox_wanted(config) else None


def openable(path, home, config=None):
    """A folder that can be offered as a project: Pi may run there. For the lists only:
    the guarded folders are resolved once in a while (see guarded_folders), and
    exec_pi checks again, exactly, before Pi starts."""
    config = config or load_config(home)[0]
    if not sandbox_wanted(config):
        return True
    real = os.path.realpath(path)
    return not any(within(guarded, real) or within(real, guarded) for guarded in guarded_folders(home))


_GUARDED = {}  # home -> (when, the folders of SANDBOX_REFUSED, resolved)
GUARDED_FRESH = 30.0


def guarded_folders(home):
    """SANDBOX_REFUSED resolved, kept a little: a search checks thousands of folders, and
    resolving the six for each one made every key typed in it slow."""
    now = time.monotonic()
    cached = _GUARDED.get(home)
    if cached is None or now - cached[0] > GUARDED_FRESH:
        cached = (now, [os.path.realpath(os.path.join(home, path[2:])) for path in SANDBOX_REFUSED])
        _GUARDED[home] = cached
    return cached[1]


def sandbox_refusal(project, home):
    """Why Pi must not run sandboxed with project read-write, or None."""
    real = os.path.realpath(project)
    for path in SANDBOX_REFUSED:
        guarded = os.path.realpath(os.path.join(home, path[2:]))
        if within(guarded, real) or within(real, guarded):
            return (f"Pi cannot run in {pretty_path(real, home)}: its sandbox would give it "
                    f"{pretty_path(guarded, home)}. Choose a project folder.")
    return None


def sandbox_argv(argv, project, home, config, env, network=None, git_socket=None, workdir=None, sessions=()):
    """argv wrapped in bubblewrap, or None when bwrap is missing.

    Inside, Pi sees the whole system read-only, and of the home directory only:
      - the project, read-write (shared folders are mounted inside it, in .pi-shared);
      - ~/.pi, read-write: Pi's settings and credentials; of its conversations only
        this project's (sessions: from session_folders), the others' are hidden;
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
            folder = program_folder(candidate, home) if within(candidate, home) and candidate != home else None
            if folder:
                mounts.setdefault(folder, "ro")
    for extra in EXTRA_PATH:
        extra = os.path.expanduser(extra)
        folder = program_folder(os.path.join(extra, "x"), home) if within(extra, home) and extra != home else None
        if folder and os.path.isdir(extra):
            mounts.setdefault(folder, "ro")
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
            "--tmpfs", "/tmp", "--tmpfs", "/home", *run_hidden()]
    if not within(home, "/home"):
        args += ["--tmpfs", home]
    args += ["--dir", home]
    # Parents before children, so a read-write project inside a read-only folder
    # stays writable.
    for path in sorted(mounts, key=lambda m: (m.count(os.sep), m)):
        if os.path.exists(path):
            args += ["--bind" if mounts[path] == "rw" else "--ro-bind", path, path]
    # The conversations of every project are in ~/.pi/agent/sessions: a Pi would read
    # what was said in the others, and write in them an order it finds there when the
    # user goes on with one. Only this project's folders come back, by descriptor (a
    # link put there by another Pi cannot give a folder elsewhere).
    pi_home = os.path.realpath(os.path.join(home, ".pi"))
    every = os.path.realpath(os.path.join(agent_dir(), "sessions"))
    if within(every, pi_home) and every != pi_home and os.path.isdir(every):
        args += ["--tmpfs", every]
        for fd, folder in sessions:
            args += ["--bind-fd", str(fd), folder] if bwrap_takes("--bind-fd") else ["--bind", folder, folder]
    # What Pier gives each Pi (see pier_dir) is the picker's, out of reach: its
    # extensions read-only, and the folder its own state goes to. ~/.pi/pier, where an
    # older picker kept them, is hidden.
    legacy = os.path.join(pi_home, "pier")
    if os.path.isdir(legacy) and not os.path.islink(legacy):
        args += ["--tmpfs", legacy]
    extensions = os.path.join(pier_dir(), "ext")
    if os.path.isdir(extensions):
        args += ["--ro-bind", extensions, extensions]
    if env.get("PIER_STATE"):
        own = os.path.dirname(env["PIER_STATE"])
        os.makedirs(own, mode=0o700, exist_ok=True)
        args += ["--bind", own, own]
    if git_socket:
        # The git broker's socket (GitBroker): Pi's git tools ask it, the token stays out here.
        args += ["--dir", NET_DIR, "--bind", git_socket, f"{NET_DIR}/git.sock"]
    if network is not None:
        # No network of its own: only the relay below, to the proxy outside (NetProxy).
        args += ["--unshare-net", "--dir", NET_DIR, "--bind", network.socket, f"{NET_DIR}/net.sock",
                 "--ro-bind", PICKER_MODULE, f"{NET_DIR}/picker.py"]
        argv = ["python3", "-B", f"{NET_DIR}/picker.py", "--net-bridge", f"{NET_DIR}/net.sock",
                *network.local_ports(), "--", *argv]
    args += ["--unshare-pid", "--unshare-ipc", "--die-with-parent", "--chdir", workdir or project, "--", *argv]
    return args


_BWRAP_HELP = []


def bwrap_takes(option):
    """Whether this bwrap knows option (--bind-fd since 0.5)."""
    if not _BWRAP_HELP:
        try:
            result = subprocess.run([shutil.which("bwrap") or "bwrap", "--help"], capture_output=True, timeout=10)
            _BWRAP_HELP.append(result.stdout.decode("utf-8", "replace") + result.stderr.decode("utf-8", "replace"))
        except (OSError, subprocess.SubprocessError):
            _BWRAP_HELP.append("")
    return option in _BWRAP_HELP[0]


def session_folders(home, *folders):
    """[(descriptor, path)] for the sessions folders of folders (the project, the
    worktree Pi works in), made when missing. Reached from home down without following
    links: ~/.pi is every Pi's to write, and one may have put a link there."""
    out = []
    for folder in dict.fromkeys(session_dir(f) for f in folders):
        if not SAFE_FD or not within(folder, home) or folder == home:
            continue
        try:
            fd = os.open(home, DIR_FLAGS)
            try:
                for part in os.path.relpath(folder, home).split(os.sep):
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                    inner = os.open(part, DIR_FLAGS, dir_fd=fd)
                    os.close(fd)
                    fd = inner
            except BaseException:
                os.close(fd)
                raise
        except OSError as exc:
            log("warn", "pi.sessions-folder", folder=folder, err=str(exc))
            continue
        out.append((fd, folder))
    return out


