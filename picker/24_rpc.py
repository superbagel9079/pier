# --- Pi in RPC mode, for Pier's conversation view ----------------------------------------
#
# Without tmux: a host process per Pi (--rpc-host) keeps `pi --mode rpc` alive on the VM
# when Pier goes, writes every line Pi prints to events.jsonl, and takes commands on a
# Unix socket. Pier joins with --rpc-attach over an SSH channel: Pi's lines from there on
# come out, Pier's commands (one JSON object a line) go in. Detaching leaves Pi working.
# The folder is the picker's state folder (Pi never writes there), 0700, the socket 0600.

RPC_LINE_MAX = 4 * 1024 * 1024    # a command from Pier, at most (an image pasted)
RPC_LOG_MAX = 16 * 1024 * 1024    # events.jsonl past this starts again (an attach follows)
RPC_SLOT_RE = re.compile(r"pi-[A-Za-z0-9_-]{1,100}")


def rpc_dir():
    return os.path.join(pier_dir(), "rpc")


def rpc_slot_dir(slot):
    if not RPC_SLOT_RE.fullmatch(slot or ""):
        raise ApiError(f"not a Pi: {slot!r}")
    return os.path.join(rpc_dir(), slot)


def rpc_alive(slot):
    """The host's pid while it runs, else None."""
    try:
        with open(os.path.join(rpc_slot_dir(slot), "pid"), encoding="utf-8") as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        return pid
    except PermissionError:
        return pid
    except (OSError, ValueError, ApiError):
        return None


