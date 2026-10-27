# --- managing what Pi loads: skills, extensions, prompts, packages ------------------------
#
# Setup lists each resource with whether Pi loads it, and turns one on or off the way
# `pi config` does (Pi's own package-manager.js): a "+path" or "-path" entry, path
# relative to its base, in the "skills" / "extensions" / "prompts" list of
# settings.json, or of the package's entry there (then relative to the package root).
# Local skills can be made, edited, imported from the PC and put in a bin; packages are
# installed and removed by `pi install` / `pi remove`, run in Pi's sandbox (see
# pi_package). Pi reads what changed when it next starts.

MANAGED_KINDS = ("skills", "extensions", "prompts")
SKILL_NAME_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")  # Pi's rule: 1-64, lowercase, hyphens


def scope_base(scope, project):
    """(base folder, settings.json, root that writes stay in) of a scope."""
    if scope == "project":
        return os.path.join(project, ".pi"), os.path.join(project, ".pi", "settings.json"), project
    agent = agent_dir()
    return agent, os.path.join(agent, "settings.json"), os.path.dirname(os.path.realpath(agent))


def skill_files(folder, recursive=True, top_md=True):
    """SKILL.md of every skill folder under folder (and, at its top, plain .md skills)."""
    found = []
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except OSError:
        return found
    for entry in entries:
        if entry.name.startswith(".") or entry.is_symlink():
            continue
        if entry.is_dir():
            skill = os.path.join(entry.path, "SKILL.md")
            if os.path.isfile(skill):
                found.append(skill)
            elif recursive:
                found.extend(skill_files(entry.path, True, False))
        elif top_md and entry.name.endswith(".md") and entry.is_file():
            found.append(entry.path)
        if len(found) >= RESOURCE_MAX:
            break
    return found


def kind_files(folder, kind):
    """The files of one kind in a folder, by Pi's conventions."""
    if kind == "skills":
        return skill_files(folder)
    try:
        names = sorted(n for n in os.listdir(folder) if not n.startswith("."))[:RESOURCE_MAX]
    except OSError:
        return []
    out = []
    for name in names:
        path = os.path.join(folder, name)
        if kind == "prompts" and name.endswith(".md") and os.path.isfile(path):
            out.append(path)
        elif kind == "extensions" and (name.endswith((".ts", ".js", ".mjs")) or os.path.isdir(path)):
            out.append(path)
    return out


def frontmatter(path):
    """name and description of a skill (its YAML front matter, the simple form)."""
    text = read_text(path, 16 * 1024) or ""
    out = {}
    if text.startswith("---"):
        for line in text.split("\n")[1:40]:
            if line.strip() == "---":
                break
            key, _, value = line.partition(":")
            if key.strip() in ("name", "description") and value.strip():
                out[key.strip()] = value.strip().strip("\"'")[:300]
    return out


def resource_state(rel_paths, patterns):
    """Whether Pi loads a resource, from the patterns of its list: plain entries other
    than paths include (none: all), "!glob" excludes, "+path" / "-path" force; the last
    exact one wins. rel_paths: the forms the resource answers to (file, skill folder)."""
    import fnmatch
    if patterns is None:
        return True
    if patterns == []:
        return False
    includes = [p for p in patterns if not p.startswith(("!", "+", "-")) and ("*" in p or "?" in p)]
    enabled = any(fnmatch.fnmatch(r, p) for r in rel_paths for p in includes) if includes else True
    for p in patterns:
        target = p[1:] if p[:1] in "!+-" else p
        target = target[2:] if target.startswith("./") else target
        if p.startswith("!") and any(fnmatch.fnmatch(r, target) for r in rel_paths):
            enabled = False
        elif p.startswith(("+", "-")) and target in rel_paths:
            enabled = p.startswith("+")
    return enabled


