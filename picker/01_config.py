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


