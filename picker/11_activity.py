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


_SESSION_CWD = {}  # session file -> the folder its header says it ran in (it never changes)


def session_ran_in(path, project):
    """Whether the session file ran in project, by its header ({"type": "session", "cwd"}).
    Pi names a project's sessions folder by its path with "/" made "-": ~/a-b and ~/a/b
    share one. A file without a readable header counts (older ones, or being written)."""
    if path not in _SESSION_CWD:
        first = (read_text(path, 64 * 1024, root=sessions_root()) or "").split("\n", 1)[0]
        try:
            header = json.loads(first) if first else {}
        except ValueError:
            header = {}
        cwd = header.get("cwd") if isinstance(header, dict) and header.get("type") == "session" else None
        if cwd is None and not first:
            return True  # not written yet: asked again next time
        remember(_SESSION_CWD, path, cwd if isinstance(cwd, str) else None, 4000)
    cwd = _SESSION_CWD[path]
    return cwd is None or os.path.realpath(cwd) == os.path.realpath(project)


def latest_session_file(project):
    folder = session_dir(project)
    try:
        names = [n for n in os.listdir(folder) if n.endswith(".jsonl")]
    except OSError:
        return None
    paths = [p for p in (os.path.join(folder, n) for n in names) if session_ran_in(p, project)]
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


_RELATIVE = {}  # (project, path) -> project_relative: the same paths, at every rebuild


def project_relative(project, path):
    known = _RELATIVE.get((project, path))
    if known is not None:
        return known
    full = os.path.normpath(path if os.path.isabs(path) else os.path.join(project, path))
    rel = os.path.relpath(full, project) if within(full, project) else full
    remember(_RELATIVE, (project, path), rel, 20000)
    return rel


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
    with open_plain(path, sessions_root()) as handle:
        handle.seek(offset)
        for raw in handle:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read with the next one
            offset += len(raw)
            if b'"role":"user"' in raw:
                last = "user"
                usage["turns"] += 1
                continue
            if b'"role":"assistant"' not in raw:
                if b'"role":"toolResult"' not in raw:
                    continue
                # A tool's result carries what it read (whole files, base64 images): two
                # fields are read from the raw line, as in session_edits, never all of it.
                last = "toolResult"
                found = re.search(rb'"toolCallId":"([^"]+)"', raw)
                if found:
                    finished[found.group(1).decode("utf-8", "replace")] = b'"isError":true' in raw
                if b'"usage":{' in raw:  # tools that run a model themselves: rare, parsed
                    try:
                        said = json.loads(raw).get("message") or {}
                        add_usage(usage, said.get("usage") if isinstance(said, dict) else None)
                    except (ValueError, AttributeError):
                        pass
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


_EDITS = {}  # path -> (identity, offset, tail, calls, finished): see session_edits


def session_edits(session):
    """The writes and edits of a session file with their whole arguments, and which
    tool calls finished (with an error or not): for api_diff. As read_session, only
    what was added since the last diff is read (each click read 200 MB again)."""
    st = os.stat(session)
    identity = (st.st_dev, st.st_ino)
    cached = _EDITS.get(session)
    if cached and cached[0] == identity and cached[1] <= st.st_size and session_tail(session, cached[1]) == cached[2]:
        offset, calls, finished = cached[1], dict(cached[3]), dict(cached[4])
    else:
        offset, calls, finished = 0, {}, {}
    with open_plain(session, sessions_root()) as handle:
        handle.seek(offset)
        for raw in handle:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read with the next one
            offset += len(raw)
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
    remember(_EDITS, session, (identity, offset, session_tail(session, offset), dict(calls), dict(finished)), 4)
    return calls, finished


def session_tail(path, offset):
    try:
        with open_plain(path, sessions_root()) as handle:
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
        with open_plain(session, sessions_root()) as handle:
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
                with open_plain(full, project) as handle:
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
            remove_entry(home, full)
            del marks[name]
            save_handoff_marks(shared, marks)
        return {"removed": full}
    if not within(full, home) or parent not in (IMAGE_DIR, FILES_DIR) or os.path.basename(full) == ".gitignore":
        raise ApiError(f"not something sent: {path}")
    # The checks above read paths Pi can change meanwhile (.pi-files swapped for a link
    # to home): the removal itself walks down from home without following links.
    if os.path.isdir(full) and parent == FILES_DIR:
        if any(within(m, full) for m in mounted_paths()):
            raise ApiError(f"a folder is mounted inside {path}: stop that share first")
        remove_entry(home, full)
    elif os.path.isfile(full):
        remove_entry(home, full)
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
    text = read_text(os.path.join(shared, HANDOFF_MARKS), 1024 * 1024, root=os.path.dirname(shared))
    try:
        marks = json.loads(text) if text is not None else {}
    except ValueError:
        return {}
    return marks if isinstance(marks, dict) else {}


