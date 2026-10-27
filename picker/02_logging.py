# --- logging -------------------------------------------------------------------------
#
# One line per event, in ~/.local/state/pier-picker/picker.log, readable by its owner
# only:
#   2026-10-12T14:32:01.123Z INFO  api.paste-image pid=4242 req=7f3a-12 ms=41 saved=...
# Times are UTC, like Pier's own log, so the two read side by side; req is the id
# Pier gave the call. A crash adds its traceback on the lines below, indented. The
# reads Pier makes every few seconds are debug lines, written only with
# DEVBOX_LOG=debug. Logging never breaks anything: when the disk is full or the home is
# read-only, lines are lost and that is all. Passwords never come here, and what is
# typed into Pi is logged as its length only.

LOG_MAX_BYTES = 1024 * 1024
LOG_KEEP = 3  # picker.log, picker.log.1, picker.log.2
LOG_LEVELS = {"error": 0, "warn": 1, "info": 2, "debug": 3}
LOG_LEVEL = LOG_LEVELS["debug" if os.environ.get("DEVBOX_LOG") == "debug" else "info"]
LOG_REQUEST = re.sub(r"[^A-Za-z0-9_.-]", "", os.environ.get("DEVBOX_REQUEST", ""))[:40]


def log_path():
    return os.path.join(os.path.dirname(state_path(home_dir())), "picker.log")


def log_value(value):
    """value as one token: bare when it is simple, else quoted like a JSON string."""
    if isinstance(value, (list, tuple, dict)):
        value = json.dumps(value, ensure_ascii=False)
    text = str(value)
    if text and text.isprintable() and not re.search(r'[\s"=\\]', text):
        return text
    return json.dumps(text, ensure_ascii=False)


def log_stamp(now=None):
    now = time.time() if now is None else now
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + f".{int(now % 1 * 1000):03d}Z"


def log(level, event, trace=None, **fields):
    """Append one event; trace (a traceback) goes on the following lines, indented."""
    if LOG_LEVELS[level] > LOG_LEVEL:
        return
    try:
        parts = [log_stamp(), level.upper().ljust(5), event, f"pid={os.getpid()}"]
        if LOG_REQUEST:
            parts.append(f"req={LOG_REQUEST}")
        parts += [f"{key}={log_value(value)}" for key, value in fields.items() if value is not None]
        line = " ".join(parts) + "\n"
        if trace:
            line += "".join(f"    {row}\n" for row in trace.rstrip("\n").splitlines())
        log_write(log_path(), line.encode("utf-8", "replace"))
    except Exception:  # noqa: BLE001 - see above: never let a log line fail the program
        pass


def log_write(path, data):
    """Append data to path, rotating it past LOG_MAX_BYTES. Several API calls run at
    once: the lock makes one of them rotate, and the others then write to the new file."""
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    for _ in range(3):
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            if fcntl:
                fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                current = os.stat(path)
            except OSError:
                continue  # rotated away meanwhile: open the new one
            if not os.path.samestat(current, os.fstat(fd)):
                continue
            if current.st_size and current.st_size + len(data) > LOG_MAX_BYTES:
                if os.name == "nt":  # Windows renames no open file (only the checks run there)
                    os.close(fd)
                    fd = None
                for n in range(LOG_KEEP - 1, 0, -1):
                    older = f"{path}.{n - 1}" if n > 1 else path
                    if os.path.exists(older):
                        os.replace(older, f"{path}.{n}")
                continue  # this fd is the rotated file now
            os.write(fd, data)
            return
        finally:
            if fd is not None:
                os.close(fd)


def log_tail(lines):
    """The last lines of the log, older files included when the current one is short."""
    lines = max(1, min(int(lines), 5000))
    path = log_path()
    rows = []
    for name in [path] + [f"{path}.{n}" for n in range(1, LOG_KEEP)]:
        try:
            with open(name, "rb") as handle:
                handle.seek(0, os.SEEK_END)
                size = handle.tell()
                handle.seek(max(0, size - 400 * lines))
                chunk = handle.read().decode("utf-8", "replace").splitlines()
        except OSError:
            continue
        if size > 400 * lines and chunk:
            chunk = chunk[1:]  # cut in the middle of a line
        rows = chunk + rows
        if len(rows) >= lines:
            break
    return rows[-lines:]


