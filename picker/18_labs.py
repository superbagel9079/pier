# --- labs: machines where Pi may do anything -------------------------------------------
#
# An option, off until the user turns it on (Settings > Labs): Pi's sandbox stays as it
# is, and Pi gets tools to use machines of its own besides.
#   - lab hosts: where labs are made, each with Incus. None until the user adds one: a VM
#     reached over SSH (the picker runs `incus` there), or Pi's own VM ("pi-vm", only if
#     the user chooses it). One is the default; a lab may name another.
#   - labs: disposable Incus containers (or virtual machines when the host has /dev/kvm)
#     on a lab host, made by Pi or the user. Root inside, nothing of the host or of home
#     inside, only what Pi copies in. Limits on CPU, memory and disk, a lifetime after
#     which they go, a "clean" snapshot to go back to, the networks chosen.
#   - machines: computers the user adds, reached over SSH with a key the picker makes and
#     keeps (Pi never sees it). Each has a rule: Pi's commands run freely, or each waits
#     for the user's approval in Pier.
# Pi reaches both through the broker socket (lab_* operations), never directly: its
# sandbox has no network to them. Every command is written to the labs journal.

# network: "open" (Incus's own NAT, the default), "none" (cut), or "vlan": the labs on an
# Incus network the admin made once on a second card of the VM (vlan_network), a VLAN of
# the firewall (pfSense...) that gives them their addresses and rules.
LABS_DEFAULTS = {"enabled": False, "max": 3, "ttl_hours": 24, "network": "open", "cpu": 2, "memory_gib": 4,
                 "disk_gib": 20, "image": "debian/13", "vlan_network": "pier-labs", "default_host": ""}
LOCAL_HOST = "pi-vm"  # Pi's own VM, as a lab host: only when the user adds it
LAB_NAME_RE = re.compile(r"[a-z][a-z0-9-]{0,39}")
LAB_IMAGE_RE = re.compile(r"[a-z0-9][a-z0-9._/-]{0,60}")
LAB_HOST_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9A-Fa-f:]+\]")
LAB_USER_RE = re.compile(r"[a-z_][a-z0-9_-]{0,31}")
LAB_RUN_MAX = 900
LAB_OUTPUT = 60 * 1024
LAB_PROCESSES = 2000  # at most, in a container lab
LAB_SNAPSHOTS = 10   # at most per lab, "clean" counted
LAB_COPY_MAX = 900  # seconds a lab_push or lab_pull may take
LAB_PUSH_SKIP = {IMAGE_DIR, FILES_DIR, SHARE_DIR, ".pi-worktrees"}
LAB_APPROVAL_WAIT = 600
LAB_ASK_MAX = 4000  # a command waiting for the user's approval is shown whole: no longer than this


def labs_dir():
    folder = os.path.join(os.path.dirname(state_path(home_dir())), "labs")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    return folder


def labs_path(home):
    return os.path.join(os.path.dirname(state_path(home)), "labs.json")


def load_labs(home):
    data = private_json(labs_path(home))
    settings = dict(LABS_DEFAULTS)
    settings.update({k: v for k, v in (data.get("settings") or {}).items() if k in LABS_DEFAULTS})
    return {"settings": settings, "labs": data.get("labs") if isinstance(data.get("labs"), dict) else {},
            "machines": data.get("machines") if isinstance(data.get("machines"), dict) else {},
            "hosts": data.get("hosts") if isinstance(data.get("hosts"), dict) else {},
            "network_notes": data.get("network_notes") if isinstance(data.get("network_notes"), dict) else {}}


def save_labs(home, data):
    save_private_json(labs_path(home), data)


def labs_lock(home):
    """labs.json is changed by Pier's commands and by every Pi's broker at once: each
    change is made under this lock, on what the file holds then."""
    return file_lock(labs_path(home) + ".lock")


def changing_labs(function):
    """function(home, ...) run under labs_lock: it reads labs.json, changes it and saves it
    as one step."""
    import functools

    @functools.wraps(function)
    def run(home, *args, **kwargs):
        with labs_lock(home):
            return function(home, *args, **kwargs)
    return run


def lab_instance(name):
    return f"pier-{name}"


def incus_argv(at, *args):
    """The command line of `incus ARGS` on a lab host: here for Pi's VM, over SSH (the
    picker's key) for another."""
    if not at or at.get("kind") == "local":
        return ["incus", *args]
    return ssh_argv(at, shlex.join(["incus", *args]))


def incus(*args, data=None, timeout=120, stream=None, at=None):
    """The incus command line on a lab host, as the user (in its incus group): stdout, or an
    ApiError with incus's message."""
    if (not at or at.get("kind") == "local") and not shutil.which("incus"):
        raise ApiError("Incus is not installed on Pi's VM: see Settings > Labs")
    try:
        result = subprocess.run(incus_argv(at, *args), input=data, stdout=stream or subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, env=dict(os.environ, LC_ALL="C"))
    except subprocess.TimeoutExpired:
        raise ApiError(f"incus {args[0]} took over {timeout} s")
    except OSError as exc:
        raise ApiError(f"incus failed: {exc}")
    if result.returncode != 0:
        raise ApiError(result.stderr.decode("utf-8", "replace").strip()[-400:] or f"incus {args[0]} failed")
    return result.stdout or b""


def incus_state(at=None, timeout=20):
    """(usable, why, kvm): whether labs can be made on a lab host."""
    local = not at or at.get("kind") == "local"
    if local and not shutil.which("incus"):
        return False, "Incus is not installed", False
    try:
        info = json.loads(incus("query", "/1.0", timeout=timeout, at=at) or b"{}")
    except (ApiError, ValueError) as exc:
        return False, f"Incus does not answer ({str(exc)[:200]}): installed, and the user in the incus group?", False
    drivers = str((info.get("environment") or {}).get("driver") or "")
    kvm = "qemu" in drivers and (not local or os.path.exists("/dev/kvm"))
    # Labs are safe on a host only through a restricted Incus project (incus-user gives
    # one to each account of the incus group): there, no lab can be privileged nor
    # reach the host's files. An unrestricted one (incus-admin, root) is refused.
    project = str((info.get("environment") or {}).get("project") or info.get("project") or "default")
    try:
        config = json.loads(incus("query", f"/1.0/projects/{project}", timeout=timeout, at=at) or b"{}").get("config")
    except (ApiError, ValueError):
        config = None  # not readable from this account: not one that runs the whole Incus
    if isinstance(config, dict) and str(config.get("restricted", "")).lower() != "true":
        return False, (f"the Incus project {project} is not restricted: use an account in the incus group (not incus-admin "
                       "nor root), whose own project Incus restricts"), kvm
    return True, "", kvm


