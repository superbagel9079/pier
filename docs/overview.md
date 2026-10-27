<!-- Part of Pier's documentation: see the index in ../README.md -->
# Why Pier, and how it works

## Why these tools

### What was missing

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

### Why the folder is chosen before Pi starts

That is what the picker is for. Pi reads its configuration, its instructions (`AGENTS.md`) and its memory **at startup**, and its Hindsight memory is filed **by folder name**. Starting Pi in one folder and then moving to another would make it work with another project's context. So the working folder is always fixed before Pi starts.

## Overview

### The pieces

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

### How they work together

- **One SSH connection.** Pier's terminals, uploads and shares all go through it: the password is asked once. Every terminal, call or share opens a "channel" on it, and OpenSSH limits how many per connection (`MaxSessions`, 10 by default): past that the VM refuses, and Pier opens another connection by itself (with the password kept in memory). To avoid it, set `MaxSessions 30` on the VM (see [Network and encryption](security.md#network-and-encryption)).
- **No port open on the VM.** Pier runs the picker over SSH with options (`pi-pick --api …`), and the picker answers in JSON.
- **One command stays open** (`pi-pick --api watch`) and sends Pier what changes, when it changes: Pier does not poll the VM. What asks other machines (the forges for Team, every five minutes; the lab hosts for the Labs tab, every minute and only while it is shown, over one SSH connection kept two minutes) is built apart, so a forge or a lab host that does not answer no longer holds the rest; a lab host that did not answer is left alone a minute. Conversations sends only the projects that changed. Pier says a word every 30 seconds: a watch that hears nothing for 150 seconds (a PC gone to sleep without closing the connection) ends by itself.
- **Pi runs in tmux,** one tmux session per Pi, on a tmux server reserved for Pier. So it survives disconnections. **Several Pis can run in the same project,** each in its own conversation.
- **Pi runs in a sandbox** (bubblewrap): it only sees its project.
- **The picker ships inside Pier.** Pier installs it on the VM and keeps it up to date: the exe is all you need.
- **Every prompt can be undone:** the project is saved before it (restore points).
- **Everything is logged,** on the PC and on the VM, in two logs that read side by side.
