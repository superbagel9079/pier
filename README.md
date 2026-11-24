# Pier

Pier is a desktop cockpit for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent:
several Pi sessions in tabs, each driven live (stream, steer, Stop), and **supervised by default**: every tool that
writes or runs waits for your approval.

Written in Rust with egui, Pier stays light: about 90 MB of RAM at idle (measured with `tools/measure-ram.ps1`).

## What Pier does

- **Tabs**: one `pi --mode rpc` process per tab. Background tabs keep running.
- **Project folder**: Pier starts without a folder; you open one, or a recent one.
- **Approvals**: every tool call that is not read-only shows the whole command, a warning when the target is outside
  the working folder, and is denied automatically after 60 s.
- **Diff**: a `write` or `edit` shows a colored preview of the added and removed lines before you approve it; after an
  `edit`, Pi's exact patch stays available in the transcript. Files changed by `bash` get no diff.
- **Resume** a saved Pi session, with its history. **Name** a session.
- **Presets**: model, thinking level, tools, folder and instructions, launched in one click.
- **Model and thinking level** switchable inside a tab, **context gauge** and session cost.
- **`/` palette** of Pi's commands, prompt templates and skills.
- **Journal**: one JSONL file per tab: tab opened, runs, every approval requested and decided.
- The taskbar flashes when a background tab waits for an approval; Windows does not sleep while a run is going.

## Requirements

- Windows 10 or 11 (Pier uses Windows Job Objects and the power API).
- Pi installed with its managed installer: `%USERPROFILE%\.pi\agent\bin\pi-launcher.js` and, if present,
  `%LOCALAPPDATA%\pi-node\current\node.exe` (otherwise `node` from the PATH). Tested with Pi 1.5.2.
- A recent stable Rust (edition 2024).

## Run

```powershell
cargo run --release
```

Arguments after `--` go to every Pi, for example a model:

```powershell
cargo run --release -- --model openrouter/deepseek/deepseek-v4.1-flash
```

## Pier's files

All in `%APPDATA%\pier\`:

| File | Purpose |
|---|---|
| `presets.json` | Presets (created with an example by Presets › Edit presets…). An unknown key, an invalid thinking level or a missing folder is reported in the menu. |
| `recent.json` | Recent project folders (10 at most). |
| `journal\*.jsonl` | One journal per tab. Launch arguments are never written there. |
| `pier-approvals-<fingerprint>.ts` | The approval extension, embedded in the executable; the name follows its content, so two Pier versions never share one. |

Conversations stay Pi's own, in Pi's session folders.

## Safety

- Pi always loads Pier's extension (`-e`), even with `--no-extensions`. Until it reports in, Pier refuses to send
  anything ("Not supervised").
- The extension fails closed: an error, a timeout or a closed window means denied. After your approval the tool input
  is frozen, so no other extension can change it.
- `read`, `grep`, `find` and `ls` skip approval only when they are Pi's own built-in tools.
- The "outside the working folder" warning is reliable for `write` and `edit`, and **a hint only** for `bash` and
  `powershell` (read from the command text). It is not a sandbox.
- Closing a tab or quitting Pier stops the tab's whole process tree (Windows Job Object).

## Tests

```powershell
cargo test                                            # unit tests, no network
node --experimental-strip-types extension/check.mjs   # extension self-check (Node 22+, uses the installed Pi)
```

Live tests talk to the real Pi and a real model (each test costs a little):

```powershell
$env:PIER_TEST_MODEL = 'openrouter/deepseek/deepseek-v4.1-flash'
cargo test --test live -- --ignored --test-threads=1
```

Before each commit: `cargo fmt`, `cargo clippy --all-targets`, `cargo test`, then the live tests.

## Code layout

```
src/
  lib.rs              the core, no egui
  pi/                 talking to Pi: process (Job Object, threads), protocol (serde types), sessions (on disk)
  session/            the model: transcript (stream, history, approvals), state, journal, diff
  workspace.rs        the tabs: launch, send, Stop, close, what needs the user's attention
  presets.rs, recent.rs, files.rs, awake.rs
  main.rs, app/       the egui interface: it draws and asks, with no session logic
extension/            the Pi approval extension and its self-check
tests/live.rs         tests against the real Pi
tools/                RAM measurement
```

Rule: all logic goes into the core, with a test; `app/` only draws.

## Known limits

- Answer text is not rendered as Markdown yet (interface pass to come).
- Extension dialogs other than "confirm" (select, input, editor) are denied.
- Resume only reads Pi's default session folder.

## License

MIT, see `LICENSE`.
