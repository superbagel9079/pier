# --- what each Pi says about itself -------------------------------------------------------
#
# Pi switches conversations by itself (/new, /resume, /fork), and the file of a new one
# only appears at its first answer: from outside, which conversation a Pi holds can only
# be guessed. So the Pis started here get a small extension (--extension, nothing is
# installed in Pi's settings) that writes, at every change, which conversation it holds
# and whether it works, to <the picker's state>/pi/pis/<tmux session>/state.json. That
# folder is the picker's: the sandbox gives each Pi its own folder there and nothing else
# of it, so a Pi cannot write what another says, nor change the extensions they load.

PIER_EXTENSION = """// Written by Pier (pier-picker): tells Pier which conversation this Pi holds and
// whether it is working. Loaded with --extension by the picker only; it writes one small
// file, PIER_STATE, and nothing else.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export default function (pi: any) {
  const target = process.env.PIER_STATE;
  if (!target) return;
  let file: string | null = null;
  let working = false;
  const write = () => {
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ file, working, pid: process.pid, at: Date.now() / 1000 }));
      renameSync(tmp, target);
    } catch {
      // Pier falls back to guessing
    }
  };
  pi.on("session_start", async (_event: any, ctx: any) => {
    file = ctx?.sessionManager?.getSessionFile?.() ?? null;
    working = false;
    write();
  });
  pi.on("agent_start", async () => { working = true; write(); });
  pi.on("agent_end", async () => { working = false; write(); });
  pi.on("agent_settled", async () => { working = false; write(); });
  pi.on("session_shutdown", async () => { working = false; write(); });
}
"""


def pier_dir():
    """What Pier gives the Pis it starts, in the picker's state folder (Pi never writes
    there): ext/ the extensions, pis/<slot>/ what each Pi says."""
    return os.path.join(os.path.dirname(state_path(home_dir())), "pi")


def pier_state_path(slot):
    return os.path.join(pier_dir(), "pis", slot, "state.json")


def forget_pier_state(path):
    """Remove what a Pi said, and its folder."""
    for remove in (os.remove, os.rmdir):
        try:
            remove(path)
        except OSError:
            pass
        path = os.path.dirname(path)


def pier_extension_file(name, text, event):
    """An extension's file in pier_dir()/ext, written when missing or different; None
    when it cannot be."""
    path = os.path.join(pier_dir(), "ext", name)
    try:
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if read_text(path) == text and not os.path.islink(path):
            return path
        atomic_write(path, text, pier_dir(), 0o644)
        return path
    except (OSError, ApiError) as exc:
        log("warn", event, err=str(exc))
        return None


def pier_extension():
    return pier_extension_file("pier-session.ts", PIER_EXTENSION, "pier.extension-failed")


def pier_state(slot):
    """What the Pi of a tmux session last said: {"file", "working"}, or None (no word
    from it: an older Pi, or one started before Pier gave the extension)."""
    text = read_text(pier_state_path(slot), 64 * 1024, root=pier_dir())
    try:
        data = json.loads(text) if text is not None else None
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    file = data.get("file") if isinstance(data.get("file"), str) else None
    if file and not said_file_ok(file):
        file = None
    return {"file": file, "working": bool(data.get("working"))}


def said_file_ok(file):
    """A path Pi wrote in its state file: a .jsonl in Pi's sessions folder, no control
    characters (it goes to tmux and to the lists), a regular file when it exists."""
    if len(file) > 1024 or any(ord(c) < 32 or ord(c) == 127 for c in file) or not file.endswith(".jsonl"):
        return False
    real = os.path.realpath(file)
    if not within(real, os.path.realpath(os.path.join(agent_dir(), "sessions"))):
        return False
    return not os.path.lexists(real) or os.path.isfile(real)


