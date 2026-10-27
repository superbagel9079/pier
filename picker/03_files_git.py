# --- filesystem and git ----------------------------------------------------------------

def home_dir():
    return os.path.realpath(os.path.expanduser("~"))


def within(path, root):
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


# Pi writes in the project and in ~/.pi, so whatever the picker (outside the sandbox)
# reads or deletes there is reached through file descriptors, folder by folder, without
# following links: a link or a folder swapped in between a check and its use cannot
# send it elsewhere. Not on Windows (the simulated tests), which has no dir_fd.
DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
# os.replace takes src_dir_fd/dst_dir_fd wherever os.rename does (both are renameat),
# but only os.rename is listed in supports_dir_fd.
SAFE_FD = (os.open in os.supports_dir_fd and os.unlink in os.supports_dir_fd and os.rename in os.supports_dir_fd
           and os.scandir in os.supports_fd)


def open_dir_walk(root, path):
    """A descriptor on the folder path (already resolved, inside root), opened from root
    down without following any link. OSError when one is met on the way."""
    rel = os.path.relpath(path, root)
    fd = os.open(root, DIR_FLAGS)
    try:
        for part in ([] if rel == "." else rel.split(os.sep)):
            nxt = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nxt
    except BaseException:
        os.close(fd)
        raise
    return fd


def open_regular(path, root=None, follow=True):
    """A read-only descriptor on path when it is a plain file, else None: a FIFO, a
    device or a folder Pi left there can neither block nor feed the picker.
    root: path may go through links that stay inside root (AGENTS.md -> CLAUDE.md), and
    is then opened from root down without following any (a swap meanwhile fails).
    follow=False: path itself must not be a link."""
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    if not follow or root is not None:
        flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        if root is None:
            fd = os.open(path, flags)
        else:
            root = os.path.realpath(root)
            real = os.path.realpath(path)
            if real == root or not within(real, root):
                return None
            if not SAFE_FD:
                fd = os.open(real, flags)
            else:
                parent = open_dir_walk(root, os.path.dirname(real))
                try:
                    fd = os.open(os.path.basename(real), flags, dir_fd=parent)
                finally:
                    os.close(parent)
    except OSError:
        return None
    try:
        if stat.S_ISREG(os.fstat(fd).st_mode):
            return fd
    except OSError:
        pass
    os.close(fd)
    return None


def open_plain(path, root=None, follow=True):
    """open(path, "rb"), for a plain file only (see open_regular); OSError otherwise."""
    fd = open_regular(path, root, follow)
    if fd is None:
        raise OSError(f"not a plain file: {path}")
    return os.fdopen(fd, "rb")


def open_folder(root, folder):
    """A descriptor on folder, really inside root, opened from root down without
    following links (see open_dir_walk). ApiError when it leads elsewhere."""
    real_root, real = os.path.realpath(root), os.path.realpath(folder)
    if not within(real, real_root):
        raise ApiError(f"refusing to write outside {pretty_path(real_root, home_dir())}: {os.path.basename(folder)}")
    try:
        return open_dir_walk(real_root, real)
    except OSError as exc:
        raise ApiError(f"{os.path.basename(folder)} changed while writing in it: {exc.strerror or exc}")


NEW_FILE = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)


def write_new_at(dir_fd, name, data, mode):
    """Create name in the folder dir_fd with data (bytes); FileExistsError if it is there."""
    fd = os.open(name, NEW_FILE, mode, dir_fd=dir_fd)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
        os.fchmod(handle.fileno(), mode)


def remove_tree_at(dir_fd, name, device):
    """Remove name in the folder dir_fd: a file, a link (the link itself), or a folder
    and all it holds, made writable on the way (a read-only copy). Never follows a
    link, and never enters another file system (a mount inside)."""
    st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    if not stat.S_ISDIR(st.st_mode):
        os.unlink(name, dir_fd=dir_fd)
        return
    fd = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    try:
        st = os.fstat(fd)
        if st.st_dev != device:
            raise ApiError(f"something is mounted in {name}: stop that share first")
        os.fchmod(fd, stat.S_IMODE(st.st_mode) | 0o700)
        with os.scandir(fd) as entries:
            names = [entry.name for entry in entries]
        for inner in names:
            remove_tree_at(fd, inner, device)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=dir_fd)


