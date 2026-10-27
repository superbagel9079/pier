# Pier

**Pi on a Linux VM, used from your laptop.** [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) is a command-line coding agent. Pier runs it on a VM of yours, in a sandbox, and gives you one window onto it: its terminal, what it reads and changes, its conversations, the files and folders you hand it, and an undo for every prompt. Close the laptop, lose the Wi-Fi: Pi carries on.

Two pieces:

- **Pier** (`client/`), a desktop app for Windows (macOS and Linux builds exist, not yet tried by hand).
- **The picker** (`pier-picker.py`, installed on the VM as `~/bin/pi-pick`): a terminal screen to choose a folder and start Pi there, and the API Pier talks to. Pier carries it and installs it itself.

## Words used here

| Word | What it is |
|---|---|
| **Pi** | the coding agent, running on the VM |
| **the VM** | the Linux machine (Debian 13) where Pi runs; your laptop only shows it |
| **the picker** (`pi-pick`) | chooses the folder Pi starts in, and answers Pier (its API) |
| **Pier** | the desktop app on the laptop |
| **a project** | a folder of the VM where Pi works; Pi sees only it (its sandbox) |
| **a share** | a folder of the laptop lent to Pi live, read-only or not |
| **hand off** | your shares become copies on the VM, so you can switch the laptop off |
| **a restore point** | the project as it was before a prompt: one click puts it back |
| **a lab, a lab host** | a throwaway machine where Pi may do anything (optional), on a VM with Incus |

## What you need

| Where | What |
|---|---|
| **The VM** | Debian 13 (or close), reached over SSH **with a password** (Pier does not use SSH keys); `tmux`, `bubblewrap`, `git`, `sshfs`; Python 3.12 or newer; Node 24 or newer; Pi, installed for your account |
| **The laptop** | Windows 10 or 11 (WebView2 is there already) |
| **Between them** | an SSH path to the VM: on your LAN, through a tunnel (WireGuard), or a bastion |

Pier checks the VM at the first connection and lists what is missing, with the command for each (**Is the VM ready?**).

## Quick start

1. **On the VM:** the tools, then Pi for your own account (so `pi update` works without sudo):
   ```bash
   sudo apt install tmux bubblewrap git sshfs
   mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
   grep -q npm-global ~/.profile || echo 'PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
   export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```
   Then run `pi` once to sign in to your model provider.
2. **On the laptop:** install Pier from the [latest release](https://github.com/superbagel9079/pier/releases/latest) (`Pier_…_x64-setup.exe`). Without a code-signing certificate, Windows SmartScreen warns once: "More info", then "Run anyway".
3. **Connect:** the VM's address, port, user and password on one screen (and a bastion if you need one); the next times, only the password. The first time, compare the fingerprint Pier shows with the VM's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there), then trust it.
4. **Pier installs the picker** on the VM, and shows what is missing there, if anything.
5. **Start Pi:** in the picker, choose a folder with the arrows and press `p`; or **Open a folder…** in Conversations. Ask Pi something.

## Day to day

- **Give Pi things:** a screenshot (Win+Shift+S), then Ctrl+V in Pier; a file or a folder dropped onto Pier (a folder: shared live, or copied into the project).
- **Follow it:** three panels beside the terminals. **Conversations** lists every conversation, to continue, name, pin or archive. **Activity** shows what Pi read and changed, live (a click on a file shows its diff), what was given to it, and its restore points. **Project** holds the project's instructions, skills and packages. **Repository** (when the project has one) its pull requests, Pi's requests and the team.
- **Undo:** **↶ Undo last prompt** at the top of Activity, or **Activity > Restore** for any earlier point.
- **Answer it:** when Pi asks to merge, post a review, create a repository or run a command on a machine of yours, the top bar says "1 waiting": read it whole, then **Approve** or **Refuse**.
- **Leave it working:** **keep working without this PC…** (hand off), then switch the laptop off. Later, connect again: the result is in Activity, and **review changes** (Activity > Given to Pi) brings Pi's work back into your folder, file by file, with a backup of what it replaces.
- **Find anything:** Ctrl+Shift+K, then a few letters: a tab, a project, a conversation, a setting, an action.
- **Several Pis** can work in one project, each in a git worktree of its own.

