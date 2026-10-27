# Reads Pier repeats every few seconds: logged only at debug level, unless they fail.
API_READS = {"version", "projects", "ls", "shares", "activity", "diff", "contexts",
             "setup", "log", "checkpoints", "checkpoint-diff", "copy-diff", "resources",
             "skill-read", "gallery", "forges", "repo", "approvals", "worktrees", "team", "collaborators", "labs", "lab-journal"}
# Fields of a reply worth a place in the log line.
API_LOGGED = ("saved", "removed", "reference", "count", "mountpoint", "stopped", "id", "restored", "safety", "typed")


def api_log_fields(command, rest):
    """The arguments of a call, for the log: what is typed into Pi only as its length."""
    if command == "type":
        chars = "stdin" if rest and rest[0] == "-" else len(rest[0]) if rest else 0
        return {"chars": chars, "target": rest[1] if len(rest) > 1 else None}
    if command == "restore" and rest[2:3] == ["-"]:
        return {"args": [a[:200] for a in rest[:2]], "files": "stdin"}
    return {"args": [a[:200] for a in rest]} if rest else {}


def stdin_bytes(limit):
    return sys.stdin.buffer.read(limit + 1)


# What an argument "-" stands for: text sent on stdin rather than on the command line,
# where any user of the VM could read it (ps, /proc), and which holds 128 KB at most.
TYPED_MAX_BYTES = 1024 * 1024


def stdin_text(limit):
    data = stdin_bytes(limit)
    if len(data) > limit:
        raise ApiError(f"more than {limit // 1024} KB sent")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise ApiError("what was sent is not UTF-8")


def typed_text(arg):
    return stdin_text(TYPED_MAX_BYTES) if arg == "-" else arg


def restore_files(args):
    if args[:1] == ["-"]:
        return [line for line in stdin_text(TYPED_MAX_BYTES).split("\n") if line]
    return [f for f in args if f]


# Every API command: (home, config, a = the arguments, padded with "") -> reply.
API_COMMANDS = {
    "version": lambda home, config, a: api_version(home, config),
    "projects": lambda home, config, a: api_projects(home, config),
    "ls": lambda home, config, a: api_ls(home, a[0]),
    "paste-image": lambda home, config, a: api_paste_image(home, a[0], stdin_bytes(IMAGE_MAX_BYTES)),
    "paste-file": lambda home, config, a: api_paste_file(home, a[0], a[1], stdin_bytes(FILE_MAX_BYTES)),
    "type": lambda home, config, a: api_type(home, typed_text(a[0]), a[1], a[2]),
    "shares": lambda home, config, a: api_shares(home),
    "share-prepare": lambda home, config, a: api_share_prepare(home, a[0], a[1]),
    "share-stop": lambda home, config, a: api_share_stop(home, a[0]),
    "activity": lambda home, config, a: api_activity(home, a[0], a[1]),
    "diff": lambda home, config, a: api_diff(home, a[0], a[1], a[2]),
    "remove": lambda home, config, a: api_remove(home, a[0]),
    "contexts": lambda home, config, a: api_contexts(home, config),
    "clear": lambda home, config, a: api_clear(home, a[0]),
    "setup": lambda home, config, a: api_setup(home, a[0]),
    "write-text": lambda home, config, a: api_write_text(home, a[0], a[1], stdin_bytes(TEXT_MAX_BYTES)),
    "handoff": lambda home, config, a: api_handoff(home, a[0], a[1], sys.stdin.buffer),
    "upload-dir": lambda home, config, a: api_upload_dir(home, a[0], a[1], sys.stdin.buffer),
    "log": lambda home, config, a: {"lines": log_tail(a[0] or 500), "path": log_path()},
    "checkpoints": lambda home, config, a: api_checkpoints(home, a[0], config),
    "checkpoint": lambda home, config, a: api_checkpoint(home, a[0], a[1]),
    "checkpoint-diff": lambda home, config, a: api_checkpoint_diff(home, a[0], a[1], a[2]),
    "restore": lambda home, config, a: api_restore(home, a[0], a[1], restore_files(a[2:])),
    "stop": lambda home, config, a: api_stop(home, a[0], a[1]),
    "label": lambda home, config, a: api_label(home, a[0], a[1], a[2], a[3]),
    "mark": lambda home, config, a: api_mark(home, a[0], a[1], a[2], a[3]),
    "conversations": lambda home, config, a: api_conversations(home),
    "copy-manifest": lambda home, config, a: api_copy_manifest(home, a[0]),
    "resources": lambda home, config, a: api_resources(home, a[0]),
    "toggle-resource": lambda home, config, a: api_toggle_resource(home, a[0], a[1], a[2], a[3], a[4], a[5]),
    "skill-new": lambda home, config, a: api_skill_new(home, a[0], a[1], a[2], a[3]),
    "skill-read": lambda home, config, a: api_skill_read(home, a[0], a[1], a[2]),
    "skill-write": lambda home, config, a: api_skill_write(home, a[0], a[1], a[2], stdin_bytes(TEXT_MAX_BYTES)),
    "skill-delete": lambda home, config, a: api_skill_delete(home, a[0], a[1], a[2]),
    "skill-import": lambda home, config, a: api_skill_import(home, a[0], a[1], a[2], sys.stdin.buffer),
    "gallery": lambda home, config, a: api_gallery(home, a[0]),
    "forges": lambda home, config, a: api_forges(home),
    "forge-add": lambda home, config, a: api_forge_add(home, a[0], a[1], stdin_bytes(4096)),
    "forge-remove": lambda home, config, a: api_forge_remove(home, a[0]),
    "repo": lambda home, config, a: api_repo(home, a[0]),
    "repo-link": lambda home, config, a: api_repo_link(home, a[0], a[1], a[2]),
    "repo-unlink": lambda home, config, a: api_repo_unlink(home, a[0]),
    "repo-create": lambda home, config, a: api_repo_create(home, a[0], a[1], a[2], a[3], a[4]),
    "pr-merge": lambda home, config, a: api_pr_merge(home, a[0], a[1], a[2]),
    "repo-settings": lambda home, config, a: api_repo_settings(home, a[0], a[1], a[2], a[3]),
    "team": lambda home, config, a: api_team(home, a[0]),
    "labs": lambda home, config, a: api_labs(home),
    "labs-settings": lambda home, config, a: api_labs_settings(home, read_stdin_text()),
    "lab-journal": lambda home, config, a: api_lab_journal(home, a[0] or "60"),
    "lab-action": lambda home, config, a: api_lab_action(home, a[0], a[1], a[2]),
    "machine-add": lambda home, config, a: api_machine_add(home, a[0], a[1], a[2], a[3], a[4], read_stdin_text()),
    "lab-new": lambda home, config, a: api_lab_new(home, a[0], a[1], read_stdin_text()),
    "lab-edit": lambda home, config, a: api_lab_edit(home, a[0], a[1], read_stdin_text()),
    "lab-network-describe": lambda home, config, a: api_lab_network_describe(home, a[0], read_stdin_text()),
    "host-add": lambda home, config, a: api_host_add(home, a[0], a[1], a[2], a[3], read_stdin_text()),
    "host-local": lambda home, config, a: api_host_local(home, a[0], read_stdin_text()),
    "host-remove": lambda home, config, a: api_host_remove(home, a[0]),
    "host-test": lambda home, config, a: api_host_test(home, a[0]),
    "machine-remove": lambda home, config, a: api_machine_remove(home, a[0]),
    "machine-test": lambda home, config, a: api_machine_test(home, a[0]),
    "collaborators": lambda home, config, a: api_collaborators(home, a[0]),
    "task-create": lambda home, config, a: api_task_create(home, a[0], a[1], read_stdin_text()),
    "handoff-give": lambda home, config, a: api_handoff_give(home, a[0], a[1], a[2], read_stdin_text()),
    "handoff-take": lambda home, config, a: api_handoff_take(home, a[0], a[1]),
    "approvals": lambda home, config, a: api_approvals(home),
    "approval-answer": lambda home, config, a: api_approval_answer(home, a[0], a[1]),
    "worktrees": lambda home, config, a: api_worktrees(home, a[0]),
    "worktree-remove": lambda home, config, a: api_worktree_remove(home, a[0], a[1]),
    "copy-diff": lambda home, config, a: api_copy_diff(home, a[0], a[1], stdin_bytes(COPY_DIFF_MAX)),
}


