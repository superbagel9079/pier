# --- project setup ---------------------------------------------------------------------
#
# Mirrors Pi's resource loader: a global context file in the agent dir, then the first
# of AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD in every directory from / down to the
# project. .pi/SYSTEM.md and .pi/APPEND_SYSTEM.md only count once the project is
# trusted (~/.pi/agent/trust.json, nearest entry wins); otherwise Pi uses the global
# ones in the agent dir.

CONTEXT_NAMES = ("AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
TEXT_MAX_BYTES = 256 * 1024
HISTORY_KEEP = 10
HISTORY_DIR = os.path.join(".pi", "devbox-history")
EDITABLE = {"instructions": None, "append": os.path.join(".pi", "APPEND_SYSTEM.md"),
            "system": os.path.join(".pi", "SYSTEM.md")}


def agent_dir():
    return os.path.expanduser(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home_dir(), ".pi", "agent"))


def context_file_in(directory):
    for name in CONTEXT_NAMES:
        path = os.path.join(directory, name)
        if os.path.isfile(path):
            return path
    return None


def read_text(path, limit=TEXT_MAX_BYTES, root=None):
    """At most limit bytes of a plain file, as text; None otherwise. With root (the
    project), a link leading out of it is not followed: see open_regular."""
    fd = open_regular(path, root)
    if fd is None:
        return None
    try:
        with os.fdopen(fd, "rb") as handle:
            return handle.read(limit).decode("utf-8", "replace")
    except OSError:
        return None


def startup_files(project, home):
    """What Pi loads as context at startup, in its order."""
    files = []
    seen = set()
    global_file = context_file_in(agent_dir())
    if global_file:
        files.append({"path": global_file, "label": pretty_path(global_file, home), "scope": "global"})
        seen.add(global_file)
    chain = []
    current = project
    while True:
        found = context_file_in(current)
        if found and found not in seen:
            chain.insert(0, {"path": found, "label": pretty_path(found, home) if within(found, home) else found,
                             "scope": "project" if current == project else "parent"})
            seen.add(found)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    files.extend(chain)
    for f in files:
        try:
            f["size"] = os.path.getsize(f["path"])
        except OSError:
            f["size"] = 0
    return files


def trust_decision(project):
    """True, False, or None (never decided), as Pi reads ~/.pi/agent/trust.json."""
    text = read_text(os.path.join(agent_dir(), "trust.json"), 4 * 1024 * 1024)
    try:
        data = json.loads(text) if text is not None else None
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    current = os.path.realpath(project)
    while True:
        value = data.get(current)
        if value is True or value is False:
            return value
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def editable_path(project, which):
    if which not in EDITABLE:
        raise ApiError(f"unknown text: {which}")
    if which == "instructions":
        return context_file_in(project) or os.path.join(project, "AGENTS.md")
    return os.path.join(project, EDITABLE[which])


