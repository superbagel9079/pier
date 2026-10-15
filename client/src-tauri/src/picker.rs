//! The picker Pier carries: pi-dir-picker.py is built into the executable, and
//! installed on the VM, where the picker command points, when it is missing or older.
//! Only Pier is to install: nothing to copy by hand.

use std::cmp::Ordering;

use crate::ssh::sh_quote;

/// pi-dir-picker.py as it was when Pier was built.
pub const SCRIPT: &str = include_str!("../../../pi-dir-picker.py");

/// A constant of the script: `VERSION = "3.9"` gives 3.9, `API_VERSION = 8` gives 8.
fn constant(name: &str) -> Option<&'static str> {
    SCRIPT.lines().find_map(|line| {
        let rest = line.strip_prefix(name)?.trim_start().strip_prefix('=')?.trim();
        Some(rest.trim_matches('"'))
    })
}

/// The script as it goes to the VM: Unix line ends whatever the file has here. A
/// Windows checkout or editor can write CRLF, and on Linux the first line then names
/// "python3" followed by a carriage return, which does not exist.
pub fn script_for_vm() -> Vec<u8> {
    SCRIPT.replace("\r\n", "\n").into_bytes()
}

pub fn bundled_version() -> &'static str {
    constant("VERSION").unwrap_or("?")
}

pub fn bundled_api() -> u64 {
    constant("API_VERSION").and_then(|v| v.parse().ok()).unwrap_or(0)
}

/// "3.10" is newer than "3.9": compared number by number.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let parts = |v: &str| v.split('.').map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a).cmp(&parts(b))
}

/// The shell script that installs the picker at the path of `remote_command`, reading
/// the new script on its stdin. It checks the new file runs and says the expected
/// version before replacing anything; the replaced file is kept next to it, as
/// NAME.previous. Only a plain path can be installed to: "~/bin/pi-pick", "/opt/pi-pick".
pub fn install_script(remote_command: &str, version: &str) -> Result<String, String> {
    let path = remote_command.trim();
    let plain = path.chars().all(|c| c.is_ascii_alphanumeric() || "._/+-~".contains(c));
    let rooted = path.starts_with("~/") || path.starts_with('/');
    let climbs = path.split('/').any(|part| part == ".." || part == ".");
    if !plain || !rooted || climbs || path.ends_with('/') || path[1..].contains('~') {
        return Err(format!(
            "Pier installs the picker only where the picker command is a plain path (like ~/bin/pi-pick), \
             and the command is \"{path}\": install it by hand, or change the command on the login screen"
        ));
    }
    let dest = match path.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
        None => sh_quote(path),
    };
    let expected = sh_quote(version);
    // No backslash anywhere: the script goes through the user's shell (bash, zsh or
    // fish) inside single quotes.
    //
    // The picker itself goes to NAME.lib/pi_dir_picker.py, and NAME is a small launcher
    // importing it: Python then keeps it compiled (__pycache__) instead of compiling its
    // 5000 lines at every call, which cost about 100 ms each. NAME.previous is always a
    // whole picker, which runs by itself.
    Ok(format!(
        r#"set -e
dest={dest}
expected={expected}
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is missing on the VM: install it (sudo apt install python3)" >&2
  exit 3
fi
mkdir -p "$(dirname "$dest")"
lib="$dest.lib"
new="$lib.pier-new.$$"
tmp="$dest.pier-new.$$"
cleanup() {{ rm -rf "$tmp" "$new"; }}
trap cleanup EXIT
mkdir -p "$new"
cat > "$new/pi_dir_picker.py"
chmod 755 "$new/pi_dir_picker.py"
# Run through its first line, which catches a broken one (Windows line ends after
# python3).
if ! got="$("$new/pi_dir_picker.py" --version 2>&1)"; then
  echo "the new picker does not start on the VM: $got" >&2
  exit 4
fi
if [ "$got" != "$expected" ]; then
  echo "the new picker says it is $got instead of $expected" >&2
  exit 5
fi
cat > "$tmp" <<PIER_LAUNCHER
#!/usr/bin/env python3
# pi-pick, installed by Pier: it runs the picker kept in $lib as a module, so that
# Python compiles it once rather than at every call.
import os
import sys
sys.path.insert(0, "$lib")
import pi_dir_picker
pi_dir_picker.SCRIPT = os.path.realpath(__file__)
pi_dir_picker.entry()
PIER_LAUNCHER
chmod 755 "$tmp"
if [ -f "$lib/pi_dir_picker.py" ]; then
  cp -p "$lib/pi_dir_picker.py" "$dest.previous" 2>/dev/null || true
elif [ -f "$dest" ] && [ ! -L "$dest" ]; then
  cp -p "$dest" "$dest.previous" 2>/dev/null || true
fi
rm -rf "$lib.old"
if [ -d "$lib" ]; then mv "$lib" "$lib.old"; fi
mv "$new" "$lib"
if ! got="$("$tmp" --version 2>&1)" || [ "$got" != "$expected" ]; then
  rm -rf "$lib"
  if [ -d "$lib.old" ]; then mv "$lib.old" "$lib"; fi
  echo "the picker's launcher does not start on the VM: $got" >&2
  exit 6
fi
rm -rf "$lib.old"
mv -f "$tmp" "$dest"
trap - EXIT
echo "$dest"
"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_script_speaks_this_api() {
        assert_eq!(bundled_api(), crate::API_VERSION, "pi-dir-picker.py and lib.rs disagree on the API version");
        assert!(compare_versions(bundled_version(), "3.8") == Ordering::Greater, "{}", bundled_version());
        assert!(SCRIPT.starts_with("#!/usr/bin/env python3"));
        let sent = script_for_vm();
        assert!(!sent.contains(&b'\r'), "the VM gets Unix line ends");
        assert!(sent.starts_with(b"#!/usr/bin/env python3\n"));
    }

    /// cargo test print_install_script -- --ignored --nocapture: the script, to try it by hand.
    #[test]
    #[ignore]
    fn print_install_script() {
        print!("{}", install_script("~/bin/pi-pick", bundled_version()).unwrap());
    }

    #[test]
    fn versions_compare_by_number() {
        assert_eq!(compare_versions("3.10", "3.9"), Ordering::Greater);
        assert_eq!(compare_versions("3.9", "3.9"), Ordering::Equal);
        assert_eq!(compare_versions("3.8", "3.9"), Ordering::Less);
        assert_eq!(compare_versions("4", "3.99"), Ordering::Greater);
        assert_eq!(compare_versions("?", "3.9"), Ordering::Less);
    }

    #[test]
    fn installs_only_to_plain_paths() {
        let script = install_script("~/bin/pi-pick", "3.9").unwrap();
        assert!(script.contains("dest=\"$HOME\"/'bin/pi-pick'"), "{script}");
        assert!(script.contains("expected='3.9'"));
        assert!(script.contains("lib=\"$dest.lib\"") && script.contains("import pi_dir_picker"), "the launcher and its module");
        assert!(!script.contains('\\'), "no backslash may reach the user's shell");
        assert!(install_script("/opt/tools/pi-pick", "3.9").unwrap().contains("dest='/opt/tools/pi-pick'"));
        for bad in ["python3 ~/pi.py", "~/bin/pi-pick; rm -rf ~", "bin/pi-pick", "~/../etc/x", "~/bin/", "~/a/~b", "$HOME/x", "~/bin/pi pick"] {
            assert!(install_script(bad, "3.9").is_err(), "{bad}");
        }
    }
}
