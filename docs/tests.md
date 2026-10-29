<!-- Part of Pier's documentation: see the index in ../README.md -->
# Tests

## The picker

The `pier-picker-tests.py` suite, to run **on the VM** (it passed entirely on 27 October 2026, picker 4.37, on the Debian VM; the CI runs it too, at every push): it drives the picker in a real tmux terminal, and checks with the real programs:

- the screen and its keys, starting Pi (directly and in tmux), the Hindsight key, two Pis in one project and the API that lists them;
- the real bubblewrap sandbox: what Pi sees, its own `/dev`, `/run` hidden, the TIOCSTI filter, and its network (no direct connection, the proxy refusing what is not allowed);
- the protections against links and FIFOs Pi could plant (Hindsight key, Setup, removals, writes, the git jail), folder copies;
- restore points around a real `--exec-pi`, the log, what Setup lists, and moving the folders of the old name (pi-dir-picker).

When `/tmp` is mounted `noexec` (a hardened VM), the suite works in `~/.cache/pier-picker-tests` instead: its fake Pi must be able to run.

The scripts go in `~/.cache/pier-tests` on the VM: a hidden folder, which the picker does not list among the projects.

```powershell
ssh pi-sh "mkdir -p ~/.cache/pier-tests"
```

```powershell
scp <repository>\pier-picker.py <repository>\pier-picker-tests.py pi-sh:.cache/pier-tests/
```

```powershell
ssh -t pi-sh "python3 -B ~/.cache/pier-tests/pier-picker-tests.py"
```

## Pier

60 Rust tests (`cargo test`, one of them ignored by default), including:

- Pi tabs in tmux control mode against a local SSH server (decoding `%output`, keys as raw bytes, sizes, end, Pi unable to fake Pier's messages, caps);
- `watch` against a local SSH server (lines cut across two packets, round trip, end);
- the connection against a real local SSH server: first contact, wrong password, changed fingerprint, bastion, a server with old algorithms refused (without the password leaving);
- shares end to end (the simulated VM can neither leave the folder nor write when read-only), path confinement, archives, filtering Pi's arguments and update targets, quoting for any login shell;
- the log's format, rotation and UTC time, the built-in picker (its API version must be Pier's, or the tests do not build), the install script (trick paths refused);
- take back file by file: comparing by content, names from the VM that Windows would read otherwise, bringing files back with a backup, a path climbing out refused.

GitHub Actions runs them at every push to `main` and every pull request, on Linux and Windows, then builds Pier for Windows, macOS and Linux (see [Pier](install.md#pier)).

## The interface

It was checked in a browser with a fake backend (which also simulates `watch` and two Pis): layout, dragging tabs, menus, Context, Hand off, Conversations, Setup, the palette, themes, narrow widths, picker update, Restore, Logs, report, reconnection; then take back file by file, the clipboard only after a real key, the Logs tab under thousands of lines, dragging a divider, and a collapsed side unfolded for a look.
