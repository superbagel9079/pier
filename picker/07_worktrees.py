# --- worktrees: several Pis in one git project ---------------------------------------------
#
# Two Pis in the same folder step on each other's files. In a git project, the first Pi
# works in the folder itself, and every other one in a worktree of its own,
# .pi-worktrees/<its tmux session>, on a branch pi/agent-N-...: they come together by
# merges or pull requests, as a team does. The worktree has links to the project's
# .pi-images, .pi-files and .pi-shared, so what is given to that Pi is found. It is
# removed when its Pi ends without having changed or committed anything; otherwise it
# stays, listed in Setup > Git, until the user removes it.

WORKTREE_DIR = ".pi-worktrees"


def git_head(project):
    try:
        return jailed_git(git_jail(project), "-C", os.path.realpath(project), "rev-parse", "--verify", "-q", "HEAD").strip() or None
    except ApiError:
        return None


def make_worktree(project, slot, home):
    """A worktree for the Pi of tmux session slot, or None (not a git project, no commit
    yet, worktrees turned off, or git refusing)."""
    config, _ = load_config(home)
    if not config["worktrees"] or not git_dir(project):
        return None
    base = git_head(project)
    if not base:
        return None
    tidy_worktrees(project)
    folder = ignored_dir(project, WORKTREE_DIR)
    name = slot if not os.path.lexists(os.path.join(folder, slot)) else f"{slot}-{stamp()}"
    path = os.path.join(folder, name)
    base_name = session_name(project, home)  # the first Pi's session; the others add -N
    suffix = slot[len(base_name) + 1:] if slot.startswith(base_name + "-") else ""
    n = int(suffix) if suffix.isdigit() else 1
    branch = f"pi/agent-{n}-{stamp()}"  # stamp: the time and a random part, never twice
    try:
        jailed_git(git_jail_rw(project), "-C", os.path.realpath(project), "worktree", "add", "-q", "-b", branch, path, base)
    except ApiError as exc:
        log("warn", "worktree.failed", project=project, slot=slot, err=str(exc))
        return None
    # What is given to Pi lives in the project: reached through links from the worktree,
    # left out of git (the common info/exclude serves every worktree).
    for given in (IMAGE_DIR, FILES_DIR, SHARE_DIR):
        target = os.path.join(path, given)
        if not os.path.lexists(target):
            try:
                os.symlink(os.path.join("..", "..", given), target)
            except OSError:
                pass
    directory = git_dir(project)
    exclude = os.path.join(directory, "info", "exclude") if directory and os.path.isdir(directory) else None
    if exclude:
        current = read_text(exclude, 64 * 1024, root=project) or ""
        wanted = [f"/{given}" for given in (IMAGE_DIR, FILES_DIR, SHARE_DIR)] + [f"/{WORKTREE_DIR}/"]
        missing = [w for w in wanted if w not in current.split("\n")]
        if missing:
            os.makedirs(os.path.dirname(exclude), exist_ok=True)
            try:
                atomic_write(exclude, current + ("" if not current or current.endswith("\n") else "\n")
                             + "# written by pier-picker: what Pi is given, and the Pis' worktrees\n" + "\n".join(missing) + "\n",
                             project, 0o644)
            except ApiError:
                pass
    log("info", "worktree.made", project=project, slot=slot, path=path, branch=branch)
    return path


def worktree_of(project, path):
    """path if it is one of the project's Pi worktrees, else None."""
    if not path:
        return None
    real, folder = os.path.realpath(path), os.path.realpath(os.path.join(project, WORKTREE_DIR))
    return real if within(real, folder) and real != folder and os.path.isdir(real) else None


def worktree_state(project, path):
    """(changed files, commits not in the project's checked-out branch)."""
    jail = git_jail(project)
    try:
        dirty = len([l for l in jailed_git(jail, "-C", path, "status", "--porcelain").splitlines() if l.strip()])
        ahead = int(jailed_git(jail, "-C", path, "rev-list", "--count", f"{git_head(project) or 'HEAD'}..HEAD").strip() or 0)
    except (ApiError, ValueError):
        return None, None
    return dirty, ahead