def clean_json(value):
    """JSON text without lone surrogates (a file name that is not UTF-8): those become a
    question mark, the rest of the answer stays readable."""
    text = json.dumps(value, sort_keys=True)
    if "\\ud" not in text:  # the usual case: nothing to clean
        return text
    return json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8", "replace").decode("utf-8")


def run_api(args):
    home = home_dir()
    config, warning = load_config(home)
    command, rest = (args[0], args[1:]) if args else ("?", [])
    if command == "watch":
        return api_watch(home, config)
    started = time.monotonic()
    try:
        if command not in API_COMMANDS:
            raise ApiError(f"unknown command: {command}" if args else "missing command")
        result = API_COMMANDS[command](home, config, rest + [""] * 4)
    except (ApiError, OSError, ValueError) as exc:
        log("warn", f"api.{command}", ms=api_ms(started), err=str(exc), **api_log_fields(command, rest))
        print(json.dumps({"api": API_VERSION, "error": str(exc)}))
        return 1
    except Exception as exc:  # noqa: BLE001 - a bug: logged with its traceback, reported in one line
        log("error", f"api.{command}", trace=traceback.format_exc(), ms=api_ms(started),
            err=f"{type(exc).__name__}: {exc}", **api_log_fields(command, rest))
        print(json.dumps({"api": API_VERSION, "error": f"the picker failed ({type(exc).__name__}: {exc}); "
                                                     f"the details are in {pretty_path(log_path(), home)}"}))
        return 1
    level = "debug" if command in API_READS else "info"
    log(level, f"api.{command}", ms=api_ms(started), **api_log_fields(command, rest),
        **{key: result[key] for key in API_LOGGED if key in result and not isinstance(result[key], (dict, list))})
    result["api"] = API_VERSION
    if warning:
        result["warning"] = warning
    try:
        print(clean_json(result))
    except BrokenPipeError:  # Pier went away: the action is done anyway
        pass
    return 0


