# --- config and state ------------------------------------------------------------------

def config_path(home):
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(base, "pier-picker", "config.toml")


def load_config(home):
    """(config, warning). Unknown keys and wrong types are reported; defaults stand in."""
    config = {key: list(value) if isinstance(value, list) else value for key, value in DEFAULTS.items()}
    path = config_path(home)
    if not os.path.isfile(path):
        return config, None
    if tomllib is None:
        return config, "config.toml ignored: reading it needs python 3.11 or newer"
    try:
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return config, f"config.toml ignored: {exc}"
    problems = []
    for key, value in data.items():
        if key not in DEFAULTS:
            problems.append(f"unknown key {key}")
            continue
        if key in ("pi_command", "continue_args", "resume_args") and isinstance(value, str):
            value = shlex.split(value)
        default = DEFAULTS[key]
        if isinstance(default, bool) != isinstance(value, bool) or not isinstance(value, type(default)):
            problems.append(f"{key} should be a {type(default).__name__}")
            continue
        if isinstance(value, list) and not all(isinstance(item, str) for item in value):
            problems.append(f"{key} should list strings")
            continue
        config[key] = value
    if not config["pi_command"]:
        config["pi_command"] = ["pi"]
        problems.append("pi_command is empty")
    return config, ("config.toml: " + "; ".join(problems)) if problems else None


def state_path(home):
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state")
    return os.path.join(base, "pier-picker", "state.json")


def migrate_old_name(home):
    """~/.config/pi-dir-picker and ~/.local/state/pi-dir-picker (restore points, labels,
    recent projects, log) moved to the new name, once. A link is left at the old place:
    a Pi started by an older picker still writes there."""
    for new in (os.path.dirname(config_path(home)), os.path.dirname(state_path(home))):
        old = os.path.join(os.path.dirname(new), OLD_NAME)
        if os.path.lexists(new) or not os.path.isdir(old) or os.path.islink(old):
            continue
        try:
            os.rename(old, new)
            os.symlink(new, old)
        except OSError:
            pass  # another picker moved it meanwhile, or it cannot be: the old place stays


def load_state(home):
    try:
        with open(state_path(home), encoding="utf-8") as handle:
            data = json.load(handle)
    except ValueError as exc:
        set_aside(state_path(home), exc)
        data = {}
    except OSError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    recent = data.get("recent")
    recent = [p for p in recent if isinstance(p, str)] if isinstance(recent, list) else []
    sort = data.get("sort") if data.get("sort") in ("name", "activity") else "name"
    return {"recent": recent, "sort": sort}


def save_state(home, state):
    """Atomic write, readable by the owner only: the paths say what you work on."""
    try:
        write_json(state_path(home), state, indent=1)
    except OSError:
        pass




# --- the config, from Pier's settings ----------------------------------------------------
# Pier reads and changes some keys of config.toml (Settings: Agents, Network & sandbox):
# only these, each checked, the rest of the file (comments, other keys) left as it is.

def _model_ok(value):
    return value == "" or bool(MODEL_RE.fullmatch(value))


def _allow_ok(value):
    return bool(parse_allow([value])) and len(value) <= 253


CONFIG_EDITABLE = {
    # key: (what the value must be, a check of each item for a list, or of the value)
    "workers": (bool, None), "helpers": (bool, None), "workers_max": (int, lambda n: 1 <= n <= 12),
    "orchestrator_model": (str, _model_ok), "worker_model": (str, _model_ok), "helper_model": (str, _model_ok),
    "worker_models": (list, _model_ok),
    "sandbox": (bool, None), "network_limit": (bool, None), "network_allow": (list, _allow_ok),
    "network_off": (list, lambda v: v in NETWORK_ALLOW or _allow_ok(v)),
    "checkpoints": (bool, None), "worktrees": (bool, None), "git_tools": (bool, None), "track_sessions": (bool, None),
}
CONFIG_LIST_MAX = 64