def end_worktree(project, path):
    """When its Pi ends: an untouched worktree goes, with its branch; one with work stays."""
    dirty, ahead = worktree_state(project, path)
    if dirty or ahead or dirty is None:
        log("info", "worktree.kept", project=project, path=path, changed=dirty, commits=ahead)
        return False
    try:
        branch = jailed_git(git_jail(project), "-C", path, "branch", "--show-current").strip()
        jailed_git(git_jail_rw(project), "-C", os.path.realpath(project), "worktree", "remove", "--force", path)
        if PI_BRANCH_RE.fullmatch(branch or ""):
            jailed_git(git_jail_rw(project), "-C", os.path.realpath(project), "branch", "-D", branch)
    except ApiError as exc:
        log("warn", "worktree.remove-failed", project=project, path=path, err=str(exc))
        return False
    log("info", "worktree.removed", project=project, path=path, why="its Pi ended without changes")
    return True


def tidy_worktrees(project):
    """The untouched worktrees of Pis that no longer run, removed (see end_worktree)."""
    folder = os.path.join(project, WORKTREE_DIR)
    try:
        names = os.listdir(folder)
    except OSError:
        return
    running = {name for name, info in read_pi_sessions().items() if info.get("path") == project}
    for name in names:
        path = worktree_of(project, os.path.join(folder, name))
        if path and not any(name == slot or name.startswith(slot + "-") for slot in running):
            end_worktree(project, path)


def api_worktrees(home, path):
    """The Pis' worktrees of a project: branch, changes, commits ahead, whether its Pi runs."""
    project = resolve_inside(home, path)
    folder = os.path.join(project, WORKTREE_DIR)
    running = {name for name, info in read_pi_sessions().items() if info.get("path") == project}
    out = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        names = []
    for name in names:
        path = os.path.join(folder, name)
        if name.startswith(".") or not os.path.isdir(path) or os.path.islink(path) or not os.path.exists(os.path.join(path, ".git")):
            continue
        try:
            branch = jailed_git(git_jail(project), "-C", path, "branch", "--show-current").strip()
        except ApiError:
            branch = None
        dirty, ahead = worktree_state(project, path)
        out.append({"name": name, "path": path, "branch": branch, "changed": dirty, "ahead": ahead,
                    "running": any(name == slot or name.startswith(slot + "-") for slot in running)})
    return {"project": project, "worktrees": out}


def api_worktree_remove(home, path, name):
    """A worktree removed from Pier (its branch stays: it may hold work to merge)."""
    project = resolve_inside(home, path)
    target = worktree_of(project, os.path.join(project, WORKTREE_DIR, name or ""))
    if not target or "/" in (name or ""):
        raise ApiError(f"not one of the Pis' worktrees: {name}")
    jailed_git(git_jail_rw(project), "-C", os.path.realpath(project), "worktree", "remove", "--force", target)
    log("info", "worktree.removed", project=project, path=target, why="removed from Pier")
    return {"removed": name}


def api_stop(home, path, slot):
    """Stop the Pis of a project, or one of them. Their conversations stay saved."""
    project = resolve_inside(home, path)
    pis = [p for p in project_pis(pi_sessions(), project) if not slot or p["name"] == slot]
    if not pis:
        raise ApiError("no Pi runs there")
    for pi in pis:
        run_quiet(tmux_cmd("kill-session", "-t", f"={pi['name']}"))
        forget_pi_sessions()
    # Killed with its session, a Pi cannot clean its worktree up itself: done here.
    tidy_worktrees(project)
    return {"project": project, "stopped": len(pis)}


