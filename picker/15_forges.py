# --- git forges: GitHub, GitLab, Gitea / Forgejo ------------------------------------------
#
# Pi works in git as it likes inside its sandbox (commit, branch, merge, all local). What
# talks to a forge goes through the picker, out of the sandbox, with a token Pi never
# sees: Pi's tools (PIER_GIT_EXTENSION) ask the broker (GitBroker) over a Unix socket,
# and the broker checks each request against the rules before doing it.
#   - push: only branches under "pi/" (the default branch only while the remote repository
#     is empty), never forced. The commits are first fetched, in git's jail (no network,
#     the project read-only), into a bare mirror of the picker's own; the mirror then
#     pushes with the token. No hook, filter or setting of the project runs with it.
#   - pull: the forge into the mirror, then the mirror into the project's
#     refs/remotes/origin/*, in the jail: Pi merges or rebases itself.
#   - pull requests: opened, listed and read freely.
#   - merging, and creating a repository: never by Pi alone. Its request waits in
#     approvals.json until the user approves it in Pier, which then does it.
# Tokens live in ~/.config/pier-picker/forges.json (mode 600), out of the sandbox's
# sight; they are never logged, nor put on a command line (git gets them in its
# environment, GIT_CONFIG_*).

FORGE_KINDS = ("github", "gitlab", "gitea")
PI_BRANCH_RE = re.compile(r"pi/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*")
REPO_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,100}")
REPO_PATH_RE = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){1,4}")
FORGE_TIMEOUT = 20


def forges_path(home):
    return os.path.join(os.path.dirname(config_path(home)), "forges.json")


def repos_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "repos.json")


def approvals_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "approvals.json")


def private_json(path):
    """A JSON file of the picker's own; {} when missing. One that cannot be read (cut by
    a power loss, a full disk) is put aside as <name>.corrupt-<date>, said in the log as
    an error, and read as {}: saved over at the next change, it would lose what it held
    (the forges' accounts, the lab hosts, the labs) without a word."""
    fd = open_regular(path, follow=False)
    if fd is None:
        return {}
    try:
        with os.fdopen(fd, "rb") as handle:
            data = json.loads(handle.read(4 * 1024 * 1024) or b"{}")
    except ValueError as exc:
        set_aside(path, exc)
        return {}
    except OSError:
        return {}
    return data if isinstance(data, dict) else {}


def set_aside(path, why):
    """A file of the picker's own that cannot be read, kept beside under another name."""
    aside = f"{path}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}"
    try:
        os.replace(path, aside)
    except OSError:
        aside = None
    log("error", "store.unreadable", file=path, kept=aside, err=str(why)[:300])


def write_json(path, data, mode=0o600, indent=2):
    """A file of the picker's own, whole or not at all: a temporary file written, flushed
    to disk, renamed over path, and the folder flushed too (a power loss leaves the old
    file or the new one, never an empty one). The temporary file goes if anything fails
    (a full disk), so no copy of a file holding tokens stays behind."""
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".pier-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(data, indent=indent))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    try:
        dir_fd = os.open(folder, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass  # not every system flushes a folder (nor Windows, in the simulated tests)


def save_private_json(path, data):
    """A file of the picker's own, readable by its owner only."""
    write_json(path, data)


def forge_api_base(kind, url):
    url = url.rstrip("/")
    if kind == "github":
        return "https://api.github.com" if url in ("https://github.com", "https://www.github.com") else f"{url}/api/v3"
    return f"{url}/api/v4" if kind == "gitlab" else f"{url}/api/v1"


def forge_request(forge, method, path, body=None):
    """A forge's REST API, as JSON. ApiError with the forge's message when it refuses."""
    import urllib.error
    import urllib.request
    url = forge_api_base(forge["kind"], forge["url"]) + path
    headers = {"Accept": "application/json", "User-Agent": f"pier-picker/{VERSION}"}
    if forge["kind"] == "github":
        headers.update({"Authorization": f"Bearer {forge['token']}", "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28"})
    elif forge["kind"] == "gitlab":
        headers["PRIVATE-TOKEN"] = forge["token"]
    else:
        headers["Authorization"] = f"token {forge['token']}"
    data = json.dumps(body).encode() if body is not None else None
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=FORGE_TIMEOUT) as answer:
            text = answer.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            payload = json.loads(exc.read(64 * 1024) or b"{}")
            detail = payload.get("message") or payload.get("error") or ""
            if isinstance(detail, (dict, list)):
                detail = json.dumps(detail)[:300]
        except (ValueError, OSError):
            pass
        raise ApiError(f"{forge['kind']} refused ({exc.code}){': ' + str(detail)[:300] if detail else ''}")
    except (OSError, ValueError) as exc:
        raise ApiError(f"{forge['url']} did not answer ({exc})")
    try:
        return json.loads(text) if text.strip() else {}
    except ValueError:
        return {}