def history_entries(project, which):
    folder = os.path.join(project, HISTORY_DIR)
    try:
        names = sorted((n for n in os.listdir(folder) if n.startswith(which + "-") and n.endswith(".md")), reverse=True)
    except OSError:
        return []
    entries = []
    for name in names[:HISTORY_KEEP]:
        path = os.path.join(folder, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        key = (st.st_size, st.st_mtime_ns)
        cached = _HISTORY.get(path)
        if not cached or cached[0] != key:
            cached = (key, read_text(path, 64 * 1024, root=project) or "")
            remember(_HISTORY, path, cached, 512)
        entries.append({"path": path, "at": int(st.st_mtime), "text": cached[1]})
    return entries


_HISTORY = {}  # history file -> ((size, mtime), text)


def first_prompt(session):
    """The first thing the user asked in a session file, for a readable list."""
    try:
        with open_plain(session, sessions_root()) as handle:
            for raw in handle:
                if b'"role":"user"' not in raw:
                    continue
                if len(raw) > 200 * 1024:
                    # A screenshot with it: the line is mostly base64, its text read without
                    # parsing it all.
                    found = re.search(rb'"type":"text","text":"((?:[^"\\]|\\.){0,4000})', raw)
                    try:
                        text = json.loads(b'"' + found.group(1) + b'"').strip() if found else ""
                    except ValueError:
                        text = ""
                    return text[:200] or "(an image)"
                content = json.loads(raw).get("message", {}).get("content")
                if isinstance(content, str):
                    return content.strip()[:200]
                if isinstance(content, list):
                    texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
                    return (" ".join(texts).strip() or "(an image)")[:200]
                return ""
    except (OSError, ValueError, AttributeError):
        return ""
    return ""


_NAMES = {}  # session file -> (identity, offset, name, tail): only what Pi appended is read again
NAME_SCAN_COLD = 4 * 1024 * 1024


def session_name_of(session):
    """The name given in Pi (/name), the last one. A file Pi appends to is read from
    where the last reading stopped, in big blocks searched for the marker only."""
    marker = b'"type":"session_info"'
    try:
        st = os.stat(session)
    except OSError:
        return None
    identity = (st.st_dev, st.st_ino)
    cached = _NAMES.get(session)
    if cached and cached[0] == identity and cached[1] <= st.st_size and session_tail(session, cached[1]) == cached[3]:
        offset, name = cached[1], cached[2]
    else:
        # Cold: a big conversation (images) is searched near its end only, where a
        # name given lately is; reading hundreds of MB would stall the watch.
        offset, name = max(0, st.st_size - NAME_SCAN_COLD), None
    try:
        with open_plain(session, sessions_root()) as handle:
            handle.seek(offset)
            rest = b""
            while True:
                block = handle.read(1 << 20)
                if not block:
                    break
                data = rest + block
                end = data.rfind(b"\n") + 1  # whole lines only; the rest waits for the next block
                lines, rest = data[:end], data[end:]
                at = lines.find(marker)
                while at >= 0:
                    start = lines.rfind(b"\n", 0, at) + 1
                    stop = lines.find(b"\n", at)
                    try:
                        info = json.loads(lines[start:stop])
                        if isinstance(info, dict) and info.get("type") == "session_info" and "name" in info:
                            name = info["name"] or None
                    except ValueError:
                        pass
                    at = lines.find(marker, stop)
                offset += len(lines)
    except OSError:
        return name
    remember(_NAMES, session, (identity, offset, name, session_tail(session, offset)), 4000)
    return name


# Names and categories given in Pier to conversations: Pier's own, in
# ~/.local/state/pier-picker/labels.json (Pi's files are not touched).

LABEL_MAX = 80


def labels_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "labels.json")


def load_labels(home):
    data = private_json(labels_path(home))
    return data if isinstance(data, dict) else {}


def api_label(home, path, file, title, category):
    project = resolve_inside(home, path)
    file = label_key(project, file)
    with labels_lock(home):
        labels = load_labels(home)
        entry = dict(labels.get(file) or {}, title=title.strip()[:LABEL_MAX], category=category.strip()[:LABEL_MAX])
        store_label(labels, file, entry)
        save_labels(home, labels, file)
    log("info", "session.label", project=project, file=os.path.basename(file), category=entry["category"])
    return {"file": file, **entry}


def label_key(project, file):
    """A conversation of project, checked, named the way the lists name it."""
    full = session_file_in(project, file)
    return os.path.join(session_dir(project), os.path.basename(full))


class file_lock:
    """One process (and one thread) at a time between enter and exit, on a lock file of
    the picker's own (never in a folder Pi can write). The thread holding it may take it
    again inside: a function changing labs.json may call another that does."""
    _held = threading.local()  # path -> how many times this thread holds it

    def __init__(self, path):
        self.path = path
        self.handle = None

    def __enter__(self):
        held = self._held.__dict__.setdefault("paths", {})
        if held.get(self.path):
            held[self.path] += 1
            return self
        try:
            import fcntl
            os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
            self.handle = open(self.path, "a")
            fcntl.flock(self.handle, fcntl.LOCK_EX)
        except (ImportError, OSError):
            self.handle = None
        held[self.path] = 1
        return self

    def __exit__(self, *exc):
        held = self._held.__dict__.setdefault("paths", {})
        held[self.path] = held.get(self.path, 1) - 1
        if held[self.path] <= 0:
            held.pop(self.path, None)
            if self.handle:
                self.handle.close()  # closing releases the lock
        return False


def labels_lock(home):
    """Two calls at once (a pin here, an archive there) must not lose one."""
    return file_lock(labels_path(home) + ".lock")


def marks_lock(shared):
    name = hashlib.sha1(os.fsencode(os.path.realpath(shared))).hexdigest()[:16]
    return file_lock(os.path.join(os.path.dirname(state_path(home_dir())), "locks", f"marks-{name}.lock"))


