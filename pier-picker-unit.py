#!/usr/bin/env python3
# subject: unit tests of pier-picker.py that need no VM: no tmux, no bubblewrap, no network,
# no forge. Pure parts (the allowlist, the seccomp program, forges' answers, sessions),
# the watch with parts of its own, the stores and their locks, the git jail's rules, the
# tar walks, the network proxy on a socket pair. Run in the CI at every push; the suite on
# the VM (pier-picker-tests.py) drives the real tmux, bwrap, git and Incus.
#
# Run: python3 -B pier-picker-unit.py   (Python 3.12 or newer; on Windows too, where the
# tests that need Linux's file descriptors or flock are skipped).

import importlib.util
import io
import json
import os
import socket
import sys
import tarfile
import tempfile
import threading
import time
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LINUX = sys.platform.startswith("linux")


def load_picker():
    """pier-picker.py as a module. Without curses (Windows), a stand-in: the picker only
    needs it to draw."""
    try:
        import curses  # noqa: F401
    except ImportError:
        class Curses(types.ModuleType):
            error = Exception

            def __getattr__(self, name):
                if name.startswith(("KEY_", "A_", "COLOR_")):
                    return 0
                raise AttributeError(name)
        sys.modules["curses"] = Curses("curses")
    spec = importlib.util.spec_from_file_location("pier_picker", os.path.join(HERE, "pier-picker.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules["pier_picker"] = module
    spec.loader.exec_module(module)
    return module


m = load_picker()


class Home(unittest.TestCase):
    """Each test in a home of its own: the picker's state and Pi's sessions in it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.realpath(os.path.join(self.tmp.name, "home"))
        os.makedirs(self.home)
        self.saved = {k: os.environ.get(k) for k in ("HOME", "USERPROFILE", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR")}
        os.environ["HOME"] = os.environ["USERPROFILE"] = self.home
        for key in ("XDG_STATE_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"):
            os.environ.pop(key, None)
        m._GUARDED.clear()

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def path(self, *parts):
        return os.path.join(self.home, *parts)

    def write(self, rel, text):
        full = self.path(*rel.split("/"))
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        return full


# --- the sandbox's rules -------------------------------------------------------------------

class AllowList(unittest.TestCase):
    def test_suffixes_hold_against_lookalikes(self):
        rules = m.parse_allow([".github.com", "registry.npmjs.org", "localhost:8080", "bad:port", ""])
        self.assertTrue(m.allowed(rules, "api.github.com", 443))
        self.assertTrue(m.allowed(rules, "github.com", 443))
        self.assertFalse(m.allowed(rules, "evilgithub.com", 443))
        self.assertFalse(m.allowed(rules, "github.com.evil.net", 443))
        self.assertFalse(m.allowed(rules, "api.github.com", 22), "only 80 and 443 without a port")
        self.assertTrue(m.allowed(rules, "127.0.0.1", 8080))
        self.assertFalse(m.allowed(rules, "127.0.0.1", 8081))
        self.assertEqual(len(rules), 3, "an entry with a bad port is left out")

    def test_trailing_dots_and_case(self):
        rules = m.parse_allow(["Registry.NPMJS.org."])
        self.assertTrue(m.allowed(rules, "registry.npmjs.org.", 443))


class Seccomp(unittest.TestCase):
    def test_a_whole_program_or_none(self):
        program = m.tiocsti_filter()
        machine = os.uname().machine if hasattr(os, "uname") else ""
        if machine in m.SECCOMP_ARCHES and sys.byteorder == "little":
            self.assertEqual(len(program) % 8, 0)
            self.assertEqual(len(program) // 8, 12)
        else:
            self.assertIsNone(program)


class Mounts(Home):
    def test_programs_mounted_without_the_pickers_state(self):
        node = self.path(".local", "state", "fnm_multishells", "1", "bin", "node")
        self.assertEqual(m.program_folder(node, self.home), self.path(".local", "state", "fnm_multishells", "1"))
        self.assertEqual(m.program_folder(self.path(".nvm", "v24", "bin", "node"), self.home), self.path(".nvm"))
        self.assertEqual(m.program_folder(self.path(".local", "bin", "pi"), self.home), self.path(".local", "bin"))

    def test_socket_folders_hidden(self):
        hidden = m.run_hidden()
        for folder in m.SOCKET_FOLDERS:
            if os.path.isdir(folder) and not os.path.islink(folder):
                self.assertIn(folder, hidden)


class GitJail(Home):
    def setUp(self):
        super().setUp()
        self.project = self.path("A")
        os.makedirs(self.project)
        self.other = self.path("B", ".git")
        self.write("B/.git/HEAD", "ref: refs/heads/main\n")

    def point(self, target):
        self.write("A/.git", f"gitdir: {target}\n")

    def test_another_repository_is_refused(self):
        self.point(self.other)
        self.assertEqual(m.git_jail_folders(self.project), [self.project])
        with self.assertRaises(m.ApiError):
            m.own_repository(self.project)

    def test_a_worktree_only_when_it_leads_back(self):
        worktree = os.path.join(self.other, "worktrees", "w")
        self.write("B/.git/worktrees/w/HEAD", "x\n")
        self.write("B/.git/worktrees/w/commondir", "../..\n")
        self.write("B/.git/worktrees/w/gitdir", self.path("elsewhere", ".git") + "\n")
        self.point(worktree)
        self.assertEqual(m.git_jail_folders(self.project), [self.project])
        self.write("B/.git/worktrees/w/gitdir", os.path.join(self.project, ".git") + "\n")
        self.assertEqual(m.git_jail_folders(self.project), [self.project, os.path.realpath(self.other)])
        self.assertIsNone(m.own_repository(self.project))

    def test_a_submodule_by_its_core_worktree(self):
        module = self.path("R", ".git", "modules", "A")
        self.write("R/.git/modules/A/HEAD", "x\n")
        self.write("R/.git/modules/A/config", "[core]\n\tworktree = ../../../../A\n")
        self.point(module)
        self.assertEqual(m.git_jail_folders(self.project), [self.project, os.path.realpath(module)])


# --- forges --------------------------------------------------------------------------------

GITHUB = {"kind": "github"}
GITLAB = {"kind": "gitlab"}
GITEA = {"kind": "gitea"}


class Forges(unittest.TestCase):
    def test_pull_requests_the_same_shape(self):
        github = m.pr_from(GITHUB, {"number": 3, "title": "T", "state": "open", "head": {"ref": "pi/x", "sha": "a", "repo": {"id": 1}},
                                    "base": {"ref": "main", "repo": {"id": 1}}, "user": {"login": "leo"}, "draft": False})
        gitlab = m.pr_from(GITLAB, {"iid": 3, "title": "T", "state": "opened", "source_branch": "pi/x", "target_branch": "main",
                                    "sha": "a", "author": {"username": "leo"}, "source_project_id": 7, "target_project_id": 7,
                                    "head_pipeline": {"status": "success"}})
        gitea = m.pr_from(GITEA, {"number": 3, "title": "T", "state": "open", "head": {"ref": "pi/x", "sha": "a", "repo": {"id": 4}},
                                  "base": {"ref": "main", "repo": {"id": 4}}, "user": {"login": "leo"}})
        for pr in (github, gitlab, gitea):
            self.assertEqual((pr["number"], pr["head"], pr["base"], pr["sha"], pr["author"], pr["state"], pr["same_repo"]),
                             (3, "pi/x", "main", "a", "leo", "open", True))
        self.assertEqual(gitlab["checks"], "success")

    def test_a_fork_is_not_the_same_repository(self):
        fork = m.pr_from(GITHUB, {"number": 1, "head": {"ref": "pi/x", "repo": {"id": 2}}, "base": {"ref": "main", "repo": {"id": 1}}})
        self.assertFalse(fork["same_repo"])
        gone = m.pr_from(GITHUB, {"number": 1, "head": {"ref": "pi/x", "repo": None}, "base": {"ref": "main", "repo": {"id": 1}}})
        self.assertFalse(gone["same_repo"], "a deleted fork")
        mr = m.pr_from(GITLAB, {"iid": 1, "source_project_id": 8, "target_project_id": 7})
        self.assertFalse(mr["same_repo"])

    def test_tasks_and_what_a_pi_wrote(self):
        task = m.issue_from(GITHUB, {"number": 9, "title": "x", "state": "open", "labels": [{"name": m.DOING_LABEL}],
                                     "assignees": [{"login": "alex"}], "body": f"do it\n\n{m.PI_WROTE}"})
        self.assertEqual((task["taken"], task["taken_by"], task["assignees"], task["by_pi"]), (True, "alex", ["alex"], True))
        self.assertFalse(m.issue_from(GITHUB, {"number": 1, "body": "by hand"})["by_pi"])

    def test_who_can_read_a_repository(self):
        self.assertTrue(m.repo_is_public(GITHUB, {"private": False}))
        self.assertFalse(m.repo_is_public(GITHUB, {"private": True}))
        self.assertTrue(m.repo_is_public(GITHUB, {}), "unknown counts as readable")
        self.assertTrue(m.repo_is_public(GITLAB, {"visibility": "internal"}))
        self.assertFalse(m.repo_is_public(GITLAB, {"visibility": "private"}))

    def test_an_unchanged_answer_costs_nothing(self):
        import io
        import urllib.error
        seen = []

        class Answer(io.BytesIO):
            headers = {"ETag": 'W/"1"'}

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake(request, timeout):
            seen.append(request.get_header("If-none-match"))
            if seen[-1]:
                raise urllib.error.HTTPError(request.full_url, 304, "Not Modified", {}, io.BytesIO(b""))
            return Answer(b'{"n": 1}')

        saved = m.forge_open
        m.forge_open = fake
        try:
            forge = dict(GITHUB, url="https://github.com", token="t")
            self.assertEqual(m.forge_request(forge, "GET", "/repos/a/b/issues"), {"n": 1})
            self.assertEqual(m.forge_request(forge, "GET", "/repos/a/b/issues"), {"n": 1}, "a 304: the answer kept")
            self.assertEqual(seen, [None, 'W/"1"'])
            m.forge_request(dict(forge, token="other"), "GET", "/repos/a/b/issues")
            self.assertIsNone(seen[-1], "another token, another answer")
        finally:
            m.forge_open = saved
            m._FORGE_ETAGS.clear()

    def test_gitlab_paths_without_a_request(self):
        self.assertEqual(m.repo_api_path(GITLAB, "group/sub/repo"), "/projects/group%2Fsub%2Frepo")
        self.assertEqual(m.repo_api_path(GITHUB, "a/b"), "/repos/a/b")

    def test_pi_branches(self):
        for good in ("pi/x", "pi/task-7", "pi/a/b.c"):
            self.assertTrue(m.PI_BRANCH_RE.fullmatch(good), good)
        for bad in ("main", "pi/", "pi//x", "feature/pi/x", "pi/a b"):
            self.assertFalse(m.PI_BRANCH_RE.fullmatch(bad), bad)


class Checks(unittest.TestCase):
    def setUp(self):
        self.answers = {}
        self.real = m.forge_request
        m.forge_request = lambda forge, method, path, body=None: next(
            (v for k, v in self.answers.items() if k in path), {})

    def tearDown(self):
        m.forge_request = self.real

    def verdict(self, runs, status, total=None):
        self.answers = {"check-runs": {"total_count": len(runs) if total is None else total, "check_runs": runs},
                        "/status": status}
        return m.pr_checks(GITHUB, "me/r", "sha")

    def test_nothing_ran_is_not_passed(self):
        self.assertEqual(self.verdict([], {"state": "pending", "total_count": 0}), "none")

    def test_an_outside_ci_failing_wins(self):
        passed = [{"status": "completed", "conclusion": "success"}]
        self.assertEqual(self.verdict(passed, {"state": "failure", "total_count": 1}), "failure")
        self.assertEqual(self.verdict(passed, {"state": "pending", "total_count": 0}), "success")

    def test_runs_not_all_read_are_pending(self):
        passed = [{"status": "completed", "conclusion": "success"}]
        self.assertEqual(self.verdict(passed, {"total_count": 0}, total=900), "pending")

    def test_the_forge_not_answering(self):
        def failing(*a, **k):
            raise m.ApiError("down")
        m.forge_request = failing
        self.assertEqual(m.pr_checks(GITHUB, "me/r", "sha"), "none")

    def test_auto_merge_only_pis_own(self):
        link = {"repo": "me/r", "default_branch": "main"}
        own = {"head": "pi/x", "same_repo": True, "base": "main", "draft": False, "checks": "success"}
        self.assertIsNone(m.auto_merge_refusal(link, own, 1))
        for change in ({"head": "feature"}, {"same_repo": False}, {"base": "dev"}, {"draft": True},
                       {"checks": "none"}, {"checks": "pending"}, {"checks": "failure"}):
            self.assertIsNotNone(m.auto_merge_refusal(link, {**own, **change}, 1), change)


# --- sessions ------------------------------------------------------------------------------

class Sessions(Home):
    def session(self, *entries, partial=""):
        folder = m.sessions_root()
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "s.jsonl")
        with open(path, "a", encoding="utf-8", newline="\n") as handle:
            for entry in entries:
                handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
            handle.write(partial)
        return path

    @staticmethod
    def assistant(tokens, call=None):
        content = [{"type": "toolCall", "id": call, "name": "edit", "arguments": {"path": "a.py"}}] if call else []
        return {"type": "message", "timestamp": "2026-10-27T10:00:00Z",
                "message": {"role": "assistant", "stopReason": "toolUse" if call else "stop", "model": "m",
                            "usage": {"input": tokens, "output": 1}, "content": content}}

    def test_read_as_it_grows(self):
        path = self.session({"type": "message", "message": {"role": "user", "content": "hi"}}, self.assistant(10, call="c1"))
        calls, finished, usage, last = m.read_session(path)
        self.assertEqual((list(calls), usage["turns"], usage["input"], last), (["c1"], 1, 10, "toolUse"))
        # A line still being written is left for later, then read whole.
        self.session(partial='{"type":"message","message":{"role":"toolResult","toolCallId":"c1"')
        _, finished, _, last = m.read_session(path)
        self.assertEqual((finished, last), ({}, "toolUse"))
        with open(path, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(',"isError":false}}\n')
        _, finished, usage, last = m.read_session(path)
        self.assertEqual((finished, last), ({"c1": False}, "toolResult"))
        self.session(self.assistant(5))
        _, _, usage, last = m.read_session(path)
        self.assertEqual((usage["input"], last), (15, "stop"))

    def test_rewritten_is_read_again(self):
        path = self.session(self.assistant(10))
        m.read_session(path)
        os.remove(path)
        path = self.session(self.assistant(3))
        self.assertEqual(m.read_session(path)[2]["input"], 3)

    def test_a_tool_result_is_not_parsed_whole(self):
        big = {"type": "message", "message": {"role": "toolResult", "toolCallId": "c1", "isError": True,
                                              "content": [{"type": "text", "text": '"role":"x" ' * 20000}]}}
        path = self.session(self.assistant(10, call="c1"), big)
        _, finished, usage, last = m.read_session(path)
        self.assertEqual((finished, usage["input"], last), ({"c1": True}, 10, "toolResult"))
        priced = {"type": "message", "message": {"role": "toolResult", "toolCallId": "c2", "usage": {"input": 7}}}
        self.session(priced)
        self.assertEqual(m.read_session(path)[2]["input"], 17, "a tool that ran a model: its usage counts")

    def test_edits_read_as_they_grow(self):
        path = self.session(self.assistant(1, call="c1"))
        calls, finished = m.session_edits(path)
        self.assertEqual((list(calls), finished), (["c1"], {}))
        self.session({"type": "message", "message": {"role": "toolResult", "toolCallId": "c1", "isError": False}})
        self.assertEqual(m.session_edits(path)[1], {"c1": False})
        self.session(self.assistant(1, call="c2"))
        self.assertEqual(list(m.session_edits(path)[0]), ["c1", "c2"], "the new part only, on top of the old")

    def test_first_prompt_beside_a_screenshot(self):
        path = self.session({"type": "message", "message": {"role": "user", "content": [
            {"type": "text", "text": 'fix the "login" bug'}, {"type": "image", "data": "A" * 300000}]}})
        self.assertEqual(m.first_prompt(path), 'fix the "login" bug')


# --- the watch -----------------------------------------------------------------------------

class Watch(Home):
    def setUp(self):
        super().setUp()
        self.saved_watch = (m.watch_part, m.watch_signature, m.WATCH_TICK, dict(m.WATCH_MIN), dict(m.WATCH_EVERY), m.WATCH_SILENCE)
        m.WATCH_TICK = 0.05
        m.WATCH_MIN = {}
        m.WATCH_EVERY.update(projects=0.2, conversations=0.3)
        self.calls = {"labs": 0, "conv": 0}

        def part(kind, value, home, config):
            if kind == "labs":
                self.calls["labs"] += 1
                time.sleep(1.0)  # a lab host slow to answer
                return {"hosts": self.calls["labs"]}
            if kind == "conversations":
                self.calls["conv"] += 1
                return {"projects": [{"project": "a", "n": 1}, {"project": "b", "n": self.calls["conv"]}], "truncated": False}
            if kind == "approvals":
                raise ValueError("broken part")
            return {"t": time.monotonic()}
        m.watch_part = part
        m.watch_signature = lambda kind, value, home: (kind, self.calls["conv"]) if kind == "conversations" else None
        read, write = os.pipe()
        self.feed = os.fdopen(write, "w")
        self.out = io.StringIO()
        out = self.out

        class Out:
            def write(self, text):
                out.write(text)

            def flush(self):
                pass
        self.thread = threading.Thread(target=m.api_watch, args=(self.home, {}, os.fdopen(read, "r"), Out()), daemon=True)

    def tearDown(self):
        (m.watch_part, m.watch_signature, m.WATCH_TICK, m.WATCH_MIN, every, m.WATCH_SILENCE) = self.saved_watch
        m.WATCH_EVERY.clear()
        m.WATCH_EVERY.update(every)
        try:
            self.feed.close()
        except OSError:
            pass
        if self.thread.ident is not None:
            self.thread.join(5)
        super().tearDown()

    def lines(self):
        return [json.loads(line) for line in self.out.getvalue().splitlines()]

    def send(self, message):
        self.feed.write(json.dumps(message) + "\n")
        self.feed.flush()

    def test_a_slow_part_holds_nothing(self):
        self.thread.start()
        self.send({"labs": True, "ping": 1})
        time.sleep(0.6)
        lines = self.lines()
        self.assertGreaterEqual(sum(1 for l in lines if l["kind"] == "projects"), 2)
        self.assertFalse(any(l["kind"] == "labs" for l in lines))
        time.sleep(1.0)
        self.assertEqual([l["data"] for l in self.lines() if l["kind"] == "labs"], [{"hosts": 1}])

    def test_conversations_as_patches(self):
        self.thread.start()
        self.send({"conversations": True})
        time.sleep(1.2)
        sent = [l for l in self.lines() if l["kind"] == "conversations"]
        self.assertIn("data", sent[0])
        self.assertTrue(len(sent) > 1 and all("patch" in s for s in sent[1:]))
        self.assertEqual(list(sent[1]["patch"]["edited"]), ["b"], "only the project that changed")
        self.assertEqual(sent[1]["patch"]["changed"], {}, "known before: not sent whole")
        self.assertEqual(sent[1]["patch"]["order"], ["a", "b"])

    def test_a_failing_part_says_so(self):
        self.thread.start()
        self.send({"approvals": True})
        time.sleep(0.4)
        errors = [l for l in self.lines() if l["kind"] == "approvals"]
        self.assertTrue(errors and "broken part" in errors[0]["error"])
        self.assertTrue(any(l["kind"] == "projects" for l in self.lines()), "the others go on")

    def test_silence_ends_a_pinging_watch(self):
        m.WATCH_SILENCE = 0.5
        self.thread.start()
        self.send({"ping": 1})
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def test_an_older_pier_is_not_cut_off(self):
        m.WATCH_SILENCE = 0.3
        self.thread.start()
        self.send({"projects": True})
        time.sleep(1.0)
        self.assertTrue(self.thread.is_alive())

    def test_the_end_of_input_ends_it(self):
        self.thread.start()
        self.feed.close()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def test_patch_shape(self):
        before = {"projects": [{"project": "a", "x": 1}, {"project": "b", "x": 1}], "truncated": False}
        now = {"projects": [{"project": "b", "x": 2}, {"project": "c", "x": 1}], "truncated": True}
        patch = m.watch_patch(before, now)
        self.assertEqual(patch["order"], ["b", "c"])
        self.assertEqual(sorted(patch["changed"]), ["c"])
        self.assertEqual(patch["edited"]["b"], {"fields": {"project": "b", "x": 2}, "order": [], "changed": {}})
        self.assertEqual(patch["rest"], {"truncated": True})

    def test_a_working_pi_sends_its_conversation_only(self):
        quiet = {"path": "q", "usage": {"turns": 3}}
        before = {"projects": [{"project": "a", "running": 1, "sessions": [{"path": "w", "usage": {"turns": 1}}, quiet]}]}
        now = {"projects": [{"project": "a", "running": 1, "sessions": [{"path": "w", "usage": {"turns": 2}}, quiet]}]}
        edited = m.watch_patch(before, now)["edited"]["a"]
        self.assertEqual(edited["order"], ["w", "q"])
        self.assertEqual(list(edited["changed"]), ["w"])
        self.assertEqual(edited["fields"], {"project": "a", "running": 1})


# --- stores --------------------------------------------------------------------------------

class Stores(Home):
    def test_a_cut_file_is_kept_aside(self):
        path = m.labs_path(self.home)
        self.write(os.path.relpath(path, self.home).replace(os.sep, "/"), '{"hosts": {"x"')
        self.assertEqual(m.load_labs(self.home)["hosts"], {})
        self.assertTrue(any(".corrupt-" in n for n in os.listdir(os.path.dirname(path))))
        m.save_labs(self.home, {"hosts": {"a": {}}})
        with open(path, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), {"hosts": {"a": {}}})
        self.assertFalse([n for n in os.listdir(os.path.dirname(path)) if n.endswith(".tmp")])

    def test_a_failed_write_leaves_no_copy(self):
        path = self.path("state", "x.json")
        with self.assertRaises(TypeError):
            m.write_json(path, {"bad": object()})
        self.assertFalse([n for n in os.listdir(os.path.dirname(path)) if n.endswith(".tmp")])

    def test_the_lock_is_taken_again_by_its_thread(self):
        with m.labs_lock(self.home):
            with m.labs_lock(self.home):
                pass

    @unittest.skipUnless(LINUX, "flock")
    def test_the_lock_keeps_other_threads_out(self):
        order = []

        def other():
            with m.labs_lock(self.home):
                order.append("other")
        with m.labs_lock(self.home):
            thread = threading.Thread(target=other)
            thread.start()
            time.sleep(0.3)
            order.append("first")
        thread.join(5)
        self.assertEqual(order, ["first", "other"])

    def test_an_expired_lab_whose_delete_failed_stays(self):
        m.save_labs(self.home, {"hosts": {"h": {"kind": "ssh", "host": "x", "user": "u"}}, "labs": {
            "gone": {"host": "h", "expires": 1}, "kept": {"host": "h", "expires": 1}, "fresh": {"host": "h", "expires": time.time() + 3600}}})
        real = m.incus

        def incus(*args, timeout=None, at=None):
            if args[-1] == m.lab_instance("kept"):
                raise m.ApiError("ssh: connect to host x: Connection timed out")
            if args[-1] == m.lab_instance("gone"):
                raise m.ApiError("Error: Instance not found")
            return b""
        m.incus = incus
        try:
            m.labs_expire(self.home)
        finally:
            m.incus = real
        self.assertEqual(sorted(m.load_labs(self.home)["labs"]), ["fresh", "kept"])


@unittest.skipUnless(LINUX, "flock between processes' threads")
class Approvals(Home):
    def test_none_lost_while_another_is_answered(self):
        project = self.path("p")
        os.makedirs(project)
        first = m.ask_approval(self.home, project, "lab", {"machine": "gpu", "op": "lab_run", "command": "a", "what": "a"}, "")
        real = m.approved_action
        m.approved_action = lambda home, approval: (time.sleep(0.5), {"ok": True})[1]
        try:
            answering = threading.Thread(target=m.api_approval_answer, args=(self.home, first["id"], "yes"))
            # A "lab" answer is only marked: a create_repo is carried out, and slow.
            m.change_approval(self.home, first["id"], kind="create_repo")
            answering.start()
            time.sleep(0.1)
            second = m.ask_approval(self.home, project, "lab", {"machine": "gpu", "op": "lab_run", "command": "b", "what": "b"}, "")
            answering.join(5)
        finally:
            m.approved_action = real
        states = {a["id"]: a["state"] for a in m.load_approvals(self.home)}
        self.assertEqual(states.get(second["id"]), "pending")
        self.assertEqual(states.get(first["id"]), "done")


# --- archives ------------------------------------------------------------------------------

class Archives(Home):
    def names(self, root, start, keep=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            m.tar_tree(archive, root, start, ".", keep)
        with tarfile.open(fileobj=io.BytesIO(buffer.getvalue())) as archive:
            return {member.name: member for member in archive.getmembers()}

    @unittest.skipUnless(LINUX and m.SAFE_FD, "file descriptors and links")
    def test_a_link_goes_in_as_a_link(self):
        self.write("secret/key", "private")
        self.write("p/a.txt", "a")
        os.symlink(self.path("secret"), self.path("p", "out"))
        members = self.names(self.path("p"), self.path("p"))
        self.assertTrue(members["./out"].issym())
        self.assertNotIn("./out/key", members)
        self.assertEqual(members["./a.txt"].size, 1)

    @unittest.skipUnless(LINUX and m.SAFE_FD, "file descriptors")
    def test_a_fifo_is_left_out_and_keep_filters(self):
        self.write("p/a.txt", "a")
        self.write("p/.pi-files/x", "given")
        os.mkfifo(self.path("p", "pipe"))
        keep = lambda info: None if ".pi-files" in info.name.split("/") else info
        members = self.names(self.path("p"), self.path("p"), keep)
        self.assertEqual(sorted(members), [".", "./a.txt"])

    def test_extract_takes_files_and_folders_only(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, kind in (("d", tarfile.DIRTYPE), ("d/f", tarfile.REGTYPE), ("d/l", tarfile.SYMTYPE), ("d/h", tarfile.LNKTYPE)):
                info = tarfile.TarInfo(name)
                info.type = kind
                if kind == tarfile.SYMTYPE:
                    info.linkname = "f"
                if kind == tarfile.LNKTYPE:
                    info.linkname = "d/f"
                data = b"x" if kind == tarfile.REGTYPE else b""
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        buffer.seek(0)
        dest = self.path("out")
        os.makedirs(dest)
        self.assertEqual(m.extract_tar(buffer, dest), 2)
        self.assertEqual(sorted(os.listdir(os.path.join(dest, "d"))), ["f"])

    def test_tarfile_versions(self):
        self.assertEqual([m.tarfile_fixed(v) for v in ((3, 12, 3), (3, 12, 11), (3, 13, 1), (3, 13, 4), (3, 14, 0))],
                         [False, True, False, True, True])

    def test_what_a_take_back_compares(self):
        self.assertTrue(m.copy_skips(True, "node_modules"))
        self.assertFalse(m.copy_skips(False, "node_modules"), "deeper: a folder of the user's")
        self.assertTrue(m.copy_skips(False, ".git"))


# --- the network proxy ---------------------------------------------------------------------

@unittest.skipUnless(hasattr(socket, "socketpair") and LINUX, "a Unix socket pair")
class Proxy(Home):
    def ask(self, request, rules):
        proxy = object.__new__(m.NetProxy)
        proxy.project, proxy.rules, proxy.blocked = "p", m.parse_allow(rules), {}
        mine, theirs = socket.socketpair()
        thread = threading.Thread(target=proxy.handle, args=(theirs,), daemon=True)
        thread.start()
        mine.sendall(request)
        mine.settimeout(5)
        answer = mine.recv(4096)
        mine.close()
        thread.join(5)
        return answer

    def test_only_connect(self):
        self.assertIn(b"405", self.ask(b"GET http://x/ HTTP/1.1\r\n\r\n", [".github.com"]))

    def test_a_host_not_allowed(self):
        self.assertIn(b"403", self.ask(b"CONNECT evilgithub.com:443 HTTP/1.1\r\n\r\n", [".github.com"]))

    def test_an_allowed_port_of_the_vm(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        port = server.getsockname()[1]
        answer = self.ask(f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode(), [f"localhost:{port}"])
        server.close()
        self.assertIn(b"200", answer)


# --- labs ----------------------------------------------------------------------------------

class Labs(Home):
    def test_a_removed_host_is_reached_nowhere(self):
        with self.assertRaises(m.ApiError):
            m.lab_host({"hosts": {}, "labs": {}}, {"host": "gone"})
        self.assertEqual(m.lab_host({"hosts": {}}, {}), {"kind": "local"}, "a lab from before hosts: Pi's VM")

    def test_the_key_allows_a_session_only(self):
        self.assertEqual(m.authorized_line("ssh-ed25519 AAAA pier-labs"), "restrict,pty ssh-ed25519 AAAA pier-labs")

    def test_root_is_refused(self):
        with self.assertRaises(m.ApiError) as said:
            m.api_host_add(self.home, "box", "10.0.0.2", "22", "root", "")
        self.assertIn("not root", str(said.exception))

    def test_networks_to_approve(self):
        m.save_labs(self.home, {"hosts": {"h": {"kind": "ssh", "host": "x", "user": "u"}}, "settings": {"network": "open"}})
        real = m.lab_networks
        m.lab_networks = lambda home, at=None, timeout=20: [{"name": "incusbr0", "kind": "nat"}, {"name": "lan", "kind": "vlan"},
                                                            {"name": "inside", "kind": "internal"}]
        try:
            self.assertEqual(m.lab_networks_to_approve(self.home, "h", ["incusbr0", "inside"]), [])
            self.assertEqual(m.lab_networks_to_approve(self.home, "h", ["lan", "incusbr0"]), ["lan"])
            self.assertEqual(m.lab_networks_to_approve(self.home, "h", []), [])
        finally:
            m.lab_networks = real


class Leftovers(Home):
    def test_the_token_stays_on_its_host(self):
        import http.server
        import urllib.request
        seen = {}

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                seen[self.server.server_port] = self.headers.get("Authorization")
                if self.path == "/go":
                    self.send_response(302)
                    self.send_header("Location", f"http://127.0.0.1:{other.server_port}/x")
                    self.end_headers()
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"{}")
        first = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        other = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        for server in (first, other):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            request = urllib.request.Request(f"http://127.0.0.1:{first.server_port}/go", headers={"Authorization": "Bearer t"})
            m.forge_open(request, 5).read()
        finally:
            first.shutdown()
            other.shutdown()
        self.assertEqual(seen[first.server_port], "Bearer t")
        self.assertIsNone(seen[other.server_port], "not sent on to another host")

    def test_a_conversation_of_another_project_sharing_the_folder(self):
        folder = m.sessions_root()
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "s.jsonl")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(json.dumps({"type": "session", "cwd": self.path("a", "b")}) + "\n")
        self.assertFalse(m.session_ran_in(path, self.path("a-b")))
        self.assertTrue(m.session_ran_in(path, self.path("a", "b")))

    def test_no_hash_in_a_file_name_for_tmux(self):
        self.assertFalse(m.said_file_ok(os.path.join(m.sessions_root(), "x#(id).jsonl")))


if __name__ == "__main__":
    unittest.main(verbosity=1)