def remove_entry(root, full):
    """Remove full (resolved, inside root) and all it holds, walking down from root
    without following links: a folder on the way swapped for a link meanwhile stops it."""
    if not within(full, root) or full == root:
        raise ApiError("refusing to remove that")
    if not SAFE_FD:
        if os.path.isdir(full) and not os.path.islink(full):
            writable_tree(full)
            shutil.rmtree(full)
        else:
            os.remove(full)
        return
    parent = open_dir_walk(root, os.path.dirname(full))
    try:
        remove_tree_at(parent, os.path.basename(full), os.fstat(parent).st_dev)
    except RecursionError:
        raise ApiError(f"too many folders inside {os.path.basename(full)} to remove it")
    finally:
        os.close(parent)


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
    text = read_text(dot, 4096)
    if text is None:
        return None
    first = text.split("\n", 1)[0].strip()
    if first.startswith("gitdir:"):
        return os.path.normpath(os.path.join(path, first[7:].strip()))
    return None


def git_branch(path):
    """Branch name, or short sha when detached, or None when not a repository."""
    directory = git_dir(path)
    if directory is None:
        return None
    head = read_text(os.path.join(directory, "HEAD"), 4096)
    if head is None:
        return None
    head = head.strip()
    if head.startswith("ref:"):
        ref = head[4:].strip()
        return ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
    return head[:7] or None


# Where Incus and LXD keep their sockets, outside /run: a member of the incus group (a
# VM that is also a lab host) would drive Incus from the sandbox, and make itself
# machines with the whole internet, out of Pier's sight.
SOCKET_FOLDERS = ("/var/lib/incus", "/var/lib/lxd", "/var/snap/lxd/common/lxd")


def run_hidden():
    """bwrap arguments hiding /run in the sandboxes: a read-only mount does not stop a
    program from connecting to a socket, and /run holds the system's (D-Bus, systemd,
    the user's session bus in /run/user, docker or others depending on the VM). Only
    what /etc/resolv.conf points to comes back, read-only, so names still resolve.
    The folders of SOCKET_FOLDERS are hidden too."""
    args = []
    if os.path.isdir("/run"):
        args = ["--tmpfs", "/run"]
        resolv = os.path.realpath("/etc/resolv.conf")
        if within(resolv, "/run") and os.path.isfile(resolv):
            folder = os.path.dirname(resolv)
            args += ["--ro-bind", folder, folder]
    for folder in SOCKET_FOLDERS:
        if os.path.isdir(folder) and not os.path.islink(folder):
            args += ["--tmpfs", folder]
    return args


# ioctls that push characters into a terminal's input, as if typed: TIOCSTI, and
# TIOCLINUX (its paste, on a console). Pi in its sandbox must not type into the
# terminal it runs in (without tmux, the user's own). --new-session would stop it too,
# but it takes the terminal away from Pi, which then misses window size changes.
TIOCSTI, TIOCLINUX = 0x5412, 0x541C
# machine -> (its AUDIT_ARCH, ioctl's number, the lowest number that is not native)
SECCOMP_ARCHES = {"x86_64": (0xC000003E, 16, 0x40000000), "aarch64": (0xC00000B7, 29, 0xFFFFFFFF)}


def tiocsti_filter():
    """A seccomp program (classic BPF, as bwrap --seccomp reads it) failing those ioctls
    with EPERM, and every system call of another architecture (32-bit calls on a 64-bit
    system would get round the check). None on a machine not known here."""
    machine = os.uname().machine if hasattr(os, "uname") else ""
    if machine not in SECCOMP_ARCHES or sys.byteorder != "little":
        return None
    arch, ioctl, foreign = SECCOMP_ARCHES[machine]
    load, jeq, jge, ret = 0x20, 0x15, 0x35, 0x06
    allow, deny = 0x7FFF0000, 0x00050000 | 1  # SECCOMP_RET_ALLOW, SECCOMP_RET_ERRNO | EPERM
    # seccomp_data: nr at 0, arch at 4, args from 16 (8 bytes each; the low half of
    # args[1], the request, at 24: the kernel reads it as 32 bits).
    program = [
        (load, 0, 0, 4),
        (jeq, 1, 0, arch),
        (ret, 0, 0, deny),          # another architecture
        (load, 0, 0, 0),
        (jge, 6, 0, foreign),       # x32 calls: to the last line, deny
        (jeq, 1, 0, ioctl),
        (ret, 0, 0, allow),         # not an ioctl
        (load, 0, 0, 24),
        (jeq, 2, 0, TIOCSTI),
        (jeq, 1, 0, TIOCLINUX),
        (ret, 0, 0, allow),
        (ret, 0, 0, deny),
    ]
    return b"".join(struct.pack("<HBBI", *line) for line in program)


