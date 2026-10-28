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
# projects and activity watch what they read (see watch_signature), so the period only
# catches what leaves no trace there: a Pi started without Pier's extension, a file
# changed on disk by a command rather than by Pi's tools. Each rebuild of projects asks
# tmux, each one of activity runs git status in its jail: not every second for nothing.
# team asks the forges (3 requests a repository, against an hourly quota), labs every lab
# host (over SSH): both follow what changes here at once (their signatures), and the rest
# at a slow pace.
WATCH_EVERY = {"projects": 5, "contexts": 4, "activity": 10, "setup": 15, "checkpoints": 10, "log": 1,
               "conversations": 10, "approvals": 30, "team": 300, "labs": 60}
# Parts built on a thread of their own, as they wait on the network or read much: a lab
# host off, a forge not answering or 2000 conversations to read no longer hold the others
# (Pi done, Activity) for as long. Each sends its last result when it has it.
WATCH_APART = {"team", "labs", "conversations"}
# What a "poke" (an action of the user) does not hurry: they ask other machines.
WATCH_NOT_POKED = {"team", "labs"}
# Pier says something at least this often (a "ping" when it has nothing else): a watch
# that hears nothing for WATCH_SILENCE seconds was left by a connection that died
# without closing, and ends, instead of asking the forges and lab hosts for hours.
WATCH_SILENCE = 150
# The shortest a part waits between two rebuilds even when its inputs move (a working
# Pi writes its session file several times a second).
WATCH_MIN = {"setup": 3, "conversations": 5, "checkpoints": 2, "activity": 1.5}


