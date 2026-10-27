<!-- Part of Pier's documentation: see the index in ../README.md -->
# Security

## What is in place

| Topic | What is in place |
|---|---|
| **Password** | Kept in memory only, never written to disk, forgotten when the address or user changes. It can never end up in a URL: the forms cannot be submitted to an address. |
| **Server identity** | The fingerprint is checked at each connection; a fingerprint that changes blocks the connection **before** the password is sent. "Trust" only accepts the key Pier has just seen. The bastion is checked the same way. |
| **Network** | No port open on the VM. Everything goes through SSH, inside WireGuard. See [Network and encryption](#network-and-encryption). |
| **Pi's sandbox** | With bubblewrap, Pi sees the system **read-only**. Of your home it sees only the **project**, `~/.pi` (of the conversations, only **this project's**: the other projects' are hidden), the folders Pi and Node run from (exactly those: `~/.local/bin`, not all of `~/.local`; never a folder holding the picker's state or settings, nor `~/.ssh`) and `~/.gitconfig`. The rest (other projects, `~/.ssh`…) is invisible. It has a `/dev` of its own (no access to your other terminals), `/run` is hidden (no session bus, no systemd, no system sockets: only the folder `/etc/resolv.conf` points to comes back, read-only), and so are Incus's and LXD's sockets (`/var/lib/incus`…: on a VM that is also a lab host, Pi cannot drive Incus), it cannot type into its terminal (a seccomp filter refuses `TIOCSTI` and `TIOCLINUX`), and its processes are isolated. If bubblewrap is missing, **Pi refuses to start** instead of running unprotected. |
| **Pi and git** | Pi pushes only `pi/…` branches, never forced, and opens pull requests; merging waits for the user's approval in Pier unless the user lets it merge once the checks pass (or keeps it local), and creating a repository always does. With colleagues, Pis take tasks, ask each other for reviews (at most 3 per pull request and account) and read what others wrote as data, never as orders. The forge's token never enters the sandbox: the picker holds it and pushes from a mirror of its own, after fetching Pi's commits in git's jail. |
| **Pi's network** | With `network_limit` (on by default), Pi has no network of its own: it reaches only Anthropic, OpenRouter, DeepSeek, npm, GitHub, PyPI and what `network_allow` adds (another model provider is to add there), through a proxy the picker runs outside the sandbox. Everything refused is logged (`net.blocked`). Needs Node 24 or newer. |
| **Folders Pi may not run in** | Your home itself, `~/.ssh`, `~/.gnupg`, `~/.config`, `~/.local`, `~/bin` (where the picker is), `~/.pi`: refused before anything starts, and not offered as projects. A trick link in a project cannot hand Pi your whole home. |
| **Hindsight key** | Read by the picker and passed to Pi in its environment, never on the command line, where other users of the VM could read it. The picker warns when the key file is readable by others. `~/.pi` is Pi's to write: a link put in place of the key is not followed (only a plain file is read). |
| **Shared folders** | Confined to the folder chosen: no `..`, no link leaving it, no tricky Windows path; what cannot be checked is refused. Read-only by default, and a confirmation for writing. |
| **Archives received** (folder copies) | Extracted with Python's safety filter: no path leaving, no dangerous link, no special file. Size and number of files capped. |
| **git on a project** | Run in a sandbox of its own: a project's `.git/config` is Pi's to write, and a filter declared there could otherwise run as you. In there, git only reads the repository, without network. No fsmonitor, no external diff program, no `textconv`. That sandbox shows the project only; the `.git` file of a worktree or a submodule (Pi's to write too) can add only a real git folder inside another repository's `.git`. |
| **Picker writes in folders Pi controls** | Through a temporary file with an unpredictable name, in a folder reached through file descriptors from the project down, without following links: a folder replaced by a link to elsewhere, even meanwhile, is refused. A folder copy or a Hand off is unpacked in the picker's own folder, out of Pi's reach, then moved in. What the picker reads there (conversations, what a Pi says, git's files, a README) must be a plain file, never a FIFO or a device, and a conversation file must stay in Pi's sessions folder. A file removed by a restore, and whatever Context takes back (×, Clear), is removed walking down from home without following links: a folder swapped for a link meanwhile stops it. Setup does not read an `AGENTS.md` or `SYSTEM.md` that leads out of the project, and never copies one into its history. What a Pi says (its conversation) is accepted only if it is one of Pi's conversation files. |
| **What the interface may ask of the VM** | Only a closed list of commands. Pi's arguments are filtered: only `--new`, `--continue`, `--session` with a session file and `--slot` with a tmux session name are accepted. |
| **Commands sent to the VM** | Each argument is quoted for the shell, and the whole line travels in base64 and is run by `/bin/sh`, whatever the login shell (fish reads quotes differently). All paths are checked to stay in home. What is typed into Pi, and the files of a restore, go on the command's input instead: on its command line, any user of the VM could read them (`ps`), and a line holds 128 KB at most. |
| **What the VM sends the PC** | A program on the VM can fill the clipboard (OSC 52) only right after a real key or click in its tab, once per key or click, and the note shows what; in a Pi tab, only once you allowed it there. Names and texts from the VM show their hidden characters (`⟨U+202E⟩`) where you decide on them. Links are never opened. An answer is limited to 64 MB, and a tmux line to 8 MB. Pi cannot fake Pier's own messages in its output, in either of the forms the terminal reads (`ESC ]` and the one-character `U+009D`). |
| **The interface itself** | No remote content: the page only loads its own files (strict CSP), and can only reach Pier's commands, the file chooser and notifications. |
| **Logs** | Never a password, nor what is typed in a terminal or into Pi. |

### A. Things to know

- **The executable is not signed:** Windows shows a warning on first start.
- **The sandbox hides `~/.ssh`,** so Pi cannot `git push` over SSH, unless you add `sandbox_read = ["~/.ssh"]`. Pi could then read the keys.
- **`~/.pi` is shared by every project** and writable by Pi (except the conversations: each Pi sees only its project's). A Pi manipulated in one project could add a package, an extension or an MCP server that the Pis of other projects will load, and `pi update` installs those packages outside the sandbox. Setup shows the list of packages: look at it before updating.

## Network and encryption

**No TLS in Pier, on purpose.** Pier only talks to the VM over **SSH**: no web server, no HTTP API, no certificate to manage. SSH encrypts and authenticates everything itself: terminals, commands, `watch`, files sent, shares (sshfs goes through the same connection). The only TLS in the system is **Pi's, to its model provider** (HTTPS, handled by Pi on the VM).

### A. The layers, from the outside in

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

### B. What could be set up on the VM

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
   AllowUsers <you>
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

5. **A second factor (TOTP code)** for SSH, with `libpam-google-authenticator`. **Pier does not handle it yet:** it answers the password only to a question asking for a password, and a code asked is left unanswered (the login then fails). It would need to ask for the code separately (a small possible change).

6. **Where Pi can send data** is limited by the picker itself, without root (`network_limit`, on by default): Pi's sandbox has no network of its own, and a relay inside passes its connections to a proxy outside, which lets through only the places allowed (Anthropic, OpenRouter, DeepSeek, npm, GitHub, PyPI, and `network_allow`). **This narrows where Pi can send data; it does not stop it sending code.** The places allowed take uploads: a gist, a push to someone else's repository with a token written in an injected instruction, `npm publish`, an account of someone else at a model provider. And a lab on the internet network gives Pi the internet. Who needs only to download from GitHub can replace its entries in `network_allow` by `codeload.github.com` and `objects.githubusercontent.com`. What is refused is written to the picker's log (`net.blocked host=…`, in the Logs tab): add the host to `network_allow` if Pi needs it (a gateway such as Bifrost, Hindsight's server). Pi, npm, git and curl follow the proxy; Node needs version 24 or newer for that, and with an older Node the network stays open (the picker says so when Pi starts). A firewall rule would also cover a program that ignores the proxy, but needs root.

### C. On the PC

- **The password** stays in memory while Pier runs (to reconnect by itself). It could be wiped from memory as soon as it is no longer needed, at the price of asking for it again at each outage.
- **`known_hosts.json`** (the accepted fingerprints) is in your Windows profile, readable by you only. A malicious program on the PC could change it, but it could also read what you type: that is beyond Pier's reach.
- **To distribute Pier to others:** sign the executable (Authenticode) and publish its SHA-256, so they know it is the right one. The picker needs no signature of its own: it is inside the exe, and travels over the verified SSH connection.
