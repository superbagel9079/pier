def versions_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "versions.json")


def npm_latest(name):
    import urllib.error
    import urllib.request
    url = "https://registry.npmjs.org/" + name.replace("/", "%2F") + "/latest"
    try:
        with urllib.request.urlopen(url, timeout=3) as answer:
            data = json.loads(answer.read(1024 * 1024))
    except urllib.error.HTTPError as exc:  # a 404 for a name Pi wrote, a 429: closed, then said
        exc.close()
        raise
    version = data.get("version") if isinstance(data, dict) else None
    return version if isinstance(version, str) else None


VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:-[\w.]+)?")


def pi_package_folder(home):
    """The folder of Pi's npm package (holding its package.json), found from its program;
    None when Pi was not installed by npm."""
    config, _ = load_config(home)
    argv = pi_argv(config, child_env(home))
    if not argv:
        return None
    folder = os.path.dirname(os.path.realpath(argv[0]))
    for _ in range(6):
        manifest = read_json_file(os.path.join(folder, "package.json"))
        if isinstance(manifest, dict) and manifest.get("name") == PI_NPM:
            return folder
        folder = os.path.dirname(folder)
    return None


def installed_pi_version(home):
    """Pi's version, read in its package.json: Pi is not run for it, so nothing it would
    load from ~/.pi (which Pi itself can write) runs outside its sandbox."""
    folder = pi_package_folder(home)
    manifest = read_json_file(os.path.join(folder, "package.json")) if folder else None
    version = manifest.get("version") if isinstance(manifest, dict) else None
    return version if isinstance(version, str) and VERSION_RE.fullmatch(version) else None


def pi_npm_prefix(home):
    """The npm prefix Pi is installed under (PREFIX/lib/node_modules/<Pi's package>)."""
    folder = pi_package_folder(home)
    tail = os.path.join("lib", "node_modules", *PI_NPM.split("/"))
    if not folder or not folder.endswith(os.sep + tail):
        return None
    return folder[:-len(tail) - 1] or "/"


def pi_program_key(home):
    """What changes when Pi is updated: its program file, resolved, and its time."""
    config, _ = load_config(home)
    argv = pi_argv(config, child_env(home))
    if not argv:
        return None
    try:
        real = os.path.realpath(argv[0])
        return [real, os.stat(real).st_mtime_ns]
    except OSError:
        return None


def pi_versions(home, sources):
    """{"pi": {"version", "latest"}, "npm:name": latest, ...}. npm is asked at most every
    6 hours per name (an hour after a failure); Pi's own version only when its program
    changed. The cache file is written only when something in it changed."""
    path = versions_path(home)
    cache = read_json_file(path)
    cache = cache if isinstance(cache, dict) else {}
    before = json.dumps(cache, sort_keys=True)
    now = time.time()

    def stale(entry):
        if not isinstance(entry, dict) or not isinstance(entry.get("checked"), (int, float)):
            return True
        return now - entry["checked"] >= (VERSIONS_FRESH if entry.get("latest") else VERSIONS_RETRY)

    def ask(name, entry):
        try:
            return {"latest": npm_latest(name), "checked": now}
        except (OSError, ValueError) as exc:
            log("debug", "versions.failed", name=name, err=str(exc))
            return {"latest": (entry or {}).get("latest") if isinstance(entry, dict) else None, "checked": now}

    pi = cache.get("pi") if isinstance(cache.get("pi"), dict) else {}
    key = pi_program_key(home)
    unknown = key and not pi.get("version") and now - pi.get("version_checked", 0) >= VERSIONS_RETRY
    if key != pi.get("program") or "version" not in pi or unknown:
        pi = dict(pi, version=installed_pi_version(home), program=key, version_checked=now)
    if stale(pi):
        pi.update(ask(PI_NPM, pi))
    packages = cache.get("packages") if isinstance(cache.get("packages"), dict) else {}
    for source in sources:
        if source.startswith("npm:") and "@" not in source[5:] and stale(packages.get(source)):  # pinned ones never move
            packages[source] = ask(source[4:], packages.get(source))
    cache = {"pi": pi, "packages": packages}
    if json.dumps(cache, sort_keys=True) != before:
        try:
            os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
            tmp = f"{path}.{os.getpid()}.tmp"
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(cache, handle)
            os.replace(tmp, path)
        except OSError:
            pass
    out = {source: (entry or {}).get("latest") for source, entry in packages.items() if isinstance(entry, dict)}
    out["pi"] = {"version": pi.get("version"), "latest": pi.get("latest")}
    return out


