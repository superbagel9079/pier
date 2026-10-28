# --- the network Pi may reach -----------------------------------------------------------
#
# With network_limit, Pi's sandbox has a network of its own with nothing in it
# (--unshare-net): Pi cannot connect anywhere by itself. Inside, a small relay of this
# file (--net-bridge) listens on 127.0.0.1:3128 and passes each connection, through a
# Unix socket bound into the sandbox, to NetProxy, which runs out here and accepts only
# HTTP CONNECT to the places allowed. Pi, npm, git and curl use it through the usual
# HTTPS_PROXY variables (NODE_USE_ENV_PROXY for Node's own fetch). Refused attempts are
# logged as net.blocked, with the host: add it to network_allow if Pi needs it.
# An address on the VM itself ("127.0.0.1:8080", a local gateway) is relayed too: the
# relay listens on that port inside, and NetProxy connects to it out here.

NET_DIR = "/tmp/.pier-net"
NET_PROXY_PORT = 3128
PICKER_MODULE = os.path.realpath(__file__)


def parse_allow(entries):
    """Entries of network_allow: (host or ".suffix", port or None) pairs."""
    rules = []
    for entry in entries:
        entry = entry.strip().lower().rstrip(".")
        if not entry:
            continue
        host, _, port = entry.rpartition(":") if entry.count(":") == 1 else (entry, "", "")
        if port and not port.isdigit():
            continue
        rules.append(("127.0.0.1" if host == "localhost" else host, int(port) if port else None))
    return rules


def allowed(rules, host, port):
    host = host.lower().rstrip(".")
    for rule_host, rule_port in rules:
        if rule_port is None and port not in (80, 443):
            continue
        if rule_port is not None and port != rule_port:
            continue
        if rule_host.startswith("."):
            if host.endswith(rule_host) or host == rule_host[1:]:
                return True
        elif host == rule_host:
            return True
    return False


def node_major(env):
    """The major version of the node Pi runs on, None when there is none."""
    node = shutil.which("node", path=env.get("PATH"))
    if not node:
        return None
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().lstrip("v").split(".")[0])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def keepalive(sock):
    """A TCP connection whose other end vanished (a host gone, a Wi-Fi cut) is found
    out within about two minutes, and its relay threads end, rather than waiting forever."""
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, value in (("TCP_KEEPIDLE", 60), ("TCP_KEEPINTVL", 15), ("TCP_KEEPCNT", 4)):
            if hasattr(socket, name):
                sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), value)
    except OSError:
        pass


def relay(a, b):
    """Copies a to b until a closes, then closes b's sending side."""
    try:
        while True:
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    try:
        b.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def relay_both(a, b):
    other = threading.Thread(target=relay, args=(b, a), daemon=True)
    other.start()
    relay(a, b)
    other.join()
    for s in (a, b):
        try:
            s.close()
        except OSError:
            pass


class NetProxy:
    """The proxy Pi's sandbox reaches through its Unix socket: CONNECT host:port to the
    places allowed, nothing else."""

    def __init__(self, project, rules):
        self.project = project
        self.rules = rules
        folder = os.path.join(os.path.dirname(state_path(home_dir())), "net")
        os.makedirs(folder, mode=0o700, exist_ok=True)
        self.socket = os.path.join(folder, f"{os.getpid()}.sock")
        try:
            os.remove(self.socket)
        except OSError:
            pass
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.socket)
        os.chmod(self.socket, 0o600)
        self.server.listen(64)
        self.blocked = {}  # host -> when it was last logged
        threading.Thread(target=self.serve, daemon=True).start()

    def local_ports(self):
        """The ports of the VM itself allowed ("127.0.0.1:8080"): the relay listens there."""
        return [str(port) for host, port in self.rules if port and host in ("127.0.0.1", "localhost")]

    def serve(self):
        while True:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(client,), daemon=True).start()

    def handle(self, client):
        try:
            client.settimeout(30)
            head = b""
            while b"\r\n\r\n" not in head and len(head) < 8192:
                chunk = client.recv(4096)
                if not chunk:
                    client.close()
                    return
                head += chunk
            line = head.split(b"\r\n", 1)[0].decode("latin-1")
            parts = line.split()
            target = parts[1] if len(parts) == 3 and parts[0].upper() == "CONNECT" else ""
            host, _, port = target.rpartition(":")
            host = host.strip("[]")
            if not host or not port.isdigit():
                client.sendall(b"HTTP/1.1 405 Only CONNECT\r\nContent-Length: 0\r\n\r\n")
                client.close()
                return
            port = int(port)
            if not allowed(self.rules, host, port):
                now = time.monotonic()
                if now - self.blocked.get(host, -1e9) > 60:
                    self.blocked[host] = now
                    log("warn", "net.blocked", project=self.project, host=host, port=port,
                        hint="add it to network_allow in ~/.config/pier-picker/config.toml")
                client.sendall(b"HTTP/1.1 403 Not allowed by network_allow\r\nContent-Length: 0\r\n\r\n")
                client.close()
                return
            try:
                upstream = socket.create_connection((host, port), timeout=15)
            except OSError as exc:
                client.sendall(f"HTTP/1.1 502 {exc.strerror or 'unreachable'}\r\nContent-Length: 0\r\n\r\n".encode("latin-1", "replace"))
                client.close()
                return
            upstream.settimeout(None)
            keepalive(upstream)
            client.settimeout(None)
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            rest = head.split(b"\r\n\r\n", 1)[1]
            if rest:
                upstream.sendall(rest)
            relay_both(client, upstream)
        except OSError:
            try:
                client.close()
            except OSError:
                pass

    def close(self):
        try:
            self.server.close()
        except OSError:
            pass
        try:
            os.remove(self.socket)
        except OSError:
            pass


