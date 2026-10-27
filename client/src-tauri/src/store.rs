//! What Pier keeps on disk, in the app's config folder: where the VM is, and the
//! server fingerprints the user accepted. Never a password.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Bastion {
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Settings {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub bastion: Option<Bastion>,
    /// How to start the picker on the VM; run by the user's shell, so "~" works.
    pub remote_command: String,
}

impl Settings {
    pub fn validate(&self) -> Result<()> {
        check_host("the address", &self.host)?;
        check_user("the user", &self.user)?;
        if self.port == 0 {
            bail!("the port must be between 1 and 65535");
        }
        if let Some(b) = &self.bastion {
            check_host("the bastion address", &b.host)?;
            check_user("the bastion user", &b.user)?;
            if b.port == 0 {
                bail!("the bastion port must be between 1 and 65535");
            }
        }
        if self.remote_command.trim().is_empty() {
            bail!("the picker command is empty");
        }
        Ok(())
    }
}

fn check_host(what: &str, host: &str) -> Result<()> {
    if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        bail!("{what} is empty or contains spaces");
    }
    Ok(())
}

fn check_user(what: &str, user: &str) -> Result<()> {
    if user.is_empty() || user.chars().any(|c| c.is_whitespace() || c.is_control() || c == '@') {
        bail!("{what} is empty or invalid");
    }
    Ok(())
}

/// A folder lent to a project's Pi, remembered so that it can be resumed after a
/// disconnection (the mount itself does not survive one).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RememberedShare {
    pub local: String,
    pub project: String,
    pub label: String,
    pub relative: String,
    pub writable: bool,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    fn known_path(&self) -> PathBuf {
        self.dir.join("known_hosts.json")
    }

    pub fn settings(&self) -> Option<Settings> {
        let text = fs::read_to_string(self.settings_path()).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        settings.validate()?;
        write_atomic(&self.settings_path(), &serde_json::to_vec_pretty(settings)?)
    }

    /// The keys trusted; none when the file is not there yet, an error when it cannot be
    /// read (taken as empty, a changed key would look like a first contact).
    fn known(&self) -> Result<BTreeMap<String, String>> {
        match fs::read_to_string(self.known_path()) {
            Ok(text) => serde_json::from_str(&text).with_context(|| format!("{} cannot be read: repair or delete it", self.known_path().display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(err) => Err(err).with_context(|| format!("reading {}", self.known_path().display())),
        }
    }

    /// Whether the trusted keys can be read: no connection otherwise.
    pub fn check_known(&self) -> Result<()> {
        self.known().map(|_| ())
    }

    /// The fingerprint accepted for "host:port", if any.
    pub fn trusted(&self, id: &str) -> Option<String> {
        self.known().ok()?.get(id).cloned()
    }

    fn shares_path(&self) -> PathBuf {
        self.dir.join("shares.json")
    }

    pub fn remembered_shares(&self) -> Vec<RememberedShare> {
        fs::read_to_string(self.shares_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Adds or updates the share of `local` in `project`.
    pub fn remember_share(&self, share: RememberedShare) -> Result<()> {
        let mut shares: Vec<RememberedShare> = self
            .remembered_shares()
            .into_iter()
            .filter(|s| !(s.local == share.local && s.project == share.project))
            .collect();
        shares.push(share);
        write_atomic(&self.shares_path(), &serde_json::to_vec_pretty(&shares)?)
    }

    pub fn forget_share(&self, local: &str, project: &str) -> Result<()> {
        let shares: Vec<RememberedShare> = self
            .remembered_shares()
            .into_iter()
            .filter(|s| !(s.local == local && s.project == project))
            .collect();
        write_atomic(&self.shares_path(), &serde_json::to_vec_pretty(&shares)?)
    }

    pub fn trust(&self, id: &str, fingerprint: &str) -> Result<()> {
        let mut known = self.known()?; // never written over what could not be read
        known.insert(id.to_string(), fingerprint.to_string());
        write_atomic(&self.known_path(), &serde_json::to_vec_pretty(&known)?)
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().context("path without a folder")?;
    fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Settings {
        Settings { host: "192.168.1.20".into(), port: 2222, user: "leo".into(), bastion: None, remote_command: "~/bin/pi-pick".into() }
    }

    #[test]
    fn validation() {
        assert!(sample().validate().is_ok());
        assert!(Settings { host: "a b".into(), ..sample() }.validate().is_err());
        assert!(Settings { port: 0, ..sample() }.validate().is_err());
        assert!(Settings { user: "x@y".into(), ..sample() }.validate().is_err());
        let with_bastion = Settings { bastion: Some(Bastion { host: "".into(), port: 22, user: "j".into() }), ..sample() };
        assert!(with_bastion.validate().is_err());
    }

    #[test]
    fn round_trip_and_trust() {
        let dir = std::env::temp_dir().join(format!("pier-store-test-{}", std::process::id()));
        let store = Store::new(dir.clone());
        assert!(store.settings().is_none());
        store.save_settings(&sample()).unwrap();
        assert_eq!(store.settings().unwrap().port, 2222);
        assert!(store.trusted("h:1").is_none());
        store.trust("h:1", "SHA256:abc").unwrap();
        assert_eq!(store.trusted("h:1").as_deref(), Some("SHA256:abc"));
        // Cut: refused, and never written over.
        fs::write(store.known_path(), "{\"h:1\": ").unwrap();
        assert!(store.check_known().is_err());
        assert!(store.trust("h:2", "SHA256:def").is_err());
        assert_eq!(fs::read_to_string(store.known_path()).unwrap(), "{\"h:1\": ");
        let _ = fs::remove_dir_all(dir);
    }
}
