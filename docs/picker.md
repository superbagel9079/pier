<!-- Part of Pier's documentation: see the index in ../README.md -->
# The picker

A single-file Python program, **with no dependencies**: only the standard library. It is used directly over SSH (`ssh pi`) and is also Pier's engine.

## The screen

- At the top, an ASCII logo and the version, when the terminal has at least 30 rows.
- The current path, then the list of non-hidden folders.
- For each folder: the **git branch**, a **star** when there are uncommitted changes, `↑2 ↓1` for commits ahead of and behind the remote, and **`[pi]`** when a Pi runs there.
- At the top of your home, the **recent projects**.
- From 110 columns, a **preview panel**: latest commits, whether `AGENTS.md` or `.pi` exist, the start of the README.
- At the bottom, a reminder of the keys, which adapts to the width.
- Folders where Pi may not run (see [Security](security.md#security)), such as `~/bin`, are not listed, found or offered at all.

## Keys

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

## Pi in tmux

When you start Pi, the picker opens it in a **tmux session of the project's own**. This tmux server is reserved for Pier and does not touch your own sessions.

- `Ctrl-b d` goes back to the picker, and **Pi keeps running**.
- `p` on the project puts you back in its session (the one of the Pi used last, when there are several).
- **Several Pis per project:** `N` starts another, in a new conversation (for example one for the code, one for the docs). The list then shows `[pi 2]`, and the tmux bar `#2`. Each Pi writes its own conversation: the picker gives it its session file itself (`--session`) and notes it in tmux, so that Pier always knows which Pi writes what.
- The tmux bar is discreet and recalls `ctrl-b d`. It shows `[sandbox]` when the sandbox is on.
- When tmux is not installed, the picker offers to install it (with `sudo`, which asks for your password itself), or to start Pi without tmux.
- **Extended keys** are on for this tmux server (`extended-keys`, in `csi-u` form, as Pi recommends): Shift+Enter makes a new line in Pi.
- **This tmux server has its own configuration,** written by the picker to `~/.local/state/pier-picker/tmux.conf`; your `~/.tmux.conf` is not read. It is applied again whenever a Pi opens, to a server started earlier too. It serves the "plain ssh" way (the picker in Windows Terminal): the mouse belongs to tmux (the wheel scrolls back through the history tmux keeps, a drag selects and copies), what tmux or Pi copies reaches the terminal's clipboard (OSC 52), and the bottom bar uses only palette colours (grey text, no background).
- **In Pier, Pi does not go through tmux's screen** (see [Terminals](pier.md#terminals)): Pier attaches in "control mode". tmux keeps Pi alive but draws nothing; it passes Pi's output on as it is, and Pier displays it. So in the picker started by Pier, `p` (and `N`, `c`, `r`) opens Pi **in a Pier tab** instead of attaching to it itself.

## Pi in "regular" mode (recommended)

Since version 1.0, Pi starts in "fullscreen" mode: it takes the mouse, scrolls and selects by itself, and shows "Copied!" when it copies. Over SSH, each notch of the wheel then makes Pi redraw the whole screen on the VM, which is not smooth, and its selection bypasses Pier's. In **regular** mode, Pi writes to the terminal like an ordinary program: the wheel, the selection and copying are Pier's. You lose Pi's scrollbar, its search in the conversation and jumping between messages.

In `~/.pi/agent/settings.json` on the VM:

```json
"tuiMode": "regular"
```

To go back to fullscreen mode, `"tuiMode": "fullscreen"` (the wheel is smoother there with `"fullscreenWheelScrollLines": 3`).

## The sandbox

By default, Pi runs in **bubblewrap**. See [Security](security.md#security).

## Configuration

Optional, in `~/.config/pier-picker/config.toml`. A commented template is in [config.example.toml](../config.example.toml).

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
| `git_tools` | Pi gets git tools for the forge (push, pull requests), through the picker (see [Git](git-and-team.md#git-pi-with-a-repository-as-a-developer)) | `true` |
| `worktrees` | in a git project, a Pi beside another works in a worktree of its own | `true` |
| `network_limit` | in the sandbox, Pi reaches only Anthropic, OpenRouter, DeepSeek, npm, GitHub, PyPI and `network_allow` (see [Security](security.md#security)); another model provider (OpenAI, Google, Mistral…) is to add there | `true` |
| `network_allow` | more places Pi may reach: `"host"`, `"host:port"`, `".domain"`, `"127.0.0.1:8080"` | `[]` |

Two environment variables exist too: `PI_BIN`, Pi's path when it is not on the PATH, and `PI_PICKER_SANDBOX=0`, which turns the sandbox off (the test suite uses it).
