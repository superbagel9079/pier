# --- picker ----------------------------------------------------------------------------

class Entry:
    """A listed row. kind: "parent" (..), "dir" (in cwd), "recent", "found" (search)."""

    __slots__ = ("kind", "path", "name", "label", "enterable", "branch", "activity")

    def __init__(self, kind, path, label, enterable=True, branch=None, stamp=0.0):
        self.kind = kind
        self.path = path
        self.name = os.path.basename(path)
        self.label = label
        self.enterable = enterable
        self.branch = branch
        self.activity = stamp

    @property
    def is_parent(self):
        return self.kind == "parent"


def make_entry(kind, path, label):
    return Entry(kind, path, label, is_enterable(path), git_branch(path), activity(path))


class Picker:
    def __init__(self, stdscr, start, grey, config, warning=None):
        self.scr = stdscr
        self.grey = grey
        self.config = config
        self.ignore = set(config["ignore"])
        self.home = home_dir()
        self.state = load_state(self.home)
        self.changed = threading.Event()
        self.git = Background(git_status, self.changed)
        self.previews = Background(preview_info, self.changed)
        self.cwd = self.home
        self.filter = ""
        self.search = None        # the query while the search results are listed, else None
        self.typing = None        # "filter" or "search" while keystrokes go to the query
        self.index = None         # every directory under home, built when f is first used
        self.running = {}         # project -> how many Pis run there
        self.tmux_declined = False
        self.message = warning or ""
        self.entries = []         # every subdirectory of cwd
        self.view = []            # the listed rows
        self.sel = 0              # index into view
        self.offset = 0
        self.rows = 1
        self.goto(start)

    # navigation

    def has_parent(self):
        return self.cwd != self.home and within(self.cwd, self.home)

    def parent(self):
        return os.path.dirname(self.cwd) or os.sep

    def pretty(self, path):
        return pretty_path(path, self.home)

    def load(self):
        # Folders Pi may not run in (~/bin, where the picker is; ~/.ssh...) are not shown:
        # nothing to start there by mistake.
        self.entries = [make_entry("dir", os.path.join(self.cwd, name), clean(name))
                        for name in list_dirs(self.cwd, self.ignore)
                        if openable(os.path.join(self.cwd, name), self.home, self.config)]
        self.running = self.tmux_sessions()

    def recent_entries(self):
        out = []
        for path in self.state["recent"]:
            if len(out) >= self.config["recent_count"]:
                break
            if within(path, self.home) and os.path.isdir(path) and openable(path, self.home, self.config):
                out.append(make_entry("recent", path, self.pretty(path)))
        return out

    def sorted_entries(self):
        if self.state["sort"] == "activity":
            return sorted(self.entries, key=lambda e: -e.activity)
        return self.entries

    def search_results(self):
        needle = (self.search or "").casefold()
        if not needle:
            return []
        self.ensure_index()
        scored = []
        for path, hay, label in self.index:
            score = match_score(needle, hay)
            if score is not None:
                scored.append((score, path, label))
        scored.sort(key=lambda item: item[0])
        return [make_entry("found", path, label) for _, path, label in scored[:SEARCH_SHOWN]]

    def ensure_index(self):
        if self.index is not None:
            return
        self.message = "searching your directories..."
        self.draw()
        self.message = ""
        self.index = []
        # Folders Pi may not run in are left out here, once, rather than at each key.
        for path in walk_dirs(self.home, self.config["search_depth"], self.ignore):
            if not openable(path, self.home, self.config):
                continue
            rel = os.path.relpath(path, self.home)
            self.index.append((path, rel.casefold(), clean(rel)))

    def apply_filter(self, select=None):
        """Rebuild view. select is a path to keep selected; otherwise the first row after '..'."""
        if self.search is not None:
            head, items = [], self.search_results()
        else:
            needle = self.filter.casefold()
            pool = (self.recent_entries() if self.cwd == self.home else []) + self.sorted_entries()
            items = [e for e in pool if needle in e.label.casefold()]
            head = [Entry("parent", self.parent(), "..")] if self.has_parent() else []
        self.view = head + items
        self.git.request([e.path for e in items if e.branch is not None])
        for index, entry in enumerate(self.view):
            if not entry.is_parent and entry.path == select:
                self.sel = index
                return
        self.sel = len(head) if items else 0

    def goto(self, path, select=None):
        path = os.path.realpath(path)
        if not within(path, self.home) or not os.path.isdir(path):
            path = self.home
        self.cwd = path
        self.filter = ""
        self.search = None
        self.typing = None
        self.offset = 0
        self.load()
        self.apply_filter(select)

    def go_up(self):
        if self.has_parent():
            self.goto(self.parent(), select=self.cwd)

    def reload(self):
        """Re-read everything after Pi, a shell or git, which may have changed anything."""
        self.git.forget()
        self.previews.forget()
        self.index = None
        path = self.cwd
        while not os.path.isdir(path) and path != self.home:
            path = os.path.dirname(path)
        if path != self.cwd:
            self.goto(path)
            return
        current = self.current()
        self.load()
        self.apply_filter(current.path if current and not current.is_parent else None)

    def current(self):
        if not self.view:
            return None
        self.sel = max(0, min(self.sel, len(self.view) - 1))
        return self.view[self.sel]

    def keep_path(self):
        current = self.current()
        return current.path if current and not current.is_parent else None

    def selected_dir(self):
        """The highlighted directory when Pi can start in it, else None ('..' is not a project)."""
        entry = self.current()
        if entry is None or entry.is_parent or not entry.enterable:
            return None
        return entry

    def move(self, delta):
        if self.view:
            self.sel = max(0, min(len(self.view) - 1, self.sel + delta))

    def open_current(self):
        entry = self.current()
        if entry is None:
            return
        if entry.is_parent:
            self.go_up()
        elif entry.enterable:
            self.goto(entry.path)
        else:
            self.message = f"cannot open {entry.label}: permission denied"

    def leave_query(self):
        """Esc: drop the filter or the search and go back to the plain listing."""
        keep = self.keep_path() if self.search is None else None
        self.filter = ""
        self.search = None
        self.typing = None
        self.apply_filter(keep)

    # pi and tmux

    def remember(self, path):
        add_recent(self.state, path)
        save_state(self.home, self.state)

    def tmux_sessions(self):
        if not self.config["tmux"] or os.environ.get("TMUX"):
            return {}
        return dict(collections.Counter(s["path"] for s in pi_sessions().values()))

    def is_running(self, path):
        return self.running.get(path, 0) > 0

    def tmux_mode(self):
        """True: run Pi in tmux. False: run it directly. None: the user cancelled.

        Inside tmux already, the picker itself survives a disconnect and Pi with it.
        """
        if not self.config["tmux"] or os.environ.get("TMUX"):
            return False
        if shutil.which("tmux"):
            return True
        if self.tmux_declined:
            return False
        answer = self.choose("tmux is missing, pi stops if the connection drops.  "
                             "i install it   enter run without   esc cancel")
        if answer == "i":
            self.install_tmux()
            return True if shutil.which("tmux") else None
        if answer == "enter":
            self.tmux_declined = True
            return False
        return None

    def install_tmux(self):
        """Install tmux with the system's package manager, in the foreground: sudo asks
        for the password itself, the picker never sees it."""
        for tool, argv in INSTALLERS:
            if shutil.which(tool):
                break
        else:
            self.message = "no known package manager: install tmux yourself"
            return
        if os.geteuid() != 0:
            if not shutil.which("sudo"):
                self.message = f"sudo is missing: as root, run {shlex.join(argv)}"
                return
            argv = ["sudo", *argv]
        self.run_child(argv, self.home, child_env(self.home), "install", pause="always",
                       announce=f"installing tmux: {shlex.join(argv)}")
        if shutil.which("tmux"):
            self.message = "tmux installed"

    def launch_pi(self, path, extra=()):
        env = child_env(self.home)
        argv = pi_argv(self.config, env)
        if argv is None:
            self.message = "pi not found on PATH: install it or set PI_BIN"
            return
        if sandbox_wanted(self.config) and not shutil.which("bwrap"):
            self.message = SANDBOX_MISSING
            return
        mode = self.tmux_mode()
        if mode is None:
            return
        self.remember(path)
        key, warning = read_hindsight_key(self.home)
        if mode:
            self.pi_in_tmux(path, list(extra), env)
        else:
            if list(extra) == ["--new"]:
                extra = []  # without tmux, one Pi at a time, in this terminal
            # The same entry point as in tmux: sandbox, key and restore points in one place.
            # It reports its own startup errors, hence no pause here.
            self.run_child([sys.executable, SCRIPT, "--exec-pi", path, *extra], path, env, "pi", pause="never")
        if warning and not self.message:
            self.message = warning

    def pi_in_tmux(self, path, extra, env):
        """Attach to the Pi already running in path, or start one in a new tmux session.

        Detaching (ctrl-b d) comes back to the picker and leaves Pi running; quitting Pi
        ends the session and comes back too.
        """
        h, w = self.scr.getmaxyx()
        try:
            name, fresh = open_pi(path, extra, env, self.home, w, h)
        except ApiError as exc:
            self.message = str(exc)
            return
        if extra and not fresh:
            self.message = "a pi already runs that conversation: attached to it"
        tmux_server_options(env, self.config)
        if os.environ.get("DEVBOX_REQUEST"):
            # Inside Pier: Pi opens in a Pier tab, which shows it through tmux's
            # control mode, history included. The request is an OSC sequence that only
            # Pier's picker tab acts on; the picker stays here.
            n = slot_number(name, path, self.home)
            request = json.dumps({"project": path, "label": self.pretty(path), "slot": name, "n": n})
            os.write(sys.stdout.fileno(), f"\x1b]7770;open-pi;{request}\x07".encode())
            self.message = f"pi opened in a Pier tab: {self.pretty(path)}" + (f" #{n}" if n > 1 else "")
            self.running = self.tmux_sessions()
            return
        self.run_child(tmux_cmd("attach-session", "-t", f"={name}"), path, env, "tmux", pause="error")

    def stop_pi(self):
        target = self.selected_dir()
        path = target.path if target else self.cwd
        count = self.running.get(path, 0)
        if not count:
            self.message = "no pi running there"
            return
        what = "the pi" if count == 1 else f"the {count} pis"
        answer = self.choose(f"stop {what} in {self.pretty(path)}? unsaved work is lost.  y yes   other key no")
        if answer != "y":
            return
        for pi in project_pis(pi_sessions(), path):
            run_quiet(tmux_cmd("kill-session", "-t", f"={pi['name']}"), child_env(self.home))
            forget_pi_sessions()
        self.running = self.tmux_sessions()
        self.message = "pi stopped" if count == 1 else f"{count} pis stopped"

    def launch_shell(self, path):
        shell = os.environ.get("SHELL") or "/bin/sh"
        self.run_child([shell], path, child_env(self.home), "shell")

    def run_child(self, argv, path, env, name, pause="quick", announce=None):
        """Run argv in path with the whole terminal, then come back to the picker.

        Not exec: replacing the process would close the SSH session when the child quits.
        curses hands the terminal over and takes it back, hence endwin/reset_prog_mode.
        The working directory is fixed before the child starts: Pi reads its project
        config, resources and memory at startup and keys its Hindsight bank on it.

        pause: "quick" holds the screen when the child fails within 3 seconds (a startup
        error to read), "error" when it fails at all, "always" in every case, "never" never.
        """
        if curses.isendwin():
            # Two children in a row with nothing drawn between them (tmux installed,
            # then Pi): curses still counts the terminal as handed over, and endwin
            # fails when called twice. A refresh takes it back first.
            self.scr.refresh()
        curses.def_prog_mode()
        curses.endwin()
        previous = ignore_terminal_signals()
        status, error = None, None
        try:
            if announce:
                print(announce, file=sys.stderr)
            started = time.monotonic()
            try:
                status = wait_child(subprocess.Popen(argv, cwd=path, env=env))
            except OSError as exc:
                error = f"cannot run {name}: {exc.strerror or exc}"
            failed = bool(error or status)
            quick = time.monotonic() - started < 3
            log("warn" if failed else "debug", f"child.{name}", status=status, err=error,
                seconds=round(time.monotonic() - started, 1))
            if pause == "always" or (failed and pause != "never" and (pause == "error" or quick)):
                if failed:
                    print(error or f"{name} exited with status {status}", file=sys.stderr)
                pause_for_enter()
        finally:
            restore_signals(previous)
            curses.reset_prog_mode()
            sync_size()
            self.scr.clear()
            self.scr.refresh()
        if error:
            self.message = error
        elif status:
            self.message = f"{name} exited with status {status}"
        self.reload()

    # directory actions

    def new_dir(self):
        name = self.ask("new dir: ")
        if name is None:
            return
        name = unicodedata.normalize("NFC", name.strip())
        if not name:
            return
        if not valid_name(name):
            self.message = "invalid name: letters, digits, . _ - only, starting with a letter or digit"
            return
        path = os.path.join(self.cwd, name)
        if os.path.isdir(path):
            self.message = f"{name} already exists"
        else:
            try:
                os.mkdir(path)
            except OSError as exc:
                self.message = f"cannot create {name}: {exc.strerror or exc}"
                return
            self.index = None
            self.message = f"created {name}, p launches pi in it"
        self.filter = ""
        self.load()
        self.apply_filter(select=path)

    def clone(self):
        url = self.ask("git clone ")
        if url is None or not url.strip():
            return
        url = url.strip()
        if not valid_clone_url(url):
            self.message = "not a git url: https://, ssh://, git://, file:// or user@host:path"
            return
        name = clone_name(url)
        if not valid_name(name):
            self.message = f"cannot name a directory after {url}"
            return
        target = os.path.join(self.cwd, name)
        if os.path.lexists(target):
            self.message = f"{name} already exists"
            return
        self.run_child(["git", "clone", "--", url, name], self.cwd, child_env(self.home),
                       "git clone", pause="error", announce=f"git clone {url}")
        if os.path.isdir(target):
            self.message = f"cloned {name}, p launches pi in it"
            self.filter = ""
            self.search = None
            self.apply_filter(select=target)

    def rename(self):
        entry = self.selected_dir()
        if entry is None:
            self.message = "select a directory to rename"
            return
        if self.is_running(entry.path):
            self.message = f"a pi runs in {entry.name}: stop it first (x)"
            return
        new = self.ask("rename to: ", entry.name)
        if new is None:
            return
        new = unicodedata.normalize("NFC", new.strip())
        if not new or new == entry.name:
            return
        if not valid_name(new):
            self.message = "invalid name: letters, digits, . _ - only, starting with a letter or digit"
            return
        target = os.path.join(os.path.dirname(entry.path), new)
        if os.path.lexists(target):
            self.message = f"{new} already exists"
            return
        try:
            os.rename(entry.path, target)
        except OSError as exc:
            self.message = f"cannot rename: {exc.strerror or exc}"
            return
        prefix = entry.path + os.sep
        self.state["recent"] = [target + p[len(entry.path):] if p == entry.path or p.startswith(prefix) else p
                                for p in self.state["recent"]]
        save_state(self.home, self.state)
        self.index = None
        self.message = f"renamed to {new}; pi's memory bank stays under the old name"
        self.load()
        self.apply_filter(select=target)

    def toggle_sort(self):
        self.state["sort"] = "activity" if self.state["sort"] == "name" else "name"
        save_state(self.home, self.state)
        self.message = "sorted by recent activity" if self.state["sort"] == "activity" else "sorted by name"
        self.apply_filter(self.keep_path())

    def start_search(self):
        self.search = ""
        self.typing = "search"
        self.offset = 0
        self.ensure_index()
        self.apply_filter()

    # prompts

    def ask(self, label, initial=""):
        """Line editor under the path. Returns the text, or None on Escape."""
        buf = initial
        while True:
            key = self.wait_key((label, buf))
            if key in ENTER:
                return buf
            if key in (ESCAPE, CTRL_C):
                return None
            if key in BACKSPACE:
                buf = buf[:-1]
            elif key == CTRL_U:
                buf = ""
            elif isinstance(key, str) and key.isprintable() and len(buf) < 1024:
                buf += key

    def choose(self, prompt):
        """One key answering prompt: "enter", a character, or None for Escape."""
        while True:
            key = self.wait_key((prompt, ""))
            if key == curses.KEY_RESIZE:
                continue
            if key in ENTER:
                return "enter"
            if key in (ESCAPE, CTRL_C):
                return None
            return key if isinstance(key, str) else None

    def show_help(self):
        drawn = False
        while True:
            if not drawn:
                self.draw_help()
                drawn = True
            key = self.read_key()
            if key == curses.KEY_RESIZE:
                drawn = False
            elif key is not None:
                return

    # drawing

    def input_line(self):
        if self.typing == "filter":
            return ("filter: ", self.filter)
        if self.typing == "search":
            return ("find: ", self.search)
        return None

    def draw(self, input_line=None):
        self.changed.clear()
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        if h < 10 or w < 40:
            put(scr, 0, 0, "terminal too small", 0, w - 1)
            show_cursor(False)
            scr.refresh()
            return
        top = self.draw_banner(w) if h >= BANNER_MIN_ROWS else 1

        width = w - 4
        title = f"find in {self.pretty(self.home)}" if self.search is not None else clean(self.cwd)
        put(scr, top, 2, fit_left(title, width))
        cursor = None
        if input_line:
            label, text = input_line
            shown = fit_left(text, width - text_width(label) - 1)
            put(scr, top + 1, 2, label + shown, 0, width)
            cursor = (top + 1, min(2 + text_width(label) + text_width(shown), w - 3))
        elif self.search is not None:
            put(scr, top + 1, 2, f"find: {self.search}", self.grey, width)
        elif self.filter:
            put(scr, top + 1, 2, f"filter: {self.filter}", self.grey, width)

        list_top = top + 2
        self.rows = max(1, h - 3 - list_top)
        list_w = int(w * 0.55) if self.config["preview"] and w >= PREVIEW_MIN_COLS else w
        self.draw_list(list_top, list_w)
        if list_w < w:
            self.draw_preview(list_top, list_w + 1, w - list_w - 3)
        self.draw_footer(h, w)
        if cursor:
            show_cursor(True)
            scr.move(*cursor)
        else:
            show_cursor(False)
        scr.refresh()

    def draw_banner(self, w):
        logo_w = max(text_width(line) for line in LOGO)
        x = max(2, (w - logo_w) // 2)
        for i, line in enumerate(LOGO):
            put(self.scr, 1 + i, x, line, curses.A_BOLD, w - 2 - x)
        # The logo alone: the version is in Pier (Settings > Picker) and in --version.
        return len(LOGO) + 2

    def git_text(self, entry):
        if not entry.branch:
            return ""
        text = clean(entry.branch)
        status = self.git.get(entry.path)
        if status:
            if status["dirty"]:
                text += "*"
            if status["ahead"]:
                text += f" {AHEAD}{status['ahead']}"
            if status["behind"]:
                text += f" {BEHIND}{status['behind']}"
        return text

    def draw_list(self, list_top, lw):
        scr, rows = self.scr, self.rows
        if self.sel < self.offset:
            self.offset = self.sel
        elif self.sel >= self.offset + rows:
            self.offset = self.sel - rows + 1
        self.offset = max(0, min(self.offset, len(self.view) - rows))

        for i, entry in enumerate(self.view[self.offset:self.offset + rows]):
            y = list_top + i
            index = self.offset + i
            text = "../" if entry.is_parent else entry.label + ("" if entry.label.endswith("/") else "/")
            count = 0 if entry.is_parent else self.running.get(entry.path, 0)
            running = "" if not count else "[pi]" if count == 1 else f"[pi {count}]"
            git = "" if entry.is_parent else fit(self.git_text(entry), (lw - 4) // 3)
            tail_w = text_width(running) + text_width(git) + (2 if running and git else 0)
            text = fit(text, lw - 4 - (tail_w + 2 if tail_w else 0))
            if index == self.sel:
                line = " " + text
                for part in (running, git):
                    if part:
                        line += "  " + part
                line += " " * max(0, lw - 2 - text_width(line))
                put(scr, y, 1, line, curses.A_REVERSE, lw - 2)
                continue
            attr = 0 if entry.is_parent or entry.enterable else self.grey
            put(scr, y, 2, text, attr, lw - 4)
            x = 4 + text_width(text)
            if running:
                put(scr, y, x, running, curses.A_BOLD, lw - 2 - x)
                x += text_width(running) + 2
            if git:
                put(scr, y, x, git, self.grey, lw - 2 - x)

        listed = len(self.view) - (1 if self.view and self.view[0].is_parent else 0)
        if not listed:
            if self.search is not None:
                note = (f"type to find a directory under ~ ({self.config['search_depth']} levels deep)"
                        if not self.search else "nothing found")
            elif self.entries:
                note = "(nothing matches the filter)"
            else:
                note = "(no directories here, n creates one)"
            put(scr, list_top + len(self.view), 2, note, self.grey, lw - 4)
        if self.offset > 0:
            put(scr, list_top, lw - 2, AHEAD if UNICODE else "^", self.grey)
        if self.offset + rows < len(self.view):
            put(scr, list_top + rows - 1, lw - 2, BEHIND if UNICODE else "v", self.grey)

    def draw_preview(self, top, x, width):
        entry = self.current()
        if entry is None or entry.is_parent:
            return
        self.previews.request([entry.path])
        info = self.previews.get(entry.path)
        lines = [(clean(entry.name) + "/", curses.A_BOLD), (self.pretty(entry.path), self.grey)]
        if entry.activity:
            lines.append((f"changed {ago(entry.activity)}", self.grey))
        lines.append(("", 0))
        if self.is_running(entry.path):
            count = self.running.get(entry.path, 0)
            lines.append(("[pi] running: p goes back to it, x stops it" if count == 1 else
                          f"[pi {count}] running: p goes back to the last used, x stops them", curses.A_BOLD))
        if entry.branch:
            detail = f"branch {clean(entry.branch)}"
            status = self.git.get(entry.path)
            if status:
                if status["dirty"]:
                    detail += ", uncommitted changes"
                if status["ahead"] or status["behind"]:
                    detail += f", {status['ahead']} ahead {status['behind']} behind"
            lines.append((detail, 0))
        if info is None:
            lines.append((ELLIPSIS, self.grey))
        else:
            for stamp, subject in info["commits"]:
                lines.append((f"{ago(stamp):>10}  {clean(subject)}", self.grey))
            if info["markers"]:
                lines += [("", 0), ("   ".join(info["markers"]), 0)]
            if info["readme"]:
                lines.append(("", 0))
                lines += [(clean(line), self.grey) for line in info["readme"]]
        for i, (text, attr) in enumerate(lines[:self.rows]):
            put(self.scr, top + i, x, text, attr, width)

    def draw_footer(self, h, w):
        scr = self.scr
        entry = self.current()
        if self.message:
            put(scr, h - 3, 2, self.message, curses.A_BOLD, w - 4)
        else:
            listed = len(self.view) - (1 if self.view and self.view[0].is_parent else 0)
            if self.search is not None:
                count = f"{listed} found"
            elif self.filter:
                count = f"{listed} shown"
            else:
                count = f"{len(self.entries)} dirs"
            if self.state["sort"] == "activity" and self.search is None:
                count += ", by activity"
            detail = f"{count}   {clean(entry.path)}" if entry else count
            put(scr, h - 3, 2, detail, self.grey, w - 4)

        can_open = entry is not None and (entry.is_parent or entry.enterable)
        has_target = self.selected_dir() is not None
        # (text, enabled, priority): on a narrow terminal the highest priorities go first.
        if self.typing:
            segments = [
                ("type to " + ("filter" if self.typing == "filter" else "find"), True, 0),
                ("up/down move", len(self.view) > 1, 3),
                ("right open", can_open, 2),
                ("enter keep", True, 1),
                ("esc clear", True, 1),
            ]
        else:
            segments = [
                ("up/down move", len(self.view) > 1, 7),
                ("enter open", can_open, 3),
                ("left up", self.has_parent() or self.search is not None, 6),
                ("p pi", has_target, 1),
                ("P here", True, 4),
                ("c continue", has_target, 5),
                ("/ filter", True, 5),
                ("f find", True, 4),
            ]
            if self.filter or self.search is not None:
                segments.append(("esc back", True, 2))
            segments += [("? help", True, 0), ("q quit", True, 0)]
        room = w - 4
        kept = set()
        for index in sorted(range(len(segments)), key=lambda i: segments[i][2]):
            cost = len(segments[index][0]) + (2 if kept else 0)
            if cost <= room:
                kept.add(index)
                room -= cost
        x = 2
        for index, (text, enabled, _) in enumerate(segments):
            if index in kept:
                put(scr, h - 2, x, text, 0 if enabled else self.grey)
                x += len(text) + 2

    def draw_help(self):
        scr = self.scr
        scr.erase()
        h, w = scr.getmaxyx()
        put(scr, 1, 2, "keys", curses.A_BOLD)
        key_w = max(len(k) for k, _ in HELP) + 3
        y = 3
        for keys, what in HELP:
            put(scr, y, 4, keys, curses.A_BOLD, w - 6)
            put(scr, y, 4 + key_w, what, 0, w - 6 - key_w)
            y += 1
        y += 1
        for note in HELP_NOTES:
            put(scr, y, 4, note, self.grey, w - 6)
            y += 1
        put(scr, y + 1, 4, f"settings: {self.pretty(config_path(self.home))}", self.grey, w - 6)
        put(scr, h - 2, 2, "any key to go back", self.grey, w - 4)
        show_cursor(False)
        scr.refresh()

    # input

    def read_key(self):
        try:
            return self.scr.get_wch()
        except curses.error:
            return None  # timeout

    def wait_key(self, input_line=None):
        """Draw, then wait for a key, redrawing whenever background results come in."""
        self.draw(input_line)
        checked = time.monotonic()
        while True:
            key = self.read_key()
            if key is not None:
                return key
            redraw = self.changed.is_set()
            # Pis start and stop elsewhere too (a Pier tab, Setup, Ctrl+D in Pi): the
            # [pi] marks follow, checked every 2 s while no key comes.
            if time.monotonic() - checked > 2:
                checked = time.monotonic()
                running = self.tmux_sessions()
                if running != self.running:
                    self.running = running
                    redraw = True
            if redraw:
                self.draw(input_line)

    def run(self):
        while True:
            key = self.wait_key(self.input_line())
            if key == curses.KEY_RESIZE:
                continue
            self.message = ""
            if key == CTRL_C:
                return
            if self.typing:
                self.typing_key(key)
            elif self.normal_key(key):
                return

    def typing_key(self, key):
        attr = "filter" if self.typing == "filter" else "search"
        text = getattr(self, attr)
        if key in ENTER:
            self.typing = None
        elif key == ESCAPE:
            self.leave_query()
        elif key in BACKSPACE:
            if text:
                setattr(self, attr, text[:-1])
                self.apply_filter()
            elif attr == "filter":
                self.typing = None
            else:
                self.leave_query()
        elif key == CTRL_U:
            setattr(self, attr, "")
            self.apply_filter()
        elif key == curses.KEY_UP:
            self.move(-1)
        elif key == curses.KEY_DOWN:
            self.move(1)
        elif key == curses.KEY_PPAGE:
            self.move(-self.rows)
        elif key == curses.KEY_NPAGE:
            self.move(self.rows)
        elif key == curses.KEY_RIGHT:
            self.open_current()
        elif key == curses.KEY_LEFT:
            if self.search is not None:
                self.leave_query()
            else:
                self.go_up()
        elif isinstance(key, str) and key.isprintable():
            setattr(self, attr, text + key)
            self.apply_filter()

    def normal_key(self, key):
        """Handle one key outside query typing. True means quit."""
        target = self.selected_dir()
        if key in (curses.KEY_UP, "k"):
            self.move(-1)
        elif key in (curses.KEY_DOWN, "j"):
            self.move(1)
        elif key == curses.KEY_PPAGE:
            self.move(-self.rows)
        elif key == curses.KEY_NPAGE:
            self.move(self.rows)
        elif key == curses.KEY_HOME:
            self.sel = 0
        elif key == curses.KEY_END:
            self.sel = max(0, len(self.view) - 1)
        elif key in (curses.KEY_RIGHT, "l") or key in ENTER:
            self.open_current()
        elif key in (curses.KEY_LEFT, "h") or key in BACKSPACE:
            if self.search is not None:
                self.leave_query()
            else:
                self.go_up()
        elif key in ("p", "c", "r", "N"):
            if target is None:
                self.message = "select a directory first (P starts pi here)"
            else:
                extra = {"p": [], "N": ["--new"], "c": self.config["continue_args"], "r": self.config["resume_args"]}[key]
                self.launch_pi(target.path, extra)
        elif key == "P":
            self.launch_pi(self.cwd)
        elif key == "x":
            self.stop_pi()
        elif key == "s":
            self.launch_shell(target.path if target else self.cwd)
        elif key == "n":
            self.new_dir()
        elif key == "g":
            self.clone()
        elif key == "R":
            self.rename()
        elif key == "t":
            self.toggle_sort()
        elif key == "/":
            if self.search is not None:
                self.leave_query()
            self.typing = "filter"
        elif key == "f":
            self.start_search()
        elif key == "?":
            self.show_help()
        elif key == CTRL_L:
            self.scr.clear()
        elif key == ESCAPE:
            if not self.filter and self.search is None:
                return True
            self.leave_query()
        elif key == "q":
            return True
        return False


def main(stdscr, start, config, warning):
    # raw: Ctrl-C and Ctrl-Z reach the picker as keys. As signals, Ctrl-C would kill
    # it with a traceback and Ctrl-Z would stop it with no shell to resume it.
    curses.raw()
    stdscr.keypad(True)
    stdscr.timeout(150)
    show_cursor(False)
    grey = curses.A_DIM
    if curses.has_colors():
        curses.start_color()
        try:
            curses.use_default_colors()
        except curses.error:
            pass
        if curses.COLORS >= 16:
            curses.init_pair(1, 8, -1)
            grey = curses.color_pair(1)
    Picker(stdscr, start, grey, config, warning).run()


def resolve_start(argv, config):
    """The directory given on the command line, else the configured one, kept inside home."""
    home = home_dir()
    for candidate in (argv[1] if len(argv) > 1 else None, config["start"]):
        if not candidate:
            continue
        candidate = os.path.realpath(os.path.expanduser(candidate))
        if os.path.isdir(candidate) and within(candidate, home):
            return candidate
    return home


USAGE = """usage: pier-picker.py [DIR]
       pier-picker.py --attach DIR [PI ARGS]
       pier-picker.py --api COMMAND [ARGS]   (see the desktop client API section)

Pick a directory under your home and start Pi in it. Press ? inside for the keys.
--attach and --api serve the desktop client over SSH.
Settings: ~/.config/pier-picker/config.toml"""


def entry():
    """The command line. Run as a script, or through the launcher Pier installs
    (~/bin/pi-pick importing this file as a module, so that Python keeps it compiled)."""
    if len(sys.argv) >= 2 and sys.argv[1] == "--net-bridge":
        sys.exit(net_bridge(sys.argv[2:]))  # inside Pi's sandbox: nothing of home to move
    migrate_old_name(home_dir())
    if len(sys.argv) >= 3 and sys.argv[1] == "--exec-pi":
        sys.exit(exec_pi(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 2 and sys.argv[1] == "--api":
        sys.exit(run_api(sys.argv[2:]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--download-files":
        sys.exit(download_files(home_dir(), sys.argv[2]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--download":
        sys.exit(download_tar(home_dir(), sys.argv[2]))
    if len(sys.argv) >= 4 and sys.argv[1] == "--share-serve":
        sys.exit(share_serve(sys.argv[2], sys.argv[3]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--attach":
        sys.exit(attach(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 3 and sys.argv[1] == "--attach-control":
        sys.exit(attach_control(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) == 3 and sys.argv[1] == "--lab-shell":
        sys.exit(lab_shell(sys.argv[2]))
    if len(sys.argv) >= 2 and sys.argv[1] == "--pi-package":
        sys.exit(pi_package(sys.argv[2:]))
    if len(sys.argv) >= 2 and sys.argv[1] == "--pi-update":
        sys.exit(pi_update(sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help"):
        print(USAGE)
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "--version":
        print(VERSION)
        sys.exit(0)
    # ncurses waits ESCDELAY after a lone Escape before delivering it, one second by
    # default: Escape to quit feels broken. 100 ms still reassembles an arrow sequence
    # that arrives split, and quits promptly.
    os.environ.setdefault("ESCDELAY", "100")
    loaded, problem = load_config(home_dir())
    try:
        curses.wrapper(main, resolve_start(sys.argv, loaded), loaded, problem)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as exc:
        log("error", "picker.crash", trace=traceback.format_exc(), err=f"{type(exc).__name__}: {exc}")
        raise


if __name__ == "__main__":
    entry()
