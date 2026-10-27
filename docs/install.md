<!-- Part of Pier's documentation: see the index in ../README.md -->
# Installation and day to day

## Installation

### On the VM

```bash
sudo apt install tmux bubblewrap sshfs git
```

**Pier installs the picker itself** at the first connection, then keeps it up to date. To use it over SSH without Pier before that, copy it by hand (the VM uses port 2222 and the name `pi-sh` defined in `~/.ssh/config`):

```powershell
scp <repository>\pier-picker.py pi-sh:bin/pi-pick
```

Python 3.12 or newer is needed, for receiving folders; Debian 13 has Python 3.13. git is used for restore points.

**Install Pi for your own account** rather than with `sudo`, so that `pi update` works without sudo:

```bash
mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
grep -q npm-global ~/.profile || echo 'PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.npm-global/bin:$PATH" && npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### On the PC: `~/.ssh/config`

```
Host pi pi-sh
    HostName 192.168.1.20
    Port 2222
    User <you>
    ServerAliveInterval 60
    ServerAliveCountMax 3

Host pi
    RequestTTY force
    RemoteCommand /home/<you>/bin/pi-pick
```

`ssh pi` opens the picker, and `ssh pi-sh` a normal shell (for scp, rsync…). With a bastion, add `ProxyJump bastion` under `Host pi pi-sh`.

### Pier

**The simplest:** download the installer from the [latest release](https://github.com/superbagel9079/pier/releases/latest) (Windows `Pier_…_x64-setup.exe`, macOS `.dmg`, Linux `.AppImage` or `.deb`) and install it. Pier then updates itself (Settings > Updates): no clone, no build. Without a code-signing certificate, Windows SmartScreen warns once, at that first installation ("More info", then "Run anyway").

**Or build it:**

The compiled executable is `client/src-tauri/target/release/pier.exe`. Nothing to install: WebView2 is already there on Windows 10 and 11.

To build it (Rust and Visual Studio Build Tools, installed with Chocolatey):

```powershell
cd <repository>\client\src-tauri
cargo tauri build --no-bundle
```

Quit Pier before building again (also from the notification area): Windows does not allow replacing a running program.

**GitHub Actions** (`.github/workflows/build.yml`) runs the tests (Rust on Linux and Windows, the picker's unit tests and the suite of the VM on Linux, `cargo audit`) and builds Pier for Windows (installer and exe), macOS (universal `.dmg`) and Linux (`.deb`, AppImage) at every push to `main`, every tag and every pull request, kept as the run's artifacts with their SHA-256. A tag `v…` (`git tag v0.3.0`, `git push --tags`) also prepares a draft GitHub release with them. Signing is optional: with the secrets listed at the top of the workflow (an Authenticode certificate for Windows, a Developer ID for macOS, notarized), the files are signed; without them they are not, and Windows and macOS warn on first start. The macOS and Linux versions are built there only, not yet tried by hand.

## Day to day

### Without Pier, over SSH

1. `ssh pi` opens the picker.
2. Select a project, then `p`: Pi starts in it.
3. `Ctrl-b d` goes back to the picker, and Pi carries on. `q` quits.

### With Pier

1. Start Pier, then type your password. **Pier logs in with a password only** (or the keyboard-interactive way that asks for it): no SSH key, no agent. The VM's sshd must accept it (`PasswordAuthentication yes`, or `KbdInteractiveAuthentication yes`), which is Debian's default.
2. The picker opens in the centre: `p` on a project (or **new** / **last** in Conversations, or Ctrl+Shift+K and a few letters).
3. A screenshot (Win+Shift+S), then Ctrl+V in Pier: the image is in Pi, you write your question.
4. A folder from the PC to show? Drop it onto Pier, then "Share live, read-only".
5. Follow the work in **Activity**; click a changed file to see the diff.
6. In the evening, if the task is long: **hand off**, then switch the PC off.
7. The next day: connect again. The result is in **Activity**, and **Take back** is in **Context**.

### Starting a new project

The **Setup** tab, then **let Pi write it** for a first `AGENTS.md`. Adjust it afterwards; every following session benefits.