def load_forges(home):
    data = private_json(forges_path(home))
    return [f for f in data.get("forges", []) if isinstance(f, dict) and f.get("kind") in FORGE_KINDS]


def forge_by_id(home, ident):
    for forge in load_forges(home):
        if forge.get("id") == ident:
            return forge
    raise ApiError(f"no forge account {ident}: connect it in Pier (Repository > Git)")


def public_forge(forge):
    return {k: forge.get(k) for k in ("id", "kind", "url", "login")}


def api_forges(home):
    return {"forges": [public_forge(f) for f in load_forges(home)]}


def api_forge_add(home, kind, url, data):
    """Connect a forge account with a token (sent on stdin, checked against the forge)."""
    if kind not in FORGE_KINDS:
        raise ApiError(f"unknown forge: {kind}")
    url = (url or ("https://github.com" if kind == "github" else "https://gitlab.com" if kind == "gitlab" else "")).rstrip("/")
    if not re.fullmatch(r"https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~-]+)*", url):
        raise ApiError("the forge's address: https://host (and a path, for a forge not at the root)")
    token = data.decode("utf-8", "replace").strip()
    if not token or len(token) > 512 or any(c.isspace() for c in token):
        raise ApiError("paste the token alone")
    forge = {"kind": kind, "url": url, "token": token}
    user = forge_request(forge, "GET", "/user")
    login = user.get("login") or user.get("username")
    if not isinstance(login, str):
        raise ApiError("the forge did not say who this token belongs to")
    forge.update(id=f"{kind}:{url.split('://', 1)[1]}:{login}", login=login)
    with file_lock(forges_path(home) + ".lock"):
        forges = [f for f in load_forges(home) if f.get("id") != forge["id"]] + [forge]
        save_private_json(forges_path(home), {"forges": forges})
    log("info", "forge.added", kind=kind, url=url, login=login)
    return public_forge(forge)


def api_forge_remove(home, ident):
    with file_lock(forges_path(home) + ".lock"):
        forges = [f for f in load_forges(home) if f.get("id") != ident]
        save_private_json(forges_path(home), {"forges": forges})
    log("info", "forge.removed", id=ident)
    return {"removed": ident}


def load_repos(home):
    return private_json(repos_path(home))


# What Pi may do alone with a repository, chosen in Repository > Git:
#   local - Pi commits and branches, nothing leaves the VM;
#   ask   - Pi pushes its pi/... branches and opens pull requests, merges wait for the user;
#   auto  - as ask, and Pi merges its pull requests itself once their checks have passed.
# Creating a repository always waits for the user.
REPO_MODES = ("local", "ask", "auto")
MERGE_METHODS = ("merge", "squash", "rebase")
# What Pier does when a task, a review or a handoff waits for this account's Pis
# (see the team section): nothing, a notification with a button, or start a Pi itself.
AGENT_WAKES = ("off", "ask", "auto")


def repo_link(home, project):
    link = load_repos(home).get(project)
    if not isinstance(link, dict) or not isinstance(link.get("repo"), str):
        return None
    if link.get("mode") not in REPO_MODES:
        link["mode"] = "ask"
    if link.get("merge_method") not in MERGE_METHODS:
        link["merge_method"] = "merge"
    if link.get("agents") not in AGENT_WAKES:
        link["agents"] = "ask"
    return link


def forge_repo(forge, repo):
    """(path in the API, the repository's details) on the forge."""
    if forge["kind"] == "gitlab":
        import urllib.parse
        path = f"/projects/{urllib.parse.quote(repo, safe='')}"
    else:
        path = f"/repos/{repo}"
    return path, forge_request(forge, "GET", path)


def clone_url(forge, repo):
    return f"{forge['url']}/{repo}.git"