def net_bridge(args):
    """--net-bridge SOCKET [PORT...] -- PROGRAM...: inside Pi's sandbox. Listens on
    127.0.0.1:3128 (the proxy) and on the local ports allowed, passes each connection to
    SOCKET, then runs PROGRAM and ends with it."""
    if "--" not in args or not args:
        print("usage: --net-bridge SOCKET [PORT...] -- PROGRAM", file=sys.stderr)
        return 2
    split = args.index("--")
    path, ports, program = args[0], [int(p) for p in args[1:split] if p.isdigit()], args[split + 1:]

    def listen(port, forward):
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", port))
        server.listen(64)

        def accept():
            while True:
                try:
                    client, _ = server.accept()
                except OSError:
                    return
                keepalive(client)
                threading.Thread(target=forward, args=(client, port), daemon=True).start()

        threading.Thread(target=accept, daemon=True).start()

    def to_proxy(client, port):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
        except OSError:
            client.close()
            return
        relay_both(client, upstream)

    def to_local(client, port):
        # A port of the VM itself: asked of the proxy as CONNECT 127.0.0.1:PORT.
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect(path)
            upstream.sendall(f"CONNECT 127.0.0.1:{port} HTTP/1.1\r\n\r\n".encode())
            answer = b""
            while b"\r\n\r\n" not in answer and len(answer) < 4096:
                chunk = upstream.recv(4096)
                if not chunk:
                    break
                answer += chunk
            if b" 200 " not in answer.split(b"\r\n", 1)[0]:
                raise OSError("refused")
        except OSError:
            client.close()
            upstream.close()
            return
        relay_both(client, upstream)

    try:
        listen(NET_PROXY_PORT, to_proxy)
        for port in ports:
            if port != NET_PROXY_PORT:
                listen(port, to_local)
    except OSError as exc:
        print(f"Pier: the network relay could not start ({exc})", file=sys.stderr)
        return 1
    # The terminal's signals are Pi's: Ctrl+C reaches it, and the relay stays up.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        child = subprocess.Popen(program)
    except OSError as exc:
        print(f"cannot run {program[0]}: {exc.strerror or exc}", file=sys.stderr)
        return 127
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda number, _frame: child.send_signal(number))
    while True:
        try:
            return child.wait()
        except InterruptedError:
            continue


def network_plan(config, env, project):
    """A NetProxy for Pi in project, or (None, why) when Pi's network is not limited."""
    if not config["network_limit"]:
        return None, None
    major = node_major(env)
    if major is not None and major < 24:
        # Node's fetch follows HTTPS_PROXY only from Node 24 on (NODE_USE_ENV_PROXY):
        # limited, Pi could not reach its model at all.
        return None, f"network not limited: Node {major} found, Node 24 or newer is needed (or set network_limit = false)"
    rules = parse_allow(list(NETWORK_ALLOW) + list(config["network_allow"]))
    return NetProxy(project, rules), None


def proxy_env(env):
    """The variables that send Pi, npm, git and curl through the relay."""
    url = f"http://127.0.0.1:{NET_PROXY_PORT}"
    for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        env[name] = url
    env["NO_PROXY"] = env["no_proxy"] = "localhost,127.0.0.1,::1"
    env["NODE_USE_ENV_PROXY"] = "1"
    return env


