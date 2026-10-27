<!-- Part of Pier's documentation: see the index in ../README.md -->
# Git, forges and the team

### Git: Pi with a repository, as a developer

A project can be connected to a repository of **GitHub**, **GitLab** or **Gitea / Forgejo**, in **Repository > Git**. Pi then works as a developer of the team: it commits, branches and merges locally as it likes (that is plain git, in its sandbox), pushes its branches and opens pull requests by itself, and asks when something more is needed.

#### A. Connecting

- With nothing connected, the page only asks where the code lives: **GitHub…**, **GitLab…** or **Gitea / Forgejo…**. Each asks for the address and a token (**Add an account…** adds another later). GitHub: a fine-grained token limited to the repositories Pi works on, with *Contents* and *Pull requests* in read and write (*Administration* too, to let Pi create repositories). GitLab: a token with the `api` scope (a project access token limits it to one project). Gitea / Forgejo: a token with read and write on repositories. Pier checks it with the service before keeping it.
- **Connect a repository…** (`owner/name`) or **Create a repository…** (private by default). The project becomes a git repository if it is not one yet.
- The page then shows the repository, the branch checked out, the **open pull requests** with their checks (✓ passed, ✗ failed, … running), and for each one **copy link** and **merge ▾** (merge, squash and merge, rebase and merge; the repository's method first).
- Two settings, under the repository, saved as soon as they are chosen:

  | **Pi may** | |
  |---|---|
  | **Work locally** | Pi commits and branches in the project; nothing is pushed, no pull request |
  | **Push, ask to merge** (the default) | Pi pushes its `pi/…` branches and opens pull requests; a merge waits for your approval |
  | **Push and merge** | the same, and Pi merges its own pull requests itself (a `pi/…` branch of this repository, not a fork, into the default branch, not a draft) once their checks ran and all passed |

  **Merges**: merge commit, squash or rebase, used for Pi's merges and offered first in **merge ▾**.

#### B. What Pi can do, and what waits for you

Pi gets git tools (from a small extension, `~/.local/state/pier-picker/pi/ext/pier-git.ts`, like the one that says which conversation it holds): `git_repo_info`, `git_push`, `git_pull`, `open_pull_request`, `list_pull_requests`, `pull_request_status`, `request_merge`, `create_repository`.

| Pi asks to | What happens |
|---|---|
| push a branch | not when the repository is set to **Work locally**; otherwise only branches named `pi/…` (the default branch only while the repository is still empty), never forced: a rewritten branch is refused by the forge |
| fetch | the forge's branches land in `origin/*` in the project; Pi merges or rebases itself |
| open, list, read pull requests | done at once (opening one: not with **Work locally**) |
| **merge** a pull request | with **Push, ask to merge**, **never by itself**: the request appears in **Repository > Git > Waiting for you**, with a Windows notification, and is done only when you click **Approve**. It shows the pull request (its title, branches and author) and the commit it is at: if a commit is pushed to it before you answer, nothing is merged, and Pi is told to ask again. So "merge it" said to Pi works, and an instruction hidden in a file cannot merge anything. With **Push and merge**, done at once only for Pi's own pull request (a `pi/…` branch of this repository, not a fork, into the default branch, not a draft) whose checks ran and all passed (GitHub's check runs and commit statuses both), and bound to the commit checked; any other pull request is refused, and one without any check too |
| create a repository | always waits for your approval, whatever the setting |

You can also merge yourself from the list of pull requests, at any time.

#### C. Several Pis: one worktree each

Two Pis in the same folder would step on each other's files. In a git project, the first Pi works in the folder itself, and every other one in a **worktree** of its own, `.pi-worktrees/<its tmux session>`, on a branch `pi/agent-N-…`: each works on its branch, and they come together by merges or pull requests, as a team does.

