<!-- Part of Pier's documentation: see the index in ../README.md -->
# Pier

The picker used to be called **pi-dir-picker**. Its folders on the VM (`~/.config/pi-dir-picker`, `~/.local/state/pi-dir-picker`) move to the new name by themselves the first time a newer picker runs, and a link stays at the old place for the Pis started before. Its tmux server keeps the old name for as long as it runs (Pis started before stay found), and takes the new one when it next starts.

Pier used to be called **devbox** (the name was already taken by a well-known tool). Whatever holds data kept the old name, so that nothing is lost: the settings and logs folder (`app.devbox.client`), the interface's preferences, and on the VM the restore points and the history of the instructions (`.pi/devbox-history`).

A **Tauri** app: the logic is in Rust, the interface in plain HTML, CSS and JavaScript, without a framework. The terminal is **xterm.js**, built into the app. The executable is about 8.5 MB.

## Connecting

- **First start:** address, port, user, and an optional **bastion** (with its own port and user).
- **Is the VM ready?** Once connected, when something Pier needs is missing on the VM (tmux, bubblewrap, git, sshfs, Python 3.12, Node 24, Pi, enough `MaxSessions`), a page lists what is there and what is not, each missing thing with the command that puts it right (**copy**, then paste it in a shell tab). It shows once for each new set of missing things, and at any time from the palette (Ctrl+Shift+K, "ready").
- **Open a folder…:** with no conversation yet, Conversations offers to choose a folder of the VM, walking down from home, and starts Pi in it (also in the palette).
- **Waiting for you:** whatever Pi asks you (a merge, a review, a repository, a command on a machine, a lab on another network) is counted in the top bar ("2 waiting"), and one click lists them all, each shown whole, with **Refuse** and **Approve**. They are still in Setup > Git and the Labs tab too.
- **The palette** also reaches every page of Settings ("Settings: Labs"), of Setup ("Setup: Git") and of Activity ("Activity: Restore points"), the Labs tab, Hand off, and the above. **Settings** open on the Picker page, then Behavior and Updates.
- **Password:** asked once, kept **in memory only** and never written to disk. It is used to reconnect by itself when the PC went to sleep. It is forgotten as soon as the address or the user changes.
- **Server fingerprint:** checked as `ssh` does. On first contact, Pier shows it for you to confirm, and only that key can be trusted. If it changes later, **the connection is refused before the password is sent**.
- **The connection settings** are changed from the login screen ("change connection"), not from the Settings.

## The picker, shipped with Pier

The exe contains the picker (`pier-picker.py`, built in at compile time). At each connection, Pier compares the VM's version with its own:

- **The picker is missing** (first connection): Pier offers to install it, where the picker command points (`~/bin/pi-pick` by default). The VM only needs Python 3.
- **It is older**: Pier updates it by itself, unless that setting is turned off in the Settings.
- **It is newer than Pier**: Pier says so, and still offers to install its own version.

The installation is careful: the new file is written next to the old one, Pier checks that it starts and announces the right version, and only then replaces the old one, which is kept as `pi-pick.previous`. The picker itself goes to `pi-pick.lib/pier_picker.py`, and `pi-pick` is a small launcher that imports it: Python then keeps it compiled, instead of compiling its 9,800 lines at every call (about 60 to 100 ms saved on each call Pier makes). `pi-pick.previous` is always a whole picker, which runs by itself. A picker copied by hand to `~/bin/pi-pick` still works as before. Pier only installs when the picker command is a plain path (`~/bin/pi-pick`, `/opt/pi-pick`).

## The workspace

Three zones, **left, centre and right**. By default, to keep it simple, **the terminals in the centre and every panel on one side** (on the right; Settings > Layout > **Panels** puts them on the left):

- **Conversations**: every conversation, of every project, with their Pis;
- **Activity**: what the Pi in use does;
- **Context**: what it was given;
- **Setup**: the project's configuration.

The **Logs** tab is a diagnostics option (Settings > Diagnostics > **Logs tab**). An older layout takes this one once; **Reset layout** brings it back.

### A. Going anywhere, arranging freely

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

### B. What stays put

- **The picker** is the main tab: it is pinned and never closes.
- **The chosen tab is always fully visible:** in a narrow side, the tab bar scrolls to it.
- **The layout is kept** from one connection to the next. "Reset layout" puts the tabs back in their default places without restarting the terminals.
- **At the top**, Pier shows the Pi in use (`session · ~/work #2 · working`). The panels follow its project automatically.

