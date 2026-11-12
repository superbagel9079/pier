# --- text ------------------------------------------------------------------------------

def clean(text):
    """Printable form of a name: undecodable bytes and control characters become visible marks."""
    try:
        raw = text.encode("utf-8", "surrogateescape")
    except UnicodeEncodeError:
        raw = text.encode("utf-8", "replace")
    text = raw.decode("utf-8", "replace")
    return "".join(ch if ch.isprintable() else "?" for ch in text)


def pretty_path(path, home):
    rel = os.path.relpath(path, home)
    return "~" if rel == "." else "~/" + clean(rel)


def char_width(ch):
    if unicodedata.combining(ch) or unicodedata.category(ch) in ("Mn", "Me", "Cf"):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


def text_width(text):
    return sum(map(char_width, text))


def fit(text, width):
    """text cut to at most width terminal cells; an ellipsis marks the cut."""
    if width <= 0:
        return ""
    if text_width(text) <= width:
        return text
    out, used = [], 0
    for ch in text:
        w = char_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return "".join(out) + ELLIPSIS


def fit_left(text, width):
    """Like fit, but keeps the end of text: for paths, the last segments matter."""
    if width <= 0:
        return ""
    if text_width(text) <= width:
        return text
    out, used = [], 0
    for ch in reversed(text):
        w = char_width(ch)
        if used + w > width - 1:
            break
        out.append(ch)
        used += w
    return ELLIPSIS + "".join(reversed(out))


def ago(stamp, now=None):
    seconds = max(0, (now or time.time()) - stamp)
    for unit, size in (("y", 31536000), ("mo", 2592000), ("d", 86400), ("h", 3600), ("min", 60)):
        if seconds >= size:
            return f"{int(seconds // size)}{unit} ago"
    return "just now"


def put(scr, y, x, text, attr=0, width=None):
    """addstr that clips to the window and never raises."""
    h, w = scr.getmaxyx()
    if not (0 <= y < h and 0 <= x < w):
        return
    room = w - x if width is None else min(width, w - x)
    text = fit(text, room)
    if not UNICODE:
        text = text.encode(ENCODING, "replace").decode(ENCODING)
    try:
        scr.addstr(y, x, text, attr)
    except curses.error:
        pass  # writing the bottom-right cell raises after drawing it


def show_cursor(visible):
    try:
        curses.curs_set(1 if visible else 0)
    except curses.error:
        pass