def rpc_sessions():
    """The Pis running in RPC mode, as read_pi_sessions gives tmux's: by name."""
    sessions = {}
    try:
        names = os.listdir(rpc_dir())
    except OSError:
        return sessions
    for name in names:
        if not RPC_SLOT_RE.fullmatch(name) or not rpc_alive(name):
            continue
        try:
            with open(os.path.join(rpc_dir(), name, "meta.json"), encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            continue
        # Started on a new conversation (no --session/--continue): never the newest file's.
        fresh = not set(meta.get("args") or []) & {"--session", "--continue"}
        sessions[name] = {"name": name, "path": meta.get("project"), "attached": False,
                          "last_attached": int(meta.get("started") or 0), "file": None, "rpc": True, "fresh": fresh}
    return sessions


def rpc_new_slot(project, home):
    """A free name: the project's tmux name, then -r1, -r2…"""
    base = session_name(project, home)
    n = 1
    while rpc_alive(f"{base}-r{n}"):
        n += 1
    return f"{base}-r{n}"


def rpc_pi_args(extra):
    """Pier's forms, as Pi takes them: a new conversation, the last one, or one file."""
    if extra in ([], ["--new"]):
        return []
    if extra == ["--continue"]:
        return ["--continue"]
    if len(extra) == 2 and extra[0] == "--session" and extra[1].endswith(".jsonl") and "\n" not in extra[1]:
        return ["--session", extra[1]]
    raise ApiError("unsupported Pi arguments")


def rpc_host(slot, project, extra):
    """--rpc-host SLOT DIR [PI ARGS]: run Pi in RPC mode for good (see the top of this part)."""
    folder = rpc_slot_dir(slot)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    events = os.path.join(folder, "events.jsonl")
    sock_path = os.path.join(folder, "in.sock")
    env = dict(os.environ, PI_PICKER_SLOT=slot, PIER_RPC="1")
    child = subprocess.Popen([sys.executable, SCRIPT, "--exec-pi", project, *extra], cwd=project, env=env,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    with open(os.path.join(folder, "pid"), "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))
    with open(os.path.join(folder, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"project": project, "args": extra, "started": int(time.time())}, f)
    try:
        os.unlink(sock_path)
    except FileNotFoundError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        server.bind(sock_path)
    finally:
        os.umask(old)
    server.listen(8)
    feeding = threading.Lock()

    def feed(conn):
        with conn, conn.makefile("rb") as lines:
            for line in lines:
                if len(line) > RPC_LINE_MAX or not line.strip():
                    continue
                with feeding:
                    try:
                        child.stdin.write(line if line.endswith(b"\n") else line + b"\n")
                        child.stdin.flush()
                    except (BrokenPipeError, ValueError):
                        return

    def accept():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=feed, args=(conn,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    log("info", "rpc.started", project=project, slot=slot)
    out = open(events, "ab")
    for raw in child.stdout:
        # Pi's own lines are JSON; anything else (a startup error) is passed on as text.
        line = raw if raw.lstrip().startswith(b"{") else (
            json.dumps({"type": "pier_text", "text": raw.decode("utf-8", "replace").rstrip("\n")}).encode() + b"\n")
        out.write(line if line.endswith(b"\n") else line + b"\n")
        out.flush()
        if out.tell() > RPC_LOG_MAX:  # a new file: an attach sees the change and reads it from its start
            out.close()
            os.replace(events, events + ".1")
            out = open(events, "ab")
    code = child.wait()
    out.write(json.dumps({"type": "pier_exit", "code": code}).encode() + b"\n")
    out.close()
    server.close()
    for name in ("in.sock", "pid"):
        try:
            os.unlink(os.path.join(folder, name))
        except FileNotFoundError:
            pass
    log("info", "rpc.ended", project=project, slot=slot, code=code)
    return 0


def rpc_say(record):
    sys.stdout.write(json.dumps(record) + "\n")
    sys.stdout.flush()


def rpc_attach(path, extra):
    """--rpc-attach DIR [--new | --continue | --session FILE | --slot NAME]: a Pi in RPC
    mode, started if need be, joined on this channel (see the top of this part). Every
    error is a {"type": "pier_error"} line: the channel carries JSON only."""
    home = home_dir()
    try:
        project = resolve_inside(home, path)
        if extra[:1] == ["--slot"] and len(extra) == 2:
            slot = extra[1]
            rpc_slot_dir(slot)
            if not rpc_alive(slot):
                raise ApiError("this Pi has stopped: its conversation is saved, continue it from the list")
            fresh = False
        else:
            args = rpc_pi_args(list(extra))
            # The last conversation by its file; one a Pi already runs is joined, never
            # opened twice (two Pis writing one file would break it).
            if args == ["--continue"]:
                latest = latest_session_file(project)
                args = ["--session", latest] if latest else []
            running = None
            if args[:1] == ["--session"]:
                file = session_file_in(project, args[1])
                running = next((p for p in project_pis(pi_sessions(), project)
                                if p.get("file") and os.path.realpath(p["file"]) == file), None)
                if running and not running.get("rpc"):
                    raise ApiError("this conversation runs in a terminal (tmux): open it there, or stop that Pi first")
            if running:
                return rpc_attach(path, ["--slot", running["name"]])
            slot = rpc_new_slot(project, home)
            folder = rpc_slot_dir(slot)
            os.makedirs(folder, mode=0o700, exist_ok=True)
            # A Pi of this name that was killed may have left its socket and pid: the attach
            # below would find that socket at once and connect to nothing (Connection refused).
            for old in ("events.jsonl", "events.jsonl.1", "in.sock", "pid"):
                try:
                    os.unlink(os.path.join(folder, old))
                except FileNotFoundError:
                    pass
            # Its own session: closing this channel (Pier gone) does not reach it.
            subprocess.Popen([sys.executable, SCRIPT, "--rpc-host", slot, project, *args], cwd=project,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True, env=child_env(home))
            forget_pi_sessions()
            fresh = True
    except ApiError as exc:
        rpc_say({"type": "pier_error", "error": str(exc)})
        return 1
    folder = rpc_slot_dir(slot)
    events, sock_path = os.path.join(folder, "events.jsonl"), os.path.join(folder, "in.sock")
    for _ in range(100):  # the host's socket: up within a few seconds
        if os.path.exists(sock_path):
            break
        time.sleep(0.1)
    else:
        rpc_say({"type": "pier_error", "error": "Pi did not start (see the picker's log)"})
        return 1
    state = load_state(home)
    add_recent(state, project)
    save_state(home, state)
    rpc_say({"type": "pier_attached", "slot": slot, "project": project, "fresh": fresh})

    def tail():
        """Pi's lines from now on (from the start for a Pi just started), the file
        followed through a restart (RPC_LOG_MAX); the end once Pi has gone."""
        while not os.path.exists(events):
            time.sleep(0.05)
        f = open(events, "rb")
        if not fresh:
            f.seek(0, os.SEEK_END)
        inode = os.fstat(f.fileno()).st_ino
        while True:
            line = f.readline()
            if line:
                sys.stdout.buffer.write(line)
                sys.stdout.flush()
                if line.startswith(b'{"type": "pier_exit"'):
                    os._exit(0)
                continue
            try:
                if os.stat(events).st_ino != inode:
                    f.close()
                    f = open(events, "rb")
                    inode = os.fstat(f.fileno()).st_ino
                    continue
            except FileNotFoundError:
                pass
            time.sleep(0.05)

    threading.Thread(target=tail, daemon=True).start()
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        # The socket's file is there a moment before the host listens on it: tried again
        # for a few seconds rather than lost at once.
        for attempt in range(50):
            try:
                conn.connect(sock_path)
                break
            except (ConnectionRefusedError, FileNotFoundError):
                if attempt == 49:
                    raise
                time.sleep(0.1)
        for line in sys.stdin.buffer:
            if len(line) <= RPC_LINE_MAX and line.strip():
                conn.sendall(line if line.endswith(b"\n") else line + b"\n")
    except OSError as exc:
        rpc_say({"type": "pier_error", "error": f"lost Pi: {exc}"})
        return 1
    finally:
        conn.close()
    return 0  # Pier went: Pi works on, for the next attach