def resource_entry(kind, path, base, scope, patterns, source=None, local=False):
    rel = os.path.relpath(path, base).replace(os.sep, "/")
    forms = [rel]
    if os.path.basename(path) == "SKILL.md":
        forms.append(os.path.dirname(rel))
    meta = frontmatter(path) if kind == "skills" else {}
    folder = os.path.dirname(path) if os.path.basename(path) == "SKILL.md" else path
    name = meta.get("name") or (os.path.basename(folder) if kind == "skills" else os.path.basename(path))
    if kind == "prompts":
        name = name[:-3] if name.endswith(".md") else name
    return {"name": name, "description": meta.get("description"), "scope": scope, "rel": rel, "source": source,
            "enabled": resource_state(forms, patterns), "path": path,
            # A local skill in its own folder of skills/: Pier can edit it, or put it in the bin.
            "editable": bool(local and kind == "skills" and os.path.basename(path) == "SKILL.md"
                             and os.path.dirname(os.path.dirname(rel)) == "skills")}


def package_resources(entry, base, scope):
    """The resources of a package, with whether Pi loads each one."""
    spec = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
    root = package_folder(spec, base) if isinstance(spec, str) else None
    out = {kind: [] for kind in MANAGED_KINDS}
    if not root or not os.path.isdir(root):
        return out
    manifest = read_json_file(os.path.join(root, "package.json"))
    declared = manifest.get("pi") if isinstance(manifest, dict) and isinstance(manifest.get("pi"), dict) else None
    for kind in MANAGED_KINDS:
        if declared is not None and isinstance(declared.get(kind), list):
            import glob
            files = []
            for item in declared[kind]:
                if not isinstance(item, str) or item.startswith(("!", "+", "-")):
                    continue
                for match in sorted(glob.glob(os.path.join(root, item))):
                    files.extend(kind_files(match, kind) if os.path.isdir(match) and not os.path.isfile(os.path.join(match, "SKILL.md")) else
                                 [os.path.join(match, "SKILL.md")] if os.path.isfile(os.path.join(match, "SKILL.md")) else [match])
        else:
            files = kind_files(os.path.join(root, kind), kind)
        patterns = entry.get(kind) if isinstance(entry, dict) and isinstance(entry.get(kind), list) else None
        for path in files[:RESOURCE_MAX]:
            if within(os.path.realpath(path), os.path.realpath(root)):
                out[kind].append(resource_entry(kind, path, root, scope, patterns, source=spec))
    return out


def api_resources(home, path):
    """Everything Setup can manage for a project: the user's and the project's skills,
    extensions and prompts, local or from packages, each with whether Pi loads it."""
    project = resolve_inside(home, path)
    out = {"project": project, "skills": [], "extensions": [], "prompts": [], "packages": []}
    for scope in ("user", "project"):
        base, settings_file, _ = scope_base(scope, project)
        settings = read_json_file(settings_file)
        settings = settings if isinstance(settings, dict) else {}
        for kind in MANAGED_KINDS:
            patterns = settings.get(kind) if isinstance(settings.get(kind), list) else None
            for file in kind_files(os.path.join(base, kind), kind):
                out[kind].append(resource_entry(kind, file, base, scope, patterns, local=True))
        for entry in settings.get("packages") or []:
            info = package_info(entry, base, scope)
            if not info:
                continue
            info["resources"] = package_resources(entry, base, scope)
            out["packages"].append(info)
            for kind in MANAGED_KINDS:
                out[kind].extend(info["resources"][kind])
    return out


def write_settings(scope, project, change):
    """settings.json of a scope, read, changed by change(settings), written back."""
    base, settings_file, root = scope_base(scope, project)
    settings = read_json_file(settings_file) if os.path.exists(settings_file) else {}
    if not isinstance(settings, dict):
        raise ApiError(f"{pretty_path(settings_file, home_dir())} is not a JSON object: fix it by hand")
    change(settings)
    os.makedirs(base, exist_ok=True)
    atomic_write(settings_file, json.dumps(settings, indent=2, ensure_ascii=False) + "\n", root, 0o644)