## Terminals

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
- **When Pi copies by itself,** the text reaches the PC's clipboard only within 2 seconds of a key pressed or a click in that tab, once per key or click, and a note shows the start of what was copied. In a Pi tab, where you type all the time, Pier also asks once, at Pi's first copy, whether Pi may copy in that tab: a program on the VM may **write** to the clipboard then, and never **read** it. The terminal's own automatic replies (cursor position, mouse reports) do not count as a key.
- **Links** shown by a program (OSC 8) are never opened, only copied, to paste in a browser after reading them.
- **A program that takes the mouse** (Pi in fullscreen mode, `htop`…) receives the clicks; **Shift+drag** still selects in Pier.
- **As responsive as plain ssh:** the connection turns off Nagle's algorithm, as OpenSSH does for interactive sessions (otherwise each key could wait up to 200 ms), and what the VM sends at once is handed to the terminal in one message, instead of one per SSH packet. While a divider is dragged, only the final size reaches the VM. With detailed logs, Pier notes the VM's response time to keys (`ui.term-latency`, median and 90th percentile).
- **Drawn by the graphics card** (WebGL): scrolling a long history stays smooth. Without WebGL, or when the graphics card loses its context, the terminal falls back to the classic renderer by itself. Setting in Settings > Terminals.

## The Context tab: everything given to Pi

You give something with **Ctrl+V**, **drag and drop**, the **Add files… / Add a folder…** buttons, or **Ctrl+Alt+V** from any application. Pier then does what is needed:

| What you give | What happens |
|---|---|
| **An image** | Copied to the project's `.pi-images/` and **typed into Pi** (`@.pi-images/…png`). Only your question is left to write. |
| **A file** | Copied to `.pi-files/` and typed into Pi. |
| **A folder** | Pier **asks**: <br>• **share live, read-only**; <br>• **share live, read and write**; <br>• **copy into the project** (a copy Pi can change without touching the original, up to 200 MB, without `.git` or `node_modules`). |

Files and folders copied in Windows Explorer (Ctrl+C) paste too.

The panel lists, **project by project**, everything that was given: images (with a preview), files, copies and shares. Each item has:
- **mention**, which types it into Pi again;
- an **×**, which takes it back. An image, a file or a copy is deleted from the VM; a share stops, and the original folder is never touched. A stopped share answers nothing more, even to a program of Pi that was still inside it (the VM's unmount is lazy); in a share open for writing, the VM cannot make names Windows cannot open (`CON`, `a.`, `b `).

The list is read on the VM: it is there again after a reconnection. The `.pi-images`, `.pi-files` and `.pi-shared` folders each contain a `.gitignore` with `*`, so that nothing gets committed by accident, without touching the project's own `.gitignore`.

## Live shares

The folder stays **on the PC**. The VM sees it **live** in the project's `.pi-shared/<name>`, and nothing is copied.

- **Read-only** by default. With writing allowed, Pi's changes are made **directly in the PC's files**: it is not a synchronisation, they are the same files.
- **How it works:** sshfs runs on the VM in "passive" mode, and Pier serves it the folder, through a small SFTP server going through the SSH connection. No port is open.
- **Pier's server serves only that folder:** it refuses to climb out with `..`, to follow a link leaving the folder (or one pointing nowhere), and tricky Windows paths (`C:x`, `a:b`, `..\`).
- **A share stops** when you click ×, on disconnecting, when Pier quits, and, by default, when the project's Pi ends.
- **After a disconnection,** shares come back **paused**, with a **resume** button. They can also resume by themselves, as set in the Settings. After a silent reconnection they start again by themselves.

## Hand off and Take back: Pi carries on, PC off

Pi runs on the VM and does not need the PC, **except for live shares**.

### A. Hand off

**Hand off** (button at the top) turns each live share into **a copy on the VM, exactly at the same place**. Pi thus keeps its files at the same paths, even in the middle of a task:
- a read-only share becomes a read-only copy;
- a read-and-write share becomes a copy Pi can change.

The copy holds the whole folder, its `.git` included (Pi goes on with its history), except the folders rebuilt from it at its top (`node_modules`, `target`, `__pycache__`, `.venv`, `venv`): Pier says which it left out. A `target` deeper in the folder is kept, as anything else.

Then Pier disconnects, and the PC can be switched off.

### B. Take back

**Take back**, on your return, from Context:
- **review changes** opens a tab that compares Pi's copy with your folder, file by file (by their SHA-256, on both sides): **changed**, **new** and **deleted** by Pi. A click on a file shows its difference (yours `-`, Pi's `+`). Check what to bring back, then **Bring back the checked files**: only those are written into your folder. Changed and new files come checked, files Pi deleted do not. Every file replaced or deleted is first moved to a folder next to yours, `mockups (before Pi's changes 2026-10-16 10-32-05)`, one of its own each time: nothing is lost. Links in the copy are never brought back, nor names Windows would read otherwise (`C:x`, `a:b`, `NUL`…) or that do not read as what they are (invisible or direction-changing characters), nor a file whose name opens another one here (a short name like `MOCKUP~1.TXT`, `readme.md` for your `README.md`): those are listed as skipped. Every file brought back gets the "came from the Internet" mark (on macOS, the quarantine), and a mark that cannot be written stops it;
- **download** saves Pi's version in a **new folder** next to the original, `mockups (from Pi)`: nothing is overwritten. The download is capped (600 MB received, 2 GB unpacked), links and special files are skipped, and every file gets the "came from the Internet" mark, so Windows warns before opening or running it;
- **share live** shares the original folder live again, in place of the copy;
- **×** deletes the copy.

