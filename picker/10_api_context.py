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

API_VERSION = 22
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


def sshd_max_sessions():
    """MaxSessions of the VM's sshd as its configuration says (10 when it says nothing),
    None when it cannot be read."""
    found = None
    paths = ["/etc/ssh/sshd_config"]
    try:
        paths += sorted(os.path.join("/etc/ssh/sshd_config.d", n) for n in os.listdir("/etc/ssh/sshd_config.d") if n.endswith(".conf"))
    except OSError:
        pass
    readable = False
    for path in paths:
        text = read_text(path, 256 * 1024)
        if text is None:
            continue
        readable = True
        for line in text.splitlines():
            parts = line.split("#", 1)[0].split()
            # sshd keeps the first value it reads; Match blocks are left aside.
            if parts and parts[0].lower() == "match":
                break
            if len(parts) == 2 and parts[0].lower() == "maxsessions" and parts[1].isdigit() and found is None:
                found = int(parts[1])
    return found if found is not None else (10 if readable else None)


def vm_checks(home, config):
    """What Pier needs on the VM, each {"name", "ok", "detail", "fix"}: what Settings >
    Picker and the page "Is the VM ready?" show, with the command that puts it right."""
    env = child_env(home)
    have = lambda name: bool(shutil.which(name, path=env.get("PATH")))
    node = node_major(env)
    sessions = sshd_max_sessions()
    python = ".".join(str(n) for n in sys.version_info[:3])
    return [
        {"name": "tmux", "ok": have("tmux"), "detail": "keeps Pi running when Pier disconnects", "fix": "sudo apt install tmux"},
        {"name": "bubblewrap", "ok": have("bwrap") or not sandbox_wanted(config), "detail": "Pi's sandbox: without it, Pi refuses to start",
         "fix": "sudo apt install bubblewrap"},
        {"name": "git", "ok": have("git"), "detail": "restore points, the git jail, the forges", "fix": "sudo apt install git"},
        {"name": "sshfs", "ok": have("sshfs"), "detail": "sharing a folder of this computer live", "fix": "sudo apt install sshfs"},
        {"name": "Python 3.12 or newer", "ok": sys.version_info >= (3, 12), "detail": f"the picker runs on {python}"
         + ("" if tarfile_fixed() else "; lab_pull needs 3.12.11 or 3.13.4"), "fix": "sudo apt install python3 (Debian 13 has 3.13)"},
        {"name": "Node 24 or newer", "ok": node is not None and node >= 24,
         "detail": f"Pi runs on Node {node}" if node else "no node found", "fix": "install Node 24 (nodejs.org, or nvm install 24): "
         "with an older one, Pi's network is not limited"},
        {"name": "Pi", "ok": pi_argv(config, env) is not None, "detail": "the agent itself",
         "fix": 'export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g --ignore-scripts @earendil-works/pi-coding-agent'},
        {"name": "MaxSessions", "ok": sessions is None or sessions >= 20,
         "detail": f"sshd allows {sessions} channels per connection" if sessions else "sshd's configuration could not be read",
         "fix": "MaxSessions 30 in /etc/ssh/sshd_config, then sudo systemctl reload ssh (Pier opens another connection otherwise)"},
    ]


def api_version(home, config):
    return {
        "version": VERSION,
        "tmux": bool(shutil.which("tmux")),
        "pi": pi_argv(config, child_env(home)) is not None,
        "checks": vm_checks(home, config),
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
    if SAFE_FD:
        # Through the folder's descriptor: swapped for a link after the check above, it
        # still cannot send the file elsewhere.
        data = text.encode("utf-8") if isinstance(text, str) else text
        dir_fd = open_folder(root, folder)
        tmp = f".pier-{os.urandom(6).hex()}.tmp"
        try:
            write_new_at(dir_fd, tmp, data, mode)
            os.replace(tmp, os.path.basename(path), src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dir_fd)
            except OSError:
                pass
            raise
        finally:
            os.close(dir_fd)
        return
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


def create_new(path, text, mode=0o644, root=None):
    """Create path with text if it does not exist; a link there is not followed. With
    root (the project), its folder is reached from root without following links."""
    if root is not None and SAFE_FD:
        dir_fd = open_folder(root, os.path.dirname(path))
        try:
            write_new_at(dir_fd, os.path.basename(path), text.encode("utf-8"), mode)
        except FileExistsError:
            return False
        finally:
            os.close(dir_fd)
        return True
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
    create_new(os.path.join(folder, ".gitignore"), "*\n", root=project)
    return folder


def type_into_pi(pi, text):
    """Type text into the prompt of a running Pi. Never presses Enter."""
    text = "".join(ch for ch in text if ch.isprintable())
    # send-keys takes a pane: "=name:" is the session's active pane, "=" makes the
    # match exact. Without the colon, tmux reads the target as a window name.
    # "--": a text starting with "-" is text, not an option of send-keys.
    return run_quiet(tmux_cmd("send-keys", "-t", f"={pi['name']}:", "-l", "--", text))


def save_new(folder, filename, data, root):
    """folder/filename created with data, folder reached from root (the project)
    without following links."""
    saved = os.path.join(folder, filename)
    if SAFE_FD:
        dir_fd = open_folder(root, folder)
        try:
            write_new_at(dir_fd, filename, data, 0o600)
        finally:
            os.close(dir_fd)
        return saved
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
    saved = save_new(ignored_dir(project, IMAGE_DIR), filename, data, project)
    return delivered(project, home, saved, f"@{IMAGE_DIR}/{filename}", session)


def api_paste_file(home, name, target, data):
    """Any file, saved in the project's .pi-files and referenced in its Pi."""
    if len(data) > FILE_MAX_BYTES:
        raise ApiError(f"file larger than {FILE_MAX_BYTES // (1024 * 1024)} MB")
    project, session = target_project(home, target, pi_sessions())
    filename = f"{stamp()}-{safe_name(name, 'file')}"
    saved = save_new(ignored_dir(project, FILES_DIR), filename, data, project)
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


def real_parent(path):
    """path with its folder resolved, but not path itself: resolving it would stat it, and
    a stalled sshfs mount there answers a stat never (an uninterruptible wait)."""
    path = os.path.abspath(path)
    return os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))


def is_mounted(path, mounts=None):
    return real_parent(path) in (mounts if mounts is not None else mounted_paths())


def share_mountpoint(home, mount):
    """mount, checked to be a share folder this API created, under home."""
    full = real_parent(mount)
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