SANDBOX_MISSING = ("bubblewrap is not installed, and Pi is set to run in a sandbox. "
                   "Install it (sudo apt install bubblewrap), "
                   "or set sandbox = false in ~/.config/pier-picker/config.toml")


def tmux_cmd(*args):
    return ["tmux", "-L", TMUX_SOCKET, *args]


def session_name(path, home):
    """tmux session for Pi in path: readable, and unique through a hash of the full path."""
    rel = os.path.relpath(path, home) if within(path, home) else path
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", rel.replace(os.sep, "_")).strip("-_")[:40] or "home"
    digest = hashlib.sha1(os.fsencode(path)).hexdigest()[:6]
    return f"pi-{slug}-{digest}"


def run_quiet(argv, env=None):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=env, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _ignore_signal(signum, frame):
    """Installed in the picker while a child runs. A handler, not SIG_IGN: exec resets
    handlers to the default in the child, whereas an ignored signal stays ignored."""


def ignore_terminal_signals():
    """Install _ignore_signal for Ctrl-C, Ctrl-\\ and Ctrl-Z; returns what to restore."""
    return {sig: signal.signal(sig, _ignore_signal)
            for sig in (signal.SIGINT, signal.SIGQUIT, signal.SIGTSTP)}


def restore_signals(previous):
    for sig, handler in previous.items():
        signal.signal(sig, handler)


def wait_child(proc):
    """Wait for proc. A child stopped by Ctrl-Z is resumed: under a RemoteCommand there
    is no shell to resume it, the session would hang."""
    while True:
        try:
            _, status = os.waitpid(proc.pid, os.WUNTRACED)
        except ChildProcessError:
            return proc.wait()
        if os.WIFSTOPPED(status):
            os.kill(proc.pid, signal.SIGCONT)
            continue
        proc.returncode = os.waitstatus_to_exitcode(status)
        return proc.returncode


def pause_for_enter(prompt="press Enter to go back to the picker "):
    try:
        sys.stderr.write(prompt)
        sys.stderr.flush()
        sys.stdin.readline()
    except (OSError, ValueError):
        pass


def sync_size():
    """Tell curses about a resize that happened while the child owned the terminal."""
    try:
        size = os.get_terminal_size(sys.__stdout__.fileno())
        curses.resizeterm(size.lines, size.columns)
    except (OSError, ValueError, AttributeError, curses.error):
        pass