def watch_signature(kind, value, home):
    """What a part depends on, cheap to read: when it moves, the part is refreshed now."""
    def stat(path):
        try:
            st = os.stat(path)
            return st.st_size, st.st_mtime_ns
        except OSError:
            return None

    def said():
        # What each Pi says, in its own folder of pier_dir()/pis.
        folder = os.path.join(pier_dir(), "pis")
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            return None
        return [(name, stat(os.path.join(folder, name, "state.json"))) for name in names]
    if kind == "projects":
        # A Pi started by Pier, ending, working or idle: its extension rewrites its file
        # (see said). Recent projects: the state file.
        return said(), stat(state_path(home))
    if kind == "activity" and isinstance(value, dict):
        project = value.get("project") or ""
        directory = git_dir(project) if project else None
        index = stat(os.path.join(directory, "index")) if directory else None  # a commit, an add
        return stat(value.get("file") or latest_session_file(project) or ""), stat(session_dir(project)), index
    if kind == "setup":
        folder = session_dir(value)
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            names = []
        texts = [stat(os.path.join(value, n)) for n in ("AGENTS.md", "CLAUDE.md", ".pi", os.path.join(".pi", "devbox-history"))]
        # How many conversations, not their sizes: a working Pi does not move Setup.
        return sum(1 for n in names if n.endswith(".jsonl")), texts, (said(), stat(versions_path(home)))
    if kind == "conversations":
        root = sessions_root()
        try:
            folders = sorted(os.listdir(root))
        except OSError:
            folders = []
        # What each Pi says, not tmux asked every second: a Pi without Pier's extension is
        # seen at the next period.
        return [(n, stat(os.path.join(root, n))) for n in folders], said(), stat(labels_path(home))
    if kind == "checkpoints":
        store = checkpoint_store(value)
        return stat(os.path.join(store, "refs", "devbox")), stat(os.path.join(store, "packed-refs"))
    if kind == "log":
        return stat(log_path())
    if kind == "approvals":
        return stat(approvals_path(home))  # a request of Pi shows at once
    if kind == "labs":
        return stat(labs_path(home)), stat(os.path.join(os.path.dirname(state_path(home)), "labs", "journal.jsonl"))
    if kind == "team":
        return stat(repos_path(home))  # the forges are asked every two minutes, or when a repository is connected
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
    if kind == "approvals":
        return api_approvals(home)
    if kind == "team":
        return api_team_watch(home)
    if kind == "labs":
        return {**api_labs(home), "journal": api_lab_journal(home, "40")["journal"]}
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
    heard = started  # when Pier last said something
    pings = False    # this Pier pings (an older one does not: then no silence ends it)
    want = {"projects": True}
    sent, due, marks, ran = {}, {}, {}, {}
    last = {}  # kind -> the message last sent, for the parts sent as patches (WATCH_PATCHED)
    busy = set()  # parts of WATCH_APART being built
    log_offset = None
    log("info", "watch.start")

    def build(kind, value):
        try:
            return {"kind": kind, "for": value, "data": watch_part(kind, value, home, config)}
        except (ApiError, OSError, ValueError) as exc:
            return {"kind": kind, "for": value, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - one part failing leaves the others
            log("error", f"watch.{kind}", trace=traceback.format_exc(), err=f"{type(exc).__name__}: {exc}")
            return {"kind": kind, "for": value, "error": f"the picker failed ({type(exc).__name__}: {exc})"}

    def apart(kind, value):
        inbox.put(("part", kind, value, build(kind, value)))

    def send(kind, message):
        text = clean_json(message)
        if sent.get(kind) == text:
            return
        sent[kind] = text
        before = last.get(kind)
        last[kind] = message if kind in WATCH_PATCHED else None
        if kind in WATCH_PATCHED and before and "data" in before and "data" in message:
            emit({"kind": kind, "for": message["for"], "patch": watch_patch(before["data"], message["data"])})
        else:
            emit(message, text)

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
        nonlocal pings
        if message.pop("ping", None):
            pings = True
        if message.pop("poke", False):
            for kind in [k for k in want if k not in WATCH_NOT_POKED]:
                for table in (sent, due, marks, ran, last):
                    table.pop(kind, None)
        for kind, value in message.items():
            if kind not in WATCH_EVERY:
                continue
            want[kind] = value
            for table in (sent, due, marks, ran, last):
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
                if kind in busy:
                    continue  # still building the last one: its result comes first
                ran[kind] = now
                due[kind] = now + WATCH_EVERY[kind]
                marks[kind] = signature
                if kind in WATCH_APART:
                    busy.add(kind)
                    threading.Thread(target=apart, args=(kind, value), daemon=True).start()
                    continue
                send(kind, build(kind, value))
            if pings and now - heard > WATCH_SILENCE:
                log("info", "watch.silent", seconds=int(now - heard), why="nothing from Pier: its connection is gone")
                break
            try:
                line = inbox.get(timeout=WATCH_TICK)
            except queue.Empty:
                continue
            while line is not None:
                if isinstance(line, tuple):  # a part built apart
                    _, kind, value, message = line
                    busy.discard(kind)
                    if want.get(kind) == value:
                        send(kind, message)
                else:
                    heard = time.monotonic()
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


# Parts sent, after the first time, as what changed only: Conversations is one block of
# every project's conversations (a megabyte with 2000 of them), and a working Pi changes
# one of them at each turn. Pier puts the whole back together (vm.js).
WATCH_PATCHED = {"conversations"}


def watch_patch(before, now):
    """{"order", "changed", "edited", "rest"}: the projects in order, the new ones
    (whole), and the rest of the data. A project known before that changed is in
    "edited": its fields but its conversations, their order, and only the conversations
    that changed (a working Pi changes one of 300). A project in neither is as it was."""
    old = {p.get("project"): p for p in before.get("projects") or []}
    projects = now.get("projects") or []
    changed, edited = {}, {}
    for project in projects:
        key = project.get("project")
        was = old.get(key)
        if was is None:
            changed[key] = project
        elif clean_json(was) != clean_json(project):
            seen = {s.get("path"): clean_json(s) for s in was.get("sessions") or []}
            sessions = project.get("sessions") or []
            edited[key] = {"fields": {k: v for k, v in project.items() if k != "sessions"},
                           "order": [s.get("path") for s in sessions],
                           "changed": {s.get("path"): s for s in sessions if seen.get(s.get("path")) != clean_json(s)}}
    return {"order": [p.get("project") for p in projects], "changed": changed, "edited": edited,
            "rest": {k: v for k, v in now.items() if k != "projects"}}


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