def host_record(data, name):
    """A lab host by name: Pi's VM (when the user added it) or an SSH host; None if not one."""
    record = data["hosts"].get(name)
    if not isinstance(record, dict):
        return None
    return {"kind": "local"} if record.get("kind") == "local" else record


def lab_host(data, lab):
    """Where a lab lives. Labs made before hosts existed live on Pi's VM. A lab whose host
    was removed is reached nowhere (ApiError), never looked for on Pi's VM instead."""
    if not lab.get("host"):
        return host_record(data, LOCAL_HOST) or {"kind": "local"}
    record = host_record(data, lab["host"])
    if record is None:
        raise ApiError(f"the lab host {lab['host']} was removed: add it again in Settings > Labs to reach its labs")
    return record


def default_host(data):
    """The host a new lab goes to: the one marked default, else the only one, else None."""
    hosts = data["hosts"]
    chosen = data["settings"].get("default_host")
    if chosen in hosts:
        return chosen
    return next(iter(sorted(hosts)), None) if len(hosts) == 1 else (sorted(hosts)[0] if hosts else None)


def labs_expire(home):
    """Labs past their lifetime go. One whose host did not delete it (off, unreachable)
    stays listed, and goes at a later look: forgotten here, it would run there for good,
    out of Pier's sight. labs.json is changed under its lock, the deletes made outside."""
    data = load_labs(home)
    now = time.time()
    gone = [n for n, lab in data["labs"].items() if lab.get("expires") and lab["expires"] < now and not lab.get("building")]
    deleted = []
    for name in gone:
        try:
            incus("delete", "--force", lab_instance(name), timeout=120, at=lab_host(data, data["labs"][name]))
        except ApiError as exc:
            if "not found" not in str(exc).lower():
                log("warn", "lab.expire-failed", lab=name, err=str(exc))
                continue
        deleted.append(name)
        log("info", "lab.expired", lab=name)
    if deleted:
        with labs_lock(home):
            data = load_labs(home)
            for name in deleted:
                data["labs"].pop(name, None)
            save_labs(home, data)


def lab_journal(entry):
    entry = {"at": int(time.time()), **entry}
    path = os.path.join(labs_dir(), "journal.jsonl")
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        if os.path.getsize(path) > 2 * 1024 * 1024:  # the last half kept
            with open(path, "rb") as handle:
                tail = handle.read()[-1024 * 1024:]
            atomic_write(path, tail.split(b"\n", 1)[-1].decode("utf-8", "replace"), labs_dir(), 0o600)
    except OSError:
        pass


def api_lab_journal(home, limit="60"):
    path = os.path.join(labs_dir(), "journal.jsonl")
    try:
        with open(path, "rb") as handle:
            lines = handle.read()[-512 * 1024:].decode("utf-8", "replace").splitlines()
    except OSError:
        lines = []
    out = []
    try:
        count = max(1, min(int(limit or 60), 300))
    except ValueError:
        raise ApiError("how many lines: a number")
    for line in lines[-count:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return {"journal": list(reversed(out))}


def machine_key():
    """The picker's own SSH key for the machines (made once): (private path, public text)."""
    key = os.path.join(labs_dir(), "id_ed25519")
    if not os.path.exists(key):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "pier-labs", "-f", key],
                       check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    with open(key + ".pub", encoding="utf-8") as handle:
        return key, handle.read().strip()


def authorized_line(public):
    """The picker's key as a line of authorized_keys that allows commands and terminals
    only: no forwarding of ports, agent or X11 (restrict), a terminal again (pty)."""
    return f"restrict,pty {public}" if public else public