def api_repo_link(home, path, forge_id, repo):
    """Connect the project to a repository of a forge account."""
    project = resolve_inside(home, path)
    if not REPO_PATH_RE.fullmatch(repo or ""):
        raise ApiError("a repository: owner/name")
    forge = forge_by_id(home, forge_id)
    _, info = forge_repo(forge, repo)
    default = info.get("default_branch") or "main"
    ensure_local_repo(project, default)
    with file_lock(repos_path(home) + ".lock"):
        repos = load_repos(home)
        before = repos.get(project) if isinstance(repos.get(project), dict) else {}
        repos[project] = {"forge": forge_id, "repo": repo, "default_branch": default, "prefix": "pi/",
                          "mode": before.get("mode") if before.get("mode") in REPO_MODES else "ask",
                          "merge_method": before.get("merge_method") if before.get("merge_method") in MERGE_METHODS else "merge",
                          "agents": before.get("agents") if before.get("agents") in AGENT_WAKES else "ask"}
        save_private_json(repos_path(home), repos)
    log("info", "repo.linked", project=project, forge=forge_id, repo=repo)
    return {"project": project, **repos[project]}


def api_repo_settings(home, path, mode, method, agents=""):
    """From Pier: what Pi may do alone with the project's repository, how it merges, and
    how Pier wakes Pis for the team."""
    project = resolve_inside(home, path)
    agents = agents or None
    if mode not in REPO_MODES or method not in MERGE_METHODS or (agents and agents not in AGENT_WAKES):
        raise ApiError(f"a mode ({', '.join(REPO_MODES)}), a merge method ({', '.join(MERGE_METHODS)}) "
                       f"and how Pis are woken ({', '.join(AGENT_WAKES)})")
    with file_lock(repos_path(home) + ".lock"):
        repos = load_repos(home)
        link = repos.get(project)
        if not isinstance(link, dict):
            raise ApiError("no repository connected to this project")
        link.update(mode=mode, merge_method=method)
        if agents:
            link["agents"] = agents
        save_private_json(repos_path(home), repos)
    log("info", "repo.settings", project=project, mode=mode, method=method, agents=link.get("agents"))
    return {"project": project, **link}


def api_repo_unlink(home, path):
    project = resolve_inside(home, path)
    with file_lock(repos_path(home) + ".lock"):
        repos = load_repos(home)
        repos.pop(project, None)
        save_private_json(repos_path(home), repos)
    log("info", "repo.unlinked", project=project)
    return {"project": project}


def create_forge_repo(home, project, forge_id, name, private, description=""):
    if not REPO_NAME_RE.fullmatch(name or ""):
        raise ApiError("a repository's name: letters, digits, '.', '_' and '-'")
    forge = forge_by_id(home, forge_id)
    description = " ".join((description or "").split())[:300]
    if forge["kind"] == "gitlab":
        made = forge_request(forge, "POST", "/projects", {"name": name, "path": name, "description": description,
                                                          "visibility": "private" if private else "public"})
        repo = made.get("path_with_namespace")
    else:
        made = forge_request(forge, "POST", "/user/repos", {"name": name, "private": bool(private), "description": description})
        repo = made.get("full_name")
    if not isinstance(repo, str):
        raise ApiError("the forge made the repository but did not say where")
    log("info", "repo.created", forge=forge_id, repo=repo, private=bool(private))
    return api_repo_link(home, project, forge_id, repo)


def api_repo_create(home, path, forge_id, name, private, description):
    """From Pier (the user's own action): a new repository, connected to the project."""
    return create_forge_repo(home, resolve_inside(home, path), forge_id, name, private == "1", description)


def git_jail_rw(project, extra_ro=(), extra_rw=()):
    """git's jail with the project writable (and more folders): for init and pull, still
    without network, and with nothing else of home."""
    args = git_jail(project)
    if args is None:
        return None
    cut = args.index("--unshare-all")
    real = os.path.realpath(project)
    binds = []
    for folder in extra_ro:
        binds += ["--ro-bind", folder, folder]
    for folder in [real, *extra_rw]:
        binds += ["--bind", folder, folder]
    return args[:cut] + binds + args[cut:]


