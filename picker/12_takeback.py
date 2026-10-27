# --- take back, file by file -------------------------------------------------------------
#
# Pier compares a handed-off copy with the original folder on the PC: the picker lists
# the copy's files with their SHA-256 (copy-manifest), shows one file's difference
# (copy-diff, the PC's version on stdin), and sends the files chosen (--download-files).
# The copy is Pi's to write: it is walked through file descriptors (os.fwalk), links are
# listed but never followed, and only plain files are read.

# Left out of the comparison, as Pier leaves them out of a hand off (copy.rs,
# take_back_skips): the rebuilt folders at the top only, the systems' files everywhere,
# and git's own files (never brought back).
COPY_REBUILT = {"node_modules", "target", "__pycache__", ".venv", "venv"}
COPY_JUNK = {".git", ".DS_Store", "Thumbs.db"}


def copy_skips(top, name):
    return name in COPY_JUNK or (top and name in COPY_REBUILT)
MANIFEST_MAX_FILES = 20000
MANIFEST_MAX_BYTES = 2 * 1024 * 1024 * 1024
COPY_DIFF_MAX = 1024 * 1024


def copy_root(home, path):
    """path, checked to be a copy Pier made (a handed-off share, or a folder copy)."""
    full = os.path.realpath(path)
    parent = os.path.basename(os.path.dirname(full))
    if not within(full, home) or parent not in (SHARE_DIR, FILES_DIR) or is_mounted(full) or not os.path.isdir(full):
        raise ApiError(f"not a copy that can be taken back: {path}")
    return full


def copy_rel_ok(rel):
    parts = rel.split("/")
    return bool(rel) and len(rel) < 4096 and not rel.startswith("/") and all(p not in ("", ".", "..") for p in parts) \
        and not any(ord(c) < 32 for c in rel)


def hash_fd(fd):
    digest = hashlib.sha256()
    while True:
        block = os.read(fd, 1 << 20)
        if not block:
            return digest.hexdigest()
        digest.update(block)


def api_copy_manifest(home, path):
    """{"files": {relative path: {"size", "sha256"}}, "links": [...], "truncated"}."""
    full = copy_root(home, path)
    files, links, total, truncated = {}, [], 0, False
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
    walker = os.fwalk(full, follow_symlinks=False) if hasattr(os, "fwalk") else ((r, d, f, None) for r, d, f in os.walk(full))
    for root, dirs, names, dir_fd in walker:
        rel_root = os.path.relpath(root, full)
        dirs[:] = [d for d in dirs if not copy_skips(rel_root == ".", d)]
        for name in sorted(names):
            if copy_skips(rel_root == ".", name):
                continue
            rel = name if rel_root == "." else f"{rel_root}/{name}".replace(os.sep, "/")
            try:
                st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False) if dir_fd is not None else os.lstat(os.path.join(root, name))
            except OSError:
                continue
            if stat.S_ISLNK(st.st_mode):
                links.append(rel)
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            if len(files) >= MANIFEST_MAX_FILES or total + st.st_size > MANIFEST_MAX_BYTES:
                truncated = True
                break
            try:
                fd = os.open(name, flags, dir_fd=dir_fd) if dir_fd is not None else os.open(os.path.join(root, name), flags)
            except OSError:
                continue
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    continue
                files[rel] = {"size": st.st_size, "sha256": hash_fd(fd)}
                total += st.st_size
            finally:
                os.close(fd)
        if truncated:
            break
    return {"path": full, "files": files, "links": links, "truncated": truncated}


def api_copy_diff(home, path, rel, local):
    """The difference between the PC's version of rel (local, bytes; empty when it has
    none) and the copy's, as a unified diff ("-" the PC, "+" Pi)."""
    import difflib
    full = copy_root(home, path)
    if not copy_rel_ok(rel):
        raise ApiError(f"not a file of the copy: {rel}")
    fd = open_regular(os.path.join(full, *rel.split("/")), root=full)
    if fd is None:
        remote = b""
    else:
        with os.fdopen(fd, "rb") as handle:
            remote = handle.read(COPY_DIFF_MAX + 1)
    if len(remote) > COPY_DIFF_MAX or len(local) > COPY_DIFF_MAX:
        return {"rel": rel, "too_big": True}
    if b"\0" in remote or b"\0" in local:
        return {"rel": rel, "binary": True, "size_vm": len(remote), "size_pc": len(local)}
    before = local.decode("utf-8", "replace").splitlines(keepends=True)
    after = remote.decode("utf-8", "replace").splitlines(keepends=True)
    diff = "".join(difflib.unified_diff(before, after, f"PC/{rel}", f"Pi/{rel}", n=3))
    return {"rel": rel, "diff": diff[:4 * COPY_DIFF_MAX]}