def host_fingerprint(machine):
    """The SHA-256 fingerprint of the key a lab host or machine showed at its first
    contact, as known_hosts holds it, or None: shown in Pier, to compare with the host's
    own (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub)."""
    port = int(machine.get("port") or 22)
    name = machine.get("host") if port == 22 else f"[{machine.get('host')}]:{port}"
    try:
        found = subprocess.run(["ssh-keygen", "-l", "-E", "sha256", "-F", name, "-f", os.path.join(labs_dir(), "known_hosts")],
                               capture_output=True, timeout=10, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.search(rb"SHA256:[A-Za-z0-9+/=]+", found.stdout)
    return match.group(0).decode() if match else None


def ssh_control_dir():
    """Where the SSH connections to lab hosts and machines stay open a little (only this
    account may enter)."""
    folder = os.path.join(labs_dir(), "ssh")
    os.makedirs(folder, mode=0o700, exist_ok=True)
    return folder


def ssh_argv(machine, command=None, tty=False):
    key, _ = machine_key()
    # One connection kept two minutes and shared: the Labs tab asks a host every minute,
    # each time over a new connection (and a line in its auth log) otherwise.
    argv = ["ssh", "-i", key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
            "-o", "ControlMaster=auto", "-o", f"ControlPath={os.path.join(ssh_control_dir(), '%C')}", "-o", "ControlPersist=120",
            "-o", f"UserKnownHostsFile={os.path.join(labs_dir(), 'known_hosts')}", "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-p", str(int(machine.get("port") or 22))]
    if tty:
        argv.append("-t")
    argv += [f"{machine['user']}@{machine['host']}"]
    if command is not None:
        argv += ["--", command]
    return argv


def lab_target(home, project, name):
    """("lab", record) or ("machine", record): what a lab name stands for, for project's Pi."""
    data = load_labs(home)
    if not data["settings"]["enabled"]:
        raise ApiError("labs are off: the user turns them on in Pier (Settings > Labs)")
    if name in data["machines"]:
        return "machine", data["machines"][name]
    lab = data["labs"].get(name)
    if not lab:
        raise ApiError(f"no lab or machine named {name}: see lab_list")
    if project and lab.get("project") != project:
        raise ApiError(f"the lab {name} belongs to another project")
    return "lab", {**lab, "_at": lab_host(data, lab)}


# A lab host that did not answer is left alone this long (seconds): one that is off cost
# the SSH connection's wait at every look.
HOST_REST = 60
_HOST_RESTING = {}  # host name -> until when (monotonic)


def api_labs(home):
    """Settings > Labs and the Labs tab: whether labs can be made, the labs, the machines."""
    labs_expire(home)
    data = load_labs(home)
    live, hosts = {}, []
    for host_name in sorted(data["hosts"]):
        at = host_record(data, host_name)
        resting = _HOST_RESTING.get(host_name, 0) - time.monotonic()
        if resting > 0:
            usable, why, kvm = False, f"did not answer: asked again in {int(resting) + 1} s", False
        else:
            usable, why, kvm = incus_state(at, timeout=8)
            if not usable and at.get("kind") != "local":
                _HOST_RESTING[host_name] = time.monotonic() + HOST_REST
            else:
                _HOST_RESTING.pop(host_name, None)
        record = data["hosts"][host_name]
        hosts.append({"name": host_name, "kind": "local" if at.get("kind") == "local" else "ssh",
                      "fingerprint": None if at.get("kind") == "local" else host_fingerprint(record),
                      "where": "Pi's VM" if at.get("kind") == "local" else f"{record.get('user')}@{record.get('host')}:{record.get('port') or 22}",
                      "description": record.get("description") or "", "default": host_name == default_host(data),
                      "incus": usable, "why": why, "kvm": kvm, "networks": lab_networks(home, at, timeout=8) if usable else []})
        if not usable:
            continue
        try:
            for item in json.loads(incus("list", "pier-", "--format", "json", timeout=15, at=at) or b"[]"):
                state = item.get("state") or {}
                interfaces = [{"name": nic, "address": next((a.get("address") for a in info.get("addresses", [])
                                                             if a.get("family") == "inet" and a.get("scope") == "global"), None)}
                              for nic, info in sorted((state.get("network") or {}).items()) if nic != "lo"]
                live[(host_name, item.get("name"))] = {"status": item.get("status"), "type": item.get("type"),
                                          "memory": (state.get("memory") or {}).get("usage"),
                                          "interfaces": interfaces,
                                          "address": next((i["address"] for i in interfaces if i["address"]), None)}
        except (ApiError, ValueError):
            pass
    labs = []
    for name, lab in sorted(data["labs"].items()):
        where = lab.get("host") or LOCAL_HOST
        labs.append({"name": name, **lab, "host": where, **live.get((where, lab_instance(name)), {"status": "unreachable" if where not in data["hosts"] and where != LOCAL_HOST else "missing"})})
    machines = [{"name": n, **{k: m.get(k) for k in ("host", "port", "user", "policy", "added", "description")}} for n, m in sorted(data["machines"].items())]
    try:
        public_key = authorized_line(machine_key()[1]) if data["machines"] or data["settings"]["enabled"] else None
    except (OSError, subprocess.SubprocessError):
        public_key = None
    main = next((h for h in hosts if h["default"]), None)
    networks = main["networks"] if main else []
    names = [n["name"] for n in networks]
    vlan = {"network": data["settings"].get("vlan_network") or "pier-labs", "networks": names, "host": main and main["name"]}
    vlan["ready"] = vlan["network"] in names
    why = main["why"] if main else "no lab host yet: add one in Settings > Labs (another VM with Incus, or Pi's VM)"
    return {"settings": data["settings"], "incus": bool(main and main["incus"]), "why": why, "kvm": bool(main and main["kvm"]),
            "labs": labs, "machines": machines, "hosts": hosts, "default_host": main and main["name"],
            "public_key": public_key, "vlan": vlan, "networks": networks, "default_networks": default_networks(data["settings"])}


# The networks a lab may be plugged into: those Incus lets this account use (a restricted
# project lists only them). Three kinds, told apart by their settings:
#   nat       a bridge with NAT (Incus's own, incusbr-*): the internet through the VM,
#             unseen by the firewall and the LAN;
#   vlan      a macvlan on a card of the VM (often with vlan=N on a trunk): a machine of its
#             own on a VLAN of the firewall, which gives its address and applies its rules;
#   internal  a bridge without NAT: between the labs on it only, for routers, DMZs, VPNs.
LAB_NETWORK_KINDS = {"nat": "the internet through the host (NAT)", "vlan": "a VLAN of your firewall",
                     "internal": "between labs only", "other": "an Incus network"}


def lab_networks(home, at=None, timeout=20):
    try:
        items = json.loads(incus("network", "list", "--format", "json", timeout=timeout, at=at) or b"[]")
    except (ApiError, ValueError):
        return []
    said = load_labs(home).get("network_notes") or {}
    out = []
    for item in items:
        name, config = item.get("name"), item.get("config") or {}
        if not name or not item.get("managed", True) or item.get("type") not in ("bridge", "macvlan", "sriov", "physical"):
            continue
        if item.get("type") == "bridge":
            kind = "internal" if str(config.get("ipv4.nat", "true")).lower() == "false" else "nat"
        else:
            kind = "vlan"
        out.append({"name": name, "kind": kind, "kind_label": LAB_NETWORK_KINDS[kind], "type": item.get("type"),
                    "address": config.get("ipv4.address") if config.get("ipv4.address") not in (None, "none") else None,
                    "vlan": config.get("vlan"), "parent": config.get("parent"),
                    "description": said.get(name) or item.get("description") or ""})
    return sorted(out, key=lambda n: ({"nat": 0, "vlan": 1, "internal": 2}.get(n["kind"], 3), n["name"]))


def default_networks(settings):
    """What a lab is plugged into when nothing is said: None (Incus's own, from the profile),
    [] (cut), or the VLAN network."""
    if settings["network"] == "none":
        return []
    if settings["network"] == "vlan":
        return [settings.get("vlan_network") or "pier-labs"]
    return None


@changing_labs
def api_lab_network_describe(home, name, text):
    """From Pier: what a network is for, in the user's words (Pi reads it in lab_list)."""
    if not LAB_NAME_RE.fullmatch(name or "") and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,62}", name or ""):
        raise ApiError("a network's name")
    data = load_labs(home)
    notes = data.get("network_notes") if isinstance(data.get("network_notes"), dict) else {}
    notes[name] = lab_description(text)
    if not notes[name]:
        notes.pop(name)
    save_labs(home, {**data, "network_notes": notes})
    return {"network": name, "description": notes.get(name, "")}


