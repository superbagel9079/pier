<!-- Part of Pier's documentation: see the index in ../README.md -->
# Outages and recovery

## What happens, and what to do

| What stops | Consequence | What to do |
|---|---|---|
| **The PC** (sleep, battery, Wi-Fi) | Pi carries on on the VM. Live shares drop. | Nothing: Pier reconnects by itself (for up to 15 minutes), its Pi tabs reattach and the shares restart. After longer, log in again: `p` or the `pi · project` tab puts you back in the conversation. |
| **The VM** (power, reboot) | Pi and tmux stop. **The conversation is saved**, Pi writes it as it goes. What was in progress is lost: the answer being written, a command running. | Conversations shows **continue where it stopped** on the project, or `c` in the picker (`--continue`). |
| **The connection** during a long task | As for the PC. | Nothing: Pier reconnects by itself while it has the password in memory. |

Tip: work in a git repository and let Pi commit regularly. After an outage, you go back to the last clean state.
