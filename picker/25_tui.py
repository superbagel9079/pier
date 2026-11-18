# --- picker: the command line ------------------------------------------------------

USAGE = """usage: pier-picker.py --api COMMAND [ARGS]   (see the desktop client API section)
       pier-picker.py --attach DIR [PI ARGS]
       pier-picker.py --version

Pier's side on the VM: Pier runs it over SSH to start Pi and to read and change what it
shows. It has no screen of its own: use Pier.
Settings: ~/.config/pier-picker/config.toml"""


def entry():
    """The command line, for Pier over SSH. Run as a script, or through the launcher Pier
    installs (~/bin/pi-pick importing this file as a module, so that Python keeps it compiled)."""
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
    if len(sys.argv) >= 3 and sys.argv[1] == "--rpc-attach":
        sys.exit(rpc_attach(sys.argv[2], sys.argv[3:]))
    if len(sys.argv) >= 4 and sys.argv[1] == "--rpc-host":
        sys.exit(rpc_host(sys.argv[2], sys.argv[3], sys.argv[4:]))
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
    print(USAGE)
    sys.exit(2)

if __name__ == "__main__":
    entry()