def jailed_git(jail, *args, cwd=None):
    """git in a jail (bwrap arguments) or plain when there is no bwrap; stdout, or an
    ApiError with git's message."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    for key in ("SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"):
        env.pop(key, None)
    try:
        result = subprocess.run([*(jail or []), "git", *GIT_OPTIONS, *args], stdin=subprocess.DEVNULL, capture_output=True,
                                env=env, timeout=120, cwd=cwd)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ApiError(f"git failed: {exc}")
    if result.returncode != 0:
        raise ApiError(result.stderr.decode("utf-8", "replace").strip()[-400:] or "git failed")
    return result.stdout.decode("utf-8", "replace")


def ensure_local_repo(project, default):
    if git_dir(project):
        return
    jailed_git(git_jail_rw(project), "-C", project, "init", "-q", "-b", default)
    log("info", "repo.init", project=project, branch=default)


def mirror_path(home, forge_id, repo):
    digest = hashlib.sha1(f"{forge_id}|{repo}".encode()).hexdigest()[:16]
    return os.path.join(os.path.dirname(state_path(home)), "git", f"{digest}.git")


def ensure_mirror(home, forge_id, repo):
    """The picker's own bare repository for a remote: no hook, no setting of anyone else."""
    path = mirror_path(home, forge_id, repo)
    if not os.path.isdir(os.path.join(path, "objects")):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        jailed_git(None, "init", "-q", "--bare", path)
    return path


def forge_git_env(forge):
    """The token for git, in its environment (other users cannot read it, unlike argv)."""
    import base64
    user = {"github": "x-access-token", "gitlab": "oauth2"}.get(forge["kind"], forge.get("login") or "git")
    basic = base64.b64encode(f"{user}:{forge['token']}".encode()).decode()
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {basic}", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


