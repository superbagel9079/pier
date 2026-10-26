# Pier and its picker

Two tools for working with **Pi**, a command-line coding agent, installed on a remote Linux VM and used from a laptop.

- **The picker** (`pier-picker.py`, installed on the VM as `~/bin/pi-pick`): a terminal screen to choose a folder and start Pi in it.
- **Pier** (`client/`): a desktop app for Windows, macOS and Linux. One window holds the VM's terminal, sending images and files to Pi, sharing folders from the PC, and following what the agent does.

The starting idea: **the agent runs on the VM, not on the laptop.** The laptop is only a window onto the VM, as a browser is for Claude. You can close it, switch it off, lose the Wi-Fi: Pi carries on.

## Contents

1. [Chapter I. Why these tools](#chapter-i-why-these-tools)
2. [Chapter II. Overview](#chapter-ii-overview)
3. [Chapter III. The picker](#chapter-iii-the-picker)
4. [Chapter IV. Pier](#chapter-iv-pier)
5. [Chapter V. Security](#chapter-v-security)
6. [Chapter VI. Installation](#chapter-vi-installation)
7. [Chapter VII. Day to day](#chapter-vii-day-to-day)
8. [Chapter VIII. Outages and recovery](#chapter-viii-outages-and-recovery)
9. [Chapter IX. Files and locations](#chapter-ix-files-and-locations)
10. [Chapter X. Tests](#chapter-x-tests)
11. [Chapter XI. Known limits and what is left to check](#chapter-xi-known-limits-and-what-is-left-to-check)
12. [Chapter XII. Ideas for later](#chapter-xii-ideas-for-later)

## Chapter I. Why these tools

### Part I. What was missing

Without them, working with Pi on the VM meant:

1. connecting over SSH;
2. moving from folder to folder with `cd`;
3. starting `pi`;
4. and, if the connection dropped, losing the running Pi session.

Three problems remained that SSH does not solve:

- **Images.** Over SSH you cannot paste a screenshot into Pi: the clipboard is the laptop's, and Pi reads the VM's.
- **The laptop's files.** Pi only sees the VM. To show it a folder from the PC, you had to copy it by hand.
- **Knowing what the agent does.** During a long task, nothing shows what it reads, what it changes, or what it costs.

The picker solves the first points of the list, and Pier the rest.

### Part II. Why the folder is chosen before Pi starts

That is what the picker is for. Pi reads its configuration, its instructions (`AGENTS.md`) and its memory **at startup**, and its Hindsight memory is filed **by folder name**. Starting Pi in one folder and then moving to another would make it work with another project's context. So the working folder is always fixed before Pi starts.

## Chapter II. Overview

### Part I. The pieces

```
   Laptop (Windows)                                   Linux VM (Debian 13)
 ┌──────────────────────────┐   one SSH connection  ┌────────────────────────────────┐
 │ Pier                     │ ◄───────────────────► │ pi-pick (the picker)           │
 │  · terminals (xterm.js)  │   (over WireGuard,    │  · folder chooser screen       │
 │  · Conversations,        │    bastion possible)  │  · API --api … (JSON answers)  │
 │    Activity, Context,    │                       │                                │
 │    Setup                 │                       │ tmux (a server of its own)     │
 │  · SFTP server for       │                       │  └ one session per Pi          │
 │    shared folders        │                       │     └ Pi, in a sandbox         │
 └──────────────────────────┘                       │       (bubblewrap)             │
                                                    └────────────────────────────────┘
```

### Part II. How they work together

- **One SSH connection.** Pier's terminals, uploads and shares all go through it: the password is asked once. Every terminal, call or share opens a "channel" on it, and OpenSSH limits how many per connection (`MaxSessions`, 10 by default): past that the VM refuses, and Pier opens another connection by itself (with the password kept in memory). To avoid it, set `MaxSessions 30` on the VM (see [Network and encryption](#part-ii-network-and-encryption)).
- **No port open on the VM.** Pier runs the picker over SSH with options (`pi-pick --api …`), and the picker answers in JSON.
- **One command stays open** (`pi-pick --api watch`) and sends Pier what changes, when it changes: Pier does not poll the VM.
- **Pi runs in tmux,** one tmux session per Pi, on a tmux server reserved for Pier. So it survives disconnections. **Several Pis can run in the same project,** each in its own conversation.
- **Pi runs in a sandbox** (bubblewrap): it only sees its project.
- **The picker ships inside Pier.** Pier installs it on the VM and keeps it up to date: the exe is all you need.
- **Every prompt can be undone:** the project is saved before it (restore points).
- **Everything is logged,** on the PC and on the VM, in two logs that read side by side.

## Chapter III. The picker

A single-file Python program, **with no dependencies**: only the standard library. It is used directly over SSH (`ssh pi`) and is also Pier's engine.

### Part I. The screen

- At the top, an ASCII logo and the version, when the terminal has at least 30 rows.
- The current path, then the list of non-hidden folders.
- For each folder: the **git branch**, a **star** when there are uncommitted changes, `↑2 ↓1` for commits ahead of and behind the remote, and **`[pi]`** when a Pi runs there.
- At the top of your home, the **recent projects**.
- From 110 columns, a **preview panel**: latest commits, whether `AGENTS.md` or `.pi` exist, the start of the README.
- At the bottom, a reminder of the keys, which adapts to the width.
- Folders where Pi may not run (see [Security](#chapter-v-security)), such as `~/bin`, are not listed, found or offered at all.

### Part II. Keys

| Key | Action |
|---|---|
| `↑` `↓` (or `k` `j`), `PgUp` `PgDn`, `Home` `End` | move |
| `→` / `Enter` (or `l`) | open the folder |
| `←` / `Backspace` (or `h`) | go up |
| **`p`** | start Pi in the **selected** folder |
| **`P`** | start Pi in the **current** folder |
| `N` | start **one more Pi** in the selection, in a new conversation |
| `c` | continue Pi's last session (`--continue`) |
| `r` | choose one of Pi's saved sessions (`--resume`) |
| `x` | stop the Pis running in the selection |
| `/` | filter the current folder as you type |
| `f` | find a folder anywhere under home |
| `n` | create a folder |
| `g` | clone a git repository here |
| `R` | rename the selection |
| `t` | sort by name or by recent activity |
| `s` | open a shell in the selection |
| `?` | help |
| `q` / `Esc` | quit (Esc first clears a filter or a search) |

### Part III. Pi in tmux

When you start Pi, the picker opens it in a **tmux session of the project's own**. This tmux server is reserved for Pier and does not touch your own sessions.

- `Ctrl-b d` goes back to the picker, and **Pi keeps running**.
- `p` on the project puts you back in its session (the one of the Pi used last, when there are several).
- **Several Pis per project:** `N` starts another, in a new conversation (for example one for the code, one for the docs). The list then shows `[pi 2]`, and the tmux bar `#2`. Each Pi writes its own conversation: the picker gives it its session file itself (`--session`) and notes it in tmux, so that Pier always knows which Pi writes what.
- The tmux bar is discreet and recalls `ctrl-b d`. It shows `[sandbox]` when the sandbox is on.
- When tmux is not installed, the picker offers to install it (with `sudo`, which asks for your password itself), or to start Pi without tmux.
- **Extended keys** are on for this tmux server (`extended-keys`, in `csi-u` form, as Pi recommends): Shift+Enter makes a new line in Pi.
- **This tmux server has its own configuration,** written by the picker to `~/.local/state/pier-picker/tmux.conf`; your `~/.tmux.conf` is not read. It is applied again whenever a Pi opens, to a server started earlier too. It serves the "plain ssh" way (the picker in Windows Terminal): the mouse belongs to tmux (the wheel scrolls back through the history tmux keeps, a drag selects and copies), what tmux or Pi copies reaches the terminal's clipboard (OSC 52), and the bottom bar uses only palette colours (grey text, no background).
- **In Pier, Pi does not go through tmux's screen** (see [Terminals](#part-iv-terminals)): Pier attaches in "control mode". tmux keeps Pi alive but draws nothing; it passes Pi's output on as it is, and Pier displays it. So in the picker started by Pier, `p` (and `N`, `c`, `r`) opens Pi **in a Pier tab** instead of attaching to it itself.

### Part IV. Pi in "regular" mode (recommended)

Since version 1.0, Pi starts in "fullscreen" mode: it takes the mouse, scrolls and selects by itself, and shows "Copied!" when it copies. Over SSH, each notch of the wheel then makes Pi redraw the whole screen on the VM, which is not smooth, and its selection bypasses Pier's. In **regular** mode, Pi writes to the terminal like an ordinary program: the wheel, the selection and copying are Pier's. You lose Pi's scrollbar, its search in the conversation and jumping between messages.

In `~/.pi/agent/settings.json` on the VM:

```json
"tuiMode": "regular"
```

To go back to fullscreen mode, `"tuiMode": "fullscreen"` (the wheel is smoother there with `"fullscreenWheelScrollLines": 3`).

### Part V. The sandbox

By default, Pi runs in **bubblewrap**. See [Security](#chapter-v-security).

### Part VI. Configuration

Optional, in `~/.config/pier-picker/config.toml`. A commented template is in [config.example.toml](config.example.toml).

| Key | Purpose | Default |
|---|---|---|
| `start` | folder shown first | `~` |
| `ignore` | folder names never listed or searched | `[]` |
| `search_depth` | depth of the `f` search | `4` |
| `pi_command` | Pi's command, with its arguments | `["pi"]` |
| `continue_args`, `resume_args` | arguments of `c` and `r` | `--continue`, `--resume` |
| `tmux` | start Pi in tmux | `true` |
| `recent_count` | number of recent projects shown | `8` |
| `preview` | preview panel | `true` |
| `sandbox` | bubblewrap sandbox | `true` |
| `sandbox_read`, `sandbox_write` | more folders Pi may read, or write | `[]` |
| `checkpoints` | restore points before each prompt | `true` |
| `track_sessions` | each Pi tells Pier which conversation it holds (an extension Pier gives it) | `true` |
| `git_tools` | Pi gets git tools for the forge (push, pull requests), through the picker (see [Git](#part-xiii-git-pi-with-a-repository-as-a-developer)) | `true` |
| `worktrees` | in a git project, a Pi beside another works in a worktree of its own | `true` |
| `network_limit` | in the sandbox, Pi reaches only its model providers, npm, GitHub, PyPI and `network_allow` (see [Security](#chapter-v-security)) | `true` |
| `network_allow` | more places Pi may reach: `"host"`, `"host:port"`, `".domain"`, `"127.0.0.1:8080"` | `[]` |

Two environment variables exist too: `PI_BIN`, Pi's path when it is not on the PATH, and `PI_PICKER_SANDBOX=0`, which turns the sandbox off (the test suite uses it).

### Part VII. The API for Pier

The picker is also Pier's engine. It opens no port: Pier runs it over SSH with `--api` and reads its JSON answer. The API is versioned (version 21 today): Pier recognises a picker that is too old and updates it.

#### A. The commands

| Command | Purpose |
|---|---|
| `version`, `projects`, `ls` | state, recent projects and running Pis, folder contents |
| `paste-image`, `paste-file` | receive an image or a file and **type** it into Pi (`@path`) |
| `upload-dir` | receive a folder as a tar archive (a copy) |
| `type` | type text into Pi's input box, never pressing Enter |
| `contexts`, `remove`, `clear` | what was given to the projects, and taking it back |
| `share-prepare`, `share-stop`, `shares`, `--share-serve` | live shares (sshfs) |
| `handoff`, `--download` | Hand off and Take back |
| `activity`, `diff` | what Pi reads and changes, its diffs, its cost |
| `setup`, `write-text` | a project's instructions, what Pi reads at startup and what it loads |
| `resources`, `toggle-resource`, `skill-new`, `skill-read`, `skill-write`, `skill-delete`, `skill-import`, `gallery` | skills, extensions and prompts: listed with their state, turned on or off, local skills made, edited, put in the bin or imported; the gallery |
| `worktrees`, `worktree-remove` | the Pis' worktrees of a project, and removing one |
| `forges`, `forge-add`, `forge-remove`, `repo`, `repo-link`, `repo-unlink`, `repo-create`, `repo-settings`, `pr-merge`, `approvals`, `approval-answer` | git forges: accounts (the token on stdin), the project's repository, pull requests, merging, and Pi's requests waiting for the user |
| `team`, `collaborators`, `task-create`, `handoff-give`, `handoff-take` | the team: tasks for the Pis, everyone's pull requests, what waits for this account, giving and taking a conversation |
| `labs`, `labs-settings`, `lab-journal`, `lab-new`, `lab-edit`, `lab-network-describe`, `host-add`, `host-local`, `host-remove`, `host-test`, `lab-action`, `machine-add`, `machine-remove`, `machine-test` | labs: whether they can be made, their limits (JSON on stdin), what was run in them, a lab made by the user, a lab or machine renamed and described (the description on stdin), a lab reset or destroyed, the machines reached over SSH |
| `--lab-shell NAME` | a terminal in a lab or on a machine (Pier's Labs tab) |
| `--pi-package install\|remove user\|PROJECT SOURCE` | `pi install` or `pi remove` in a Pier terminal, in Pi's sandbox |
| `conversations`, `label`, `mark` | every conversation of every project; naming them, filing them, pinning and archiving |
| `checkpoints`, `checkpoint`, `checkpoint-diff`, `restore` | restore points: list, make one, what changed since, go back |
| `log` | the end of the picker's log |
| `stop DIR [SLOT]` | stop a project's Pis, or one of them |
| `watch` | stays open: Pier writes what it wants to follow, the picker answers with a JSON line at each change |
| `--attach DIR [ARGS]` | open a Pi of the project: the one used last (or a new one), `--new`, `--slot NAME` (a running Pi), `--continue` or `--session FILE` (its Pi if it runs, else a new Pi on it) |
| `--attach-control DIR [ARGS]` | the same in tmux's control mode, for Pier's Pi tabs |
| `--pi-update [ARGS]` | `pi update` in a Pier terminal (see Setup) |

#### B. The `watch` command

Before, each Pier tab asked for its state again every 2.5 to 15 seconds, each time with a new SSH command starting Python. Now one command stays open for the whole connection. Pier tells it what it follows (the projects, a conversation's activity, a project's setup, its restore points, the conversations, the contents of Context, the log), and it sends a part **only when it changed**. It looks at the size and time of the files concerned first: a Pi started by Pier starting, finishing or changing a file shows within a second, and nothing travels when nothing moves. What leaves no such trace is caught by a slower round: a Pi started without Pier's extension (within 5 seconds), a file changed on disk by a command rather than by Pi's tools (within 10 seconds). While a Pi works, its activity is rebuilt at most every 1.5 seconds. A tab is followed only while it is shown. Pi's conversation files, which keep growing, are read again only from where the last reading stopped, and a part whose inputs keep moving (a working Pi) is rebuilt at most every few seconds. If the connection drops, Pier opens it again by itself.

## Chapter IV. Pier

The picker used to be called **pi-dir-picker**. Its folders on the VM (`~/.config/pi-dir-picker`, `~/.local/state/pi-dir-picker`) move to the new name by themselves the first time a newer picker runs, and a link stays at the old place for the Pis started before. Its tmux server keeps the old name for as long as it runs (Pis started before stay found), and takes the new one when it next starts.

Pier used to be called **devbox** (the name was already taken by a well-known tool). Whatever holds data kept the old name, so that nothing is lost: the settings and logs folder (`app.devbox.client`), the interface's preferences, and on the VM the restore points and the history of the instructions (`.pi/devbox-history`).

A **Tauri** app: the logic is in Rust, the interface in plain HTML, CSS and JavaScript, without a framework. The terminal is **xterm.js**, built into the app. The executable is about 7 MB.

### Part I. Connecting

- **First start:** address, port, user, and an optional **bastion** (with its own port and user).
- **Password:** asked once, kept **in memory only** and never written to disk. It is used to reconnect by itself when the PC went to sleep. It is forgotten as soon as the address or the user changes.
- **Server fingerprint:** checked as `ssh` does. On first contact, Pier shows it for you to confirm, and only that key can be trusted. If it changes later, **the connection is refused before the password is sent**.
- **The connection settings** are changed from the login screen ("change connection"), not from the Settings.

### Part II. The picker, shipped with Pier

The exe contains the picker (`pier-picker.py`, built in at compile time). At each connection, Pier compares the VM's version with its own:

- **The picker is missing** (first connection): Pier offers to install it, where the picker command points (`~/bin/pi-pick` by default). The VM only needs Python 3.
- **It is older**: Pier updates it by itself, unless that setting is turned off in the Settings.
- **It is newer than Pier**: Pier says so, and still offers to install its own version.

The installation is careful: the new file is written next to the old one, Pier checks that it starts and announces the right version, and only then replaces the old one, which is kept as `pi-pick.previous`. The picker itself goes to `pi-pick.lib/pier_picker.py`, and `pi-pick` is a small launcher that imports it: Python then keeps it compiled, instead of compiling its 5000 lines at every call (about 60 to 100 ms saved on each call Pier makes). `pi-pick.previous` is always a whole picker, which runs by itself. A picker copied by hand to `~/bin/pi-pick` still works as before. Pier only installs when the picker command is a plain path (`~/bin/pi-pick`, `/opt/pi-pick`).

### Part III. The workspace

Three zones, **left, centre and right**. By default, to keep it simple, **the terminals in the centre and every panel on one side** (on the right; Settings > Layout > **Panels** puts them on the left):

- **Conversations**: every conversation, of every project, with their Pis;
- **Activity**: what the Pi in use does;
- **Context**: what it was given;
- **Setup**: the project's configuration.

The **Logs** tab is a diagnostics option (Settings > Diagnostics > **Logs tab**). An older layout takes this one once; **Reset layout** brings it back.

#### A. Going anywhere, arranging freely

After that, any tab can go to any zone:

- **The palette, Ctrl+Shift+K**, from anywhere, terminals included (or **search** in the top bar): type a few letters to go anywhere.
  - **tabs and panels:** an open tab, or a closed panel to open again;
  - **projects:** a new Pi, the last conversation, or its setup;
  - **conversations:** continue any of them;
  - **settings:** the Settings, a new shell, the panels left or right, the Logs tab, a theme.

  ↑ ↓ to choose, Enter to go, Esc to close.
- **The +** of a tab bar offers a shell, a picker, and every panel: to open again when closed, or to bring here.
- **Moving a tab:** drag it onto another zone (a marker shows where it lands), its right-click menu, or the Settings.
- **The width of the sides** is set by dragging the divider; it is kept for each side. A double click on the divider restores the usual width.
- **Tabs share the bar:** their names shorten ("…", the full name on hover) before the bar scrolls. The active tab keeps its whole name, and only it and the one under the pointer show ×. Everything else (rename, move, collapse, close) is in the right-click menu.
- **The sides collapse** with the ‹/› button or a tab's right-click menu (Collapse this side). A click on a tab only shows it; it never collapses the side.
- **On a collapsed side, a click on a tab unfolds it for a look.** It folds back once you are back on the terminals: as soon as the pointer is over them when the focus follows the mouse (Settings > Terminals), at your next click on them otherwise. **the pin button** (in place of ‹/› while it is unfolded), or Keep this side open in the tab's right-click menu, keeps it open instead. The layout saved stays collapsed until then.
- **Right-clicking a tab** offers:
  - **Rename** (the name is kept);
  - **Move** to the left, the centre or the right;
  - **Collapse this side**;
  - for a terminal, **New**, **Restart** and **Clear scrollback**;
  - **Close** and **Close the other tabs here**.

#### B. What stays put

- **The picker** is the main tab: it is pinned and never closes.
- **The chosen tab is always fully visible:** in a narrow side, the tab bar scrolls to it.
- **The layout is kept** from one connection to the next. "Reset layout" puts the tabs back in their default places without restarting the terminals.
- **At the top**, Pier shows the Pi in use (`session · ~/work #2 · working`). The panels follow its project automatically.

### Part IV. Terminals

They are real terminals on the VM, going through the SSH connection already open.

- **Pasting an image into the terminal where Pi runs:** Ctrl+Shift+V (Ctrl+V in Windows mode); the image goes to Pi, and the focus stays in the terminal. Elsewhere in the window, Ctrl+V is enough.
- **Shift+Enter, Ctrl+Enter and Alt+Enter** reach Pi without being mistaken for Enter.
- **Closing a terminal tab does not kill Pi,** which carries on in tmux.
- **Copy and paste as on Linux** (default): **Ctrl+Shift+C** copies, **Ctrl+Shift+V** pastes (text, or an image sent to Pi), Shift+Insert pastes too. **Ctrl+C** always interrupts the program and **Ctrl+V** goes to the program. Settings (Settings > Terminals):
  - the keys: Linux mode, or Windows mode (Ctrl+C copies when text is selected, Ctrl+V pastes);
  - copying: **select, then Ctrl+Shift+C** (default), or **copy as soon as text is selected**.

  A small note at the top right of the terminal confirms each copy ("copied 42 characters"). Pasted text never runs by itself.
- **Right-click** opens Pier's menu: Copy, Paste, Select all, Clear scrollback, Restart, New terminal. Also in Pi's tmux.
- **Ctrl+ and Ctrl-** make the terminals' text bigger or smaller, **Ctrl+0** goes back to the default size.
- **Pi tabs talk to tmux in "control mode"** (`tmux -C`), like iTerm2 on the Mac: tmux keeps Pi alive on the VM (it survives disconnections) but draws nothing; it passes Pi's output on as it is, and Pier's terminal shows it as if Pi ran on the PC. With Pi in regular mode, **the whole conversation is in Pier's history**: the wheel scrolls it on the PC, without a round trip to the VM, and the selection, Ctrl+Shift+C and the right-click menu are Pier's. On opening, Pier makes Pi redraw (two sizes in a row), which brings back the conversation already written. No tmux bar in these tabs, but **`Ctrl-b d` detaches** as in tmux (the tab closes, Pi carries on; `Ctrl-b` followed by another key reaches Pi as typed). Closing the tab detaches too. **When Pi ends** (`Ctrl+D`, `/exit`), its tab closes with it. **When the connection drops**, the tab stays and comes back by itself once Pier is reconnected.
- **When Pi copies by itself,** the text reaches the PC's clipboard only within 2 seconds of a key pressed or a click in that tab, once per key or click, and a note shows the start of what was copied: a program on the VM may **write** to the clipboard then, and never **read** it. The terminal's own automatic replies (cursor position, mouse reports) do not count as a key.
- **Links** shown by a program (OSC 8) are never opened, only copied, to paste in a browser after reading them.
- **A program that takes the mouse** (Pi in fullscreen mode, `htop`…) receives the clicks; **Shift+drag** still selects in Pier.
- **As responsive as plain ssh:** the connection turns off Nagle's algorithm, as OpenSSH does for interactive sessions (otherwise each key could wait up to 200 ms), and what the VM sends at once is handed to the terminal in one message, instead of one per SSH packet. While a divider is dragged, only the final size reaches the VM. With detailed logs, Pier notes the VM's response time to keys (`ui.term-latency`, median and 90th percentile).
- **Drawn by the graphics card** (WebGL): scrolling a long history stays smooth. Without WebGL, or when the graphics card loses its context, the terminal falls back to the classic renderer by itself. Setting in Settings > Terminals.

### Part V. The Context tab: everything given to Pi

You give something with **Ctrl+V**, **drag and drop**, the **Add files… / Add a folder…** buttons, or **Ctrl+Alt+V** from any application. Pier then does what is needed:

| What you give | What happens |
|---|---|
| **An image** | Copied to the project's `.pi-images/` and **typed into Pi** (`@.pi-images/…png`). Only your question is left to write. |
| **A file** | Copied to `.pi-files/` and typed into Pi. |
| **A folder** | Pier **asks**: <br>• **share live, read-only**; <br>• **share live, read and write**; <br>• **copy into the project** (a copy Pi can change without touching the original, up to 200 MB, without `.git` or `node_modules`). |

Files and folders copied in Windows Explorer (Ctrl+C) paste too.

The panel lists, **project by project**, everything that was given: images (with a preview), files, copies and shares. Each item has:
- **mention**, which types it into Pi again;
- an **×**, which takes it back. An image, a file or a copy is deleted from the VM; a share stops, and the original folder is never touched.

The list is read on the VM: it is there again after a reconnection. The `.pi-images`, `.pi-files` and `.pi-shared` folders each contain a `.gitignore` with `*`, so that nothing gets committed by accident, without touching the project's own `.gitignore`.

### Part VI. Live shares

The folder stays **on the PC**. The VM sees it **live** in the project's `.pi-shared/<name>`, and nothing is copied.

- **Read-only** by default. With writing allowed, Pi's changes are made **directly in the PC's files**: it is not a synchronisation, they are the same files.
- **How it works:** sshfs runs on the VM in "passive" mode, and Pier serves it the folder, through a small SFTP server going through the SSH connection. No port is open.
- **Pier's server serves only that folder:** it refuses to climb out with `..`, to follow a link leaving the folder (or one pointing nowhere), and tricky Windows paths (`C:x`, `a:b`, `..\`).
- **A share stops** when you click ×, on disconnecting, when Pier quits, and, by default, when the project's Pi ends.
- **After a disconnection,** shares come back **paused**, with a **resume** button. They can also resume by themselves, as set in the Settings. After a silent reconnection they start again by themselves.

### Part VII. Hand off and Take back: Pi carries on, PC off

Pi runs on the VM and does not need the PC, **except for live shares**.

#### A. Hand off

**Hand off** (button at the top) turns each live share into **a copy on the VM, exactly at the same place**. Pi thus keeps its files at the same paths, even in the middle of a task:
- a read-only share becomes a read-only copy;
- a read-and-write share becomes a copy Pi can change.

Then Pier disconnects, and the PC can be switched off.

#### B. Take back

**Take back**, on your return, from Context:
- **review changes** opens a tab that compares Pi's copy with your folder, file by file (by their SHA-256, on both sides): **changed**, **new** and **deleted** by Pi. A click on a file shows its difference (yours `-`, Pi's `+`). Check what to bring back, then **Bring back the checked files**: only those are written into your folder. Changed and new files come checked, files Pi deleted do not. Every file replaced or deleted is first moved to a folder next to yours, `mockups (before Pi's changes 2026-10-16 10-32)`: nothing is lost. Links in the copy are never brought back, nor names Windows would read otherwise (`C:x`, `a:b`, `NUL`…), and every file brought back gets the "came from the Internet" mark;
- **download** saves Pi's version in a **new folder** next to the original, `mockups (from Pi)`: nothing is overwritten. The download is capped (600 MB received, 2 GB unpacked), links and special files are skipped, and every file gets the "came from the Internet" mark, so Windows warns before opening or running it;
- **share live** shares the original folder live again, in place of the copy;
- **×** deletes the copy.

### Part VIII. The Activity tab: what the agent does

Everything is read from **Pi's session log**, which it writes as it goes (`~/.pi/agent/sessions/--<project path>--/*.jsonl`).

- **Activity:** the files **being read**, **read**, **being changed**, **changed**, **failed**, what changed on disk without going through Pi's tools (seen by git), and the recent history of actions.
- **The agent's state:** working, or idle.
- **The session's cost:** input, output and cached tokens, cost in dollars, model.
- **Files:** the tree with the same marks (◐ being read, ● read, ✎ being changed, ✓ changed, ! failed) and the git state.
- **Several Pis in the project:** a list at the top chooses whose work is followed (by default, the one used last).
- **A click** on a changed file opens its **diff** in a tab: the git diff, and the changes Pi made itself, even outside git. **A double click** mentions the file in Pi.
- **What is not possible:** knowing what Pi **will** read next. Pi decides as it goes.
- **Restore:** the restore points, see below.

### Part IX. Restore points: undoing what Pi did

#### A. Using them

The project is saved **when Pi starts**, **when each prompt arrives** (before Pi acts) and **when Pi stops working**. **Activity > Restore** lists these points: "Pi started", "before “add tests”", "Pi finished working".

- **A click on a point** shows what changed since: files changed (~), created (+), deleted (−).
- **diff** shows the difference of a file between that point and now; **put back** restores it as it was, **remove** deletes a file created since.
- **Go back to 14:32** puts the whole project back in that point's state: files created since are deleted, the others get their content back.
- **Going back can be undone too:** before each restore, the current state is itself saved ("before going back to 14:32").
- **Save a restore point now** makes one by hand, with a name if you like.
- Pier refuses to restore **while Pi is working**. Pi is not told: tell it what you undid.

#### B. How it works

- The points are kept **outside the project**, in a git repository of their own per project (`~/.local/state/pier-picker/checkpoints/`). **The project's git is never touched**, and Pi, in its sandbox, does not see that folder.
- git stores each version of a file once: a point costs only what changed. The latest 50 points are kept per project.
- That repository reads none of your git configuration: no hook, filter or fsmonitor runs.
- **Not saved:** what `.gitignore` leaves out (node_modules, build, `.env`…), what was given to Pi (`.pi-images`, `.pi-files`, the shares), files over 50 MB, and files that cannot be read (they are skipped, the rest is saved).
- A point identical to the previous one is not a duplicate: it replaces it and takes over its name. Each point in the list is thus a different state.
- The first question of a **new** session is a special case: Pi only writes its session with its first answer, when its tools start. That question is therefore attached to the "Pi started" point, which does hold the state from before.

### Part X. Logs: what happened, to understand a problem

#### A. The two logs

Pier and the picker each write a log, **one line per event**, in the same format and in UTC:

```
2026-10-12T14:32:01.123Z INFO  vm.paste-image req=7f3a-12 ms=41 sent=48213
2026-10-12T14:32:01.150Z INFO  api.paste-image pid=4242 req=7f3a-12 ms=22 saved=/home/leo/work/.pi-images/…
```

- **On the PC** (`%LOCALAPPDATA%\app.devbox.client\logs\pier.log`): connection and reconnections, every call to the VM (duration, error), terminals opened and closed, shares, Hand off, picker installation, interface errors and every error message shown.
- **On the VM** (`~/.local/state/pier-picker/picker.log`): every API command, Pi starting and stopping (with its exit status), restore points, crashes **with their traceback**.
- **A call carries the same `req=…` in both logs:** an action can be followed end to end.
- **Never in the logs:** passwords, what is typed in a terminal, what is typed into Pi (only its length), file contents.
- **Detailed logs** (Settings) adds the detail lines, on both sides: the reads repeated every few seconds, terminal sizes, the steps of the SSH connection.
- The logs rotate at 5 MB (PC) and 1 MB (VM), keeping 3 files.

#### B. The Logs tab

**The Logs tab** (shown with Settings > Diagnostics > **Logs tab**) shows both logs live, **newest at the top**, with a filter by level and by text. **Copy a report** puts a full report on the clipboard: versions, connection (never a password), settings, and the end of both logs. That is what to send when something goes wrong.

### Part XI. The Conversations tab: the one place for conversations

Every conversation of Pi on the VM, **grouped by project**. The project of the Pi in use comes first, marked ●, and stays open. Then the projects where a Pi runs, then the others, from the most recent to the oldest. Past the first three, a project is folded; **▾** unfolds it, and Pier remembers.

- **A project's header:**
  - how many Pis run there, how many conversations, its totals (today, 7 days);
  - **new**: one more Pi, in a new conversation;
  - **last**: continues the last conversation;
  - **setup**: opens its configuration in Setup.
- **The running Pis**, first: each with its conversation (Pi #1, Pi #2…, working or waiting for you), **open** (its terminal) and **stop**. A Pi just started, with no conversation yet, shows as "*New conversation*". **stop them all** when there are several.
- **Which Pi holds which conversation:** each Pi started by Pier says so itself, even when you switch conversations in Pi (`/new`, `/resume`, `/fork`), and even before its first answer. Pier starts it with a small extension (`--extension ~/.pi/pier/pier-session.ts`; nothing is added to Pi's settings). At each change, it writes its conversation and whether it is working to `~/.pi/pier/pis/<tmux session>.json`. It shows in the list of extensions when Pi starts. It adds no tool, reads no message and sends nothing over the network. To do without it: `track_sessions = false` in the picker's config; Pier then guesses as before.
- **Then the conversations:** pinned ones (★), then the most recent (5; **show all** for the rest). Each shows:
  - its date and its number of messages;
  - what it cost: in dollars when the model has a price in Pi, else in tokens (for the 300 most recent);
  - its category.
- **Actions:** **continue** starts a Pi on it. **⋯** gives it a **name** and a **category**, **pins** it or **archives** it: it leaves the lists, but can still be found by the search and with the **archived** box. Pier keeps these in `~/.local/state/pier-picker/labels.json`; Pi's files are not touched.
- **Recovery after an outage:** if the VM restarted while Pi was working, the project shows a **continue where it stopped** banner.
- **The search** covers every conversation of every project (name, question, category), archived ones included.

Pier reads Pi's sessions folder (`~/.pi/agent/sessions`). The view is only updated while it is shown, at most every 5 seconds while Pi works.

### Part XII. The Setup tab: a project's configuration, as in Claude Projects

For Pi, **a project is a folder**: each session started in it begins with the same context. This tab makes it visible and editable. It follows the project of the Pi in use (or the one chosen in its list, or opened with **setup** in Conversations). A line at the top sums the project up (Pi's version, packages, skills and how many are off, MCP servers, conversations, with **open them in Conversations**), then six pages, the one chosen being remembered:

- **Instructions:** `AGENTS.md` and, folded, what Pi reads at startup;
- **Skills:** skills, extensions and prompt templates, with a filter and **+ Add**;
- **Packages:** Pi, the packages, **Install a package…** and the gallery;
- **Git:** the project's repository, its pull requests, Pi's requests waiting for you (Part XIII);
- **Team:** tasks, reviews between Pis and conversations shared with colleagues (Part XIII, D);
- **Advanced:** MCP servers, the default model, and Pi's system prompt.

What each page holds:

- **Instructions (`AGENTS.md`)**, read at the start of each session. The editor offers:
  - a **token counter** (this text is read again at every session);
  - **add a section ▾**, ready-made blocks to fill in: project, commands, conventions, git, language, don'ts;
  - **let Pi write it**: Pi reads the project and writes its `AGENTS.md` itself;
  - **earlier versions**: the last 10 versions, to restore;
  - **Ctrl+S** to save.
- **What Pi reads at startup**: the exact, ordered list of what Pi loads:
  1. the global `AGENTS.md` of `~/.pi/agent`;
  2. those of the parent folders;
  3. the project's.

  The tab also says whether the project is **trusted** in Pi. Untrusted, the files of `.pi/` are ignored.
- **What Pi loads**: what Pi loads besides itself, yours (`~/.pi/agent`) and the project's (`.pi/`):
  - **Pi itself**, its version and the latest published one, with **update** when a newer one exists;
  - the **packages** of `settings.json` (`npm:…`, `git:…` or a path), with their version, or "not installed". An npm package behind gets **update**, and **update all packages** appears when there are several; **remove** runs `pi remove`;
  - the **skills**, **extensions** and **prompts**, yours and the project's, local or from a package, each with a **checkbox**: unchecked, Pi leaves it out at its next start (nothing is deleted). Pier writes it as `pi config` does, `-skills/name/SKILL.md` in the list of `settings.json` (or of the package's entry there);
  - the **MCP servers**, which Pi 1.x connects itself: `~/.pi/agent/mcp.json` (yours) and the project's `.pi/mcp.json` (read only once the project is trusted), with their type (stdio or http) and whether they are off;
  - the default model.

  The latest versions are asked of the npm registry from the VM, in the background, at most every 6 hours (`~/.local/state/pier-picker/versions.json`). **update** opens a "pi update" tab where `pi update` runs (or `pi update <package>`, `pi update --extensions`), visible from start to end. If Pi was installed for all users (`sudo npm install -g`, in `/usr` or `/usr/local`), it cannot update itself and gives the npm command that would: the tab shows it and offers to run it with `sudo` (sudo asks for your password in that terminal; only a command of that exact form, for Pi's own package, is accepted). Better: install Pi for your own account, in `~/.npm-global` (the picker finds it there first and the sandbox exposes it read-only): `pi update` then works without sudo. Pis already running keep their version until they restart. To add an MCP server on the VM: `pi mcp add …`.

  On the Skills page, one line each, under "Yours" and "This project"; a skill left out has its name dimmed. **+ Add** offers, each asking for you (every project) or this project only:
  - **New skill…**: a skill of your own, made from a template (`name` and `description` in its front matter), then opened to edit;
  - **Import a skill from this computer…**: a folder holding a `SKILL.md`, copied into the skills (under the name it declares);
  - **Install a package…**: as on the Packages page.

  A local skill has **⋯** (shown under the pointer): **Edit its SKILL.md…** (Ctrl+S saves) and **Put it in the bin**, a bin on the VM (`~/.local/state/pier-picker/trash`), where Pi does not look and from where it can be taken back.

  On the Packages page: **Install a package…**, a source (`npm:…`, `git:…`, `https://…`) installed by `pi install` (`-l` for the project) in a tab where it runs, visible; and the **gallery**, the packages tagged `pi-package` on npm (those of pi.dev/packages), searched from the VM as you type, with **install**.

  A package's extensions run code with your rights when Pi starts, and skills can tell Pi to do anything: look at a package before installing it. `pi install` and `pi remove` run in Pi's sandbox (when it is on), network limited as Pi's: npm's install scripts see `~/.pi` and the project only. A package from a site outside `network_allow` needs it added there first.
- **Advanced:** `.pi/APPEND_SYSTEM.md` is added to Pi's system prompt, and `.pi/SYSTEM.md` replaces it (with a warning).

### Part XIII. Git: Pi with a repository, as a developer

A project can be connected to a repository of **GitHub**, **GitLab** or **Gitea / Forgejo**, in **Setup > Git**. Pi then works as a developer of the team: it commits, branches and merges locally as it likes (that is plain git, in its sandbox), pushes its branches and opens pull requests by itself, and asks when something more is needed.

#### A. Connecting

- With nothing connected, the page only asks where the code lives: **GitHub…**, **GitLab…** or **Gitea / Forgejo…**. Each asks for the address and a token (**Add an account…** adds another later). GitHub: a fine-grained token limited to the repositories Pi works on, with *Contents* and *Pull requests* in read and write (*Administration* too, to let Pi create repositories). GitLab: a token with the `api` scope (a project access token limits it to one project). Gitea / Forgejo: a token with read and write on repositories. Pier checks it with the service before keeping it.
- **Connect a repository…** (`owner/name`) or **Create a repository…** (private by default). The project becomes a git repository if it is not one yet.
- The page then shows the repository, the branch checked out, the **open pull requests** with their checks (✓ passed, ✗ failed, … running), and for each one **copy link** and **merge ▾** (merge, squash and merge, rebase and merge; the repository's method first).
- Two settings, under the repository, saved as soon as they are chosen:

  | **Pi may** | |
  |---|---|
  | **Work locally** | Pi commits and branches in the project; nothing is pushed, no pull request |
  | **Push, ask to merge** (the default) | Pi pushes its `pi/…` branches and opens pull requests; a merge waits for your approval |
  | **Push and merge** | the same, and Pi merges its pull requests itself once their checks have passed |

  **Merges**: merge commit, squash or rebase, used for Pi's merges and offered first in **merge ▾**.

#### B. What Pi can do, and what waits for you

Pi gets git tools (from a small extension, `~/.pi/pier/pier-git.ts`, like the one that says which conversation it holds): `git_repo_info`, `git_push`, `git_pull`, `open_pull_request`, `list_pull_requests`, `pull_request_status`, `request_merge`, `create_repository`.

| Pi asks to | What happens |
|---|---|
| push a branch | not when the repository is set to **Work locally**; otherwise only branches named `pi/…` (the default branch only while the repository is still empty), never forced: a rewritten branch is refused by the forge |
| fetch | the forge's branches land in `origin/*` in the project; Pi merges or rebases itself |
| open, list, read pull requests | done at once (opening one: not with **Work locally**) |
| **merge** a pull request | with **Push, ask to merge**, **never by itself**: the request appears in **Setup > Git > Waiting for you**, with a Windows notification, and is done only when you click **approve**. So "merge it" said to Pi works, and an instruction hidden in a file cannot merge anything. With **Push and merge**, done at once if the pull request is open and its checks have not failed or are not still running |
| create a repository | always waits for your approval, whatever the setting |

You can also merge yourself from the list of pull requests, at any time.

#### C. Several Pis: one worktree each

Two Pis in the same folder would step on each other's files. In a git project, the first Pi works in the folder itself, and every other one in a **worktree** of its own, `.pi-worktrees/<its tmux session>`, on a branch `pi/agent-N-…`: each works on its branch, and they come together by merges or pull requests, as a team does.

- What is given to a Pi (`.pi-images`, `.pi-files`, `.pi-shared`) is reached from its worktree through links, so pasted images and files work as before.
- When its Pi ends (or is stopped) without having changed or committed anything, the worktree goes, with its branch. Otherwise it stays, listed in **Setup > Git > Pis' worktrees** (its branch, the files changed, the commits ahead), until you **remove** it; its branch stays either way.
- `.pi-worktrees` is left out of git (its own `.gitignore`, and the repository's `info/exclude`) and of the restore points.
- `worktrees = false` in the picker's config turns this off.
- Known: the worktree holds its own copy of the project's `AGENTS.md`, so a Pi there reads it twice (the worktree's and the folder's); and Activity shows its files under `.pi-worktrees/…`.

#### D. The team: several people, several Pis

Each colleague has their Pier, their VM and their Pis; **they meet in the repository**, as a team of developers does. **Setup > Team** shows, for the project's repository:

- **For you:** the pull requests whose review is asked of your account (**let a Pi review it**), and the conversations a colleague gave you (**take it over**).
- **Tasks:** issues labelled `pi-task`, free or taken by someone's Pi; **let a Pi do it** on a free one, **New task…** to add one (a Pi can also split a large piece of work into tasks).
- **Who works on what:** every open pull request, its author, its branch, its checks, and whose review it waits for.
- **When something waits for your Pis:** do nothing, **notify me** (the default: a notification, a Pi on your click), or **start a Pi by itself** while Pier is connected (one every two minutes at most).

Pi gets more git tools for this: `list_tasks`, `get_task`, `create_task`, `claim_task`, `release_task`, `pull_request_diff`, `review_pull_request`, `request_review`.

| Pi asks to | What happens |
|---|---|
| take a task | the issue gets the label `pi-doing` and is assigned to your account; a task already taken is refused, so two Pis never do the same one. The work goes on `pi/task-N`, then a pull request saying "Closes #N" |
| ask a colleague's Pis for a review | the colleague's account is asked as reviewer, with the label `pi-review`; their Pier tells them |
| post a review | with the repository set to **Push, ask to merge**, it waits for your approval in Setup > Git, like a merge; with **Push and merge**, posted at once. At most **3 reviews** by one account on one pull request: then a human decides |

**Giving a conversation:** in Conversations, ⋯ > **Give to a colleague…** sends the whole conversation (and its `pi/…` branch, pushed) on a branch `pi-handoff/<colleague>/…` that only they take. In their Team page, **take it over** adds it to their conversations and opens it in a Pi, with a word on the branch to switch to; the handoff branch is then deleted. The conversation holds everything said in it, including what was pasted: Pier says so before it leaves.

**Safety:** what colleagues and their Pis wrote (tasks, pull requests, reviews, notes) reaches your Pi marked as written by others, data to read and never orders. A Pi that Pier starts for the team gets its prompt from the picker, written from fixed words and a number, never from a colleague's text. Each Pi acts with its own account's token, never a colleague's.

#### E. Why the token is safe

The token stays on the VM, in `~/.config/pier-picker/forges.json` (readable by you only), which Pi's sandbox does not see. Pi's tools do not hold it: they ask the picker, through a socket given to the sandbox, and the picker checks each request against the rules above before doing it. To push, the picker first fetches Pi's commits, **in git's jail** (no network, the project read-only), into a bare repository of its own (`~/.local/state/pier-picker/git/`), then pushes from there: no hook, filter or setting of the project ever runs with the token. git receives the token in its environment, never on a command line, and it is never written to a log.

### Part XIV. Labs: machines where Pi may do anything

**An option, off until you turn it on** (Settings > Labs): Pi's sandbox stays exactly as it is, and Pi gets tools to use machines of its own besides, to run tests with services, build with Docker, install system packages, try things out.

**Turning it on sets nothing up.** Labs are made on **lab hosts**, and there is none until you add one:

```
Pi's VM: Pi in bubblewrap ── lab_* tools ──┬──> lab host A (Incus): lab-1, lab-2
                                           ├──> lab host B (Incus): lab-3
                                           ├──> Pi's VM (Incus), only if you chose it
                                           └──> machines (plain SSH, no Incus)
```

- **Lab hosts:** VMs where Incus runs and labs are made. **Add a lab host…** (Settings > Labs): another VM, which Pier reaches over SSH with its own key, running `incus` there. Or **Use Pi's VM as a lab host**, if you want the labs beside Pi. One host is the **default**; Pi (`lab_create`'s `host`) or New lab… may name another, and Pi reads each host's description in `lab_list`. **No lab host, no lab**: Pi is told so, and so are you.
- **Labs:** disposable [Incus](https://linuxcontainers.org/incus/) containers on a lab host (or full virtual machines when that host has `/dev/kvm`), made by Pi on its own, or by you (**New lab…** in the Labs tab), each with a name and a description of what it is for. Root inside, nothing of the VM or of home: only what Pi copies in. Each has CPU, memory and disk limits, a lifetime after which it goes (24 h by default), a **clean** snapshot to go back to, and the network open or cut.
- **Machines:** computers of yours (a server with a GPU, a test server) that Pi reaches over SSH. Pier makes a key of its own on the VM, which you put in the machine's `~/.ssh/authorized_keys`; Pi never sees it. Give each a description Pi reads in `lab_list`: what it is for, and what to leave alone there ("GPU with CUDA 12, never touch /data"). Each machine has its rule: **each command waits for your approval** (the default, shown with the other requests in Setup > Git and as a notification) or Pi runs commands freely.

Pi's tools: `lab_list` (its labs, the lab hosts with their networks, the machines), `lab_create` (a name, a description, the host, its networks), `lab_run` (a command, its output and exit code), `lab_push` (the project, or a part, into the lab: what was given to Pi stays out, links stay links), `lab_pull` (a file or folder back into `.pi-files/`), `lab_snapshot`, `lab_reset`, `lab_destroy`. They go through the picker's broker, like the git tools; Pi's sandbox has no network to the labs.

The **Labs tab** (the **+** of a tab bar) lists the labs and machines with their descriptions, opens a **terminal** in any of them, **edits** a name or a description (a lab is stopped for a moment to be renamed), resets or destroys a lab, and shows **what was done**: every command run by Pi, with its exit code and time.

**A lab host, made ready: once for each host.** On the host (Pi's VM included, if you use it):

```bash
sudo apt install incus
sudo incus admin init --minimal
sudo adduser $USER incus
```

then put Pier's key in that user's `~/.ssh/authorized_keys` (copied when you add the host; Pi's VM needs none), reconnect Pier if it is Pi's VM (the group counts from the next login), and **test** the host in Settings > Labs: it says "ready". That restricted project refuses snapshots and nested containers by default: labs still work, a **reset** then rebuilds the lab from its image, and Docker needs a VM lab. To have instant resets and Docker in containers, once (after the first lab, which makes the project):

```bash
sudo incus project set user-$(id -u) restricted.snapshots=allow restricted.containers.nesting=allow
```

The `incus` group gives each user a restricted Incus project of their own: labs cannot reach the VM's files nor be privileged.

**Virtual machines too (optional, once):** labs are containers by default (a full Debian with systemd, its own IP, SSH, services, Docker, firewall rules inside; only the kernel is the VM's). For real virtual machines, the VM must see the processor's virtualisation. Check in the VM: `grep -cE 'vmx|svm' /proc/cpuinfo` must give more than 0, and `/dev/kvm` must exist. If not, under Proxmox:

1. on the Proxmox host, nested virtualisation on: `cat /sys/module/kvm_intel/parameters/nested` (or `kvm_amd`) says `Y` or `1`; otherwise `options kvm-intel nested=Y` (or `options kvm-amd nested=1`) in `/etc/modprobe.d/`, then restart the host;
2. the VM's CPU type set to **host** (Hardware > Processors);
3. the VM stopped then started from Proxmox (a reboot from inside the VM is not enough).

#### Labs on a VLAN of their own (pfSense or another firewall)

By default (**Network: open**), the labs are behind Incus's NAT inside their lab host: the firewall sees only the host. With **Network: your VLAN**, each lab is a machine of its own on a VLAN of the firewall: it gets its address from the firewall's DHCP, and the firewall's rules apply to it.

> **Once, and once only.** These steps are made a single time. Afterwards every lab made with Network: your VLAN lands on it by itself, with nothing more to do.

1. **The firewall (pfSense):** *Interfaces > Assignments > VLANs*, a VLAN (say **30**) on the interface towards Proxmox; assign it as a new interface (**LABS**, say `10.30.0.1/24`) with **DHCP** on. Rules on LABS: the internet and the firewall's DNS allowed, **your LAN and the lab host blocked**, then what you want, lab by lab.
2. **Proxmox:** `vmbr0` marked **VLAN aware** (System > Network), the link to the firewall carrying VLAN 30. On the lab host's VM, *Hardware > Add > Network Device*: bridge `vmbr0`, **VLAN Tag 30**, Proxmox's firewall unticked on that card (its MAC filter would stop the labs).
3. **The lab host:** find the new card, the one without an address (often `ens19`), then make the labs' Incus network on it and let your Incus project use it:

   ```bash
   ip -br link
   ```

   ```bash
   sudo incus network create pier-labs --type=macvlan parent=ens19
   ```

   ```bash
   incus network list
   ```

   ```bash
   sudo incus project set user-$(id -u) restricted.networks.access=incusbr-$(id -u),pier-labs
   ```

   (`incus network list` gives your own network's name, often `incusbr-1000`: keep it in that list, or the labs on Incus's NAT stop working.)
4. **Pier:** Settings > Labs > Network: **your VLAN**. The page says whether the network `pier-labs` is there and allowed, and shows these commands otherwise. In the Labs tab, each lab then shows `VLAN` and the address the firewall gave it.

The lab host itself has no address on that VLAN, and needs none: the labs talk to the firewall, never to the host through it (a limit of macvlan, here a wall more).

#### Networks: what each lab is plugged into

A lab can be plugged into **any network Incus lets your account use**, and into **several at once**. You choose in **New lab…** (the networks are ticked there, the default ones already ticked), and Pi chooses with `lab_create`'s `networks`. **Settings > Labs > Networks** lists them, with what each is for.

**The three kinds of network**

| Kind | What it is | What the lab can reach | Seen by your firewall |
|---|---|---|---|
| **The internet through the host (NAT)** | Incus's own bridge (`incusbr-1000`), there from the start | the internet, through the lab host; not your LAN's machines from outside | no: only the host is |
| **A VLAN of your firewall** | a macvlan network on a card of the lab host, tagged with a VLAN of pfSense | what pfSense allows on that VLAN | yes: the lab is a machine of its own, with its address from pfSense's DHCP and its rules |
| **Between labs only** | an Incus bridge without NAT | the other labs on it, nothing else | no, and nothing goes out |

**One interface per network.** A lab on two networks gets `eth0` on the first ticked and `eth1` on the second, each with its address (Pier configures DHCP on the extra interfaces). The Labs tab shows each interface with its network and address. With nothing ticked, the lab has no network at all.

**What it is for, with examples**

- *Run the project's tests with a database:* one lab on the NAT (default), Postgres inside.
- *Test what your firewall lets through:* a lab on the VLAN, then look at its traffic in pfSense.
- *Test a router or a firewall between two networks:* three labs. `client` on `lab-lan`, `server` on `lab-dmz`, and `router` on both `lab-lan` and `lab-dmz` (plus the NAT if it should reach the internet). Then check with `lab_run` that `client` reaches `server` only through what `router` allows.
- *A VPN between two labs, a DNS server, a mail relay:* labs on a network between labs only, so nothing they do leaks out.

**Describe the networks.** In Settings > Labs > Networks, **describe** says what a network is for ("the DMZ of the firewall tests"). The description shows there and in New lab…, and Pi reads it in `lab_list` to choose a lab's networks.

**The network of a new lab, by default** (Settings > Labs): the NAT (the default), your VLAN (Part above), or none. It is what a lab gets when nobody chooses: Pi without `networks`, or New lab… left as it is.

**Adding a network: an admin, once for each.**

> **Once for each network.** A network made and allowed stays: every lab can then be plugged into it, with nothing more to do.

On the lab host (each host has its own networks). **A VLAN of the firewall, several on one card:** in Proxmox, give the host's second card **no VLAN Tag** (it then carries every VLAN, a "trunk"; its *trunks* option can limit them), and make one Incus network per VLAN on it:

```bash
sudo incus network create pier-labs-30 --type=macvlan parent=ens19 vlan=30
```

```bash
sudo incus network create pier-labs-40 --type=macvlan parent=ens19 vlan=40
```

(each VLAN made in pfSense too, with its DHCP and rules). **A network between labs only:** no card, nothing in pfSense:

```bash
sudo incus network create lab-lan --type=bridge ipv4.address=10.50.0.1/24 ipv4.nat=false
```

```bash
sudo incus network create lab-dmz --type=bridge ipv4.address=10.60.0.1/24 ipv4.nat=false
```

**Then let your account use them**, listing every network it should see, your own NAT included (`incus network list` gives its name, often `incusbr-1000`; left out, labs on the NAT stop working):

```bash
sudo incus project set user-$(id -u) restricted.networks.access=incusbr-$(id -u),pier-labs-30,pier-labs-40,lab-lan,lab-dmz
```

Settings > Labs > Networks shows them as soon as they are allowed, and the same commands in **Add a network**.

### Part XV. Notifications and shortcut

- **A Windows notification** when a Pi goes from "working" to "idle", for every Pi started. Nothing shows when Pier is already in front.
- **Ctrl+Alt+V,** from any application: sends the clipboard's image or files to Pi. When another program already uses it, the Settings say so.
- **One Pier at a time:** starting it again brings the running one forward (even minimised to the notification area) instead of opening a second one.
- **Closing the window** leaves Pier in the notification area. To quit it: right-click the icon, then Quit.

### Part XVI. Settings (once connected)

The categories in a column on the left, the page on the right; the window opens again on the last page shown.

- **Layout:** which side the panels go to (Panels), where each tab lives, and Reset layout.
- **Appearance:** theme, and for the terminals: font size, font (any monospaced font installed on this computer; the list offers the usual ones found here, and a font missing falls back to Cascadia Mono, with a note), and the space around their text (0 to 40 px, 8 by default; the scrollbar stays against the edge). **Pier's font** (panels, menus, settings): the terminals' by default, another console font, the system's sans, or one typed by name; paths, branches, logs and diffs stay in the terminals' font. Built-in themes, 24: Pier dark/light (or "follow the system"), Ayu dark/light, Catppuccin Latte/Mocha, Dracula, Everforest Dark, GitHub dark/light, Gruvbox dark/light, Kanagawa, Monokai, Night Owl, Nord, One Dark/Light, Rosé Pine (and Dawn), Solarized dark/light, Tokyo Night, Tomorrow Night. The theme colours the whole interface **and** the terminal (the 16 ANSI colours included).
  - **Import a VS Code or Zed theme…:** takes the `.json` of a VS Code theme (the extension's `themes/` folder, comments accepted) or a Zed theme (zed.dev/themes, `~/.config/zed/themes`; a Zed file can hold several themes, all are added). Missing colours are derived from the others.
  - **Customize…:** changes each colour with a live preview, then saves it under a name. Starting from a built-in or imported theme makes a copy; one of your themes is changed in place. "delete this theme" deletes one of your themes.
- **Terminals:** the copy and paste keys, copying on selection or with Ctrl+Shift+C, focus following the mouse, drawing by the graphics card.
- **Behavior:**
  - Ctrl+Alt+V;
  - stopping shares when the project's Pi ends;
  - notifications;
  - also deleting, when a Pi ends, what was given to it;
  - resuming shares after a reconnection.
- **Picker:** its version and Pier's, automatic updates (on by default), and a button to install it again.
- **Diagnostics:** the **Logs** tab (shown or not), detailed logs, where the logs are, **Copy a report**, **Save a report…**, and opening the logs folder.
- **Labs:** turning labs on, the **lab hosts** (add one, use Pi's VM, test, make default; how to make one ready), the limits (labs at a time, lifetime, CPUs, memory, disk, default image), the network of a new lab by default (Incus's NAT, your VLAN with its one-time setup, or none), the **networks** labs can be plugged into (what each is for, and how to add one), and the machines with Pier's key.
- **Updates:** Pier's version; whether a new one is out, with its notes and **Install and restart**; **Check now**; looking by itself at startup, then every 6 hours (on by default). When a new Pier is out, "update to 0.3.0" also shows in the top bar. An update comes from this repository's GitHub releases and is installed only if signed with the project's key; shares are stopped before Pier restarts. How to publish one: [RELEASING.md](RELEASING.md).
- **Connection:** where Pier connects (changed from the login screen).

## Chapter V. Security

### Part I. What is in place

| Topic | What is in place |
|---|---|
| **Password** | Kept in memory only, never written to disk, forgotten when the address or user changes. It can never end up in a URL: the forms cannot be submitted to an address. |
| **Server identity** | The fingerprint is checked at each connection; a fingerprint that changes blocks the connection **before** the password is sent. "Trust" only accepts the key Pier has just seen. The bastion is checked the same way. |
| **Network** | No port open on the VM. Everything goes through SSH, inside WireGuard. See [Network and encryption](#part-ii-network-and-encryption). |
| **Pi's sandbox** | With bubblewrap, Pi sees the system **read-only**. Of your home it sees only the **project**, `~/.pi`, the folders Pi and Node run from (exactly those: `~/.local/bin`, not all of `~/.local`) and `~/.gitconfig`. The rest (other projects, `~/.ssh`…) is invisible. It has a `/dev` of its own (no access to your other terminals), `/run` is hidden (no session bus, no systemd, no system sockets: only the folder `/etc/resolv.conf` points to comes back, read-only), it cannot type into its terminal (a seccomp filter refuses `TIOCSTI` and `TIOCLINUX`), and its processes are isolated. If bubblewrap is missing, **Pi refuses to start** instead of running unprotected. |
| **Pi and git** | Pi pushes only `pi/…` branches, never forced, and opens pull requests; merging waits for the user's approval in Pier unless the user lets it merge once the checks pass (or keeps it local), and creating a repository always does. With colleagues, Pis take tasks, ask each other for reviews (at most 3 per pull request and account) and read what others wrote as data, never as orders. The forge's token never enters the sandbox: the picker holds it and pushes from a mirror of its own, after fetching Pi's commits in git's jail. |
| **Pi's network** | With `network_limit` (on by default), Pi has no network of its own: it reaches only its model providers, npm, GitHub, PyPI and what `network_allow` adds, through a proxy the picker runs outside the sandbox. Everything refused is logged (`net.blocked`). Needs Node 24 or newer. |
| **Folders Pi may not run in** | Your home itself, `~/.ssh`, `~/.gnupg`, `~/.config`, `~/.local`, `~/bin` (where the picker is), `~/.pi`: refused before anything starts, and not offered as projects. A trick link in a project cannot hand Pi your whole home. |
| **Hindsight key** | Read by the picker and passed to Pi in its environment, never on the command line, where other users of the VM could read it. The picker warns when the key file is readable by others. `~/.pi` is Pi's to write: a link put in place of the key is not followed (only a plain file is read). |
| **Shared folders** | Confined to the folder chosen: no `..`, no link leaving it, no tricky Windows path; what cannot be checked is refused. Read-only by default, and a confirmation for writing. |
| **Archives received** (folder copies) | Extracted with Python's safety filter: no path leaving, no dangerous link, no special file. Size and number of files capped. |
| **git on a project** | Run in a sandbox of its own: a project's `.git/config` is Pi's to write, and a filter declared there could otherwise run as you. In there, git only reads the repository, without network. No fsmonitor, no external diff program, no `textconv`. That sandbox shows the project only; the `.git` file of a worktree or a submodule (Pi's to write too) can add only a real git folder inside another repository's `.git`. |
| **Picker writes in folders Pi controls** | Through a temporary file with an unpredictable name, in a folder reached through file descriptors from the project down, without following links: a folder replaced by a link to elsewhere, even meanwhile, is refused. A folder copy or a Hand off is unpacked in the picker's own folder, out of Pi's reach, then moved in. What the picker reads there (conversations, what a Pi says, git's files, a README) must be a plain file, never a FIFO or a device, and a conversation file must stay in Pi's sessions folder. A file removed by a restore, and whatever Context takes back (×, Clear), is removed walking down from home without following links: a folder swapped for a link meanwhile stops it. Setup does not read an `AGENTS.md` or `SYSTEM.md` that leads out of the project, and never copies one into its history. What a Pi says (its conversation) is accepted only if it is one of Pi's conversation files. |
| **What the interface may ask of the VM** | Only a closed list of commands. Pi's arguments are filtered: only `--new`, `--continue`, `--session` with a session file and `--slot` with a tmux session name are accepted. |
| **Commands sent to the VM** | Each argument is quoted for the shell, and the whole line travels in base64 and is run by `/bin/sh`, whatever the login shell (fish reads quotes differently). All paths are checked to stay in home. What is typed into Pi, and the files of a restore, go on the command's input instead: on its command line, any user of the VM could read them (`ps`), and a line holds 128 KB at most. |
| **What the VM sends the PC** | A program on the VM can fill the clipboard (OSC 52) only right after a real key or click in its tab, once per key or click, and the note shows what. Links are never opened. An answer is limited to 64 MB, and a tmux line to 8 MB. Pi cannot fake Pier's own messages in its output. |
| **The interface itself** | No remote content: the page only loads its own files (strict CSP), and can only reach Pier's commands, the file chooser and notifications. |
| **Logs** | Never a password, nor what is typed in a terminal or into Pi. |

#### A. Things to know

- **The executable is not signed:** Windows shows a warning on first start.
- **The sandbox hides `~/.ssh`,** so Pi cannot `git push` over SSH, unless you add `sandbox_read = ["~/.ssh"]`. Pi could then read the keys.
- **`~/.pi` is shared by every project** and writable by Pi. A Pi manipulated in one project could add a package, an extension or an MCP server that the Pis of other projects will load, and `pi update` installs those packages outside the sandbox. Setup shows the list of packages: look at it before updating.

### Part II. Network and encryption

**No TLS in Pier, on purpose.** Pier only talks to the VM over **SSH**: no web server, no HTTP API, no certificate to manage. SSH encrypts and authenticates everything itself: terminals, commands, `watch`, files sent, shares (sshfs goes through the same connection). The only TLS in the system is **Pi's, to its model provider** (HTTPS, handled by Pi on the VM).

#### A. The layers, from the outside in

1. **WireGuard** (ChaCha20-Poly1305, Curve25519): the VM can only be reached through the tunnel.
2. **SSH**, inside the tunnel, with what Pier accepts to negotiate:

   | | Accepted | Refused (even when the server offers it) |
   |---|---|---|
   | Key exchange | **`mlkem768x25519-sha256`** first (post-quantum hybrid, OpenSSH 9.9+'s: Debian 13 offers it), then `curve25519-sha256`, then 4096/8192-bit DH | SHA-1 DH, small DH groups, NIST curves |
   | Server key | Ed25519, RSA with SHA-2, ECDSA P-256/P-384 | **RSA with SHA-1** (`ssh-rsa`) |
   | Encryption | ChaCha20-Poly1305, AES-256-GCM, AES-128-GCM | AES-CTR, AES-CBC, 3DES |
   | Integrity | built into the encryption, or HMAC-SHA2 "encrypt-then-MAC" | HMAC-SHA1, non-ETM MACs |
   | Compression | none | |

   Protection against the **Terrapin** attack ("strict kex") is on. A server offering nothing of this list is refused **before** the password is sent (checked by a test).
3. **The server's fingerprint**, pinned on first contact: a fake server on the way never gets the password.
4. **With a bastion:** the connection to the VM is encrypted **end to end through it**. The bastion passes encrypted bytes: it sees neither the VM's password nor what is exchanged. Its fingerprint is checked the same way.

#### B. What could be set up on the VM

None of it needs an SSH key.

1. **Accept SSH only through WireGuard,** with the firewall rather than `ListenAddress`: if the tunnel does not come up at boot, sshd is not left without an address, and the hypervisor console stays available. With nftables (adapt `wg0`):

   ```
   # /etc/nftables.conf (excerpt): SSH (port 2222) only from the tunnel
   table inet filter {
     chain input {
       type filter hook input priority 0; policy drop;
       ct state established,related accept
       iif "lo" accept
       udp dport 51820 accept                 # WireGuard itself
       iifname "wg0" tcp dport 2222 accept   # SSH, through the tunnel only
       icmp type echo-request accept
       icmpv6 type { echo-request, nd-neighbor-solicit, nd-router-advert, nd-neighbor-advert } accept
     }
   }
   ```

   Then `sudo systemctl enable --now nftables`. **Test it with the VM's console open**, to be able to go back.

2. **Harden sshd** with a file of its own, which leaves Debian's configuration alone:

   ```
   # /etc/ssh/sshd_config.d/50-pier.conf
   PermitRootLogin no
   AllowUsers leo
   MaxAuthTries 3
   LoginGraceTime 20
   MaxStartups 5:50:20
   # Pier opens one channel per terminal, call or share: 10 (the default) is not always enough.
   MaxSessions 30
   # What Pier uses, nothing more: no port forwarding, no X11.
   DisableForwarding yes
   PermitTunnel no
   # The same algorithms as Pier.
   KexAlgorithms mlkem768x25519-sha256,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org
   Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
   MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
   HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256
   ```

   Check with `sudo sshd -t`, then `sudo systemctl reload ssh`. `DisableForwarding` does not bother Pier: shares go through a command, not a forwarding. **On a bastion, however, leave it out**: its forwarding is precisely what leads to the VM.

3. **fail2ban** (`sudo apt install fail2ban`, SSH protection is on by default): bans an address after a few wrong passwords. Useful mostly if SSH stays open outside the tunnel; behind WireGuard alone, only your devices can try.

4. **A pre-shared key (`PresharedKey`) in WireGuard,** for each device (`wg genpsk`, the same value on both ends). It adds symmetric encryption to the tunnel: traffic recorded today would stay unreadable even if Curve25519 one day fell to a quantum computer.

5. **A second factor (TOTP code)** for SSH, with `libpam-google-authenticator`. **Pier does not handle it yet:** today it answers the password to every hidden question of the server. It would need to ask for the code separately (a small possible change).

6. **Where Pi can send data** is limited by the picker itself, without root (`network_limit`, on by default): Pi's sandbox has no network of its own, and a relay inside passes its connections to a proxy outside, which lets through only the places allowed (its model providers, npm, GitHub, PyPI, and `network_allow`). An instruction hidden in a file Pi reads can no longer make it send code anywhere else. What is refused is written to the picker's log (`net.blocked host=…`, in the Logs tab): add the host to `network_allow` if Pi needs it (a gateway such as Bifrost, Hindsight's server). Pi, npm, git and curl follow the proxy; Node needs version 24 or newer for that, and with an older Node the network stays open (the picker says so when Pi starts). A firewall rule would also cover a program that ignores the proxy, but needs root.

#### C. On the PC

- **The password** stays in memory while Pier runs (to reconnect by itself). It could be wiped from memory as soon as it is no longer needed, at the price of asking for it again at each outage.
- **`known_hosts.json`** (the accepted fingerprints) is in your Windows profile, readable by you only. A malicious program on the PC could change it, but it could also read what you type: that is beyond Pier's reach.
- **To distribute Pier to others:** sign the executable (Authenticode) and publish its SHA-256, so they know it is the right one. The picker needs no signature of its own: it is inside the exe, and travels over the verified SSH connection.

### Part III. Audit of 14 October 2026

#### A. What was fixed

A full review (security on the PC, security on the VM, stability, performance) was made; what it confirmed was fixed (picker 4.11 and later):

- **git no longer runs anything outside the sandbox** (a filter in a project's `.git/config`, which Pi can write, used to run when Pier asked for `git status` or a diff).
- **Pi's sandbox** no longer exposes all of `~/.local`, has its own `/dev`, hides `/run/user`, and refuses the folders listed above.
- **The picker's writes** in folders Pi controls are safe from links; what a Pi says is checked.
- **The sudo update** only accepts the exact npm command Pi suggests.
- **On the PC:** commands in base64 for any login shell; the clipboard and links protected; take-back capped and marked; memory caps; trust bound to the key seen; the password forgotten on a change of address; live shares failing closed; Pi unable to fake Pier's messages.
- **Stability:** silent reconnection for up to 15 minutes after the PC sleeps, Pi tabs reattaching and shares restarting; a dead connection no longer freezes the app; a big paste no longer blocks the other terminals; unsaved Setup text can no longer go to another project; the watch no longer restarts in a loop; dead sshfs mounts are seen and unmounted; an unreadable file no longer stops restore points, and a restore no longer loses its point.
- **Performance:** `git status` at most every 3 seconds per project, parts rebuilt at most every few seconds while Pi works, npm versions asked in the background, Pi's tool calls kept compact, tmux control mode decoded in linear time, resizing sent once the drag ends, the Logs tab no longer redrawn at each line.

#### B. Still known

- **`~/.pi` shared by every project** (see above).
- **One-off calls to the VM** (opening a folder, a diff) start Python each time, now kept compiled (about 60 to 100 ms less each). They could go through the watch.
- **The order of very fast keystrokes** is guaranteed only by the order of the calls. A sequence number would make it certain.

### Part IV. Audit of 15 October 2026

A second full review (security, CPU, memory, smoothness). Fixed in pier-picker 4.15 to 4.20, and checked by the test suite on the VM:

- **Links planted by Pi:** in `~/.pi` and in the project, everything the picker reads or writes outside the sandbox (the Hindsight key, `AGENTS.md`, conversations, what each Pi says, copies, the × and Clear of Context) goes through file descriptors, without following links; FIFOs and devices are never read. Folder copies and Hand offs are unpacked out of Pi's reach, then moved in.
- **The sandbox:** `/run` hidden (system sockets), a seccomp filter refusing `TIOCSTI` and `TIOCLINUX` (Pi cannot type into its terminal), git's jail limited to the project, and the network limited to an allowlist (`network_limit`).
- **The clipboard (OSC 52):** a program on the VM fills it only right after a real key or click, once per key or click; the terminal's automatic replies no longer count as a key.
- **The command line:** what is typed into Pi, and the files of a restore, go on the command's input, not where other users of the VM could read them.
- **Smoothness:** the Logs tab, dragging a divider, the Setup list and the searches no longer redraw everything; the watch rebuilds less when nothing moves; the picker is kept compiled.
- **Found by the suite on the VM:** the link protections were silently off under Linux (a Python detail), and tmux never recorded which conversation each Pi held when two ran in one project. Both fixed.

## Chapter VI. Installation

### Part I. On the VM

```bash
sudo apt install tmux bubblewrap sshfs git
```

**Pier installs the picker itself** at the first connection, then keeps it up to date. To use it over SSH without Pier before that, copy it by hand (the VM uses port 2222 and the name `pi-sh` defined in `~/.ssh/config`):

```powershell
scp C:\Users\leo\Downloads\pier\pier-picker.py pi-sh:bin/pi-pick
```

Python 3.12 or newer is needed, for receiving folders; Debian 13 has Python 3.13. git is used for restore points.

**Install Pi for your own account** rather than with `sudo`, so that `pi update` works without sudo:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
grep -q npm-global ~/.profile || echo 'PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### Part II. On the PC: `~/.ssh/config`

```
Host pi pi-sh
    HostName 192.168.1.20
    Port 2222
    User leo
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host pi
    RequestTTY force
    RemoteCommand /home/leo/bin/pi-pick
```

`ssh pi` opens the picker, and `ssh pi-sh` a normal shell (for scp, rsync…). With a bastion, add `ProxyJump bastion` under `Host pi pi-sh`.

### Part III. Pier

**The simplest:** download the installer from the [latest release](https://github.com/superbagel9079/pier/releases/latest) (Windows `Pier_…_x64-setup.exe`, macOS `.dmg`, Linux `.AppImage` or `.deb`) and install it. Pier then updates itself (Settings > Updates): no clone, no build. Without a code-signing certificate, Windows SmartScreen warns once, at that first installation ("More info", then "Run anyway").

**Or build it:**

The compiled executable is `client/src-tauri/target/release/pier.exe`. Nothing to install: WebView2 is already there on Windows 10 and 11.

To build it (Rust and Visual Studio Build Tools, installed with Chocolatey):

```powershell
cd C:\Users\leo\Downloads\pier\client\src-tauri
cargo tauri build --no-bundle
```

Quit Pier before building again (also from the notification area): Windows does not allow replacing a running program.

**GitHub Actions** (`.github/workflows/build.yml`) runs the tests and builds Pier for Windows (installer and exe), macOS (universal `.dmg`) and Linux (`.deb`, AppImage) at every push, kept as the run's artifacts with their SHA-256. A tag `v…` (`git tag v0.3.0`, `git push --tags`) also prepares a draft GitHub release with them. Signing is optional: with the secrets listed at the top of the workflow (an Authenticode certificate for Windows, a Developer ID for macOS, notarized), the files are signed; without them they are not, and Windows and macOS warn on first start. The macOS and Linux versions are built there only, not yet tried by hand.

## Chapter VII. Day to day

### Part I. Without Pier, over SSH

1. `ssh pi` opens the picker.
2. Select a project, then `p`: Pi starts in it.
3. `Ctrl-b d` goes back to the picker, and Pi carries on. `q` quits.

### Part II. With Pier

1. Start Pier, then type your password.
2. The picker opens in the centre: `p` on a project (or **new** / **last** in Conversations, or Ctrl+Shift+K and a few letters).
3. A screenshot (Win+Shift+S), then Ctrl+V in Pier: the image is in Pi, you write your question.
4. A folder from the PC to show? Drop it onto Pier, then "Share live, read-only".
5. Follow the work in **Activity**; click a changed file to see the diff.
6. In the evening, if the task is long: **hand off**, then switch the PC off.
7. The next day: connect again. The result is in **Activity**, and **Take back** is in **Context**.

### Part III. Starting a new project

The **Setup** tab, then **let Pi write it** for a first `AGENTS.md`. Adjust it afterwards; every following session benefits.

## Chapter VIII. Outages and recovery

### Part I. What happens, and what to do

| What stops | Consequence | What to do |
|---|---|---|
| **The PC** (sleep, battery, Wi-Fi) | Pi carries on on the VM. Live shares drop. | Nothing: Pier reconnects by itself (for up to 15 minutes), its Pi tabs reattach and the shares restart. After longer, log in again: `p` or the `pi · project` tab puts you back in the conversation. |
| **The VM** (power, reboot) | Pi and tmux stop. **The conversation is saved**, Pi writes it as it goes. What was in progress is lost: the answer being written, a command running. | Conversations shows **continue where it stopped** on the project, or `c` in the picker (`--continue`). |
| **The connection** during a long task | As for the PC. | Nothing: Pier reconnects by itself while it has the password in memory. |

Tip: work in a git repository and let Pi commit regularly. After an outage, you go back to the last clean state.

## Chapter IX. Files and locations

### Part I. On the VM

| Path | Contents |
|---|---|
| `~/bin/pi-pick` | the picker's launcher (installed by Pier), or the picker itself (copied by hand) |
| `~/bin/pi-pick.lib/` | the picker, as Pier installs it, and its compiled form (`__pycache__`) |
| `~/.local/state/pier-picker/incoming/` | where a folder copy or a Hand off is unpacked, out of Pi's reach, before it is moved into the project |
| `~/.config/pier-picker/config.toml` | its configuration (optional) |
| `~/.local/state/pier-picker/state.json` | recent projects, sorting (readable by you only) |
| `~/.local/state/pier-picker/picker.log` | the picker's log (`.1`, `.2`: the previous ones) |
| `~/.local/state/pier-picker/checkpoints/` | the restore points, one git repository per project |
| `~/.local/state/pier-picker/labels.json` | names, categories, pinned and archived conversations (Pier) |
| `~/.local/state/pier-picker/versions.json` | latest versions of Pi and the packages, asked of npm at most every 6 hours |
| `~/.local/state/pier-picker/tmux.conf` | the configuration of the Pis' tmux server (rewritten by the picker) |
| `~/.pi/pier/pier-session.ts` | the extension Pier gives each Pi it starts (`--extension`) |
| `~/.pi/pier/pis/<tmux session>.json` | what each Pi says: its conversation, whether it works (deleted when it stops) |
| `~/bin/pi-pick.previous` | the picker's version from before Pier's last update |
| `<project>/.pi-images/`, `.pi-files/` | images, files and copies sent (ignored by git) |
| `<project>/.pi-shared/` | live shares and copies from a Hand off |
| `<project>/.pi/devbox-history/` | earlier versions of the instructions |
| `<project>/AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/SYSTEM.md` | Pi's context for that project |
| `~/.pi/agent/sessions/` | Pi's sessions (read by Activity and Conversations) |
| `~/.pi/hindsight.key` | the Hindsight memory key (keep it `chmod 600`) |

### Part II. On the PC

Pier's configuration folder, `%APPDATA%\app.devbox.client` on Windows:

| File | Contents |
|---|---|
| `settings.json` | address, port, user, bastion. **Never a password.** |
| `known_hosts.json` | the accepted server fingerprints |
| `shares.json` | the shares to find again (paused, or from a Hand off) |

The log is in `%LOCALAPPDATA%\app.devbox.client\logs\` (`pier.log`, then `pier.1.log`, `pier.2.log`). The display preferences (layout, theme…) are kept by the app itself.

### Part III. In this repository

| Path | Purpose |
|---|---|
| `pier-picker.py` | the picker and its API |
| `pier-picker-tests.py` | the test suite, to run on the VM, in a real tmux terminal |
| `config.example.toml` | the picker's configuration template |
| `client/ui/` | Pier's interface: `index.html`, `style.css`, `themes.js`, xterm.js in `vendor/` |
| `client/ui/js/` | its code, one file per part: `core.js` (preferences, log, helpers), `vm.js` (the VM's state, received through `watch`), `connect.js`, `workspace.js` (the three zones and their tabs), `prefs.js`, `terminal.js`, `context.js`, `project.js` (Activity), `diff.js`, `conversations.js`, `setup.js`, `logs.js`, `palette.js`, `backend.js` (the Rust side), `mock.js` (a fake VM to try the interface in a browser), `main.js` |
| `client/src-tauri/src/` | the Rust side: `ssh.rs` (connection, fingerprints, bastion), `term.rs` (terminals), `share.rs` (the shares' SFTP server), `copy.rs` (folder archives), `store.rs` (settings), `clip.rs` (clipboard), `journal.rs` (the log), `picker.rs` (the built-in picker and its installation), `watch.rs` (the `watch` command), `lib.rs` (everything else) |

## Chapter X. Tests

### Part I. The picker

The `pier-picker-tests.py` suite, to run **on the VM** (it passed entirely on 16 October 2026, picker 4.20): it drives the picker in a real tmux terminal, and checks with the real programs:

- the screen and its keys, starting Pi (directly and in tmux), the Hindsight key, two Pis in one project and the API that lists them;
- the real bubblewrap sandbox: what Pi sees, its own `/dev`, `/run` hidden, the TIOCSTI filter, and its network (no direct connection, the proxy refusing what is not allowed);
- the protections against links and FIFOs Pi could plant (Hindsight key, Setup, removals, writes, the git jail), folder copies;
- restore points around a real `--exec-pi`, the log, what Setup lists, and moving the folders of the old name (pi-dir-picker).

When `/tmp` is mounted `noexec` (a hardened VM), the suite works in `~/.cache/pier-picker-tests` instead: its fake Pi must be able to run.

```powershell
scp C:\Users\leo\Downloads\pier\pier-picker.py C:\Users\leo\Downloads\pier\pier-picker-tests.py pi-sh:pi-tui/
```

```powershell
ssh -t pi-sh "python3 -B ~/pi-tui/pier-picker-tests.py"
```

If `~/pi-tui` does not exist on the VM yet, create it first: `ssh pi-sh "mkdir -p ~/pi-tui"`.

### Part II. Pier

47 Rust tests (`cargo test`), including:

- Pi tabs in tmux control mode against a local SSH server (decoding `%output`, keys as raw bytes, sizes, end, Pi unable to fake Pier's messages, caps);
- `watch` against a local SSH server (lines cut across two packets, round trip, end);
- the connection against a real local SSH server: first contact, wrong password, changed fingerprint, bastion, a server with old algorithms refused (without the password leaving);
- shares end to end (the simulated VM can neither leave the folder nor write when read-only), path confinement, archives, filtering Pi's arguments and update targets, quoting for any login shell;
- the log's format, rotation and UTC time, the built-in picker (its API version must be Pier's, or the tests do not build), the install script (trick paths refused);
- take back file by file: comparing by content, names from the VM that Windows would read otherwise, bringing files back with a backup, a path climbing out refused.

GitHub Actions runs them at every push, then builds Pier for Windows, macOS and Linux (see [Pier](#part-iii-pier)).

### Part III. The interface

It was checked in a browser with a fake backend (which also simulates `watch` and two Pis): layout, dragging tabs, menus, Context, Hand off, Conversations, Setup, the palette, themes, narrow widths, picker update, Restore, Logs, report, reconnection; then take back file by file, the clipboard only after a real key, the Logs tab under thousands of lines, dragging a divider, and a collapsed side unfolded for a look.

## Chapter XI. Known limits and what is left to check

### Part I. To check on the real VM

Tested only locally or in simulation so far (the sandbox, its network and git's jail are now checked by the suite on the VM):
- access to shared folders (sshfs) from the sandbox;
- the network allowlist with the real Pi: Node 24 or newer, its providers (Bifrost, OpenRouter, Claude Max…), Hindsight, `pi update` through the proxy;
- really unmounting sshfs during a Hand off, while Pi works, and take back file by file on a real copy;
- really resuming a session with `--continue` and `--session`;
- Ctrl+V of files copied in Explorer, and Windows notifications;
- installing and updating the picker by Pier on the real VM;
- restore points during a real Pi session (in particular the delay between a prompt arriving and Pi's first change);
- the tracking extension (`~/.pi/pier/pier-session.ts`) with the real Pi 1.x, in the sandbox: the conversation followed after `/new`, `/resume`, `/fork`, and "working" going back down at the end;
- `pi update` started from Setup, and asking npm for the latest versions from the VM;
- silent reconnection after the PC sleeps;
- the macOS and Linux builds of GitHub Actions, never started by hand.

### Part II. Limits

- **Two Pis changing the same files:** in a git project (with at least one commit), every Pi beside the first works in a worktree of its own (see [Git](#part-xiii-git-pi-with-a-repository-as-a-developer)), so they no longer step on each other. In a folder without git, nothing prevents it: several Pis there suit separate tasks (the code and the docs). A project's restore points are shared by its Pis, and cover the folder itself, not the worktrees.
- **A `/new` or `/resume` typed in Pi:** each Pi started by Pier says so itself (its extension). Without it (a Pi started earlier, or `track_sessions = false`), the picker guesses by looking for the recent file no other Pi holds; two Pis of the same project doing `/new` in the same second can then be mixed up.
- **The name of a very big conversation** (images, hundreds of MB) is looked for in its last 4 MB only the first time: a name given at the start of such a conversation, never given again, may not show.
- **What Pi will read next** cannot be known in advance.
- **Files read or changed by a bash command** of Pi only show as "changed on disk", through git.
- **No notification while Pier is off.**
- **Live shares need the PC on.** Copies and Hand off do not.
- **Restore points** cover neither files ignored by git, nor what a Pi command did outside the project (a database, a package installed, a `git push`).

## Chapter XII. Ideas for later

### Part I. Possible next steps

- **A notification on the phone** when Pi is done, sent by the VM itself (ntfy), so even with the PC off.
- **SSH limited to the WireGuard tunnel,** sshd hardened, fail2ban, a WireGuard `PresharedKey`: see [Network and encryption](#part-ii-network-and-encryption).
- **A second factor (TOTP)** in Pier.
- **Signing certificates** for the GitHub Actions builds (the workflow is ready for them).
- **Several VMs** saved, chosen at login.

## License

MIT: see [LICENSE](LICENSE).
