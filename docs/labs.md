<!-- Part of Pier's documentation: see the index in ../README.md -->
# Labs

### Labs: machines where Pi may do anything

**An option, off until you turn it on** (Settings > Labs): Pi's sandbox stays as it is, and Pi gets tools to use machines of its own besides. **A lab on the internet network gives Pi the internet** (it copies files in, and runs what it likes there): the sandbox's network limit does not hold for what Pi does in a lab. Labs are for running tests with services, building with Docker, installing system packages, trying things out.

**Turning it on sets nothing up.** Labs are made on **lab hosts**, and there is none until you add one:

```
Pi's VM: Pi in bubblewrap ── lab_* tools ──┬──> lab host A (Incus): lab-1, lab-2
                                           ├──> lab host B (Incus): lab-3
                                           ├──> Pi's VM (Incus), only if you chose it
                                           └──> machines (plain SSH, no Incus)
```

- **Lab hosts:** VMs where Incus runs and labs are made. **Add a lab host…** (Settings > Labs): another VM, which Pier reaches over SSH with its own key, running `incus` there. Or **Use Pi's VM as a lab host**, if you want the labs beside Pi. One host is the **default**; Pi (`lab_create`'s `host`) or New lab… may name another, and Pi reads each host's description in `lab_list`. **No lab host, no lab**: Pi is told so, and so are you.
- **Labs:** disposable [Incus](https://linuxcontainers.org/incus/) containers on a lab host (or full virtual machines when that host has `/dev/kvm`), made by Pi on its own, or by you (**New lab…** in the Labs tab), each with a name and a description of what it is for. Root inside, nothing of the VM or of home: only what Pi copies in. Each has CPU, memory and disk limits, a lifetime after which it goes (24 h by default), a **clean** snapshot to go back to, and the network open or cut.
- **Machines:** computers of yours (a server with a GPU, a test server) that Pi reaches over SSH. Pier makes a key of its own on the VM, which you put in the machine's `~/.ssh/authorized_keys`; Pi never sees it. Give each a description Pi reads in `lab_list`: what it is for, and what to leave alone there ("GPU with CUDA 12, never touch /data"). Each machine has its rule: **each command waits for your approval** (the default, shown with the other requests in Repository > Git and in the Labs tab, and as a notification) or Pi runs commands freely. A command waiting for you is shown whole, and what runs is exactly what was shown: at most 4000 characters, written plainly (a character that would not show, such as a direction change, is refused before you are asked). Unanswered after ten minutes, the request goes.

Pi's tools: `lab_list` (its labs, the lab hosts with their networks, the machines), `lab_create` (a name, a description, the host, its networks), `lab_run` (a command, its output and exit code), `lab_push` (the project, or a part, into the lab: what was given to Pi stays out, links stay links), `lab_pull` (a file or folder back into `.pi-files/`), `lab_snapshot`, `lab_reset`, `lab_destroy`. They go through the picker's broker, like the git tools; Pi's sandbox has no network to the labs.

The **Labs tab** (the **+** of a tab bar) lists the labs and machines with their descriptions, opens a **terminal** in any of them, **edits** a name or a description (a lab is stopped for a moment to be renamed), resets or destroys a lab, and shows **what was done**: every command run by Pi, with its exit code and time.

**A lab host, made ready: once for each host.** On the host (Pi's VM included, if you use it):

```bash
sudo apt install incus
sudo incus admin init --minimal
sudo adduser $USER incus
```

then put Pier's key in that user's `~/.ssh/authorized_keys` (copied when you add the host; Pi's VM needs none), reconnect Pier if it is Pi's VM (the group counts from the next login), and **test** the host in Settings > Labs: it says "ready". That restricted project refuses snapshots and nested containers by default: labs still work, a **reset** then rebuilds the lab from its image, and Docker needs a VM lab. To have instant resets and Docker in containers, once (after the first lab, which makes the project):

```bash
sudo incus project set user-$(id -u) restricted.snapshots=allow restricted.containers.nesting=allow
```

The `incus` group gives each user a restricted Incus project of their own: labs cannot reach the VM's files nor be privileged. **Pier checks it**: a host whose Incus project is not restricted (an account of `incus-admin`, root) is "not ready", and `root` cannot be added as a lab host's user. Pier's key is given as a line that allows commands and terminals only (`restrict,pty`: no port, agent or X11 forwarding). The first connection takes the host's key; Settings > Labs then shows its fingerprint, to compare with the host's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).

On such a project, a container lab has at most 2000 processes, a lab at most 10 snapshots, and a disk limit the storage pool cannot hold (a `dir` pool, what `incus admin init --minimal` makes) is said in the labs' journal instead of silently ignored. What comes back from a lab (`lab_pull`) holds only files and folders, and needs Python 3.12.11 or 3.13.4 or newer on the VM (older ones' archive filter can be got round).

**Virtual machines too (optional, once):** labs are containers by default (a full Debian with systemd, its own IP, SSH, services, Docker, firewall rules inside; only the kernel is the VM's). For real virtual machines, the VM must see the processor's virtualisation. Check in the VM: `grep -cE 'vmx|svm' /proc/cpuinfo` must give more than 0, and `/dev/kvm` must exist. If not, under Proxmox:

1. on the Proxmox host, nested virtualisation on: `cat /sys/module/kvm_intel/parameters/nested` (or `kvm_amd`) says `Y` or `1`; otherwise `options kvm-intel nested=Y` (or `options kvm-amd nested=1`) in `/etc/modprobe.d/`, then restart the host;
2. the VM's CPU type set to **host** (Hardware > Processors);
3. the VM stopped then started from Proxmox (a reboot from inside the VM is not enough).

#### Labs on a VLAN of their own (pfSense or another firewall)

By default (**Network: open**), the labs are behind Incus's NAT inside their lab host: the firewall sees only the host. With **Network: your VLAN**, each lab is a machine of its own on a VLAN of the firewall: it gets its address from the firewall's DHCP, and the firewall's rules apply to it.

> **Once, and once only.** These steps are made a single time. Afterwards every lab made with Network: your VLAN lands on it by itself, with nothing more to do.

1. **The firewall (pfSense):** *Interfaces > Assignments > VLANs*, a VLAN (say **30**) on the interface towards Proxmox; assign it as a new interface (**LABS**, say `10.30.0.1/24`) with **DHCP** on. Rules on LABS: the internet and the firewall's DNS allowed, **your LAN and the lab host blocked**, then what you want, lab by lab.
2. **Proxmox:** `vmbr0` marked **VLAN aware** (System > Network), the link to the firewall carrying VLAN 30. On the lab host's VM, *Hardware > Add > Network Device*: bridge `vmbr0`, **VLAN Tag 30**, Proxmox's firewall unticked on that card (its MAC filter would stop the labs).
3. **The lab host:** find the new card, the one without an address (often `ens19`), then make the labs' Incus network on it and let your Incus project use it:

   ```bash
   ip -br link
   ```

   ```bash
   sudo incus network create pier-labs --type=macvlan parent=ens19
   ```

   ```bash
   incus network list
   ```

   ```bash
   sudo incus project set user-$(id -u) restricted.networks.access=incusbr-$(id -u),pier-labs
   ```

   (`incus network list` gives your own network's name, often `incusbr-1000`: keep it in that list, or the labs on Incus's NAT stop working.)
4. **Pier:** Settings > Labs > Network: **your VLAN**. The page says whether the network `pier-labs` is there and allowed, and shows these commands otherwise. In the Labs tab, each lab then shows `VLAN` and the address the firewall gave it.

The lab host itself has no address on that VLAN, and needs none: the labs talk to the firewall, never to the host through it (a limit of macvlan, here a wall more).

#### Networks: what each lab is plugged into

A lab can be plugged into **any network Incus lets your account use**, and into **several at once**. You choose in **New lab…** (the networks are ticked there, the default ones already ticked), and Pi chooses with `lab_create`'s `networks`. **Settings > Labs > Networks** lists them, with what each is for.

**The three kinds of network**

| Kind | What it is | What the lab can reach | Seen by your firewall |
|---|---|---|---|
| **The internet through the host (NAT)** | Incus's own bridge (`incusbr-1000`), there from the start | the internet, the lab host itself, and your LAN (Incus's NAT does not stop private addresses); the LAN cannot reach the lab | no: only the host is |
| **A VLAN of your firewall** | a macvlan network on a card of the lab host, tagged with a VLAN of pfSense | what pfSense allows on that VLAN | yes: the lab is a machine of its own, with its address from pfSense's DHCP and its rules |
| **Between labs only** | an Incus bridge without NAT | the other labs on it, nothing else | no, and nothing goes out |

**Pi asks before using another network.** Pi makes labs on its own on the networks you chose for labs (Settings > Labs), on Incus's NAT and on the networks between labs. A lab on any other network (a VLAN, the LAN through a macvlan) waits for your approval, like a command on a machine.

**One interface per network.** A lab on two networks gets `eth0` on the first ticked and `eth1` on the second, each with its address (Pier configures DHCP on the extra interfaces). The Labs tab shows each interface with its network and address. With nothing ticked, the lab has no network at all.

**What it is for, with examples**

- *Run the project's tests with a database:* one lab on the NAT (default), Postgres inside.
- *Test what your firewall lets through:* a lab on the VLAN, then look at its traffic in pfSense.
- *Test a router or a firewall between two networks:* three labs. `client` on `lab-lan`, `server` on `lab-dmz`, and `router` on both `lab-lan` and `lab-dmz` (plus the NAT if it should reach the internet). Then check with `lab_run` that `client` reaches `server` only through what `router` allows.
- *A VPN between two labs, a DNS server, a mail relay:* labs on a network between labs only, so nothing they do leaks out.

**Describe the networks.** In Settings > Labs > Networks, **describe** says what a network is for ("the DMZ of the firewall tests"). The description shows there and in New lab…, and Pi reads it in `lab_list` to choose a lab's networks.

**The network of a new lab, by default** (Settings > Labs): the NAT (the default), your VLAN (Part above), or none. It is what a lab gets when nobody chooses: Pi without `networks`, or New lab… left as it is.

**Adding a network: an admin, once for each.**

> **Once for each network.** A network made and allowed stays: every lab can then be plugged into it, with nothing more to do.

On the lab host (each host has its own networks). **A VLAN of the firewall, several on one card:** in Proxmox, give the host's second card **no VLAN Tag** (it then carries every VLAN, a "trunk"; its *trunks* option can limit them), and make one Incus network per VLAN on it:

```bash
sudo incus network create pier-labs-30 --type=macvlan parent=ens19 vlan=30
```

```bash
sudo incus network create pier-labs-40 --type=macvlan parent=ens19 vlan=40
```

(each VLAN made in pfSense too, with its DHCP and rules). **A network between labs only:** no card, nothing in pfSense:

```bash
sudo incus network create lab-lan --type=bridge ipv4.address=10.50.0.1/24 ipv4.nat=false
```

```bash
sudo incus network create lab-dmz --type=bridge ipv4.address=10.60.0.1/24 ipv4.nat=false
```

**Then let your account use them**, listing every network it should see, your own NAT included (`incus network list` gives its name, often `incusbr-1000`; left out, labs on the NAT stop working):

```bash
sudo incus project set user-$(id -u) restricted.networks.access=incusbr-$(id -u),pier-labs-30,pier-labs-40,lab-lan,lab-dmz
```

Settings > Labs > Networks shows them as soon as they are allowed, and the same commands in **Add a network**.