_VERSIONS_ASKING = threading.Lock()


def pi_versions_soon(home, sources):
    """pi_versions without waiting on the network: the cached answer now, and a refresh
    in the background (one at a time) that the next look picks up."""
    if _VERSIONS_ASKING.acquire(blocking=False):
        def refresh():
            try:
                pi_versions(home, sources)
            except Exception as exc:  # noqa: BLE001 - versions are a nicety
                log("warn", "versions.refresh-failed", err=f"{type(exc).__name__}: {exc}")
            finally:
                _VERSIONS_ASKING.release()
        threading.Thread(target=refresh, daemon=True).start()
    cache = read_json_file(versions_path(home))
    cache = cache if isinstance(cache, dict) else {}
    packages = cache.get("packages") if isinstance(cache.get("packages"), dict) else {}
    out = {source: (entry or {}).get("latest") for source, entry in packages.items() if isinstance(entry, dict)}
    pi = cache.get("pi") if isinstance(cache.get("pi"), dict) else {}
    out["pi"] = {"version": pi.get("version"), "latest": pi.get("latest")}
    return out


def forget_versions(home):
    try:
        os.remove(versions_path(home))
    except OSError:
        pass


PI_UPDATE_TARGET = re.compile(r"(npm:|git:|https://)[A-Za-z0-9@/._:+~-]{1,200}")

# When Pi was installed by root (`sudo npm install -g`, in /usr/local), updating it needs
# sudo. Only a command of this shape (npm, a system prefix, install -g, Pi's own package
# at a version) is run with sudo, once the user says yes; sudo asks for the password in
# this terminal.
NPM_SELF_UPDATE = re.compile(
    r"npm --prefix (/usr|/usr/local|/opt/[\w.-]+) install -g " + re.escape(PI_NPM) + r"@\d+\.\d+\.\d+(?:-[\w.]+)?")


def pi_self_update(home, env):
    """Pi itself, updated by a fixed npm command (npm --prefix PREFIX install -g Pi@latest),
    not by `pi update --self`: Pi reads ~/.pi/agent/settings.json, which Pi can write from
    its sandbox, and whose npmCommand chooses what runs; this runs outside the sandbox
    (Pi's program is read-only in there). A prefix of root's: the same command with sudo,
    once the user says yes."""
    prefix = pi_npm_prefix(home)
    if prefix is None:
        print("Pi was not installed with npm install -g: update it the way it was installed.")
        return 1
    try:
        latest = npm_latest(PI_NPM)
    except (OSError, ValueError) as exc:
        print(f"the npm registry did not answer ({exc})")
        return 1
    npm = shutil.which("npm", path=env.get("PATH"))
    if not latest or not VERSION_RE.fullmatch(latest) or not npm:
        print("npm not found on PATH" if not npm else "the npm registry gave no version of Pi")
        return 1
    command = f"npm --prefix {shlex.quote(prefix)} install -g {PI_NPM}@{latest}"
    print(f"$ {command}", flush=True)
    log("info", "pi.self-update", prefix=prefix, version=latest)
    try:
        # From / : no project's .npmrc is read on the way.
        status = subprocess.call([npm, *shlex.split(command)[1:]], env=env, cwd="/")
    except OSError as exc:
        print(f"cannot run npm: {exc}")
        status = 1
    log("warn" if status else "info", "pi.self-update-done", status=status)
    if status and NPM_SELF_UPDATE.fullmatch(command) and not os.access(prefix, os.W_OK) and shutil.which("sudo"):
        print(f"\nPi is installed for all users (by root): updating it needs sudo.\n  sudo {command}")
        sys.stdout.write("Run it now? sudo asks for your password here. [y/N] ")
        sys.stdout.flush()
        try:
            answer = sys.stdin.readline().strip().lower()
        except (OSError, ValueError):
            answer = ""
        if answer in ("y", "yes", "o", "oui"):
            log("info", "pi.update-sudo", command=command)
            status = subprocess.call(["sudo", *shlex.split(command)], env=env, cwd="/")
            log("warn" if status else "info", "pi.update-sudo-done", status=status)
    return status