def exec_pi(path, extra):
    """Entry point inside a tmux session: run Pi in path with the Hindsight key.

    The key is read here rather than passed on tmux's command line, where any user
    could read it in the process list. A failure at startup holds the pane open so the
    error can be read; otherwise the session would vanish before the attach.
    """
    home = home_dir()
    config, _ = load_config(home)
    env = child_env(home)
    key, _ = read_hindsight_key(home)
    if key:
        env["HINDSIGHT_API_KEY"] = key
    argv = pi_argv(config, env)
    if argv is None:
        print("pi not found on PATH: install it or set PI_BIN")
        log("error", "pi.missing", project=path, path=env.get("PATH"))
        pause_for_enter("press Enter to close ")
        return 1
    pi_exe = argv[0]
    slot = os.environ.get("PI_PICKER_SLOT")
    tracked = []
    if slot and config["track_sessions"]:
        extension = pier_extension()
        if extension:
            tracked = ["--extension", extension]
            env["PIER_STATE"] = pier_state_path(slot)
            forget_pier_state(env["PIER_STATE"])  # what an earlier Pi of that name said
    network = None  # the proxy of a sandbox whose network is limited (see NetProxy)
    broker = None   # Pi's git tools ask it (see GitBroker)
    sessions = []   # descriptors of this project's sessions folders, for the sandbox
    # A Pi beside another in the project works in its own worktree (see make_worktree).
    worktree = worktree_of(os.path.realpath(path), os.environ.get("PIER_WORKTREE"))
    workdir = worktree or path
    git_extension = pier_git_extension() if config["git_tools"] else None
    labs_extension = pier_labs_extension() if labs_enabled(home) else None
    if git_extension or labs_extension:
        try:
            broker = GitBroker(os.path.realpath(path))
        except OSError as exc:
            log("warn", "git.broker-failed", project=path, err=str(exc))
        if broker:
            for extension in (git_extension, labs_extension):
                if extension:
                    tracked = tracked + ["--extension", extension]
            env["PIER_GIT_SOCKET"] = broker.socket
    plain = argv + list(extra)
    argv = argv + tracked + list(extra)
    if sandbox_wanted(config):
        refusal = sandbox_refusal(path, home)
        if refusal:
            print(refusal)
            log("error", "pi.sandbox-refused", project=path)
            pause_for_enter("press Enter to close ")
            return 1
        for key in ("DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR"):
            env.pop(key, None)
        network, unlimited = network_plan(config, env, os.path.realpath(path)) if shutil.which("bwrap") else (None, None)
        if unlimited:
            print(f"Pier: {unlimited}")
            log("warn", "pi.network-unlimited", project=path, why=unlimited)
        if network:
            proxy_env(env)
        git_socket = broker.socket if broker else None
        if broker:
            env["PIER_GIT_SOCKET"] = f"{NET_DIR}/git.sock"  # where the sandbox sees it
        # Refuse rather than run unconfined: a sandbox that silently goes away
        # protects nothing.
        sessions = session_folders(home, os.path.realpath(path), os.path.realpath(workdir))
        argv = sandbox_argv(argv, os.path.realpath(path), home, config, env, network, git_socket, workdir=workdir,
                            sessions=sessions)
        plain = sandbox_argv(plain, os.path.realpath(path), home, config, env, network, git_socket, workdir=workdir,
                             sessions=sessions)
        if argv is None:
            print(SANDBOX_MISSING)
            log("error", "pi.sandbox-missing", project=path)
            pause_for_enter("press Enter to close ")
            return 1
    project = os.path.realpath(path)
    watcher = None
    if config["checkpoints"]:
        # Saved before Pi starts, so that whatever it does first can be undone.
        # A Pi in a worktree of its own changes that folder, not the project (whose points
        # leave .pi-worktrees out), and writes its conversations as that folder's: its
        # points are the worktree's, in a store of their own.
        saved = os.path.realpath(workdir)
        if not os.path.isdir(checkpoint_store(saved)):
            print("Pier: saving the project's first restore point (only the first one takes a while)...", flush=True)
        try:
            checkpoint_create(saved, "start", "Pi started")
        except Exception as exc:  # noqa: BLE001 - Pi starts anyway, without restore points
            log("warn", "checkpoint.start-failed", project=saved, err=str(exc))
            print(f"Pier: no restore point for this session ({exc})")
        file = extra[extra.index("--session") + 1] if "--session" in extra[:-1] else None
        watcher = PromptWatcher(saved, file, os.environ.get("PI_PICKER_SLOT"))
        watcher.start()
    log("info", "pi.start", project=project, sandbox=sandbox_wanted(config), network="limited" if network else "open",
        args=list(extra), pi=pi_exe)
    sandboxed = sandbox_wanted(config)

    def launch(command):
        # In the sandbox, the filter stopping Pi from typing into its terminal (see
        # tiocsti_filter): a fresh pipe each time, bwrap reads it to the end.
        fd = seccomp_pipe() if sandboxed else None
        if fd is not None:
            command = [command[0], "--seccomp", str(fd), *command[1:]]
        kept = [held for held, _ in sessions] + ([] if fd is None else [fd])
        try:
            child = subprocess.Popen(command, cwd=workdir, env=env, pass_fds=kept)
        finally:
            if fd is not None:
                os.close(fd)
        return wait_child(child)

    previous = ignore_terminal_signals()
    started = time.monotonic()
    try:
        status = launch(argv)
        if status and tracked and time.monotonic() - started < 2:
            # Likely a Pi too old for --extension: once more without it.
            log("warn", "pi.without-extension", project=project, status=status)
            env.pop("PIER_STATE", None)
            status = launch(plain)
    except OSError as exc:
        print(f"cannot run pi: {exc.strerror or exc}")
        log("error", "pi.cannot-run", project=project, err=str(exc))
        status = 1
    for held, _ in sessions:
        os.close(held)
    if watcher:
        watcher.stop()
    if network:
        network.close()
    if broker:
        broker.close()
    if worktree:
        end_worktree(os.path.realpath(path), worktree)
    if env.get("PIER_STATE"):
        forget_pier_state(env["PIER_STATE"])
    seconds = round(time.monotonic() - started, 1)
    log("warn" if status else "info", "pi.exit", project=project, status=status, seconds=seconds)
    if status and seconds < 3:
        print(f"pi exited with status {status}")
        pause_for_enter("press Enter to close ")
    restore_signals(previous)
    return status if isinstance(status, int) and status >= 0 else 1


