# Pier

Pier is a desktop cockpit for the [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent:
several Pi sessions in tabs, each driven live (stream, steer, Stop), and **supervised by default**: every tool that
writes or runs waits for your approval.

Written in Rust with egui, Pier stays light: about 215 MB of RAM at idle with its default renderer, wgpu on DirectX 12
(measured with `tools/measure-ram.ps1`).

Renderers: wgpu on DirectX 12 first. If it cannot start, on old graphics, Pier falls back to
egui's own OpenGL renderer (OpenGL 2.0 and up). That one uses about 90 MB; set `PIER_RENDERER=glow` to always use
it. It is not the default because it froze a whole PC on window resize with an Intel Arc GPU.

## What Pier does

- **Tabs**: one `pi --mode rpc` process per tab. Background tabs keep running.
- **Steer or queue for after** while a run is going; **Edit queue…** takes the waiting messages back from Pi to
  change, reorder or drop them, then sends them back (text only: images in a waiting message are lost).
- **Project folder**: Pier starts without a folder; you open one, or a recent one.
- **Approvals**: every tool call that is not read-only shows the whole command, a warning when the target is outside
  the working folder, and is denied automatically after 60 s.
- **Permission modes** per tab, from the mode menu in the top bar: **Supervised** (default), **Accept edits** (`write`
  and `edit` inside the folder pass without asking; outside it and commands still ask), **Plan** (read-only: anything
  that writes or runs is refused without asking). Each automatic decision shows in the transcript and the journal.
  Every new tab, and every fork, starts Supervised.
- **Allowlist** of shell commands that run without asking (except in Plan): a single simple command (no `;`, `&`,
  `|`, redirection, `$`, backtick, parentheses or newline) that starts with an entry word by word, with no path
  outside the folder. "Allow + always allow" adds the command's program and subcommand. **Risky** commands (recursive
  delete, downloaded code, git history rewrite, elevation…) get a red badge and are never allowlisted.
- **Diff**: a `write` or `edit` shows a colored preview of the added and removed lines before you approve it; after an
  `edit`, Pi's exact patch stays available in the transcript. Files changed by `bash` get no diff.
- **Checkpoints**: before each message, the folder's files are saved (git must be installed); "Restore files…" puts
  them back as they were, and the restore itself can be undone. Pi's conversation is not rewound.
- **Fork** from an earlier message: the tab moves to a new session holding the conversation up to just before it,
  and the message comes back to the editor; optionally the files are restored too. The original stays in Resume.
- **Resume** a saved Pi session, with its history, from a window listing every session of the folder: search the
  titles, or the messages too; **archive** a session to hide it (Pier's list only: Pi's file is not touched).
  **Name** a session.
- **Presets**: model, thinking level, tools, folder and instructions, launched in one click.
- **Model and thinking level** switchable inside a tab, **context gauge** and session cost.
- **`/` palette** of Pi's commands, prompt templates and skills.
- **`@` mentions** of the project's files (ignored files left out): as in Pi, only the path goes into the message.
- **Images**: paste a screenshot (Ctrl+V), drop an image file on the window, or Attach image… (PNG, JPEG, GIF,
  WebP, 10 MB at most). Sending is refused when the model does not read images.
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
| `allowlist.json` | Commands that run without asking (`{"commands": [...]}`), read by the extension at each call. Until it exists, a read-only default list applies (`ls`, `pwd`, `git status`, `git diff`, `git log`…). A broken file allows nothing. |
| `archived.json` | Sessions hidden from Resume. Deleting it brings them all back. |
| `journal\*.jsonl` | One journal per tab. Launch arguments are never written there. |
| `checkpoints\<fingerprint>.git` | One shadow git repository per project folder, holding its checkpoints. The project's own git is never touched; its `.gitignore` files are honored. Never cleaned up yet: delete a folder's repository to drop its checkpoints. |
| `pier-approvals-<fingerprint>.ts` | The approval extension, embedded in the executable; the name follows its content, so two Pier versions never share one. |

Conversations stay Pi's own, in Pi's session folders.

## Safety

- Pi always loads Pier's extension (`-e`), even with `--no-extensions`. Until it reports in, Pier refuses to send
  anything ("Not supervised").
- The mode is switched by Pier with `/pier-mode`, an extension command that runs on a prompt only: the model cannot
  change it. Pier shows the mode the extension reports, not the one it asked for.
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

Before each commit: `cargo fmt`, `cargo clippy --all-targets`, `cargo test`, then the live tests. GitHub Actions runs
everything but the live tests on each push (`.github/workflows/ci.yml`).

## Code layout

```
src/
  lib.rs              the core, no egui
  pi/                 talking to Pi: process (Job Object, threads), protocol (serde types), sessions (on disk)
  session/            the model: transcript (stream, history, approvals), state, journal, diff
  workspace/          the open tabs: tab/ (one Pi session, its checkpoints), browser.rs (Resume list), mod.rs
  checkpoint.rs       saving and restoring the folder's files (shadow git repository), file list for @
  complete.rs         / and @ completion in the editor
  attach.rs           attached images
  archive.rs          sessions hidden from Resume
  allowlist.rs        the allowlist file (the extension decides)
  presets.rs, recent.rs, files.rs, awake.rs, text.rs
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
- Checkpoints cover the project folder only, not ignored files nor nested git repositories, and only messages sent
  in this tab (not a resumed history). A checkpoint over 20,000 files or 500 MB of new content is refused.

## License

MIT, see `LICENSE`.
