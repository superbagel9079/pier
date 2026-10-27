<!-- Part of Pier's documentation: see the index in ../README.md -->
# Files and locations

## On the VM

| Path | Contents |
|---|---|
| `~/bin/pi-pick` | the picker's launcher (installed by Pier), or the picker itself (copied by hand) |
| `~/bin/pi-pick.lib/` | the picker, as Pier installs it, and its compiled form (`__pycache__`) |
| `~/.local/state/pier-picker/incoming/` | where a folder copy or a Hand off is unpacked, out of Pi's reach, before it is moved into the project |
| `~/.config/pier-picker/config.toml` | its configuration (optional) |
| `~/.config/pier-picker/forges.json` | the forges' accounts **with their tokens** (readable by you only) |
| `~/.config/pier-picker/repos.json` | which project is linked to which repository, and its rules |
| `~/.local/state/pier-picker/approvals.json` | Pi's requests waiting for you, and the latest answered |
| `~/.local/state/pier-picker/labs.json` | labs' settings, lab hosts, machines and labs |
| `~/.local/state/pier-picker/labs/id_ed25519` | **the key that opens every lab host and machine** (no passphrase; readable by you only), and its `known_hosts`, `journal.jsonl`, `ssh/` (shared connections) |
| `~/.local/state/pier-picker/git/` | the bare mirrors the picker pushes from, with the token |
| `~/.local/state/pier-picker/net/` | the sockets of each Pi's network proxy and broker |
| `~/.local/state/pier-picker/pi/` | what Pier gives each Pi: its extensions (`ext/`) and what it says (`pis/`) |
| `~/.local/state/pier-picker/trash/` | skills put in the bin from Setup |
| `~/.local/state/pier-picker/*.corrupt-<date>` | a file that could not be read, kept aside instead of written over (said in the log as an error) |
| `/tmp/.pier-net/` (in the sandbox only) | where Pi's sandbox sees its proxy, broker and the relay |
| `<project>/.pi-worktrees/` | the worktrees of a second Pi in the same project |
| `~/.local/state/pier-picker/state.json` | recent projects, sorting (readable by you only) |
| `~/.local/state/pier-picker/picker.log` | the picker's log (`.1`, `.2`: the previous ones) |
| `~/.local/state/pier-picker/checkpoints/` | the restore points, one git repository per project |
| `~/.local/state/pier-picker/labels.json` | names, categories, pinned and archived conversations (Pier) |
| `~/.local/state/pier-picker/versions.json` | latest versions of Pi and the packages, asked of npm at most every 6 hours |
| `~/.local/state/pier-picker/tmux.conf` | the configuration of the Pis' tmux server (rewritten by the picker) |
| `~/.local/state/pier-picker/pi/ext/` | the extensions Pier gives each Pi it starts (`--extension`): which conversation it holds, git, labs |
| `~/.local/state/pier-picker/pi/pis/<tmux session>/state.json` | what each Pi says: its conversation, whether it works (deleted when it stops) |
| `~/bin/pi-pick.previous` | the picker's version from before Pier's last update |
| `<project>/.pi-images/`, `.pi-files/` | images, files and copies sent (ignored by git) |
| `<project>/.pi-shared/` | live shares and copies from a Hand off |
| `<project>/.pi/devbox-history/` | earlier versions of the instructions |
| `<project>/AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/SYSTEM.md` | Pi's context for that project |
| `~/.pi/agent/sessions/` | Pi's sessions (read by Activity and Conversations) |
| `~/.pi/hindsight.key` | the Hindsight memory key (keep it `chmod 600`) |

## On the PC

Pier's configuration folder, `%APPDATA%\app.devbox.client` on Windows:

| File | Contents |
|---|---|
| `settings.json` | address, port, user, bastion. **Never a password.** |
| `known_hosts.json` | the accepted server fingerprints |
| `shares.json` | the shares to find again (paused, or from a Hand off) |

The log is in `%LOCALAPPDATA%\app.devbox.client\logs\` (`pier.log`, then `pier.1.log`, `pier.2.log`). The display preferences (layout, theme…) are kept by the app itself.

## In this repository

| Path | Purpose |
|---|---|
| `pier-picker.py` | the picker and its API, the one file the VM runs: **made from `picker/`**, not edited by hand |
| `picker/NN_*.py` | the picker in parts, one per subject (config, sandbox, network, restore points, forges, team, labs, broker, watch, the screen…), one module cut in pieces: edit them, then `python3 tools/bundle.py` writes `pier-picker.py` (the CI checks they match) |
| `tools/bundle.py` | joins the parts (`--check`: whether `pier-picker.py` is them joined; `--split`: cuts it into them again) |
| `pier-picker-tests.py` | the test suite, to run on the VM, in a real tmux terminal (the CI runs it too) |
| `pier-picker-unit.py` | the picker's unit tests, without a VM (`python3 -B pier-picker-unit.py`) |
| `config.example.toml` | the picker's configuration template |
| `client/ui/` | Pier's interface: `index.html`, `style.css`, `themes.js`, xterm.js in `vendor/` |
| `client/ui/js/` | its code, one file per part: `core.js` (preferences, log, helpers), `ui.js` (what the panels build their lists with: link buttons, rows, notices, `~` paths), `firstuse.js` (Is the VM ready?, Open a folder…, Waiting for you), `approvals.js`, `vm.js` (the VM's state, received through `watch`), `connect.js`, `workspace.js` (the three zones and their tabs), `prefs.js`, `terminal.js`, `context.js`, `project.js` (Activity), `diff.js`, `conversations.js`, `setup.js`, `logs.js`, `palette.js`, `backend.js` (the Rust side), `mock.js` (a fake VM to try the interface in a browser), `main.js` |
| `client/src-tauri/src/` | the Rust side: `lib.rs` (the app, the connection, the API to the VM, diagnostics, updates), `cmd/` (the interface's commands by subject: `send.rs`, `terminals.rs`, `shares.rs`, `setup.rs`, `forge.rs`, `labs.rs`, `take_back.rs`), `ssh.rs` (connection, fingerprints, bastion), `term.rs` (terminals), `share.rs` (the shares' SFTP server), `copy.rs` (folder archives), `store.rs` (settings), `clip.rs` (clipboard), `journal.rs` (the log), `picker.rs` (the built-in picker and its installation), `watch.rs` (the `watch` command), `lib.rs` (everything else) |
