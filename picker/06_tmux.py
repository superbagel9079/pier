# --- tmux sessions -------------------------------------------------------------------------

def add_recent(state, path):
    recent = [p for p in state["recent"] if p != path]
    state["recent"] = [path] + recent[:RECENT_KEPT - 1]


_PI_SESSIONS = [0.0, None]  # (when, answer): the watch asks for several parts in one go
PI_SESSIONS_FRESH = 0.5


def forget_pi_sessions():
    """After starting, stopping or relabelling a Pi: the next pi_sessions asks tmux."""
    _PI_SESSIONS[1] = None


def pi_sessions():
    """The tmux sessions holding a Pi, by name: {"name", "path", "attached",
    "last_attached", "file", "working"}. "file" is the session file of that Pi, when
    known (see PIER_EXTENSION, PromptWatcher): a project can run several Pis, each in
    its own conversation. Asked to tmux at most every half second.

    Empty when tmux is missing or runs no session.
    """
    now = time.monotonic()
    if _PI_SESSIONS[1] is None or now - _PI_SESSIONS[0] >= PI_SESSIONS_FRESH:
        _PI_SESSIONS[0], _PI_SESSIONS[1] = now, read_pi_sessions()
    sessions = {}
    for name, info in _PI_SESSIONS[1].items():
        said = pier_state(name)  # what Pi says, read every time: small files, and it moves
        sessions[name] = dict(info, file=(said and said["file"]) or info["file"],
                              working=said["working"] if said else None)
    return sessions


def read_pi_sessions():
    if not shutil.which("tmux"):
        return {}
    fmt = "#{session_name}\t#{session_attached}\t#{session_last_attached}\t#{@pi-file}\t#{session_path}"
    try:
        result = subprocess.run(tmux_cmd("list-sessions", "-F", fmt), stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, errors="surrogateescape", timeout=2)
    except (OSError, subprocess.SubprocessError):
        return {}
    if result.returncode != 0:
        return {}
    sessions = {}
    for line in result.stdout.splitlines():
        parts = line.split("\t", 4)
        if len(parts) != 5:
            continue
        name, attached, last, file, path = parts
        sessions[name] = {
            "name": name,
            "path": path,
            "attached": attached not in ("", "0"),
            "last_attached": int(last) if last.isdigit() else 0,
            "file": file or None,  # what tmux recorded; what Pi says wins (see pi_sessions)
        }
    return sessions


def project_pis(sessions, project):
    """The Pis running in project, the one used last first."""
    pis = [s for s in sessions.values() if s["path"] == project]
    pis.sort(key=lambda s: (s["attached"], s["last_attached"]), reverse=True)
    return pis


def slot_number(name, project, home):
    """1 for the first Pi of a project (its tmux session is session_name), n for "name-n"."""
    base = session_name(project, home)
    rest = name[len(base) + 1:] if name.startswith(base + "-") else ""
    return int(rest) if rest.isdigit() else 1


def free_slot(project, home, sessions):
    base = session_name(project, home)
    if base not in sessions:
        return base
    n = 2
    while f"{base}-{n}" in sessions:
        n += 1
    return f"{base}-{n}"


def new_session_file(project):
    """A path for a new conversation, named the way Pi names its own. Pi creates the
    file there (at its first answer) when given --session with a path that does not
    exist: so the picker knows which file each Pi writes."""
    folder = session_dir(project)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    now = time.time()
    stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime(now)) + f"-{int(now % 1 * 1000):03d}Z"
    return os.path.join(folder, f"{stamp}_{uuid.uuid4()}.jsonl")


def session_file_in(project, file):
    """file, checked to be a conversation of project (existing or not)."""
    full = os.path.realpath(file)
    if os.path.dirname(full) != os.path.realpath(session_dir(project)) or not full.endswith(".jsonl"):
        raise ApiError(f"not a Pi session of this project: {file}")
    return full


def pi_file(pi, project, count):
    """The session file of a running Pi: known, else (a lone Pi) the newest one."""
    if pi.get("file"):
        return pi["file"]
    return latest_session_file(project) if count == 1 else None


def pi_infos(project, home, pis):
    infos = []
    for pi in pis:
        file = pi_file(pi, project, len(pis))
        working = pi.get("working")
        infos.append({"slot": pi["name"], "n": slot_number(pi["name"], project, home), "file": file,
                      "attached": pi["attached"], "last_attached": pi["last_attached"],
                      "working": working if working is not None else bool(file) and session_working(file)})
    return infos


def open_pi(project, extra, env, home, width, height):
    """(tmux session, started): the Pi of project that extra asks for.

      []                  the Pi used last there, or a new one
      ["--new"]           a new Pi, in a new conversation
      ["--slot", NAME]    that running Pi
      ["--continue"]      the latest conversation: its Pi if one runs it, else a new Pi on it
      ["--session", FILE] the same for that conversation
      ["--agent-task", KIND, N]  a new Pi, in a new conversation, asked to take task N or
                          review pull request N (KIND: task, review; see AGENT_PROMPTS)
      anything else       a new Pi with those arguments (--resume...)
    """
    refusal = pi_refusal(project, home)
    if refusal:
        # Said now, before tmux: started, Pi would only print it in a pane nobody sees.
        raise ApiError(refusal)
    sessions = pi_sessions()
    pis = project_pis(sessions, project)
    extra = list(extra)
    if not extra and pis:
        return pis[0]["name"], False
    if extra[:1] == ["--slot"]:
        names = [p["name"] for p in pis]
        if len(extra) != 2 or extra[1] not in names:
            raise ApiError("that Pi is not running any more")
        return extra[1], False
    if extra[:1] == ["--agent-task"]:
        if len(extra) != 3:
            raise ApiError("--agent-task takes a kind and a number")
        extra = ["--session", new_session_file(project), agent_prompt(extra[1], extra[2])]
    elif not extra or extra == ["--new"]:
        extra = ["--session", new_session_file(project)]
    elif extra == ["--continue"]:
        latest = latest_session_file(project)
        extra = ["--session", latest or new_session_file(project)]
    if extra[:1] == ["--session"] and len(extra) != 3:
        if len(extra) != 2:
            raise ApiError("--session takes one session file")
        extra = ["--session", session_file_in(project, extra[1])]
        for pi in pis:
            if pi_file(pi, project, len(pis)) == extra[1]:
                return pi["name"], False
    for _ in range(4):
        name = free_slot(project, home, sessions)
        # Another Pi works in the folder: this one gets a worktree of its own, on its branch.
        worktree = make_worktree(project, name, home) if pis else None
        if start_pi_session(project, extra, env, home, width, height, name, worktree=worktree):
            return name, True
        # Another call took that name meanwhile: look again.
        forget_pi_sessions()
        sessions = pi_sessions()
    raise ApiError("tmux could not start the session")