def seccomp_pipe():
    """The filter on the read end of a pipe, inheritable, for bwrap --seccomp FD; None
    when there is none for this machine."""
    program = tiocsti_filter()
    if program is None:
        return None
    read, write = os.pipe()
    os.write(write, program)  # a few hundred bytes: well within a pipe's buffer
    os.close(write)
    os.set_inheritable(read, True)
    return read


def git_jail(path):
    """bwrap arguments that run git on path's repository with nothing else: the
    repository read-only, the rest of home hidden, no network, no way out. A project's
    .git/config is Pi's to write (filters, hooks would run commands); in here they can
    only read the project. None without bwrap."""
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    home = os.path.realpath(home_dir())
    args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
            "--tmpfs", "/home", *run_hidden()]
    if not within(home, "/home"):
        args += ["--tmpfs", home]
    for folder in git_jail_folders(path):
        args += ["--ro-bind", folder, folder]
    args += ["--unshare-all", "--die-with-parent", "--new-session", "--"]
    return args


def linked_git_folder(project, real):
    """True when real, a git folder outside project, is really project's own: a
    worktree's (<repo>/.git/worktrees/<n>) or a submodule's (<repo>/.git/modules/<n>)
    whose way back (the worktree's gitdir file, the submodule's core.worktree) leads to
    project. The .git file pointing there is Pi's to write, those files are not: a .git
    file naming another repository's own .git, or another project's worktree, is refused."""
    parts = real.split(os.sep)
    if len(parts) < 3 or parts[-2] not in ("worktrees", "modules") or ".git" not in parts[:-2]:
        return False
    if os.path.islink(real) or not os.path.isfile(os.path.join(real, "HEAD")):
        return False
    if parts[-2] == "worktrees":
        back = read_text(os.path.join(real, "gitdir"), 4096)
        return bool(back and back.strip()) and os.path.realpath(os.path.dirname(back.strip())) == project
    config = read_text(os.path.join(real, "config"), 65536) or ""
    match = re.search(r"^\s*worktree\s*=\s*(.+?)\s*$", config, re.MULTILINE)
    return bool(match) and os.path.realpath(os.path.join(real, match.group(1).strip('"'))) == project


def git_jail_folders(path):
    """What the git jail shows: the project, and nothing else unless its repository
    lives elsewhere (a worktree, a submodule). The .git file saying where is Pi's to
    write: only a git folder that is really this project's (see linked_git_folder) is
    then added, with the repository's .git it shares for a worktree."""
    project = os.path.realpath(path)
    folders = [project]
    directory = git_dir(path)
    if not directory:
        return folders
    real = os.path.realpath(directory)
    if within(real, project) or not linked_git_folder(project, real):
        return folders
    folders.append(real)
    common = read_text(os.path.join(real, "commondir"), 4096)
    if common and common.strip():
        shared = os.path.realpath(os.path.join(real, common.strip()))
        if within(real, shared) and real != shared and os.path.isfile(os.path.join(shared, "HEAD")) \
                and not os.path.islink(shared):
            folders[-1] = shared  # the worktree's folder is inside it: the whole .git
    return folders


def own_repository(project):
    """ApiError unless project's git folder is its own: inside it, or a worktree's or a
    submodule's that leads back to it. The broker reads commits with it and pushes
    them with the token: a .git file naming another repository would publish that one."""
    directory = git_dir(project)
    if directory is None:
        return
    real, root = os.path.realpath(directory), os.path.realpath(project)
    if not within(real, root) and not linked_git_folder(root, real):
        raise ApiError("this project's .git points to another repository: Pier does not push or pull for it")


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
            text = read_text(full, 4096, root=path)  # no FIFO to hang the screen on
            if text is None:
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
            try:
                value = self._probe(path)
            except Exception as exc:  # noqa: BLE001 - one folder failing never ends the preview for the session
                log("warn", "preview.failed", path=path, err=f"{type(exc).__name__}: {exc}")
                value = None
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