@changing_labs
def api_labs_settings(home, text):
    """From Pier: labs on or off, and their limits (JSON on stdin)."""
    try:
        wanted = json.loads(text or "{}")
    except ValueError:
        raise ApiError("labs settings: JSON expected")
    data = load_labs(home)
    settings = data["settings"]
    checks = {"enabled": lambda v: isinstance(v, bool), "max": lambda v: isinstance(v, int) and 1 <= v <= 10,
              "ttl_hours": lambda v: isinstance(v, int) and 1 <= v <= 24 * 30, "network": lambda v: v in ("open", "none", "vlan"),
              "vlan_network": lambda v: isinstance(v, str) and bool(LAB_NAME_RE.fullmatch(v)),
              "cpu": lambda v: isinstance(v, int) and 1 <= v <= 64, "memory_gib": lambda v: isinstance(v, int) and 1 <= v <= 256,
              "disk_gib": lambda v: isinstance(v, int) and 2 <= v <= 2000, "image": lambda v: isinstance(v, str) and bool(LAB_IMAGE_RE.fullmatch(v)),
              "default_host": lambda v: v == "" or v in data["hosts"]}
    for key, value in (wanted.items() if isinstance(wanted, dict) else []):
        if key in checks:
            if not checks[key](value):
                raise ApiError(f"labs settings: {key} out of range")
            settings[key] = value
    save_labs(home, {**data, "settings": settings})
    log("info", "labs.settings", **settings)
    return api_labs(home)


LAB_NO_SNAPSHOTS = ("snapshots are not allowed in this Incus project: lab_reset rebuilds the lab from its image instead. "
                    "To allow them (an admin, once): sudo incus project set user-$(id -u) restricted.snapshots=allow")


# A lab plugged into more than one network gets one interface per network: eth0, eth1...
# Images configure DHCP on eth0 only; the others are given it here (systemd-networkd on
# Debian, netplan on Ubuntu), so each interface gets its address from its network.
LAB_EXTRA_DHCP = r"""for nic in "$@"; do
  if command -v netplan >/dev/null 2>&1; then
    printf 'network:\n  version: 2\n  ethernets:\n    %s:\n      dhcp4: true\n' "$nic" > "/etc/netplan/60-pier-$nic.yaml"
  else
    mkdir -p /etc/systemd/network
    printf '[Match]\nName=%s\n\n[Network]\nDHCP=ipv4\n' "$nic" > "/etc/systemd/network/60-pier-$nic.network"
  fi
done
if command -v netplan >/dev/null 2>&1; then netplan apply; else systemctl restart systemd-networkd 2>/dev/null || networkctl reload; fi
"""


def lab_build(name, image, vm, settings, networks=None, at=None):
    """The Incus instance of a lab, started, with its work folder and, when the project
    allows it, a "clean" snapshot: (Docker possible, snapshots possible). Nothing stays
    when it fails."""
    instance = lab_instance(name)
    args = ["init", f"images:{image}", instance, "-c", f"limits.cpu={settings['cpu']}", "-c", f"limits.memory={settings['memory_gib']}GiB"]
    if vm:
        args.append("--vm")
    else:
        args += ["-c", f"limits.processes={LAB_PROCESSES}"]  # a fork bomb stays in the lab
    nesting = not vm
    try:
        incus(*args, *(["-c", "security.nesting=true"] if nesting else []), timeout=600, at=at)
    except ApiError:
        if not nesting:
            raise
        nesting = False  # a restricted Incus project may refuse it: no Docker inside then
        incus(*args, timeout=600, at=at)
    snapshots = True
    try:
        try:
            incus("config", "device", "override", instance, "root", f"size={settings['disk_gib']}GiB", timeout=30, at=at)
        except ApiError as exc:
            # A storage pool without quotas ("dir", what incus admin init --minimal makes):
            # the disk is not limited. Said in the log and the journal, not silent.
            log("warn", "lab.disk-unlimited", lab=name, err=str(exc)[:200])
            lab_journal({"lab": name, "what": f"its disk is not limited to {settings['disk_gib']} GiB: the storage pool has no quotas (dir)"})
        if networks is None:
            networks = default_networks(settings)
        if networks is not None and not networks:
            incus("config", "device", "add", instance, "eth0", "none", timeout=30, at=at)
        for index, network in enumerate(networks or []):
            nic = f"eth{index}"
            if index == 0:
                try:  # the profile's eth0, moved onto the chosen network
                    incus("config", "device", "override", instance, "eth0", f"network={network}", timeout=30, at=at)
                    continue
                except ApiError:
                    pass
            incus("config", "device", "add", instance, nic, "nic", f"network={network}", f"name={nic}", timeout=30, at=at)
        incus("start", instance, timeout=120, at=at)
        deadline = time.monotonic() + (180 if vm else 60)
        while True:  # a VM answers once its agent runs
            try:
                incus("exec", instance, "--", "mkdir", "-p", "/root/project", timeout=20, at=at)
                break
            except ApiError:
                if time.monotonic() > deadline:
                    raise ApiError("the lab did not start in time")
                time.sleep(2)
        if networks and len(networks) > 1:
            try:
                incus("exec", instance, "--", "sh", "-c", LAB_EXTRA_DHCP, "sh", *[f"eth{i}" for i in range(1, len(networks))], timeout=60, at=at)
            except ApiError as exc:
                log("warn", "lab.extra-dhcp-failed", lab=name, err=str(exc))
        try:
            incus("snapshot", "create", instance, "clean", timeout=300, at=at)
        except ApiError as exc:
            if "snapshot" not in str(exc).lower():
                raise
            snapshots = False  # the user's restricted Incus project: reset rebuilds instead
            log("info", "lab.no-snapshots", lab=name, err=str(exc))
    except ApiError:
        try:
            incus("delete", "--force", instance, timeout=120, at=at)
        except ApiError:
            pass
        raise
    return nesting, snapshots


