<!-- Part of Pier's documentation: see the index in ../README.md -->
# Known limits, and ideas for later

## Known limits and what is left to check

### To check on the real VM

Tested only locally or in simulation so far (the sandbox, its network and git's jail are now checked by the suite on the VM):
- access to shared folders (sshfs) from the sandbox;
- the network allowlist with the real Pi: Node 24 or newer, its providers (Bifrost, OpenRouter, Claude Max…), Hindsight, `pi update` through the proxy;
- really unmounting sshfs during a Hand off, while Pi works, and take back file by file on a real copy;
- really resuming a session with `--continue` and `--session`;
- Ctrl+V of files copied in Explorer, and Windows notifications;
- installing and updating the picker by Pier on the real VM;
- restore points during a real Pi session (in particular the delay between a prompt arriving and Pi's first change);
- the tracking extension (`pier-session.ts`) with the real Pi 1.x, in the sandbox: the conversation followed after `/new`, `/resume`, `/fork`, and "working" going back down at the end;
- `pi update` started from Setup, and asking npm for the latest versions from the VM;
- silent reconnection after the PC sleeps;
- the macOS and Linux builds of GitHub Actions, never started by hand.

### Limits

- **Two Pis changing the same files:** in a git project (with at least one commit), every Pi beside the first works in a worktree of its own (see [Git](git-and-team.md#git-pi-with-a-repository-as-a-developer)), so they no longer step on each other. In a folder without git, nothing prevents it: several Pis there suit separate tasks (the code and the docs). A project's restore points are shared by its Pis, and cover the folder itself, not the worktrees.
- **A `/new` or `/resume` typed in Pi:** each Pi started by Pier says so itself (its extension). Without it (a Pi started earlier, or `track_sessions = false`), the picker guesses by looking for the recent file no other Pi holds; two Pis of the same project doing `/new` in the same second can then be mixed up.
- **The name of a very big conversation** (images, hundreds of MB) is looked for in its last 4 MB only the first time: a name given at the start of such a conversation, never given again, may not show.
- **What Pi will read next** cannot be known in advance.
- **Files read or changed by a bash command** of Pi only show as "changed on disk", through git.
- **No notification while Pier is off.**
- **Live shares need the PC on.** Copies and Hand off do not.
- **Restore points** cover neither files ignored by git, nor what a Pi command did outside the project (a database, a package installed, a `git push`).

## Ideas for later

### Possible next steps

- **A notification on the phone** when Pi is done, sent by the VM itself (ntfy), so even with the PC off.
- **SSH limited to the WireGuard tunnel,** sshd hardened, fail2ban, a WireGuard `PresharedKey`: see [Network and encryption](security.md#network-and-encryption).
- **A second factor (TOTP)** in Pier.
- **Signing certificates** for the GitHub Actions builds (the workflow is ready for them).
- **Several VMs** saved, chosen at login.