def api_toggle_resource(home, scope, path, kind, source, rel, on):
    """Turn a resource on or off, as `pi config` does: "+rel" or "-rel" in its list."""
    project = resolve_inside(home, path)
    if scope not in ("user", "project") or kind not in MANAGED_KINDS:
        raise ApiError("unknown resource")
    if not rel or rel.startswith(("/", "+", "-", "!")) or ".." in rel.split("/") or any(c in rel for c in "\n*?"):
        raise ApiError(f"not a resource path: {rel}")
    enable = on == "1"

    def toggled(entries):
        kept = [p for p in entries if not (isinstance(p, str) and (p[1:] if p[:1] in "!+-" else p) == rel)]
        return kept + [("+" if enable else "-") + rel]

    def change(settings):
        if not source:
            settings[kind] = toggled(settings.get(kind) if isinstance(settings.get(kind), list) else [])
            return
        packages = settings.get("packages") if isinstance(settings.get("packages"), list) else []
        for i, entry in enumerate(packages):
            spec = entry if isinstance(entry, str) else entry.get("source") if isinstance(entry, dict) else None
            if spec != source:
                continue
            pkg = dict(entry) if isinstance(entry, dict) else {"source": spec}
            pkg[kind] = toggled(pkg.get(kind) if isinstance(pkg.get(kind), list) else [])
            packages[i] = pkg
            settings["packages"] = packages
            return
        raise ApiError(f"{source} is not in {scope} settings")

    write_settings(scope, project, change)
    log("info", "resource.toggle", scope=scope, kind=kind, source=source or "local", rel=rel, on=enable)
    return {"rel": rel, "enabled": enable}


SKILL_TEMPLATE = """---
name: {name}
description: {description}
---

# {title}

When to use this skill, and what to do, step by step.
"""


def skills_folder(scope, project):
    base, _, root = scope_base(scope, project)
    folder = os.path.join(base, "skills")
    os.makedirs(folder, exist_ok=True)
    return folder, root


def skill_name(name):
    if not SKILL_NAME_RE.fullmatch(name or "") or len(name) > 64:
        raise ApiError("a skill's name: 1 to 64 lowercase letters, digits and single hyphens (my-skill)")
    return name


def api_skill_new(home, scope, path, name, description):
    project = resolve_inside(home, path)
    name = skill_name(name)
    folder, root = skills_folder(scope, project)
    description = " ".join((description or "").split())[:300] or "What this skill does, and when Pi should use it."
    dir_fd = open_folder(root, folder) if SAFE_FD else None
    try:
        if dir_fd is None:
            os.mkdir(os.path.join(folder, name), 0o755)
        else:
            os.mkdir(name, 0o755, dir_fd=dir_fd)
    except FileExistsError:
        raise ApiError(f"a skill named {name} is already there")
    finally:
        if dir_fd is not None:
            os.close(dir_fd)
    text = SKILL_TEMPLATE.format(name=name, description=description, title=name.replace("-", " ").capitalize())
    create_new(os.path.join(folder, name, "SKILL.md"), text, 0o644, root=root)
    log("info", "skill.new", scope=scope, name=name)
    return {"name": name, "path": os.path.join(folder, name, "SKILL.md")}


def api_skill_read(home, scope, path, name):
    project = resolve_inside(home, path)
    folder, root = skills_folder(scope, project)
    text = read_text(os.path.join(folder, skill_name(name), "SKILL.md"), TEXT_MAX_BYTES, root=root)
    if text is None:
        raise ApiError(f"no SKILL.md for {name}")
    return {"name": name, "text": text}


def api_skill_write(home, scope, path, name, data):
    project = resolve_inside(home, path)
    folder, root = skills_folder(scope, project)
    if len(data) > TEXT_MAX_BYTES:
        raise ApiError(f"text larger than {TEXT_MAX_BYTES // 1024} KB")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError("the text is not UTF-8")
    target = os.path.join(folder, skill_name(name), "SKILL.md")
    if not os.path.isfile(target):
        raise ApiError(f"no skill named {name}")
    atomic_write(target, text, root, 0o644)
    log("info", "skill.saved", scope=scope, name=name, chars=len(text))
    return {"saved": target}