def check_config_value(key, value):
    """value for key, checked; ApiError says what is wrong."""
    kind, check = CONFIG_EDITABLE[key]
    if kind is bool:
        if not isinstance(value, bool):
            raise ApiError(f"{key}: true or false")
    elif kind is int:
        if isinstance(value, bool) or not isinstance(value, int) or (check and not check(value)):
            raise ApiError(f"{key}: a whole number from 1 to 12")
    elif kind is str:
        if not isinstance(value, str) or not check(value.strip()):
            raise ApiError(f"{key}: a model as Pi's --model takes it (provider/id), or empty")
        value = value.strip()
    else:
        if not isinstance(value, list) or len(value) > CONFIG_LIST_MAX or not all(isinstance(v, str) for v in value):
            raise ApiError(f"{key}: a list of at most {CONFIG_LIST_MAX} texts")
        value = list(dict.fromkeys(v.strip() for v in value if v.strip()))
        bad = [v for v in value if not check(v)]
        if bad:
            raise ApiError(f"{key}: not valid: {', '.join(bad[:3])}")
    return value


def toml_value(value):
    """A value as TOML writes it: JSON's strings, numbers, booleans and arrays are TOML's."""
    return json.dumps(value, ensure_ascii=False)


def _key_span(lines, key):
    """(first, last) lines of the top-level key = ... in config.toml, or None; an array
    may go over several lines. Only before the first [table]."""
    start = re.compile(rf"\s*{re.escape(key)}\s*=")
    for i, line in enumerate(lines):
        if line.lstrip().startswith("["):
            return None  # a table: top-level keys are above it
        if start.match(line):
            depth, j, quote = 0, i, None
            while j < len(lines):
                text = lines[j] if j > i else lines[j].split("=", 1)[1]
                for c in text:
                    if quote:
                        quote = None if c == quote else quote
                    elif c in "\"'":
                        quote = c
                    elif c == "#":
                        break
                    elif c == "[":
                        depth += 1
                    elif c == "]":
                        depth -= 1
                if depth <= 0:
                    return i, j
                j += 1
            return i, len(lines) - 1
    return None


def config_set(home, key, value):
    """key = value in config.toml (None: the line goes, the default comes back). The file
    must read back with the new value, else nothing is written."""
    if key not in CONFIG_EDITABLE:
        raise ApiError(f"{key} is not changed from Pier: edit config.toml")
    if tomllib is None:
        raise ApiError("changing config.toml needs python 3.11 or newer on the VM")
    if value is not None:
        value = check_config_value(key, value)
    path = config_path(home)
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read()
    except FileNotFoundError:
        text = ""
    except OSError as exc:
        raise ApiError(f"cannot read config.toml: {exc.strerror or exc}")
    lines = text.split("\n")
    span = _key_span(lines, key)
    new = [] if value is None else [f"{key} = {toml_value(value)}"]
    if span:
        lines[span[0]:span[1] + 1] = new
    elif new:
        # Above the first table, after the keys already there.
        first_table = next((i for i, line in enumerate(lines) if line.lstrip().startswith("[")), None)
        at = first_table if first_table is not None else len(lines)
        while at > 0 and lines[at - 1].strip() == "" and first_table is None:
            at -= 1
        lines[at:at] = new
    out = "\n".join(lines)
    if not out.endswith("\n"):
        out += "\n"
    try:
        data = tomllib.loads(out)
    except tomllib.TOMLDecodeError as exc:
        raise ApiError(f"config.toml would not read back ({exc}): edit it by hand")
    if (data.get(key) if value is not None else key in data) != (value if value is not None else False):
        raise ApiError(f"{key} is written in a way Pier cannot change (in a table?): edit config.toml by hand")
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    atomic_write(path, out, os.path.dirname(path), 0o600)
    log("info", "config.set", key=key, reset=value is None)
    return {"key": key, "value": load_config(home)[0][key], "default": value is None}


def api_config(home):
    """The keys Pier changes: their values, defaults, whether config.toml sets them; and
    the places Pi always reaches."""
    config, warning = load_config(home)
    written = {}
    if tomllib is not None and os.path.isfile(config_path(home)):
        try:
            with open(config_path(home), "rb") as handle:
                written = tomllib.load(handle)
        except (OSError, tomllib.TOMLDecodeError):
            written = {}
    keys = {key: {"value": config[key], "default": DEFAULTS[key], "set": key in written} for key in CONFIG_EDITABLE}
    return {"keys": keys, "warning": warning, "path": pretty_path(config_path(home), home),
            "network_builtin": list(NETWORK_ALLOW), "writable": tomllib is not None}