def download_files(home, path):
    """--download-files PATH: the files of a copy named on stdin (one relative path a
    line), as a tar stream on stdout. Plain files only, opened without following links."""
    import tarfile
    try:
        full = copy_root(home, path)
    except ApiError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    wanted = [rel for rel in sys.stdin.read(8 * 1024 * 1024).split("\n") if rel]
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        for rel in wanted:
            if not copy_rel_ok(rel):
                continue
            fd = open_regular(os.path.join(full, *rel.split("/")), root=full)
            if fd is None:
                continue
            with os.fdopen(fd, "rb") as handle:
                info = archive.gettarinfo(fileobj=handle, arcname=rel)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                archive.addfile(info, handle)
    return 0


def tar_tree(archive, root, start, arcname, keep=None):
    """Add start (resolved, inside root) and all it holds to archive, as tarfile's add
    would, but walking down from root by descriptors without following any link: a
    link goes in as a link, and a folder Pi swaps for a link while it is read is not
    entered (tarfile's add reads by path: the swap would send what the link names).
    Nothing of another file system (a share mounted inside), no FIFO nor device.
    keep(info): tarfile's filter, None leaves the entry (a folder: all it holds) out."""
    import tarfile
    if not SAFE_FD:
        archive.add(start, arcname=arcname, recursive=True, filter=keep)
        return
    nofollow = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)

    def entry(name, st, kind):
        info = tarfile.TarInfo(name)
        info.type, info.mode, info.mtime = kind, stat.S_IMODE(st.st_mode), int(st.st_mtime)
        return info

    def add(dir_fd, name, arc, device):
        st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            info = entry(arc, st, tarfile.SYMTYPE)
            info.linkname = os.readlink(name, dir_fd=dir_fd)
            info = keep(info) if keep else info
            if info is not None:
                archive.addfile(info)
        elif stat.S_ISREG(st.st_mode):
            fd = os.open(name, nofollow, dir_fd=dir_fd)
            with os.fdopen(fd, "rb") as handle:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    return
                info = entry(arc, st, tarfile.REGTYPE)
                info.size = st.st_size
                info = keep(info) if keep else info
                if info is not None:
                    archive.addfile(info, handle)
        elif stat.S_ISDIR(st.st_mode):
            fd = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
            try:
                inside(fd, arc, device)
            finally:
                os.close(fd)

    def inside(fd, arc, device):
        st = os.fstat(fd)
        if st.st_dev != device:
            return
        info = entry(arc, st, tarfile.DIRTYPE)
        info = keep(info) if keep else info
        if info is None:
            return
        archive.addfile(info)
        with os.scandir(fd) as entries:
            names = sorted(e.name for e in entries)
        for name in names:
            try:
                add(fd, name, f"{arc}/{name}", device)
            except FileNotFoundError:
                continue  # gone meanwhile

    try:
        if start == root:
            fd = os.open(root, DIR_FLAGS)
            try:
                inside(fd, arcname, os.fstat(fd).st_dev)
            finally:
                os.close(fd)
        else:
            parent = open_dir_walk(root, os.path.dirname(start))
            try:
                add(parent, os.path.basename(start), arcname, os.fstat(parent).st_dev)
            finally:
                os.close(parent)
    except RecursionError:
        raise ApiError(f"too many folders inside {os.path.basename(start)}")


def download_tar(home, path):
    """--download PATH: a handed-off copy or a folder copy, as a tar stream on stdout."""
    import tarfile
    full = os.path.realpath(path)
    parent = os.path.basename(os.path.dirname(full))
    if not within(full, home) or parent not in (SHARE_DIR, FILES_DIR) or is_mounted(full) or not os.path.isdir(full):
        print(f"not a copy that can be downloaded: {path}", file=sys.stderr)
        return 1
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|") as archive:
        tar_tree(archive, full, full, os.path.basename(full))
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
    staging = private_staging()
    try:
        count = extract_tar(stream, staging)
        if not move_into(staging, folder, os.path.basename(dest), project):
            shutil.copytree(staging, dest, symlinks=True)  # another file system: copied
    except ApiError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise ApiError(f"{exc}: share it live instead")
    except Exception as exc:  # noqa: BLE001 - nothing half-made stays
        shutil.rmtree(staging, ignore_errors=True)
        raise ApiError(f"{type(exc).__name__}: {exc}" if not isinstance(exc, (tarfile.TarError, OSError)) else str(exc))
    shutil.rmtree(staging, ignore_errors=True)  # gone already when it was moved
    relative = f"{FILES_DIR}/{os.path.basename(dest)}"
    typed = session is not None and type_into_pi(session, relative + "/ ")
    return {"saved": dest, "project": project, "label": pretty_path(project, home),
            "reference": relative + "/", "running": session is not None, "typed": typed, "count": count}


