# --- restore points ----------------------------------------------------------------------
#
# The project is saved when Pi starts, when it is given a prompt, and when it stops
# working: a restore point. Going back to one puts every file as it was then, files
# created since included (they are removed), or only the files chosen.
#
# They live outside the project, in a git repository of their own per project under
# ~/.local/state/pier-picker/checkpoints. The project's own git, if any, is never
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
CHECKPOINT_EXCLUDE = ("/.pi-images/", "/.pi-files/", "/.pi-shared/", "/.pi-worktrees/", "/.pi/devbox-history/",
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
            # The untracked cache: the private GIT_DIR is the picker's alone, so nothing else
            # reads or rewrites it, and a point of an unchanged big tree no longer walks
            # all of it twice (ls-files, then add).
            "-c", "core.untrackedCache=true", "-c", "core.longpaths=true", *args]
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
    # A lock left by a git that was killed would block every later point. Every git
    # that writes here runs under CheckpointLock, held now: one found is stale, at once
    # (without flock, only after 10 minutes).
    lock = os.path.join(store, "index.lock")
    try:
        if fcntl or time.time() - os.stat(lock).st_mtime > 600:
            os.remove(lock)
            log("warn", "checkpoint.stale-lock", project=project)
    except OSError:
        pass
    os.makedirs(os.path.join(store, "info"), exist_ok=True)
    with open(os.path.join(store, "info", "exclude"), "w", encoding="utf-8") as handle:
        handle.write("# written by pier-picker: never saved in restore points\n")
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


def checkpoint_commit(project, tree, meta, after=None):
    """A point of tree. after: the latest point's id; the new one comes after it even
    with the clock set back (the points are ordered, and pruned, by their ids)."""
    message = json.dumps(meta, ensure_ascii=False).encode("utf-8") + b"\n"
    commit = checkpoint_git(project, "commit-tree", tree, stdin=message).decode().strip()
    now = time.time_ns()
    if after and after.isdigit():
        now = max(now, int(after) + 1)
    ident = f"{now:020d}"
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
        ident = checkpoint_commit(project, tree, meta, after=latest and latest["id"])
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
        ident = checkpoint_commit(project, latest["tree"], meta, after=latest["id"])
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
        fresh = [f for f in names if f != self.file and f not in others and os.path.getmtime(f) >= self.started
                 and session_ran_in(f, self.project)]
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
        with open_plain(session, sessions_root()) as handle:
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