def trash_folder():
    folder = os.path.join(os.path.dirname(state_path(home_dir())), "trash")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    return folder


def api_skill_delete(home, scope, path, name):
    """A local skill moved to the picker's bin (~/.local/state/pier-picker/trash), where
    Pi does not look: nothing is lost."""
    project = resolve_inside(home, path)
    folder, root = skills_folder(scope, project)
    name = skill_name(name)
    kept = f"{stamp()}-{scope}-{name}"
    bin_folder = trash_folder()
    src_fd = open_folder(root, folder) if SAFE_FD else None
    try:
        if src_fd is None:
            os.rename(os.path.join(folder, name), os.path.join(bin_folder, kept))
        else:
            st = os.stat(name, dir_fd=src_fd, follow_symlinks=False)
            if not stat.S_ISDIR(st.st_mode):
                raise ApiError(f"{name} is not a skill folder")
            dst_fd = os.open(bin_folder, DIR_FLAGS)
            try:
                os.rename(name, kept, src_dir_fd=src_fd, dst_dir_fd=dst_fd)
            finally:
                os.close(dst_fd)
    except FileNotFoundError:
        raise ApiError(f"no skill named {name}")
    except OSError as exc:
        if exc.errno == 18:  # another file system: copied, then removed
            shutil.copytree(os.path.join(folder, name), os.path.join(bin_folder, kept), symlinks=True)
            remove_entry(os.path.realpath(root), os.path.realpath(os.path.join(folder, name)))
        else:
            raise
    finally:
        if src_fd is not None:
            os.close(src_fd)
    log("info", "skill.binned", scope=scope, name=name, kept=kept)
    return {"name": name, "kept": os.path.join(bin_folder, kept)}


def api_skill_import(home, scope, path, name, stream):
    """A skill folder sent from the PC (a tar stream, as a folder copy), unpacked out of
    Pi's reach, checked to hold a SKILL.md, then moved into the skills."""
    import tarfile
    project = resolve_inside(home, path)
    folder, root = skills_folder(scope, project)
    wanted = re.sub(r"[^a-z0-9-]+", "-", (name or "").lower()).strip("-")[:64] or "skill"
    staging = private_staging()
    try:
        extract_tar(stream, staging)
        entries = os.listdir(staging)
        inner = os.path.join(staging, entries[0]) if len(entries) == 1 and os.path.isdir(os.path.join(staging, entries[0])) else staging
        skill_md = os.path.join(inner, "SKILL.md")
        if not os.path.isfile(skill_md) or os.path.islink(skill_md):
            raise ApiError("no SKILL.md at the top of that folder: it is not a skill")
        declared = frontmatter(skill_md).get("name", "")
        target = declared if SKILL_NAME_RE.fullmatch(declared) and len(declared) <= 64 else wanted
        if os.path.lexists(os.path.join(folder, target)):
            raise ApiError(f"a skill named {target} is already there: put it in the bin first")
        if not move_into(inner, folder, target, root):
            shutil.copytree(inner, os.path.join(folder, target), symlinks=True)
    except (tarfile.TarError, OSError) as exc:
        raise ApiError(str(exc))
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    log("info", "skill.imported", scope=scope, name=target)
    return {"name": target, "path": os.path.join(folder, target, "SKILL.md")}


_GALLERY = {}  # query -> (when, results)


