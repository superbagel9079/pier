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