## The Activity tab: what the agent does

Everything is read from **Pi's session log**, which it writes as it goes (`~/.pi/agent/sessions/--<project path>--/*.jsonl`).

- **Activity:** the files **being read**, **read**, **being changed**, **changed**, **failed**, what changed on disk without going through Pi's tools (seen by git), and the recent history of actions.
- **The agent's state:** working, or idle.
- **The session's cost:** input, output and cached tokens, cost in dollars, model.
- **Files:** the tree with the same marks (◐ being read, ● read, ✎ being changed, ✓ changed, ! failed) and the git state.
- **Several Pis in the project:** a list at the top chooses whose work is followed (by default, the one used last).
- **A click** on a changed file opens its **diff** in a tab: the git diff, and the changes Pi made itself, even outside git. **A double click** mentions the file in Pi.
- **What is not possible:** knowing what Pi **will** read next. Pi decides as it goes.
- **Restore:** the restore points, see below.

## Restore points: undoing what Pi did

### A. Using them

The project is saved **when Pi starts**, **when each prompt arrives** (before Pi acts) and **when Pi stops working**. **Activity > Restore** lists these points: "Pi started", "before “add tests”", "Pi finished working".

- **A click on a point** shows what changed since: files changed (~), created (+), deleted (−).
- **diff** shows the difference of a file between that point and now; **put back** restores it as it was, **remove** deletes a file created since.
- **Go back to 14:32** puts the whole project back in that point's state: files created since are deleted, the others get their content back.
- **Going back can be undone too:** before each restore, the current state is itself saved ("before going back to 14:32").
- **Save a restore point now** makes one by hand, with a name if you like.
- Pier refuses to restore **while Pi is working**. Pi is not told: tell it what you undid.

### B. How it works

- The points are kept **outside the project**, in a git repository of their own per project (`~/.local/state/pier-picker/checkpoints/`). **The project's git is never touched**, and Pi, in its sandbox, does not see that folder.
- git stores each version of a file once: a point costs only what changed. The latest 50 points are kept per project.
- That repository reads none of your git configuration: no hook, filter or fsmonitor runs.
- **Not saved:** what `.gitignore` leaves out (node_modules, build, `.env`…), what was given to Pi (`.pi-images`, `.pi-files`, the shares), files over 50 MB, and files that cannot be read (they are skipped, the rest is saved).
- A point identical to the previous one is not a duplicate: it replaces it and takes over its name. Each point in the list is thus a different state.
- The first question of a **new** session is a special case: Pi only writes its session with its first answer, when its tools start. That question is therefore attached to the "Pi started" point, which does hold the state from before.

## Logs: what happened, to understand a problem

### A. The two logs

Pier and the picker each write a log, **one line per event**, in the same format and in UTC:

```
2026-10-12T14:32:01.123Z INFO  vm.paste-image req=7f3a-12 ms=41 sent=48213
2026-10-12T14:32:01.150Z INFO  api.paste-image pid=4242 req=7f3a-12 ms=22 saved=/home/<you>/work/.pi-images/…
```