def api_gallery(home, query):
    """Packages of the gallery (pi.dev/packages): those tagged pi-package on npm."""
    import urllib.parse
    import urllib.request
    query = " ".join((query or "").split())[:100]
    cached = _GALLERY.get(query)
    if cached and time.monotonic() - cached[0] < 600:
        return cached[1]
    text = "keywords:pi-package" + (f" {query}" if query else "")
    url = "https://registry.npmjs.org/-/v1/search?" + urllib.parse.urlencode({"text": text, "size": 40})
    try:
        with urllib.request.urlopen(url, timeout=10) as answer:
            data = json.loads(answer.read(4 * 1024 * 1024))
    except (OSError, ValueError) as exc:
        raise ApiError(f"the npm registry did not answer ({exc})")
    results = []
    for item in data.get("objects") or []:
        pkg = item.get("package") if isinstance(item, dict) else None
        if not isinstance(pkg, dict) or not isinstance(pkg.get("name"), str):
            continue
        publisher = pkg.get("publisher") if isinstance(pkg.get("publisher"), dict) else {}
        results.append({"name": pkg["name"], "version": pkg.get("version"), "date": pkg.get("date"),
                        "description": (pkg.get("description") or "")[:300], "publisher": publisher.get("username"),
                        "source": f"npm:{pkg['name']}"})
    reply = {"query": query, "results": results}
    _GALLERY[query] = (time.monotonic(), reply)
    return reply


def pi_package(args):
    """--pi-package install|remove user|PROJECT SOURCE: `pi install` or `pi remove`
    (-l for a project) in a terminal of Pier. npm runs the packages' install scripts:
    with the sandbox on, it all runs in Pi's sandbox, network limited as Pi's is, so a
    package cannot read your keys or the rest of home while it installs."""
    if len(args) != 3 or args[0] not in ("install", "remove") or not PI_UPDATE_TARGET.fullmatch(args[2]):
        print("usage: --pi-package install|remove user|PROJECT SOURCE")
        return 2
    action, scope, source = args
    home = home_dir()
    config, _ = load_config(home)
    env = child_env(home)
    argv = pi_argv(config, env)
    if argv is None:
        print("pi not found on PATH: install it or set PI_BIN")
        pause_for_enter("press Enter to close ")
        return 1
    if scope == "user":
        project, local = os.path.join(home, ".pi"), []
    else:
        project, local = resolve_inside(home, scope), ["-l"]
    command = [*argv, action, *local, source]
    print(f"$ pi {action} {' '.join(local + [source])}", flush=True)
    network = None
    if sandbox_wanted(config):
        if not shutil.which("bwrap"):
            print(SANDBOX_MISSING)
            pause_for_enter("press Enter to close ")
            return 1
        for key in ("DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"):
            env.pop(key, None)
        network, unlimited = network_plan(config, env, project)
        if unlimited:
            print(f"Pier: {unlimited}")
        if network:
            proxy_env(env)
        command = sandbox_argv(command, os.path.realpath(project), home, config, env, network)
        print("(in Pi's sandbox: the package sees ~/.pi and this project only"
              + (", and reaches only network_allow)" if network else ")"), flush=True)
    else:
        print("(sandbox off: npm's install scripts run with all your rights)", flush=True)
    log("info", f"pi.{action}", source=source, scope="user" if not local else project)
    fd = seccomp_pipe() if sandbox_wanted(config) else None  # bwrap reads it: only in the sandbox
    if fd is not None:
        command = [command[0], "--seccomp", str(fd), *command[1:]]
    try:
        status = subprocess.call(command, env=env, cwd=project, pass_fds=() if fd is None else (fd,))
    except OSError as exc:
        print(f"cannot run pi: {exc}")
        status = 1
    finally:
        if fd is not None:
            os.close(fd)
        if network:
            network.close()
    log("warn" if status else "info", f"pi.{action}-done", source=source, status=status)
    forget_versions(home)
    print("\n" + ("done" if not status else f"pi {action} failed (status {status})")
          + ". Pis load the change when they next start.")
    if status and network:
        print("If it needed another site, look for net.blocked in the picker's log (Logs tab), "
              "and add it to network_allow in ~/.config/pier-picker/config.toml.")
    pause_for_enter("press Enter to close ")
    return status