def lab_description(text):
    """A lab's or machine's description: one line, at most 500 characters."""
    return " ".join(str(text or "").split())[:500]


def lab_create(home, project, name, vm=False, image=None, description="", networks=None, check_only=False, host=None):
    labs_expire(home)
    data = load_labs(home)
    settings = data["settings"]
    if not settings["enabled"]:
        raise ApiError("labs are off: the user turns them on in Pier (Settings > Labs)")
    if not data["hosts"]:
        raise ApiError("no lab host: the user adds one in Pier (Settings > Labs > Lab hosts): another VM with Incus, or Pi's VM")
    host = host or default_host(data)
    at = host_record(data, host)
    if not at:
        raise ApiError(f"no lab host {host}: those of lab_list are {', '.join(sorted(data['hosts']))}")
    usable, why, kvm = incus_state(at)
    if not usable:
        raise ApiError(f"no lab can be made on {host}: {why}")
    known = [n["name"] for n in lab_networks(home, at)]
    if networks is not None:
        if not isinstance(networks, list) or len(networks) > 4 or len(set(networks)) != len(networks):
            raise ApiError("networks: a list of at most 4 different networks (see lab_list), or [] for none")
        missing = [n for n in networks if n not in known]
        if missing:
            raise ApiError(f"no network {', '.join(map(str, missing))} for labs: those of lab_list are {', '.join(known) or 'none'}")
    elif settings["network"] == "vlan" and (settings.get("vlan_network") or "pier-labs") not in known:
        raise ApiError(f"the labs' network {settings.get('vlan_network') or 'pier-labs'} is not there or not allowed to this "
                       "account: see Settings > Labs (made once by an admin)")
    if len(data["labs"]) >= settings["max"]:
        raise ApiError(f"already {len(data['labs'])} labs, the most allowed: destroy one first (lab_destroy)")
    if not name:
        n = 1
        while f"lab-{n}" in data["labs"]:
            n += 1
        name = f"lab-{n}"
    if not LAB_NAME_RE.fullmatch(name) or name in data["labs"] or name in data["machines"] or name in data["hosts"]:
        raise ApiError("a lab's name: lowercase letters, digits and '-', starting with a letter, not taken")
    image = image or settings["image"]
    if not LAB_IMAGE_RE.fullmatch(image) or ".." in image:
        raise ApiError("an image of images.linuxcontainers.org, like debian/13 or ubuntu/24.04")
    if vm and not kvm:
        raise ApiError(f"virtual machines need /dev/kvm on {host} (Proxmox: CPU type host); make a container instead")
    chosen = networks if networks is not None else default_networks(settings)
    if check_only:
        return {"name": name, "image": image, "vm": bool(vm), "networks": chosen, "host": host}
    record = {"project": project, "host": host, "image": image, "vm": bool(vm), "network": settings["network"], "networks": chosen,
              "description": lab_description(description), "created": int(time.time()), "expires": int(time.time() + settings["ttl_hours"] * 3600)}
    # The name and the place taken under the lock, before the build (minutes): two Pis
    # asking at once no longer both pass the most allowed.
    with labs_lock(home):
        data = load_labs(home)
        if len(data["labs"]) >= data["settings"]["max"]:
            raise ApiError(f"already {len(data['labs'])} labs, the most allowed: destroy one first (lab_destroy)")
        if name in data["labs"] or name in data["machines"] or name in data["hosts"]:
            raise ApiError(f"the name {name} was just taken: choose another")
        data["labs"][name] = {**record, "building": True}
        save_labs(home, data)
    try:
        nesting, snapshots = lab_build(name, image, bool(vm), settings, chosen, at)
    except BaseException:
        with labs_lock(home):
            data = load_labs(home)
            if (data["labs"].get(name) or {}).get("building"):
                data["labs"].pop(name)
                save_labs(home, data)
        raise
    record.update(docker=nesting, snapshots=snapshots)
    with labs_lock(home):
        data = load_labs(home)
        data["labs"][name] = record
        save_labs(home, data)
    log("info", "lab.created", lab=name, project=project, image=image, vm=bool(vm), host=host)
    lab_journal({"lab": name, "project": project, "what": f"created on {host} ({'VM' if vm else 'container'}, {image})"})
    return {"lab": name, **record, "workdir": "/root/project",
            "note": "copy the project in with lab_push, run with lab_run; lab_reset goes back to this clean state"}