- What is given to a Pi (`.pi-images`, `.pi-files`, `.pi-shared`) is reached from its worktree through links, so pasted images and files work as before.
- When its Pi ends (or is stopped) without having changed or committed anything, the worktree goes, with its branch. Otherwise it stays, listed in **Repository > Git > Pis' worktrees** (its branch, the files changed, the commits ahead), until you **remove** it; its branch stays either way.
- `.pi-worktrees` is left out of git (its own `.gitignore`, and the repository's `info/exclude`) and of the restore points.
- `worktrees = false` in the picker's config turns this off.
- Known: the worktree holds its own copy of the project's `AGENTS.md`, so a Pi there reads it twice (the worktree's and the folder's); and Activity shows its files under `.pi-worktrees/…`.

#### D. The team: several people, several Pis

Each colleague has their Pier, their VM and their Pis; **they meet in the repository**, as a team of developers does. **Repository > Team** shows, for the project's repository:

- **For you:** the pull requests whose review is asked of your account (**let a Pi review it**), and the conversations a colleague gave you (**take it over**).
- **Tasks:** issues labelled `pi-task`, free or taken by someone's Pi; **let a Pi do it** on a free one, **New task…** to add one (a Pi can also split a large piece of work into tasks).
- **Who works on what:** every open pull request, its author, its branch, its checks, and whose review it waits for.
- **When something waits for your Pis:** do nothing, **notify me** (the default: a notification, a Pi on your click), or **start a Pi by itself** while Pier is connected (one every five minutes, 3 an hour and 10 a day at most, and never on a task a Pi wrote: Pis asking each other cannot start Pis without end). One Pi may make at most 10 tasks or review requests an hour. A Pi only gives back a task its own account took.

Pi gets more git tools for this: `list_tasks`, `get_task`, `create_task`, `claim_task`, `release_task`, `pull_request_diff`, `review_pull_request`, `request_review`.

| Pi asks to | What happens |
|---|---|
| take a task | the issue gets the label `pi-doing` and is assigned to your account; a task already taken is refused, so two Pis never do the same one. The work goes on `pi/task-N`, then a pull request saying "Closes #N" |
| ask a colleague's Pis for a review | the colleague's account is asked as reviewer, with the label `pi-review`; their Pier tells them |
| post a review | with the repository set to **Push, ask to merge**, it waits for your approval in Repository > Git, like a merge, shown whole and bound to the commit Pi reviewed; with **Push and merge**, posted at once, except an **approval**, which always waits for you: a Pi's approval, under your account, would count as a human's review. At most **3 reviews** by one account on one pull request: then a human decides |

**Giving a conversation:** in Conversations, ⋯ > **Give to a colleague…** sends the whole conversation (and its `pi/…` branch, pushed) on a branch `pi-handoff/<colleague>/…` for them. In their Team page, **take it over** adds it to their conversations and opens it in a Pi, with a word on the branch to switch to; the handoff branch is then deleted. The conversation holds everything said in it, including what was pasted: Pier says so before it leaves. **Everyone who can read the repository can read that branch** (and its commit stays readable after it is deleted): Pier refuses to give a conversation in a public repository (on GitLab, an internal one too). Their note is shown in Pier, marked as not verified (anyone who may push could have written that branch), and never typed into Pi.

**Safety:** what colleagues and their Pis wrote (tasks, pull requests, reviews, notes) reaches your Pi marked as written by others, data to read and never orders. A Pi that Pier starts for the team gets its prompt from the picker, written from fixed words and a number, never from a colleague's text. Each Pi acts with its own account's token, never a colleague's.

#### E. Why the token is safe

The token stays on the VM, in `~/.config/pier-picker/forges.json` (readable by you only), which Pi's sandbox does not see. Pi's tools do not hold it: they ask the picker, through a socket given to the sandbox, and the picker checks each request against the rules above before doing it. To push, the picker first fetches Pi's commits, **in git's jail** (no network, the project read-only), into a bare repository of its own (`~/.local/state/pier-picker/git/`), then pushes from there: no hook, filter or setting of the project ever runs with the token. A project whose `.git` file names another repository (rather than a worktree or a submodule of its own) is refused: Pi cannot make the picker push another project's code. git receives the token in its environment, never on a command line, and it is never written to a log.
