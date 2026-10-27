#!/usr/bin/env python3
"""pier-picker.py, the one file the VM runs, put together from picker/NN_*.py.

The picker is kept in parts, one per subject, in picker/: their names say the order
(00_head.py, 01_config.py, ...). They are one module cut in pieces, one namespace: a part
is not run nor imported alone. This script joins them, in that order, as they are.

  python3 tools/bundle.py           writes pier-picker.py
  python3 tools/bundle.py --check   exits 1 when pier-picker.py is not the parts joined
                                    (the CI runs it: edit the parts, then bundle)
  python3 tools/bundle.py --split   cuts pier-picker.py into the parts again, at the
                                    "# --- " headers listed in PARTS (after an edit of
                                    pier-picker.py itself)
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLE = os.path.join(ROOT, "pier-picker.py")
FOLDER = os.path.join(ROOT, "picker")

# (part, the first line it starts with): the first part starts at the file's start.
PARTS = [
    ("head", None),
    ("config", "# --- config and state "),
    ("logging", "# --- logging "),
    ("files_git", "# --- filesystem and git "),
    ("processes", "# --- processes "),
    ("network", "# --- the network Pi may reach "),
    ("tmux", "# --- tmux sessions "),
    ("worktrees", "# --- worktrees: "),
    ("pi_state", "# --- what each Pi says about itself "),
    ("checkpoints", "# --- restore points "),
    ("api_context", "# --- desktop client API "),
    ("activity", "# --- agent activity "),
    ("takeback", "# --- take back, file by file "),
    ("setup", "# --- project setup "),
    ("resources", "# --- managing what Pi loads: "),
    ("forges", "# --- git forges: "),
    ("approvals", "# Pi's requests waiting for the user, in approvals.json."),
    ("team", "# --- the team: "),
    ("labs", "# --- labs: "),
    ("broker", "LAB_OPS = ("),
    ("versions", "def versions_path(home):"),
    ("api", "# Reads Pier repeats every few seconds:"),
    ("watch", "# --- watch: "),
    ("text", "# --- text "),
    ("tui", "# --- picker "),
]


def part_files():
    names = sorted(n for n in os.listdir(FOLDER) if n.endswith(".py") and n[:2].isdigit())
    return [os.path.join(FOLDER, n) for n in names]


def joined():
    out = []
    for path in part_files():
        with open(path, encoding="utf-8", newline="") as handle:
            out.append(handle.read())
    return "".join(out)


def split():
    with open(BUNDLE, encoding="utf-8", newline="") as handle:
        lines = handle.read().splitlines(keepends=True)
    starts = [0]
    for name, head in PARTS[1:]:
        found = [i for i, line in enumerate(lines) if line.startswith(head) and i > starts[-1]]
        if not found:
            sys.exit(f"no line starts with {head!r} after line {starts[-1] + 1}: update PARTS")
        starts.append(found[0])
    os.makedirs(FOLDER, exist_ok=True)
    for path in part_files():
        os.remove(path)
    for index, ((name, _), begin) in enumerate(zip(PARTS, starts)):
        end = starts[index + 1] if index + 1 < len(starts) else len(lines)
        with open(os.path.join(FOLDER, f"{index:02d}_{name}.py"), "w", encoding="utf-8", newline="") as handle:
            handle.write("".join(lines[begin:end]))
    print(f"{len(PARTS)} parts in picker/")


def main(args):
    if args == ["--split"]:
        split()
        return 0
    text = joined()
    if args == ["--check"]:
        with open(BUNDLE, encoding="utf-8", newline="") as handle:
            if handle.read() != text:
                print("pier-picker.py is not picker/*.py joined: run python3 tools/bundle.py", file=sys.stderr)
                return 1
        return 0
    with open(BUNDLE, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