def start_pi_session(path, extra, env, home, width, height, name=None, worktree=None):
    """A detached tmux session running Pi in path, styled to stay discreet. False on failure.
    PI_PICKER_SLOT tells --exec-pi its session name, to record its conversation there."""
    name = name or session_name(path, home)
    command = [sys.executable, SCRIPT, "--exec-pi", path, *extra]
    # -f: a server started here reads Pier's config, not ~/.tmux.conf (see tmux_conf).
    conf = write_tmux_conf(load_config(home)[0])
    where = ["-e", f"PIER_WORKTREE={worktree}"] if worktree else []
    if not run_quiet(tmux_cmd("-f", conf, "new-session", "-d", "-s", name, "-c", path, "-e", f"PI_PICKER_SLOT={name}", *where,
                              "-x", str(width), "-y", str(height), *command), env):
        log("error", "tmux.new-session-failed", project=path, session=name)
        return False
    log("info", "tmux.new-session", project=path, session=name, size=f"{width}x{height}")
    forget_pi_sessions()
    tmux_server_options(env, load_config(home)[0])
    label = pretty_path(path, home).replace("#", "##")
    n = slot_number(name, path, home)
    if n > 1:
        label += f"  #{n}".replace("#", "##")
    config, _ = load_config(home)
    if sandbox_wanted(config):
        label += "  [sandbox]"
    # The rest of the bar's look is global, in tmux_conf: only the project is per session.
    run_quiet(tmux_cmd("set-option", "-t", f"={name}:", "status-left", f" pi  {label} "), env)
    if extra[:1] == ["--session"] and len(extra) >= 2:
        set_pi_file(name, extra[1])
    return True


def tmux_conf(config):
    """The config of this tmux server, which only runs Pi sessions. It is the server's
    own: a server started by the picker reads it instead of ~/.tmux.conf (whose bindings,
    colours or messages would surprise), and it is read again at every attach, so that
    a server started earlier gets it too.

    Pier does not go through tmux's screen: its Pi tabs use control mode (see
    attach_control), and scroll, select and copy in Pier itself. This config is for
    the other way in, a plain `ssh` with the picker in a terminal:
    - extended keys: without them tmux turns Shift+Enter and Ctrl+Enter into Enter, and
      Pi warns about it. csi-u needs tmux 3.5; older ones keep their default quietly.
    - mouse: the wheel scrolls back through Pi's history (kept by tmux), a drag selects
      and copies.
    - set-clipboard: what is copied in tmux, or by Pi, reaches the terminal's clipboard
      (OSC 52).
    - colours: only the terminal's 16, never fixed ones. The bar is the palette's grey
      on no background: it follows the terminal's theme.
    """
    lines = [
        "# Written by pier-picker for the tmux server of Pi's sessions (see tmux_conf there).",
        "# Rewritten at each start. ~/.tmux.conf is not read by this server.",
        "set -s extended-keys on",
        "set -sq extended-keys-format csi-u",
        "set -s set-clipboard on",
        "set -s escape-time 10",
        "set -su terminal-overrides[90]",
        "set -g mouse on",
        "set -g history-limit 20000",
        "",
        "# Colours from the terminal's palette: the bar follows its theme.",
        'set -g status-style "bg=default,fg=brightblack"',
        'set -g message-style "bg=default,fg=yellow"',
        'set -g message-command-style "bg=default,fg=yellow"',
        'set -g mode-style "bg=brightblack,fg=default"',
        'set -gq copy-mode-position-style "bg=default,fg=brightblack"',
        'set -g status-left-length 80',
        'set -g status-right " ctrl-b d: detach, pi keeps running "',
        "set -g status-right-length 60",
        'set -g window-status-format ""',
        'set -g window-status-current-format ""',
        "",
    ]
    return "\n".join(lines)


def write_tmux_conf(config):
    """The config file, written when it changed; its path."""
    conf = os.path.join(os.path.dirname(state_path(home_dir())), "tmux.conf")
    text = tmux_conf(config)
    try:
        with open(conf, encoding="utf-8") as handle:
            if handle.read() == text:
                return conf
    except OSError:
        pass
    os.makedirs(os.path.dirname(conf), mode=0o700, exist_ok=True)
    with open(conf, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    return conf


def tmux_server_options(env, config):
    """Applies tmux_conf to the running server, and resets the look older pickers set
    per session, so that every session follows it."""
    conf = write_tmux_conf(config)
    run_quiet(tmux_cmd("source-file", "-q", conf), env)
    for name in pi_sessions():
        for option in ("status-style", "status-right", "status-right-length", "window-status-format",
                       "window-status-current-format", "status-left-length"):
            run_quiet(tmux_cmd("set-option", "-u", "-t", f"={name}:", option), env)


def set_pi_file(slot, file):
    """Record in tmux which conversation the Pi of a session writes. set-option takes a
    pane: "=name:" is the session's (without the colon, tmux looks for a window)."""
    run_quiet(tmux_cmd("set-option", "-t", f"={slot}:", "@pi-file", file))
    forget_pi_sessions()


