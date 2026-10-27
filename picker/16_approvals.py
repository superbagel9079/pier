# Pi's requests waiting for the user, in approvals.json. Several processes write it at
# once (each Pi's broker asks, Pier answers): every change is made under its lock, on
# what the file holds then. A request holds exactly what is done once approved (the
# command, the pull request and the commit it is at), and leaves "pending" before
# anything is done: a second click finds it taken.
APPROVALS_KEPT = 200        # answered requests kept for the record; waiting ones always stay
APPROVALS_WAITING_MAX = 20  # per project: past that, Pi waits for the user's answers


def load_approvals(home):
    data = private_json(approvals_path(home))
    return [a for a in data.get("approvals", []) if isinstance(a, dict)]


def approvals_lock(home):
    return file_lock(approvals_path(home) + ".lock")


def save_approvals(home, approvals):
    """Every request still waiting, and the latest answered ones (under approvals_lock)."""
    answered = {id(a) for a in [a for a in approvals if a.get("state") != "pending"][-APPROVALS_KEPT:]}
    save_private_json(approvals_path(home), {"approvals": [a for a in approvals if a.get("state") == "pending" or id(a) in answered]})


def change_approval(home, ident, when=None, **fields):
    """A request changed (its state, its result), if it is still there and, with when, still
    in that state: the request as changed, or None."""
    with approvals_lock(home):
        approvals = load_approvals(home)
        approval = next((a for a in approvals if a.get("id") == ident and (when is None or a.get("state") == when)), None)
        if approval is not None:
            approval.update(fields)
            save_approvals(home, approvals)
    return approval


def ask_approval(home, project, kind, args, reason, replaces=None):
    """A request of Pi, waiting for the user in Pier. replaces: which earlier waiting
    request of the project, of the same kind, it makes stale (by default the same args)."""
    approval = {"id": uuid.uuid4().hex[:12], "project": project, "kind": kind, "args": args,
                "reason": " ".join((reason or "").split())[:500], "at": int(time.time()), "state": "pending"}
    stale = replaces or (lambda a: a.get("args") == args)
    with approvals_lock(home):
        approvals = [a for a in load_approvals(home)
                     if not (a.get("state") == "pending" and a.get("project") == project and a.get("kind") == kind and stale(a))]
        if sum(1 for a in approvals if a.get("state") == "pending" and a.get("project") == project) >= APPROVALS_WAITING_MAX:
            raise ApiError(f"{APPROVALS_WAITING_MAX} requests of this project already wait for the user: wait for the answers")
        save_approvals(home, approvals + [approval])
    log("info", "git.approval-asked", project=project, kind=kind, id=approval["id"])
    return approval


def api_approvals(home):
    pending = [a for a in load_approvals(home) if a.get("state") == "pending"]
    return {"approvals": pending}


def api_approval_answer(home, ident, answer):
    """The user's answer to a request of Pi (from Pier). A command on a machine is run by
    the broker waiting for it, from the request; the others are done here, now."""
    with approvals_lock(home):
        approvals = load_approvals(home)
        approval = next((a for a in approvals if a.get("id") == ident and a.get("state") == "pending"), None)
        if approval is None:
            raise ApiError("that request is no longer waiting")
        kind = approval.get("kind")
        approval.update(state="refused" if answer != "yes" else "approved" if kind == "lab" else "running", answered=int(time.time()))
        save_approvals(home, approvals)
    if answer != "yes":
        log("info", "git.approval-refused", id=ident, kind=kind)
        return {"id": ident, "state": "refused"}
    if kind == "lab":
        log("info", "lab.approved", id=ident, machine=(approval.get("args") or {}).get("machine"))
        return {"id": ident, "state": "approved"}
    try:
        result = approved_action(home, approval)
    except Exception as exc:  # noqa: BLE001 - recorded, then raised as it came
        change_approval(home, ident, state="failed", error=str(exc) if isinstance(exc, ApiError) else type(exc).__name__)
        raise
    change_approval(home, ident, state="done", result=result)
    return {"id": ident, "state": "done", "result": result}


def approved_action(home, approval):
    """What the user approved, done as the request holds it: a merge or a review only while
    the pull request is still at the commit the user was shown."""
    project, args, kind = approval["project"], approval.get("args") or {}, approval.get("kind")
    if kind == "create_repo":
        return create_forge_repo(home, project, args.get("forge"), args.get("name"), args.get("private", True), args.get("description", ""))
    if kind not in ("merge", "review"):
        raise ApiError("unknown request")
    link = repo_link(home, project)
    if not link:
        raise ApiError("the project is no longer connected to a repository")
    if not args.get("sha"):
        raise ApiError("this request was made by an older picker, without the commit it is for: nothing was done; ask Pi again")
    if args.get("repo") != link["repo"]:
        raise ApiError(f"this request was for {args.get('repo')}, and the project is now connected to {link['repo']}: nothing was done")
    number = args.get("number")
    pr = get_pr(home, link, number)
    if pr.get("state") != "open":
        raise ApiError(f"pull request #{number} is {pr.get('state')}: nothing was done")
    if pr.get("sha") != args["sha"]:
        raise ApiError(f"pull request #{number} changed since Pi asked (new commits): nothing was done; ask Pi again")
    if kind == "merge":
        return merge_pr(home, project, link, number, args.get("method"), sha=args["sha"])
    return post_review(home, link, number, args.get("verdict"), args.get("body") or "")


def pr_facts(link, pr):
    """What a request about a pull request shows the user, and the commit it is bound to."""
    return {"repo": link["repo"], "sha": pr.get("sha"), "title": " ".join(str(pr.get("title") or "").split())[:300],
            "author": pr.get("author"), "head": pr.get("head"), "base": pr.get("base"), "url": pr.get("url"), "draft": bool(pr.get("draft"))}


def api_repo(home, path):
    """What Setup's Git page shows: the forge accounts, the project's repository, its open
    pull requests, and what Pi asks."""
    project = resolve_inside(home, path)
    link = repo_link(home, project)
    out = {"project": project, "forges": [public_forge(f) for f in load_forges(home)], "link": link, "prs": [],
           "local": bool(git_dir(project)), "branch": git_branch(project),
           "approvals": [a for a in load_approvals(home) if a.get("state") == "pending" and a.get("project") == project]}
    if link:
        try:
            out["prs"] = list_prs(home, link)
            forge = forge_by_id(home, link["forge"])
            for pr in out["prs"][:10]:
                if forge["kind"] != "gitlab":
                    pr["checks"] = pr_checks(forge, link["repo"], pr.get("sha"))
        except ApiError as exc:
            out["error"] = str(exc)
    return out


def api_pr_merge(home, path, number, method):
    project = resolve_inside(home, path)
    link = repo_link(home, project)
    if not link:
        raise ApiError("no repository connected to this project")
    return merge_pr(home, project, link, int(number), method or None)


