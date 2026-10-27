<!-- Part of Pier's documentation: see the index in ../README.md -->
# The picker's API

### The API for Pier

The picker is also Pier's engine. It opens no port: Pier runs it over SSH with `--api` and reads its JSON answer. The API is versioned (version 22 today): Pier recognises a picker that is too old and updates it.

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