def run_tail(argv, timeout, keep):
    """(exit code or None when stopped, stdout's last keep bytes, stderr's, stdout's length,
    stderr's): a command whose output may be endless (a lab is Pi's, as root), read as it
    comes and only its end kept."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=dict(os.environ, LC_ALL="C"))
    tails, sizes = [bytearray(), bytearray()], [0, 0]

    def read(stream, n):
        for chunk in iter(lambda: stream.read(65536), b""):
            sizes[n] += len(chunk)
            tails[n] += chunk
            if len(tails[n]) > keep:
                del tails[n][:len(tails[n]) - keep]

    readers = [threading.Thread(target=read, args=(s, n), daemon=True) for n, s in enumerate((process.stdout, process.stderr))]
    for reader in readers:
        reader.start()
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        code = None
    for reader in readers:
        reader.join(5)
    return code, bytes(tails[0]), bytes(tails[1]), sizes[0], sizes[1]


def platform_python():
    return ".".join(str(n) for n in sys.version_info[:3])


def lab_run(home, project, name, command, timeout=300):
    kind, record = lab_target(home, project, name)
    command = str(command or "")
    if not command.strip() or len(command) > 20000:
        raise ApiError("a command to run")
    timeout = max(1, min(int(timeout or 300), LAB_RUN_MAX))
    if kind == "lab":
        argv = incus_argv(record["_at"], "exec", lab_instance(name), "--cwd", "/root/project", "--", "sh", "-lc", command)
    else:
        argv = ssh_argv(record, f"mkdir -p ~/pier-lab && cd ~/pier-lab && {command}")
    started = time.monotonic()
    try:
        code, out, err, out_size, err_size = run_tail(argv, timeout, LAB_OUTPUT * 4)
    except OSError as exc:
        raise ApiError(f"could not run it: {exc}")
    if code is None:
        err += f"\n[stopped after {timeout} s]".encode()
    ms = int((time.monotonic() - started) * 1000)
    lab_journal({"lab": name, "project": project, "command": command, "exit": code, "ms": ms})  # whole: what was done
    tail = lambda b: b.decode("utf-8", "replace")[-LAB_OUTPUT:]
    return {"lab": name, "exit": code, "ms": ms, "stdout": tail(out), "stderr": tail(err),
            "truncated": out_size > LAB_OUTPUT or err_size > LAB_OUTPUT}


def lab_push(home, project, name, path="."):
    """Files of the project into the lab (/root/project, or ~/pier-lab on a machine), as
    a tar stream: links stay links, read by descriptors (see tar_tree: nothing outside
    the project is read, even with a folder swapped meanwhile), what was given to Pi
    and its worktrees stay out."""
    import tarfile
    kind, record = lab_target(home, project, name)
    real = os.path.realpath(project)
    source = os.path.realpath(os.path.join(real, path or "."))
    if not within(source, real):
        raise ApiError("a path inside the project")
    total = [0]

    def keep(info):
        if any(part in LAB_PUSH_SKIP for part in info.name.split("/")):
            return None
        total[0] += max(info.size, 0)
        if total[0] > COPY_MAX_BYTES:
            raise ApiError(f"over {COPY_MAX_BYTES // (1024 * 1024)} MB to copy: push a part of the project")
        return info
    target = "/root/project" if kind == "lab" else "~/pier-lab"
    argv = (incus_argv(record["_at"], "exec", lab_instance(name), "--", "sh", "-c", f"mkdir -p {target} && tar -x -C {target}")
            if kind == "lab" else ssh_argv(record, f"mkdir -p {target} && tar -x -C {target}"))
    # stderr into a file, not a pipe read at the end: tar's warnings (one per file, with a
    # clock off) would fill it and block both sides. And a limit, the broker's lock held.
    errors = tempfile.TemporaryFile()
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors)
    watchdog = threading.Timer(LAB_COPY_MAX, process.kill)
    watchdog.start()
    try:
        with tarfile.open(fileobj=process.stdin, mode="w|") as archive:
            arcname = os.path.relpath(source, real)
            tar_tree(archive, real, source, "." if arcname == "." else arcname.replace(os.sep, "/"), keep)
        process.stdin.close()
        code = process.wait(timeout=LAB_COPY_MAX)
    except BaseException:
        process.kill()
        raise
    finally:
        watchdog.cancel()
        errors.seek(0)
        err = errors.read()[-4096:]
        errors.close()
    if code != 0:
        raise ApiError(err.decode("utf-8", "replace").strip()[-300:] or "the copy failed")
    lab_journal({"lab": name, "project": project, "what": f"pushed {path or '.'} ({total[0] // 1024} kB)"})
    return {"lab": name, "pushed": path or ".", "kb": total[0] // 1024, "into": target}


def tarfile_fixed(version=None):
    """Whether this Python's tarfile filters hold against a hostile archive: the ways
    round the "data" filter of June 2025 (CVE-2025-4517, -4330, -4138) are closed from
    3.12.11 and 3.13.4. A lab is Pi's, as root: what comes back from it is hostile."""
    version = tuple(version or sys.version_info[:3])
    return (3, 12, 11) <= version < (3, 13) or version >= (3, 13, 4)


def lab_pull(home, project, name, path):
    """A file or folder of the lab into the project's .pi-files/<stamp>-lab-<name>, through
    a private folder and tarfile's data filter, as a folder given to Pi is."""
    if not tarfile_fixed():
        raise ApiError(f"the VM's Python {platform_python()} unpacks archives unsafely: lab_pull needs 3.12.11 or 3.13.4 "
                       "or newer (sudo apt upgrade python3)")
    kind, record = lab_target(home, project, name)
    path = str(path or "").strip()
    if not path or "\n" in path or "\0" in path:
        raise ApiError("a path in the lab")
    base = "/root/project" if kind == "lab" else "~/pier-lab"
    quoted = shlex.quote(path)
    script = f"cd {base} && tar -c -C \"$(dirname {quoted})\" \"$(basename {quoted})\""
    argv = (incus_argv(record["_at"], "exec", lab_instance(name), "--", "sh", "-c", script) if kind == "lab" else ssh_argv(record, script))
    staging = private_staging()
    errors = tempfile.TemporaryFile()  # as in lab_push: never a pipe left to fill
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errors)
    watchdog = threading.Timer(LAB_COPY_MAX, process.kill)
    watchdog.start()
    try:
        count = extract_tar(process.stdout, staging)
        code = process.wait(timeout=LAB_COPY_MAX)
        errors.seek(0)
        err = errors.read()[-4096:]
        if code != 0 and not count:
            raise ApiError(err.decode("utf-8", "replace").strip()[-300:] or "nothing came back")
        folder = ignored_dir(project, FILES_DIR)
        dest = f"{stamp()}-lab-{name}"
        if not move_into(staging, folder, dest, project):
            shutil.copytree(staging, os.path.join(folder, dest), symlinks=True)
    except Exception:
        process.kill()
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        watchdog.cancel()
        errors.close()
    shutil.rmtree(staging, ignore_errors=True)
    lab_journal({"lab": name, "project": project, "what": f"pulled {path}"})
    return {"lab": name, "pulled": path, "into": f"{FILES_DIR}/{dest}/", "files": count}