def mirror_git(forge, mirror, *args):
    """git in the mirror, outside the sandbox, with the token: only for push and fetch."""
    env = dict(os.environ, **forge_git_env(forge))
    for key in ("SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"):
        env.pop(key, None)
    try:
        result = subprocess.run(["git", "--git-dir", mirror, "-c", "core.hooksPath=/dev/null", *args],
                                stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ApiError(f"git failed: {exc}")
    text = result.stderr.decode("utf-8", "replace").replace(forge["token"], "***")
    if result.returncode != 0:
        raise ApiError(text.strip()[-600:] or "git failed")
    return text


def remote_branches(forge, repo):
    if forge["kind"] == "gitlab":
        api, _ = forge_repo(forge, repo)
        items = forge_request(forge, "GET", f"{api}/repository/branches?per_page=100")
    else:
        items = forge_request(forge, "GET", f"/repos/{repo}/branches?per_page=100")
    return [b.get("name") for b in items if isinstance(b, dict) and isinstance(b.get("name"), str)] if isinstance(items, list) else []


def git_push(home, project, link, branch):
    """Pi's branch pushed to the forge, under the rules (see above)."""
    forge = forge_by_id(home, link["forge"])
    default = link.get("default_branch") or "main"
    if not PI_BRANCH_RE.fullmatch(branch or "") or ".." in branch or branch.endswith((".lock", "/", ".")):
        if branch != default:
            raise ApiError(f"Pi pushes only its own branches, named pi/…: not {branch}")
        if remote_branches(forge, link["repo"]):
            raise ApiError(f"{default} is the default branch: push a pi/… branch and open a pull request")
    own_repository(project)
    mirror = ensure_mirror(home, link["forge"], link["repo"])
    jail = git_jail(project)
    if jail is not None:
        cut = jail.index("--unshare-all")
        jail = jail[:cut] + ["--bind", mirror, mirror] + jail[cut:]
    # The commits, into the mirror: git reads the project in its jail, writes nowhere else.
    jailed_git(jail, "--git-dir", mirror, "fetch", "--no-tags", "--quiet", os.path.realpath(project),
               f"+refs/heads/{branch}:refs/heads/{branch}")
    # Then pushed by the mirror, never forced: a branch rewritten is refused by the forge.
    said = mirror_git(forge, mirror, "push", "--porcelain", clone_url(forge, link["repo"]), f"refs/heads/{branch}:refs/heads/{branch}")
    log("info", "git.push", project=project, repo=link["repo"], branch=branch)
    return {"pushed": branch, "repo": link["repo"], "detail": said.strip()[-300:]}


def git_pull(home, project, link):
    """The forge's branches, into the project's refs/remotes/origin/*: Pi merges itself."""
    forge = forge_by_id(home, link["forge"])
    own_repository(project)
    mirror = ensure_mirror(home, link["forge"], link["repo"])
    mirror_git(forge, mirror, "fetch", "--prune", "--no-tags", clone_url(forge, link["repo"]), "+refs/heads/*:refs/remotes/origin/*")
    jailed_git(git_jail_rw(project, extra_ro=[mirror]), "-C", os.path.realpath(project), "fetch", "--no-tags", "--quiet",
               mirror, "+refs/remotes/origin/*:refs/remotes/origin/*")
    log("info", "git.pull", project=project, repo=link["repo"])
    return {"fetched": link["repo"], "into": "refs/remotes/origin/*"}


def pr_from(forge, item):
    """A pull request (or GitLab merge request), the same shape whatever the forge."""
    if forge["kind"] == "gitlab":
        state = {"opened": "open", "merged": "merged", "closed": "closed"}.get(item.get("state"), item.get("state"))
        pipeline = (item.get("head_pipeline") or {}).get("status") if isinstance(item.get("head_pipeline"), dict) else None
        return {"number": item.get("iid"), "title": item.get("title"), "state": state, "head": item.get("source_branch"),
                "base": item.get("target_branch"), "url": item.get("web_url"), "draft": bool(item.get("draft")), "sha": item.get("sha"),
                "checks": {"success": "success", "failed": "failure", "running": "pending", "pending": "pending"}.get(pipeline, "none" if not pipeline else pipeline),
                "author": (item.get("author") or {}).get("username"),
                "same_repo": item.get("source_project_id") is not None and item.get("source_project_id") == item.get("target_project_id"),
                "requested": [r.get("username") for r in item.get("reviewers") or [] if isinstance(r, dict)],
                "labels": [l for l in item.get("labels") or [] if isinstance(l, str)]}
    merged = bool(item.get("merged") or item.get("merged_at"))
    return {"number": item.get("number"), "title": item.get("title"), "state": "merged" if merged else item.get("state"),
            "head": (item.get("head") or {}).get("ref"), "base": (item.get("base") or {}).get("ref"),
            "url": item.get("html_url"), "draft": bool(item.get("draft")), "checks": None, "sha": (item.get("head") or {}).get("sha"),
            "mergeable": item.get("mergeable"), "author": (item.get("user") or {}).get("login"),
            "same_repo": same_github_repo(item),
            "requested": [r.get("login") for r in item.get("requested_reviewers") or [] if isinstance(r, dict)],
            "labels": [l.get("name") for l in item.get("labels") or [] if isinstance(l, dict)]}


def same_github_repo(item):
    """GitHub, Gitea: the pull request's branch is in the repository itself, not a fork."""
    head, base = (item.get("head") or {}).get("repo"), (item.get("base") or {}).get("repo")
    if not isinstance(head, dict) or not isinstance(base, dict):
        return False
    return head.get("id") is not None and head.get("id") == base.get("id")


CHECK_PAGES = 5  # GitHub's check runs, 100 a page


def pr_checks(forge, repo, sha):
    """"success", "failure", "pending" or "none" (no check at all, or the forge did not
    answer) for a commit: on GitHub its check runs (every page) and its commit statuses
    (an outside CI: Jenkins, CircleCI), on Gitea its statuses. Any failure wins, then
    anything still running."""
    if not sha:
        return "none"
    found = []
    try:
        if forge["kind"] == "github":
            runs, total = [], None
            for page in range(1, CHECK_PAGES + 1):
                said = forge_request(forge, "GET", f"/repos/{repo}/commits/{sha}/check-runs?per_page=100&page={page}")
                runs += said.get("check_runs") or []
                total = said.get("total_count") if isinstance(said.get("total_count"), int) else len(runs)
                if len(runs) >= total or not said.get("check_runs"):
                    break
            if total is not None and len(runs) < total:
                found.append("pending")  # more than we read: never taken for passed
            if runs:
                if any(r.get("status") != "completed" for r in runs):
                    found.append("pending")
                elif any(r.get("conclusion") in ("failure", "timed_out", "cancelled", "action_required", "stale") for r in runs):
                    found.append("failure")
                else:
                    found.append("success")
        combined = forge_request(forge, "GET", f"/repos/{repo}/commits/{sha}/status")
        # With no status at all, GitHub says "pending" and a total_count of 0.
        if (combined.get("total_count") or len(combined.get("statuses") or [])) > 0:
            found.append({"success": "success", "failure": "failure", "error": "failure", "pending": "pending"}.get(combined.get("state"), "pending"))
    except ApiError:
        return "none"
    for verdict in ("failure", "pending", "success"):
        if verdict in found:
            return verdict
    return "none"


def auto_merge_refusal(link, pr, number):
    """Why Pi may not merge pull request number by itself in auto mode, or None: only its
    own (a pi/… branch of this repository, not a fork), into the default branch, not a
    draft, and only once checks ran and all passed."""
    default = link.get("default_branch") or "main"
    if not PI_BRANCH_RE.fullmatch(pr.get("head") or "") or not pr.get("same_repo"):
        return f"pull request {number} is not Pi's (a pi/… branch of {link['repo']}): only the user merges it"
    if pr.get("base") != default:
        return f"pull request {number} goes into {pr.get('base')}, not {default}: only the user merges it"
    if pr.get("draft"):
        return f"pull request {number} is a draft"
    checks = pr.get("checks")
    if checks == "success":
        return None
    if checks == "pending":
        return f"pull request {number}: its checks have not finished; merge once they pass"
    if checks == "failure":
        return f"pull request {number}: its checks have failed"
    return f"pull request {number} has no check that passed: in auto mode Pi merges only once checks ran and passed"


def list_prs(home, link, state="open"):
    forge = forge_by_id(home, link["forge"])
    if forge["kind"] == "gitlab":
        api, _ = forge_repo(forge, link["repo"])
        items = forge_request(forge, "GET", f"{api}/merge_requests?state={'opened' if state == 'open' else 'all'}&per_page=50")
    else:
        items = forge_request(forge, "GET", f"/repos/{link['repo']}/pulls?state={state}&per_page=50")
    return [pr_from(forge, i) for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def get_pr(home, link, number):
    forge = forge_by_id(home, link["forge"])
    if forge["kind"] == "gitlab":
        api, _ = forge_repo(forge, link["repo"])
        pr = pr_from(forge, forge_request(forge, "GET", f"{api}/merge_requests/{int(number)}"))
    else:
        pr = pr_from(forge, forge_request(forge, "GET", f"/repos/{link['repo']}/pulls/{int(number)}"))
        pr["checks"] = pr_checks(forge, link["repo"], pr.get("sha"))
    return pr


def open_pr(home, project, link, branch, title, body, base, draft):
    forge = forge_by_id(home, link["forge"])
    base = base or link.get("default_branch") or "main"
    if not PI_BRANCH_RE.fullmatch(branch or ""):
        raise ApiError(f"a pull request starts from a pi/… branch: not {branch}")
    title = " ".join((title or "").split())[:250] or branch
    body = (body or "")[:60000]
    if forge["kind"] == "gitlab":
        api, _ = forge_repo(forge, link["repo"])
        item = forge_request(forge, "POST", f"{api}/merge_requests",
                             {"source_branch": branch, "target_branch": base, "title": ("Draft: " if draft else "") + title, "description": body})
    else:
        payload = {"title": title, "head": branch, "base": base, "body": body}
        if forge["kind"] == "github":
            payload["draft"] = bool(draft)
        item = forge_request(forge, "POST", f"/repos/{link['repo']}/pulls", payload)
    pr = pr_from(forge, item)
    log("info", "git.pr-opened", project=project, repo=link["repo"], number=pr.get("number"), branch=branch)
    return pr


def merge_pr(home, project, link, number, method=None, sha=None):
    """Merges a pull request: from Pier, a request of Pi the user approved, or Pi itself
    when the repository is set to auto and the checks have passed. sha: the commit the
    user (or the checks) saw; the forge refuses the merge if the pull request moved on."""
    forge = forge_by_id(home, link["forge"])
    method = method if method in MERGE_METHODS else link.get("merge_method") or "merge"
    if forge["kind"] == "gitlab":
        api, _ = forge_repo(forge, link["repo"])
        forge_request(forge, "PUT", f"{api}/merge_requests/{int(number)}/merge", {"squash": method == "squash", **({"sha": sha} if sha else {})})
    elif forge["kind"] == "github":
        forge_request(forge, "PUT", f"/repos/{link['repo']}/pulls/{int(number)}/merge", {"merge_method": method, **({"sha": sha} if sha else {})})
    else:
        forge_request(forge, "POST", f"/repos/{link['repo']}/pulls/{int(number)}/merge", {"Do": method, **({"head_commit_id": sha} if sha else {})})
    log("info", "git.merged", project=project, repo=link["repo"], number=int(number), method=method)
    return {"merged": int(number)}