def store_label(labels, file, entry):
    """Keeps an entry only while it says something."""
    if any(entry.get(k) for k in ("title", "category", "pinned", "archived")):
        labels[file] = entry
    else:
        labels.pop(file, None)


def api_mark(home, path, file, what, value):
    """Pins a conversation (kept on top) or archives it (hidden from the lists, still
    searchable): `mark PROJECT FILE pinned|archived 1|0`."""
    if what not in ("pinned", "archived") or value not in ("0", "1"):
        raise ApiError("mark takes pinned or archived, and 1 or 0")
    project = resolve_inside(home, path)
    file = label_key(project, file)
    with labels_lock(home):
        labels = load_labels(home)
        entry = dict(labels.get(file) or {})
        entry[what] = value == "1"
        if entry[what] and what == "archived":
            entry["pinned"] = False
        store_label(labels, file, entry)
        save_labels(home, labels, file)
    log("info", "session.mark", project=project, file=os.path.basename(file), what=what, value=value)
    return {"file": file, what: entry[what]}


def save_labels(home, labels, file):
    # Forgotten conversations go: a label lives as long as its file.
    labels = {f: v for f, v in labels.items() if os.path.exists(f) or f == file}
    write_json(labels_path(home), labels, indent=1)


_SESSION_INFO = {}  # path -> ((size, mtime), info): a session file is read again only when it changed


def session_info(path, st):
    """A conversation for the lists: name, first question, and its token use (files up
    to 8 MB), read again only when the file changed."""
    key = (st.st_size, st.st_mtime_ns)
    cached = _SESSION_INFO.get(path)
    if cached and cached[0] == key:
        return dict(cached[1])
    first = cached[1] if cached else None
    info = {"path": path, "file": os.path.basename(path), "modified": int(st.st_mtime),
            "name": session_name_of(path),
            # The first prompt does not change once there is one.
            "prompt": first["prompt"] if first and first["prompt"] else first_prompt(path), "usage": None}
    if st.st_size <= 8 * 1024 * 1024:
        try:
            _, _, usage, _ = read_session(path)
            info["usage"] = usage
        except OSError:
            pass
    remember(_SESSION_INFO, path, (key, info), 4000)
    return dict(info)


# What Pi loads besides itself, read from where Pi looks (nothing is run):
# - packages: "packages" in settings.json (npm:name, git:…, or a path), installed in
#   <agent dir>/npm or git for the user's, <project>/.pi/npm or git for a project's;
# - extensions, skills and prompt templates: their folders, in the agent dir and in the
#   project's .pi, plus the paths in settings.json;
# - MCP servers: ~/.pi/agent/mcp.json and the project's .pi/mcp.json (Pi 1.x connects
#   them itself; `pi mcp add`), with whether each is enabled.
# A project's .pi only counts once the project is trusted: Setup says so next to it.

RESOURCE_KINDS = ("extensions", "skills", "prompts")
RESOURCE_MAX = 100


def read_json_file(path):
    """A JSON file, comment lines allowed; None when missing or unreadable."""
    if not os.path.isfile(path):
        return None
    text = read_text(path) or ""
    for attempt in (text, re.sub(r"(?m)^\s*//.*$", "", text)):
        try:
            return json.loads(attempt)
        except ValueError:
            continue
    return None


def package_folder(spec, base):
    if spec.startswith("npm:"):
        name = spec[4:]
        at = name.rfind("@")
        return os.path.join(base, "npm", "node_modules", name[:at] if at > 0 else name)
    if spec.startswith(("git:", "http://", "https://", "ssh://", "git@")):
        # Pi clones to <base>/git/<host>/<path> (docs/packages.md), without the @ref.
        rest = re.sub(r"^(git:|https?://|ssh://)", "", spec)
        rest = re.sub(r"^git@([^:/]+)[:/]", r"\1/", rest)  # git@host:user/repo
        rest = re.sub(r"@[^/@]*$", "", rest).removesuffix(".git").strip("/")
        if not rest or ".." in rest.split("/"):
            return None
        return os.path.join(base, "git", *rest.split("/"))
    path = os.path.expanduser(spec)
    return path if os.path.isabs(path) else os.path.join(base, path)


