<!-- Part of Pier's documentation: see the index in ../README.md -->
# Security: the audits

### Audit of 14 October 2026

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

### Audit of 15 October 2026

A second full review (security, CPU, memory, smoothness). Fixed in pier-picker 4.15 to 4.20, and checked by the test suite on the VM:

- **Links planted by Pi:** in `~/.pi` and in the project, everything the picker reads or writes outside the sandbox (the Hindsight key, `AGENTS.md`, conversations, what each Pi says, copies, the × and Clear of Context, the files `lab_push` sends to a lab and those a download takes back) goes through file descriptors, without following links; FIFOs and devices are never read. Folder copies and Hand offs are unpacked out of Pi's reach, then moved in.
- **The sandbox:** `/run` hidden (system sockets), a seccomp filter refusing `TIOCSTI` and `TIOCLINUX` (Pi cannot type into its terminal), git's jail limited to the project (a `.git` file naming another repository's adds nothing), Incus's sockets hidden, each project's conversations seen only by its own Pis, and the network limited to an allowlist (`network_limit`).
- **The clipboard (OSC 52):** a program on the VM fills it only right after a real key or click, once per key or click; the terminal's automatic replies no longer count as a key.
- **The command line:** what is typed into Pi, and the files of a restore, go on the command's input, not where other users of the VM could read them.
- **Smoothness:** the Logs tab, dragging a divider, the Setup list and the searches no longer redraw everything; the watch rebuilds less when nothing moves; the picker is kept compiled.
- **Found by the suite on the VM:** the link protections were silently off under Linux (a Python detail), and tmux never recorded which conversation each Pi held when two ran in one project. Both fixed.