def lab_snapshot(home, project, name, snapshot, restore=False):
    kind, found = lab_target(home, project, name)
    at = found.get("_at")
    if kind != "lab":
        raise ApiError("a machine has no snapshots: only labs do")
    snapshot = snapshot or "clean"
    if not LAB_NAME_RE.fullmatch(snapshot):
        raise ApiError("a snapshot's name: lowercase letters, digits and '-'")
    lab = load_labs(home)["labs"].get(name) or {}
    if lab.get("snapshots") is False:
        if not restore or snapshot != "clean":
            raise ApiError(LAB_NO_SNAPSHOTS)
        # No snapshot: the lab is made again from its image, under the same name.
        incus("delete", "--force", lab_instance(name), timeout=180, at=at)
        settings = {**load_labs(home)["settings"], "network": lab.get("network", "open")}
        nesting, snapshots = lab_build(name, lab.get("image") or settings["image"], bool(lab.get("vm")), settings, lab.get("networks"), at)
        with labs_lock(home):
            data = load_labs(home)
            if name in data["labs"]:
                data["labs"][name].update(docker=nesting, snapshots=snapshots)
                save_labs(home, data)
        lab_journal({"lab": name, "project": project, "what": "rebuilt from its image (back to clean)"})
        return {"lab": name, "restored": "clean", "rebuilt": True}
    if restore:
        incus("snapshot", "restore", lab_instance(name), snapshot, timeout=300, at=at)
    else:
        try:
            info = json.loads(incus("query", f"/1.0/instances/{lab_instance(name)}/snapshots", timeout=30, at=at) or b"[]")
        except (ApiError, ValueError):
            info = []
        if isinstance(info, list) and len(info) >= LAB_SNAPSHOTS:
            raise ApiError(f"{name} has {len(info)} snapshots, the most allowed: go back to one, or reset the lab")
        incus("snapshot", "create", lab_instance(name), snapshot, timeout=300, at=at)
    lab_journal({"lab": name, "project": project, "what": f"{'back to' if restore else 'snapshot'} {snapshot}"})
    return {"lab": name, "restored" if restore else "snapshot": snapshot}


def lab_destroy(home, project, name):
    kind, found = lab_target(home, project, name)
    if kind != "lab":
        raise ApiError("a machine is the user's: it is removed in Pier, not destroyed")
    try:
        incus("delete", "--force", lab_instance(name), timeout=180, at=found.get("_at"))
    except ApiError as exc:
        if "not found" not in str(exc).lower():
            raise
    with labs_lock(home):
        data = load_labs(home)
        data["labs"].pop(name, None)
        save_labs(home, data)
    lab_journal({"lab": name, "project": project, "what": "destroyed"})
    log("info", "lab.destroyed", lab=name)
    return {"destroyed": name}


def lab_list(home, project):
    status = api_labs(home)
    if not status["settings"]["enabled"]:
        raise ApiError("labs are off: the user turns them on in Pier (Settings > Labs)")
    return {"labs": [{k: l.get(k) for k in ("name", "host", "description", "status", "image", "vm", "networks", "docker", "snapshots", "expires")}
                     for l in status["labs"] if l.get("project") == project],
            "hosts": [{"name": h["name"], "description": h["description"], "default": h["default"], "ready": h["incus"],
                       "vm_possible": h["kvm"], "networks": [n["name"] for n in h["networks"]]} for h in status["hosts"]],
            "machines": [{"name": m["name"], "description": m.get("description") or "", "host": m["host"],
                          "needs_approval": m.get("policy") != "auto"} for m in status["machines"]],
            "networks": [{k: n.get(k) for k in ("name", "kind_label", "address", "vlan", "description")} for n in status["networks"]],
            "default_networks": status["default_networks"] if status["default_networks"] is not None else "Incus's own NAT",
            "note": "descriptions are the user's: what each machine or network is for, and what to leave alone there",
            "can_create": any(h["incus"] for h in status["hosts"]) and len(status["labs"]) < status["settings"]["max"],
            "vm_possible": status["kvm"], "why_not": status["why"] or None}


@changing_labs
def api_machine_add(home, name, host, port, user, policy, description=""):
    data = load_labs(home)
    if not LAB_NAME_RE.fullmatch(name or "") or name in data["labs"] or name in data["hosts"]:
        raise ApiError("a machine's name: lowercase letters, digits and '-', starting with a letter, not taken")
    if not LAB_HOST_RE.fullmatch(host or "") or not LAB_USER_RE.fullmatch(user or ""):
        raise ApiError("a host name or address, and a user name")
    if not str(port or "22").isdigit() or not 0 < int(port or 22) < 65536 or policy not in ("ask", "auto"):
        raise ApiError("a port, and ask or auto")
    _, public = machine_key()
    data["machines"][name] = {"host": host, "port": int(port or 22), "user": user, "policy": policy, "added": int(time.time()),
                              "description": lab_description(description)}
    save_labs(home, data)
    log("info", "lab.machine-added", machine=name, host=host, policy=policy)
    return {"machine": name, "public_key": authorized_line(public),
            "next": f"add this key to ~{user}/.ssh/authorized_keys on {host}, then test it"}


@changing_labs
def api_machine_remove(home, name):
    data = load_labs(home)
    data["machines"].pop(name, None)
    save_labs(home, data)
    log("info", "lab.machine-removed", machine=name)
    return {"removed": name}