def save_handoff_marks(shared, marks):
    atomic_write(os.path.join(shared, HANDOFF_MARKS), json.dumps(marks), shared)


def extract_tar(stream, dest):
    """Extract a tar stream into dest with tarfile's "data" filter and the size caps.
    Only folders and plain files: no link of either kind, whatever the filter would let
    through (the filter's own fixes depend on the VM's Python, see TARFILE_FIXED).
    Returns the number of members."""
    import tarfile
    total, count = 0, 0
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            if not (member.isfile() or member.isdir()):
                continue
            count += 1
            total += max(member.size, 0)
            if count > COPY_MAX_MEMBERS or total > COPY_MAX_BYTES:
                raise ApiError(f"folder too big to copy (over {COPY_MAX_BYTES // (1024 * 1024)} MB "
                               f"or {COPY_MAX_MEMBERS} files)")
            archive.extract(member, dest, filter="data")
    return count


def private_staging():
    """A fresh folder of the picker's own (in its state folder, which Pi never sees),
    where an archive is unpacked before it is moved into a project: Pi cannot swap
    anything inside it while tarfile writes there."""
    base = os.path.join(os.path.dirname(state_path(home_dir())), "incoming")
    os.makedirs(base, mode=0o700, exist_ok=True)
    return tempfile.mkdtemp(dir=base)


def move_into(source, folder, name, root):
    """Rename source (a folder of ours) to folder/name, folder reached from root without
    following links. False when they are on different file systems (the caller copies)."""
    if not SAFE_FD:
        os.rename(source, os.path.join(folder, name))
        return True
    dir_fd = open_folder(root, folder)
    try:
        os.rename(source, name, dst_dir_fd=dir_fd)
    except OSError as exc:
        if exc.errno == 18:  # EXDEV
            return False
        raise
    finally:
        os.close(dir_fd)
    return True


def read_only_tree(path, keep_top=False):
    """Removes write permission everywhere under path: a read-only share stays read-only
    once it is a copy. Only on a folder of the picker's own (see private_staging)."""
    for root, dirs, files in os.walk(path, topdown=False):
        for name in files + dirs:
            full = os.path.join(root, name)
            if not os.path.islink(full):
                os.chmod(full, os.lstat(full).st_mode & ~0o222)
    if not keep_top:
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
    staging = private_staging()
    try:
        count = extract_tar(stream, staging)
        entries = os.listdir(staging)
        # Pier packs the folder under its own name: unpack that level away.
        inner = os.path.join(staging, entries[0]) if len(entries) == 1 and os.path.isdir(os.path.join(staging, entries[0])) else staging
        if mode != "rw":
            # Here, where Pi reaches nothing; the top folder last, once it is in place
            # (moving a folder needs it writable).
            read_only_tree(inner, keep_top=True)
        if is_mounted(mount):
            tool = shutil.which("fusermount3") or shutil.which("fusermount")
            if not tool or not run_quiet([tool, "-u", "-z", mount]):
                raise ApiError("could not unmount the share")
        project = os.path.dirname(shared)
        dir_fd = open_folder(project, shared) if SAFE_FD else None
        try:
            if dir_fd is None:
                if os.path.isdir(mount):
                    os.rmdir(mount)
                os.rename(inner, mount)
            else:
                try:
                    os.rmdir(name, dir_fd=dir_fd)
                except FileNotFoundError:
                    pass
                try:
                    os.rename(inner, name, dst_dir_fd=dir_fd)
                except OSError as exc:
                    if exc.errno != 18:  # EXDEV: another file system, copied instead
                        raise
                    shutil.copytree(inner, mount, symlinks=True)
            if mode != "rw":
                if dir_fd is None:
                    os.chmod(mount, os.stat(mount).st_mode & ~0o222)
                else:
                    top = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
                    try:
                        os.fchmod(top, stat.S_IMODE(os.fstat(top).st_mode) & ~0o222)
                    finally:
                        os.close(top)
        finally:
            if dir_fd is not None:
                os.close(dir_fd)
    except (ApiError, OSError, Exception) as exc:
        writable_tree(staging) if os.path.isdir(staging) else None
        shutil.rmtree(staging, ignore_errors=True)
        raise ApiError(str(exc)) if not isinstance(exc, ApiError) else exc
    if os.path.isdir(staging):
        writable_tree(staging)
        shutil.rmtree(staging, ignore_errors=True)
    with marks_lock(shared):
        marks = handoff_marks(shared)
        marks[name] = {"mode": "rw" if mode == "rw" else "ro", "at": int(time.time())}
        save_handoff_marks(shared, marks)
    project = os.path.dirname(shared)
    return {"mountpoint": mount, "project": project, "label": pretty_path(project, home),
            "relative": f"{SHARE_DIR}/{name}", "count": count}