- **On the PC** (`%LOCALAPPDATA%\app.devbox.client\logs\pier.log`): connection and reconnections, every call to the VM (duration, error), terminals opened and closed, shares, Hand off, picker installation, interface errors and every error message shown.
- **On the VM** (`~/.local/state/pier-picker/picker.log`): every API command, Pi starting and stopping (with its exit status), restore points, crashes **with their traceback**.
- **A call carries the same `req=…` in both logs:** an action can be followed end to end.
- **Never in the logs:** passwords, what is typed in a terminal, what is typed into Pi (only its length), file contents.
- **Detailed logs** (Settings) adds the detail lines, on both sides: the reads repeated every few seconds, terminal sizes, the steps of the SSH connection.
- The logs rotate at 5 MB (PC) and 1 MB (VM), keeping 3 files.

### B. The Logs tab

**The Logs tab** (shown with Settings > Diagnostics > **Logs tab**) shows both logs live, **newest at the top**, with a filter by level and by text. **Copy a report** puts a full report on the clipboard: versions, connection (never a password), settings, and the end of both logs. That is what to send when something goes wrong.

## The Conversations tab: the one place for conversations

Every conversation of Pi on the VM, **grouped by project**. The project of the Pi in use comes first, marked ●, and stays open. Then the projects where a Pi runs, then the others, from the most recent to the oldest. Past the first three, a project is folded; **▾** unfolds it, and Pier remembers.

- **A project's header:**
  - how many Pis run there, how many conversations, its totals (today, 7 days);
  - **new**: one more Pi, in a new conversation;
  - **last**: continues the last conversation;
  - **setup**: opens its configuration in Setup.
- **The running Pis**, first: each with its conversation (Pi #1, Pi #2…, working or waiting for you), **open** (its terminal) and **stop**. A Pi just started, with no conversation yet, shows as "*New conversation*". **stop them all** when there are several.
- **Which Pi holds which conversation:** each Pi started by Pier says so itself, even when you switch conversations in Pi (`/new`, `/resume`, `/fork`), and even before its first answer. Pier starts it with a small extension (`--extension ~/.local/state/pier-picker/pi/ext/pier-session.ts`; nothing is added to Pi's settings). At each change, it writes its conversation and whether it is working to `~/.local/state/pier-picker/pi/pis/<tmux session>/state.json`. In the sandbox, each Pi sees only its own folder there, and the extensions read-only: a Pi cannot write what another one says. It shows in the list of extensions when Pi starts. It adds no tool, reads no message and sends nothing over the network. To do without it: `track_sessions = false` in the picker's config; Pier then guesses as before.
- **Then the conversations:** pinned ones (★), then the most recent (5; **show all** for the rest). Each shows:
  - its date and its number of messages;
  - what it cost: in dollars when the model has a price in Pi, else in tokens (for the 300 most recent);
  - its category.
- **Actions:** **continue** starts a Pi on it. **⋯** gives it a **name** and a **category**, **pins** it or **archives** it: it leaves the lists, but can still be found by the search and with the **archived** box. Pier keeps these in `~/.local/state/pier-picker/labels.json`; Pi's files are not touched.
- **Recovery after an outage:** if the VM restarted while Pi was working, the project shows a **continue where it stopped** banner.
- **The search** covers every conversation of every project (name, question, category), archived ones included.

Pier reads Pi's sessions folder (`~/.pi/agent/sessions`). The view is only updated while it is shown, at most every 5 seconds while Pi works.

## The Setup tab: a project's configuration, as in Claude Projects

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

## Notifications and shortcut

- **A Windows notification** when a Pi goes from "working" to "idle", for every Pi started. Nothing shows when Pier is already in front.
- **Ctrl+Alt+V,** from any application: sends the clipboard's image or files to Pi. When another program already uses it, the Settings say so.
- **One Pier at a time:** starting it again brings the running one forward (even minimised to the notification area) instead of opening a second one.
- **Closing the window** leaves Pier in the notification area. To quit it: right-click the icon, then Quit.

## Settings (once connected)

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
- **Updates:** Pier's version; whether a new one is out, with its notes and **Install and restart**; **Check now**; looking by itself at startup, then every 6 hours (on by default). When a new Pier is out, "update to 0.3.0" also shows in the top bar. An update comes from this repository's GitHub releases and is installed only if signed with the project's key; shares are stopped before Pier restarts. How to publish one: [RELEASING.md](../RELEASING.md).
- **Connection:** where Pier connects (changed from the login screen).