def api_machine_test(home, name):
    data = load_labs(home)
    machine = data["machines"].get(name)
    if not machine:
        raise ApiError(f"no machine {name}")
    try:
        result = subprocess.run(ssh_argv(machine, "uname -srm"), stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ApiError(f"no answer: {exc}")
    if result.returncode != 0:
        raise ApiError(result.stderr.decode("utf-8", "replace").strip()[-300:] or "the connection failed")
    return {"machine": name, "answer": result.stdout.decode("utf-8", "replace").strip()}


def api_lab_new(home, name, vm, text):
    """From Pier: a lab of the user's own (no project's Pi uses it), named, described, on the
    networks chosen (JSON on stdin: description, networks or null for the default)."""
    try:
        wanted = json.loads(text or "{}")
    except ValueError:
        wanted = {"description": text}
    networks = wanted.get("networks") if isinstance(wanted, dict) else None
    host = wanted.get("host") if isinstance(wanted, dict) and isinstance(wanted.get("host"), str) else None
    return lab_create(home, "", name or "", vm=vm == "vm", description=str((wanted or {}).get("description") or ""),
                      networks=networks if isinstance(networks, list) else None, host=host or None)


@changing_labs
def api_host_add(home, name, host, port, user, description):
    """From Pier: another VM where labs are made (Incus there, the picker's key in the
    user's authorized_keys)."""
    data = load_labs(home)
    if not LAB_NAME_RE.fullmatch(name or "") or name == LOCAL_HOST or name in data["hosts"] or name in data["labs"] or name in data["machines"]:
        raise ApiError("a lab host's name: lowercase letters, digits and '-', starting with a letter, not taken")
    if not LAB_HOST_RE.fullmatch(host or "") or not LAB_USER_RE.fullmatch(user or ""):
        raise ApiError("a host name or address, and a user name")
    if user == "root":
        raise ApiError("not root: labs are made by an account of its own, in the incus group (not incus-admin), "
                       "whose Incus project is restricted; root's key would open the whole host to Pi's labs")
    if not str(port or "22").isdigit() or not 0 < int(port or 22) < 65536:
        raise ApiError("a port")
    _, public = machine_key()
    data["hosts"][name] = {"kind": "ssh", "host": host, "port": int(port or 22), "user": user, "added": int(time.time()),
                           "description": lab_description(description)}
    if not data["settings"].get("default_host") or data["settings"]["default_host"] not in data["hosts"]:
        data["settings"]["default_host"] = name
    save_labs(home, data)
    log("info", "lab.host-added", host=name, address=host)
    return {"host": name, "public_key": authorized_line(public),
            "next": f"on {host}: Incus installed, {user} in its incus group, and this key in ~{user}/.ssh/authorized_keys; then test it"}


@changing_labs
def api_host_local(home, on, description=""):
    """From Pier: Pi's own VM used as a lab host, or no longer."""
    data = load_labs(home)
    if on == "1":
        data["hosts"][LOCAL_HOST] = {"kind": "local", "added": int(time.time()), "description": lab_description(description)
                                     or data["hosts"].get(LOCAL_HOST, {}).get("description", "")}
        if not data["settings"].get("default_host") or data["settings"]["default_host"] not in data["hosts"]:
            data["settings"]["default_host"] = LOCAL_HOST
    else:
        left = [n for n, lab in data["labs"].items() if (lab.get("host") or LOCAL_HOST) == LOCAL_HOST]
        if left:
            raise ApiError(f"labs still live on Pi's VM ({', '.join(left)}): destroy them first")
        data["hosts"].pop(LOCAL_HOST, None)
    save_labs(home, data)
    return {"local": on == "1"}


@changing_labs
def api_host_remove(home, name):
    data = load_labs(home)
    left = [n for n, lab in data["labs"].items() if (lab.get("host") or LOCAL_HOST) == name]
    if left:
        raise ApiError(f"labs still live on {name} ({', '.join(left)}): destroy them first")
    data["hosts"].pop(name, None)
    if data["settings"].get("default_host") == name:
        data["settings"]["default_host"] = ""
    save_labs(home, data)
    log("info", "lab.host-removed", host=name)
    return {"removed": name}


def api_host_test(home, name):
    data = load_labs(home)
    at = host_record(data, name)
    if not at:
        raise ApiError(f"no lab host {name}")
    usable, why, kvm = incus_state(at)
    if not usable:
        raise ApiError(why)
    return {"host": name, "answer": "Incus answers" + (": containers and virtual machines" if kvm else ": containers")}


@changing_labs
def api_lab_edit(home, name, new_name, description):
    """From Pier: a lab or a machine renamed and described again. A lab is stopped for the
    rename (Incus renames only a stopped instance), then started again."""
    data = load_labs(home)
    new_name = new_name or name
    kind = ("machines" if name in data["machines"] else "labs" if name in data["labs"] else
            "hosts" if name in data["hosts"] else None)
    if not kind:
        raise ApiError(f"no lab, machine or lab host named {name}")
    if new_name != name:
        if (not LAB_NAME_RE.fullmatch(new_name) or new_name in data["labs"] or new_name in data["machines"]
                or new_name in data["hosts"] or (kind == "hosts" and LOCAL_HOST in (name, new_name))):
            raise ApiError("a name: lowercase letters, digits and '-', starting with a letter, not taken (Pi's VM keeps its name)")
        if kind == "labs":
            at = lab_host(data, data["labs"][name])
            incus("stop", "--force", lab_instance(name), timeout=120, at=at)
            try:
                incus("rename", lab_instance(name), lab_instance(new_name), timeout=120, at=at)
            except ApiError as exc:
                try:  # not left stopped without a word
                    incus("start", lab_instance(name), timeout=120, at=at)
                except ApiError:
                    raise ApiError(f"{name} could not be renamed ({exc}), and is stopped: start it from its host")
                raise ApiError(f"{name} could not be renamed ({exc}): it runs under its old name")
            incus("start", lab_instance(new_name), timeout=120, at=at)
        if kind == "hosts":
            for lab in data["labs"].values():
                if lab.get("host") == name:
                    lab["host"] = new_name
            if data["settings"].get("default_host") == name:
                data["settings"]["default_host"] = new_name
        data[kind][new_name] = data[kind].pop(name)
    data[kind][new_name]["description"] = lab_description(description)
    save_labs(home, data)
    lab_journal({"lab": new_name, "what": f"renamed from {name}" if new_name != name else "description changed"})
    log("info", "lab.edited", kind=kind, old=name, new=new_name)
    return {"name": new_name, "description": data[kind][new_name]["description"]}


def api_lab_action(home, action, name, extra=""):
    """From Pier (the user's own act): a lab made, reset, destroyed."""
    if action == "create":
        project = resolve_inside(home, name) if name else ""
        return lab_create(home, project, "", vm=extra == "vm")
    data = load_labs(home)
    lab = data["labs"].get(name)
    if not lab:
        raise ApiError(f"no lab {name}")
    if action == "reset":
        return lab_snapshot(home, lab.get("project"), name, "clean", restore=True)
    if action == "destroy":
        return lab_destroy(home, lab.get("project"), name)
    raise ApiError(f"unknown action: {action}")


def lab_shell(name):
    """--lab-shell NAME: a terminal in a lab or on a machine (Pier's Labs tab)."""
    data = load_labs(home_dir())
    if name in data["machines"]:
        argv = ssh_argv(data["machines"][name], tty=True)
    elif name in data["labs"]:
        try:
            at = lab_host(data, data["labs"][name])
        except ApiError as exc:
            print(exc)
            return 1
        inside = ["exec", lab_instance(name), "--cwd", "/root/project", "--", "sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"]
        argv = ["incus", *inside] if at.get("kind") == "local" else ssh_argv(at, shlex.join(["incus", *inside]), tty=True)
    else:
        print(f"no lab or machine named {name}")
        return 1
    lab_journal({"lab": name, "what": "terminal opened by the user"})
    os.execvp(argv[0], argv)