def pi_update(args):
    """--pi-update [--all | --extensions | SOURCE]: an update in a terminal of Pier, then
    the versions are asked again. Pi itself (no argument, --all) by pi_self_update; the
    packages (--extensions, --all, SOURCE) by `pi update` in Pi's sandbox, as `pi install`
    is: a git hook, an .npmrc or a package Pi changed in ~/.pi runs with Pi's rights only."""
    home = home_dir()
    config, _ = load_config(home)
    env = child_env(home)
    argv = pi_argv(config, env)
    if argv is None:
        print("pi not found on PATH: install it or set PI_BIN")
        return 1
    if len(args) > 1 or (args and args[0] not in ("--all", "--extensions") and not PI_UPDATE_TARGET.fullmatch(args[0])):
        print("usage: --pi-update [--all | --extensions | SOURCE]")
        return 2
    log("info", "pi.update", args=list(args))
    status = 0
    if not args or args[0] == "--all":
        status = pi_self_update(home, env)
    if args:
        packages = ["--extensions"] if args[0] in ("--all", "--extensions") else [args[0]]
        print("\n$ pi update " + " ".join(packages), flush=True)
        done, _ = run_in_pi_sandbox([*argv, "update", *packages], os.path.join(home, ".pi"), home, config, env)
        status = status or (1 if done is None else done)
    log("warn" if status else "info", "pi.update-done", args=list(args), status=status)
    forget_versions(home)
    print("\n" + ("done" if not status else f"pi update failed (status {status})")
          + ". Running Pis keep their version until they restart.")
    pause_for_enter("press Enter to close ")
    return status


def api_setup(home, path):
    project = resolve_inside(home, path)
    pis = pi_infos(project, home, project_pis(pi_sessions(), project))
    texts = {}
    for which in EDITABLE:
        target = editable_path(project, which)
        # A link leading out of the project (AGENTS.md -> ~/.config/...) is not read.
        text = read_text(target, root=project) if os.path.isfile(target) else None
        texts[which] = {"path": target, "name": os.path.relpath(target, project), "exists": text is not None,
                        "text": text or "", "history": history_entries(project, which)}
    for which, name in (("append", "APPEND_SYSTEM.md"), ("system", "SYSTEM.md")):
        texts[which]["global"] = os.path.isfile(os.path.join(agent_dir(), name))
    # The conversations themselves are in the Conversations part (api_conversations):
    # Setup only says how many.
    try:
        conversations = sum(1 for n in os.listdir(session_dir(project)) if n.endswith(".jsonl"))
    except OSError:
        conversations = 0
    return {
        "project": project, "label": pretty_path(project, home), "running": bool(pis), "pis": pis,
        "conversations": conversations,
        "startup": startup_files(project, home), "trusted": trust_decision(project),
        "texts": texts, "resources": pi_resources(project, home),
    }


def api_write_text(home, path, which, data):
    """Save one of the project's texts for Pi, keeping the previous version in
    .pi/devbox-history. An empty append or system text deletes the file, so Pi falls
    back to the global one."""
    project = resolve_inside(home, path)
    if len(data) > TEXT_MAX_BYTES:
        raise ApiError(f"text larger than {TEXT_MAX_BYTES // 1024} KB")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError("the text is not UTF-8")
    target = editable_path(project, which)
    if not within(os.path.realpath(os.path.dirname(target)), project):
        raise ApiError("refusing to write outside the project")
    # Never the content of a link leading out of the project: it would be copied into
    # the history, where Pi reads it. Saving replaces such a link with the file itself.
    previous = read_text(target, root=project) if os.path.isfile(target) else None
    if previous is not None and previous != text:
        history = safe_folder(project, HISTORY_DIR)
        create_new(os.path.join(history, ".gitignore"), "*\n", root=project)
        # Nanoseconds, zero-padded: names sort in saving order even within one second.
        create_new(os.path.join(history, f"{which}-{time.time_ns():020d}.md"), previous, 0o600, root=project)
        old = sorted((n for n in os.listdir(history) if n.startswith(which + "-")), reverse=True)
        for name in old[HISTORY_KEEP:]:
            os.remove(os.path.join(history, name))
    if not text.strip() and which != "instructions":
        if os.path.isfile(target):
            os.remove(target)
        return {"saved": None, "removed": target}
    os.makedirs(os.path.dirname(target), exist_ok=True)
    atomic_write(target, text, project, 0o644)
    return {"saved": target}