Optional, each off until you turn it on: **Git** (Pi pushes `pi/…` branches, opens pull requests, merges with your approval), **Team** (tasks and reviews between colleagues' Pis), **Labs** (machines where Pi may do anything). See [Git, forges and the team](docs/git-and-team.md) and [Labs](docs/labs.md).

## Updates

Pier looks for a new version at start and every 6 hours, and shows "update to x.y.z" in its top bar: one click installs it, once its signature is checked against the project's key. The picker on the VM follows Pier, which updates it itself. Pi and its packages are updated from Setup > Packages.

## When something goes wrong

| What happened | What to do |
|---|---|
| The laptop slept, the Wi-Fi went | Nothing: Pier reconnects by itself for 15 minutes, Pi tabs reattach, shares restart. |
| The VM restarted | Conversations shows **continue where it stopped**: the conversation is saved, what was running is lost. |
| Pi does not start: "sandbox" | bubblewrap is missing: `sudo apt install bubblewrap`. Pi refuses to run unprotected. |
| Pi cannot reach a site (`net.blocked` in the log) | Its network is limited to its model providers (Anthropic, OpenRouter, DeepSeek), npm, GitHub and PyPI: add the host to `network_allow` in `~/.config/pier-picker/config.toml`. |
| The VM refuses more channels | `MaxSessions 30` in the VM's `/etc/ssh/sshd_config` (Pier opens another connection meanwhile). |
| Anything else | Settings > Diagnostics > **Copy a report**: versions, settings, both logs' ends, never a password. |

More: [Outages and recovery](docs/troubleshooting.md).

## Security, in short

- Pi runs in a **bubblewrap sandbox**: of your home it sees only its project and Pi's own folder, the rest of the system read-only, no system socket; it cannot type into its terminal; its network goes to an allowlist only. Without bubblewrap, Pi does not start.
- **Each project is its own:** a Pi sees no other project, nor the other projects' conversations.
- **Pi proposes, you decide:** a merge, a review posted, a repository made, a command on a machine set to ask, a lab on another network wait for your approval, shown exactly as they will be done.
- The forges' **tokens never enter the sandbox**: the picker holds them and pushes from a mirror of its own.
- **The SSH connection** checks the VM's key before the password leaves, uses modern algorithms only, and goes through a bastion end to end.
- What the VM sends the laptop is **checked**: no link opened, the clipboard written only just after a key you pressed, files brought back marked as coming from the Internet.
- **Updates are signed**, with a key used only to build a release.
- The allowlist **narrows** where Pi can send data; it does not stop it (the places allowed take uploads). A lab on the internet network gives Pi the internet.

All of it, with its limits: [Security](docs/security.md). To report a flaw: [SECURITY.md](SECURITY.md).

## Documentation

| Page | What is in it |
|---|---|
| [Why Pier, and how it works](docs/overview.md) | the idea, the pieces, how they talk |
| [The picker](docs/picker.md) | its screen and keys, tmux, the sandbox, its configuration |
| [Pier, the desktop app](docs/pier.md) | connecting, the workspace, terminals, Context, shares, hand off and take back, Activity, restore points, logs, Conversations, Setup, notifications, settings |
| [Git, forges and the team](docs/git-and-team.md) | repositories, what Pi may do alone, approvals, tasks and reviews between Pis, giving a conversation |
| [Labs](docs/labs.md) | lab hosts, labs, machines, networks, VLANs, firewalls |
| [Security](docs/security.md) | what is in place, network and encryption, hardening the VM |
| [Security: the audits](docs/security-history.md) | what earlier audits found, and what was fixed |
| [Installation and day to day](docs/install.md) | the VM, `~/.ssh/config`, building Pier, using the picker without Pier |
| [Outages and recovery](docs/troubleshooting.md) | what happens when something stops |
| [Files and locations](docs/files.md) | every file on the VM, on the PC, in this repository |
| [The picker's API](docs/api.md) | the commands Pier calls |
| [Tests](docs/tests.md) | the suite on the VM, the unit tests, the Rust tests |
| [Known limits, and ideas for later](docs/limits.md) | what is left to check, and what could come |

## Contributing, releasing

- The picker lives in `picker/NN_*.py`: edit the parts, then `python3 tools/bundle.py` writes `pier-picker.py` (the CI checks they match).
- Tests: `python3 -B pier-picker-unit.py` anywhere, `pier-picker-tests.py` on a VM (the CI runs both), `cargo test` in `client/src-tauri`.
- Releases: [RELEASING.md](RELEASING.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT: see [LICENSE](LICENSE).