def package_info(entry, base, scope):
    spec = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
    if not isinstance(spec, str) or not spec:
        return None
    info = {"source": spec, "scope": scope, "version": None, "description": None, "installed": None}
    folder = package_folder(spec, base)
    if folder:
        info["installed"] = os.path.isdir(folder)
        manifest = read_json_file(os.path.join(folder, "package.json")) or {}
        if isinstance(manifest, dict):
            info["version"] = manifest.get("version") if isinstance(manifest.get("version"), str) else None
            description = manifest.get("description")
            info["description"] = description[:200] if isinstance(description, str) else None
    return info


def folder_items(folder, kind):
    try:
        names = sorted(os.listdir(folder))[:RESOURCE_MAX]
    except OSError:
        return []
    items = []
    for name in names:
        if name.startswith("."):
            continue
        path = os.path.join(folder, name)
        if kind == "skills" and not os.path.isfile(os.path.join(path, "SKILL.md")):
            continue
        if kind == "prompts" and not name.endswith(".md"):
            continue
        if kind == "extensions" and os.path.isfile(path) and not name.endswith((".ts", ".js", ".mjs")):
            continue
        items.append(name[:-3] if kind == "prompts" else name)
    return items


MCP_FILES = (("user", "{agent}/mcp.json"), ("project", "{project}/.pi/mcp.json"))


def pi_resources(project, home):
    agent = agent_dir()
    places = (("user", agent, read_json_file(os.path.join(agent, "settings.json"))),
              ("project", os.path.join(project, ".pi"), read_json_file(os.path.join(project, ".pi", "settings.json"))))
    out = {"packages": [], "extensions": [], "skills": [], "prompts": [], "mcp": [], "model": {}}
    for scope, base, settings in places:
        settings = settings if isinstance(settings, dict) else {}
        for entry in settings.get("packages") or []:
            info = package_info(entry, base, scope)
            if info:
                out["packages"].append(info)
        for kind in RESOURCE_KINDS:
            for name in folder_items(os.path.join(base, kind), kind):
                out[kind].append({"name": name, "scope": scope, "from": pretty_path(os.path.join(base, kind), home)})
            for path in settings.get(kind) or []:
                if isinstance(path, str):
                    out[kind].append({"name": path, "scope": scope, "from": "settings.json"})
        for key in ("defaultProvider", "defaultModel", "defaultThinkingLevel"):
            if isinstance(settings.get(key), str):
                out["model"][key] = settings[key]
    for scope, pattern in MCP_FILES:
        path = pattern.format(agent=agent, project=project)
        config = read_json_file(path)
        servers = config.get("mcpServers") if isinstance(config, dict) else None
        if not isinstance(servers, dict):
            continue
        for name, server in list(servers.items())[:RESOURCE_MAX]:
            server = server if isinstance(server, dict) else {}
            kind = "http" if server.get("url") else "stdio" if server.get("command") else None
            description = server.get("description") if isinstance(server.get("description"), str) else None
            out["mcp"].append({"name": name, "scope": scope, "from": pretty_path(path, home), "kind": kind,
                               "enabled": server.get("enabled") is not False, "description": description})
    versions = pi_versions_soon(home, [p["source"] for p in out["packages"]])
    out["pi"] = versions.get("pi")
    for info in out["packages"]:
        info["latest"] = versions.get(info["source"])
    return out


# Every conversation of every project, for the Conversations tab: Pi's sessions folder
# holds one folder per project; the project is the "cwd" of a session's first line.
# Light on purpose: no token counts (Setup has them, project by project).

_FOLDER_PROJECT = {}  # sessions folder -> project path (a folder never changes project)
# The most recent conversations, over all projects, come with their token use (the
# others with their name and first question only): what the lists show first.
CONVERSATIONS_WITH_USAGE = 300
_SUMMARY = {}         # session file -> ((size, mtime), summary)
CONVERSATIONS_MAX = 2000


def sessions_root():
    """Pi's sessions folder: the session files read outside the sandbox stay in it
    (open_regular resolves it when it checks)."""
    return os.path.join(agent_dir(), "sessions")


def folder_project(folder):
    if folder in _FOLDER_PROJECT:
        return _FOLDER_PROJECT[folder]
    project = None
    try:
        names = sorted(n for n in os.listdir(folder) if n.endswith(".jsonl"))
    except OSError:
        names = []
    for name in names[:3]:
        try:
            with open_plain(os.path.join(folder, name), sessions_root()) as handle:
                header = json.loads(handle.readline(64 * 1024))
            if isinstance(header, dict) and isinstance(header.get("cwd"), str):
                project = header["cwd"]
                break
        except (OSError, ValueError):
            continue
    if project:
        _FOLDER_PROJECT[folder] = project
    return project


def session_summary(path, st):
    key = (st.st_size, st.st_mtime_ns)
    cached = _SUMMARY.get(path)
    if cached and cached[0] == key:
        return dict(cached[1])
    first = cached[1] if cached else None
    summary = {"path": path, "modified": int(st.st_mtime) // 60 * 60, "name": session_name_of(path),
               "prompt": first["prompt"] if first and first["prompt"] else first_prompt(path)}
    remember(_SUMMARY, path, (key, summary), 4000)
    return dict(summary)


def api_conversations(home):
    root = sessions_root()
    labels = load_labels(home)
    pis = pi_sessions()
    try:
        folders = [os.path.join(root, n) for n in os.listdir(root)]
    except OSError:
        folders = []
    found = {}  # project -> [(path, stat)]
    # A session without its project in its first line (an older Pi): matched by its
    # folder's name with the recent projects and those where a Pi runs.
    known = {session_dir(p): p for p in [*load_state(home)["recent"], *(pi["path"] for pi in pis.values())]}
    for folder in folders:
        project = folder_project(folder) or known.get(folder)
        if not project or not within(project, home) or not os.path.isdir(project):
            continue
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    if entry.name.endswith(".jsonl"):
                        try:
                            found.setdefault(project, []).append((entry.path, entry.stat()))
                        except OSError:
                            pass
        except OSError:
            continue
    every = sorted(((f[1].st_mtime, project) for project, files in found.items() for f in files), reverse=True)
    cut = every[CONVERSATIONS_MAX - 1][0] if len(every) > CONVERSATIONS_MAX else None
    usage_from = every[CONVERSATIONS_WITH_USAGE - 1][0] if len(every) > CONVERSATIONS_WITH_USAGE else None
    projects = []
    total = 0
    for project in set(found) | {p["path"] for p in pis.values() if within(p["path"], home)}:
        files = sorted(found.get(project, []), key=lambda f: f[1].st_mtime, reverse=True)
        infos = pi_infos(project, home, project_pis(pis, project))
        # Which conversation each Pi holds, as Setup sees it (a lone Pi without a known
        # file holds the newest one).
        here = {i["file"]: i for i in infos if i["file"]}
        sessions = []
        for path, st in files:
            if cut is not None and st.st_mtime < cut:
                break
            if usage_from is None or st.st_mtime >= usage_from:
                summary = session_info(path, st)
                summary["modified"] = summary["modified"] // 60 * 60
            else:
                summary = dict(session_summary(path, st), usage=None)
            label = labels.get(path) or {}
            pi = here.get(path)
            summary.update(title=label.get("title") or None, category=label.get("category") or None,
                           pinned=bool(label.get("pinned")), archived=bool(label.get("archived")),
                           slot=pi["slot"] if pi else None, working=bool(pi and pi.get("working")))
            sessions.append(summary)
        total += len(sessions)
        running = [p for p in pis.values() if p["path"] == project]
        if not os.path.isdir(project):
            continue
        if sessions or running:
            # Interrupted: the last conversation was mid-work and no Pi runs it (the VM
            # restarted, Pi was killed): it can be taken up where it stopped.
            last = sessions[0] if sessions else None
            interrupted = last["path"] if last and not last["slot"] and session_working(last["path"]) else None
            projects.append({"project": project, "label": pretty_path(project, home), "running": len(running),
                             "modified": sessions[0]["modified"] if sessions else 0, "sessions": sessions,
                             "pis": infos, "interrupted": interrupted})
    projects.sort(key=lambda p: (p["running"] > 0, p["modified"]), reverse=True)
    return {"projects": projects, "truncated": cut is not None}


# Pi's version and the newest one, and the newest version of each npm package. Asked to
# npm's registry from the VM, at most every 6 hours (an hour after a failure); the
# answer is kept in ~/.local/state/pier-picker/versions.json.

PI_NPM = "@earendil-works/pi-coding-agent"
VERSIONS_FRESH = 6 * 3600
VERSIONS_RETRY = 3600


