//! One SSH connection to the VM, direct or through a bastion, kept open while Pier runs.
//!
//! Authentication is by password (keyboard-interactive as a fallback, for PAM setups):
//! Windows' OpenSSH cannot share a connection between commands, so the system ssh would
//! ask for the password on every image. The server's key is checked against the
//! fingerprints the user accepted before, like ssh's known_hosts: an unknown key is
//! reported for confirmation, a changed key refuses the connection, and in both cases
//! the password is never sent.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use std::borrow::Cow;

use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PublicKeyOrCertificate};
use russh::{cipher, kex, mac, ChannelMsg, Disconnect, Preferred};

/// Where to log in and with what.
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
}

impl Endpoint {
    /// The key under which this server's fingerprint is remembered.
    pub fn id(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// Result of a connection attempt that did not fail outright.
pub enum Outcome {
    Connected(Connection),
    /// First contact: the user must confirm the fingerprint.
    Unknown { which: &'static str, host: String, fingerprint: String },
    /// The server presents another key than the one trusted: refused.
    Changed { which: &'static str, host: String, fingerprint: String, known: String },
}

pub struct Connection {
    session: Handle<Checker>,
    // The bastion's session carries the tunnel: it must live as long as the VM's.
    _bastion: Option<Handle<Checker>>,
}

/// russh handler that records the server's fingerprint and accepts only the trusted one.
pub struct Checker {
    trusted: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Checker {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let presented = fingerprint(key);
        let accepted = self.trusted.as_deref() == Some(presented.as_str());
        *self.seen.lock().unwrap() = Some(presented);
        Ok(accepted)
    }
}

/// SHA256 fingerprint, written as ssh-keygen -l writes it.
pub fn fingerprint(key: &PublicKeyOrCertificate) -> String {
    match key {
        PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
        PublicKeyOrCertificate::Certificate(cert) => cert.public_key().fingerprint(HashAlg::Sha256).to_string(),
    }
}

/// What Pier accepts to negotiate: modern algorithms only, the post-quantum hybrid
/// key exchange first (OpenSSH 9.9 and later, so Debian 13, offer it). Left out from
/// russh's defaults: RSA signatures with SHA-1, the NIST curves and the smaller DH
/// groups for the key exchange, AES-CTR and the MACs that are not encrypt-then-MAC.
/// "kex-strict" (the Terrapin fix) stays on. A server that offers nothing of this is
/// refused before any password is sent.
const KEX: &[kex::Name] = &[
    kex::MLKEM768X25519_SHA256,
    kex::CURVE25519,
    kex::CURVE25519_PRE_RFC_8731,
    kex::DH_G18_SHA512,
    kex::DH_G16_SHA512,
    kex::DH_GEX_SHA256,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];
const HOST_KEYS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
    Algorithm::Rsa { hash: Some(HashAlg::Sha256) },
    Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
    Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
];
const CIPHERS: &[cipher::Name] = &[cipher::CHACHA20_POLY1305, cipher::AES_256_GCM, cipher::AES_128_GCM];
const MACS: &[mac::Name] = &[mac::HMAC_SHA512_ETM, mac::HMAC_SHA256_ETM];

pub fn preferred() -> Preferred {
    Preferred {
        kex: Cow::Borrowed(KEX),
        key: Cow::Borrowed(HOST_KEYS),
        cipher: Cow::Borrowed(CIPHERS),
        mac: Cow::Borrowed(MACS),
        // No compression: it saves little on a LAN or WireGuard, and compressing
        // before encrypting can leak what the data looks like.
        compression: Cow::Borrowed(&[russh::compression::NONE]),
        ..Preferred::DEFAULT
    }
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Keepalives notice a dead link (laptop asleep, Wi-Fi gone) within ~2 minutes.
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        inactivity_timeout: None,
        // Nagle off, as OpenSSH does for interactive sessions: a keystroke (or a scroll
        // of the mouse wheel, sent as arrow keys) leaves at once instead of waiting
        // for the previous packet to be acknowledged.
        nodelay: true,
        preferred: preferred(),
        ..Default::default()
    })
}

enum Handshake {
    Ok(Handle<Checker>),
    Refused(Outcome),
}

/// Opens the connection to `target`, through `bastion` when given.
///
/// `trusted` returns the accepted fingerprint for a server id ("host:port").
pub async fn open(target: &Endpoint, bastion: Option<&Endpoint>, trusted: impl Fn(&str) -> Option<String>) -> Result<Outcome> {
    let mut bastion_handle = None;
    if let Some(jump) = bastion {
        let mut handle = match connect_checked("bastion", jump, trusted(&jump.id()), None).await? {
            Handshake::Ok(handle) => handle,
            Handshake::Refused(outcome) => return Ok(outcome),
        };
        authenticate(&mut handle, jump).await.context("bastion")?;
        bastion_handle = Some(handle);
    }
    let mut session = match connect_checked("target", target, trusted(&target.id()), bastion_handle.as_ref()).await? {
        Handshake::Ok(handle) => handle,
        Handshake::Refused(outcome) => return Ok(outcome),
    };
    authenticate(&mut session, target).await?;
    Ok(Outcome::Connected(Connection { session, _bastion: bastion_handle }))
}

/// TCP (or a direct-tcpip channel of the bastion) then SSH handshake, with the key check.
async fn connect_checked(
    which: &'static str,
    endpoint: &Endpoint,
    trusted: Option<String>,
    via: Option<&Handle<Checker>>,
) -> Result<Handshake> {
    let seen = Arc::new(Mutex::new(None));
    let checker = Checker { trusted: trusted.clone(), seen: seen.clone() };
    let started = Instant::now();
    log_debug!("ssh.connect", to = label(which), host = endpoint.id(), via = if via.is_some() { "bastion" } else { "direct" });
    let attempt = match via {
        None => {
            let addr = (endpoint.host.as_str(), endpoint.port);
            tokio::time::timeout(Duration::from_secs(15), client::connect(config(), addr, checker))
                .await
                .map_err(|_| {
                    log_warn!("ssh.timeout", to = label(which), host = endpoint.id(), secs = 15);
                    anyhow!("{}: no answer from {} (15 s)", label(which), endpoint.id())
                })?
        }
        Some(jump) => {
            let channel = jump
                .channel_open_direct_tcpip(endpoint.host.clone(), u32::from(endpoint.port), "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    log_warn!("ssh.tunnel-failed", host = endpoint.id(), err = e);
                    anyhow!("the bastion could not reach {}: {e}", endpoint.id())
                })?;
            client::connect_stream(config(), channel.into_stream(), checker).await
        }
    };
    match attempt {
        Ok(handle) => {
            log_debug!("ssh.handshake", to = label(which), host = endpoint.id(), ms = started.elapsed().as_millis());
            Ok(Handshake::Ok(handle))
        }
        Err(err) => {
            // A rejected key surfaces as an error; tell it apart from a network failure.
            let presented = seen.lock().unwrap().clone();
            match (presented, trusted) {
                (Some(fingerprint), None) => {
                    log_info!("ssh.unknown-key", to = label(which), host = endpoint.id(), fingerprint = fingerprint);
                    Ok(Handshake::Refused(Outcome::Unknown { which, host: endpoint.id(), fingerprint }))
                }
                (Some(fingerprint), Some(known)) if fingerprint != known => {
                    log_warn!("ssh.changed-key", to = label(which), host = endpoint.id(), fingerprint = fingerprint, known = known);
                    Ok(Handshake::Refused(Outcome::Changed { which, host: endpoint.id(), fingerprint, known }))
                }
                _ => {
                    log_warn!("ssh.connect-failed", to = label(which), host = endpoint.id(), ms = started.elapsed().as_millis(), err = friendly(&err));
                    Err(anyhow!("{}: cannot connect to {}: {}", label(which), endpoint.id(), friendly(&err)))
                }
            }
        }
    }
}

fn label(which: &str) -> &'static str {
    if which == "bastion" { "bastion" } else { "VM" }
}

fn friendly(err: &russh::Error) -> String {
    match err {
        russh::Error::IO(io) => match io.kind() {
            std::io::ErrorKind::ConnectionRefused => "connection refused (port closed?)".into(),
            std::io::ErrorKind::TimedOut => "timed out".into(),
            _ => io.to_string(),
        },
        other => other.to_string(),
    }
}

/// Password, then keyboard-interactive answering the hidden prompts with the password.
async fn authenticate(handle: &mut Handle<Checker>, endpoint: &Endpoint) -> Result<()> {
    if handle.authenticate_password(endpoint.user.clone(), endpoint.password.clone()).await?.success() {
        log_debug!("ssh.auth", host = endpoint.id(), user = endpoint.user, method = "password");
        return Ok(());
    }
    log_debug!("ssh.auth-fallback", host = endpoint.id(), method = "keyboard-interactive");
    let mut reply = handle
        .authenticate_keyboard_interactive_start(endpoint.user.clone(), None::<String>)
        .await?;
    for _ in 0..4 {
        match reply {
            KeyboardInteractiveAuthResponse::Success => {
                log_debug!("ssh.auth", host = endpoint.id(), user = endpoint.user, method = "keyboard-interactive");
                return Ok(());
            }
            KeyboardInteractiveAuthResponse::Failure { .. } => break,
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // The password goes only to a question asking for it: never to a one-time
                // code or another secret the server asks next.
                let answers = prompts
                    .iter()
                    .map(|p| if !p.echo && p.prompt.to_lowercase().contains("password") { endpoint.password.clone() } else { String::new() })
                    .collect();
                reply = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    log_warn!("ssh.auth-refused", host = endpoint.id(), user = endpoint.user);
    bail!("password refused for {}@{}", endpoint.user, endpoint.id())
}

/// What a remote command printed, and how it ended.
pub struct Output {
    pub status: Option<u32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Connection {
    pub fn is_closed(&self) -> bool {
        self.session.is_closed()
    }

    /// A new session channel, for a terminal or a share.
    pub async fn channel(&self) -> Result<russh::Channel<client::Msg>> {
        Ok(self.session.channel_open_session().await?)
    }

    /// Runs `command` through the user's shell on the VM, feeding it `stdin`.
    #[cfg(test)]
    pub async fn exec(&self, command: &str, stdin: &[u8]) -> Result<Output> {
        run(self.session.channel_open_session().await?, command, stdin).await
    }

    pub async fn close(&self) {
        let _ = self.session.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

/// Why the server refused to open a channel, when that is the error. OpenSSH refuses
/// past MaxSessions channels on one connection (10 by default).
pub fn refusal(err: &anyhow::Error) -> Option<String> {
    match err.downcast_ref::<russh::Error>() {
        Some(russh::Error::ChannelOpenFailure(reason)) => Some(format!("{reason:?}")),
        _ => None,
    }
}

/// Most bytes an answer may bring back into memory: the VM cannot flood the PC.
pub const RUN_MAX: usize = 64 * 1024 * 1024;

/// Runs `command` on an open channel, feeding it `stdin`, until it exits. An answer
/// past RUN_MAX is an error.
pub async fn run(channel: russh::Channel<client::Msg>, command: &str, stdin: &[u8]) -> Result<Output> {
    let mut stdout = Vec::new();
    let (status, stderr) = run_into(channel, command, stdin, &mut stdout, RUN_MAX as u64).await?;
    Ok(Output { status, stdout, stderr })
}

/// The same, writing the output to `sink` (a file for a take-back), at most `max` bytes.
pub async fn run_into(
    mut channel: russh::Channel<client::Msg>,
    command: &str,
    stdin: &[u8],
    sink: &mut impl std::io::Write,
    max: u64,
) -> Result<(Option<u32>, Vec<u8>)> {
    channel.exec(true, command).await?;
    if !stdin.is_empty() {
        channel.data(stdin).await?;
    }
    channel.eof().await?;
    let (mut status, mut stderr, mut written) = (None, Vec::new(), 0u64);
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                written += data.len() as u64;
                if written > max {
                    let _ = channel.close().await;
                    bail!("the VM sent more than {} MB: stopped", max / 1024 / 1024);
                }
                sink.write_all(&data)?;
            }
            ChannelMsg::ExtendedData { data, ext: 1 } if stderr.len() < 1024 * 1024 => stderr.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            _ => {}
        }
    }
    Ok((status, stderr))
}

/// A POSIX shell command line made safe for whatever login shell the user has (sshd
/// runs every command through it, and fish reads backslashes inside single quotes):
/// the line travels in base64, which every shell passes through untouched, and /bin/sh
/// runs it.
pub fn posix_line(line: &str) -> String {
    format!("/bin/sh -c 'eval \"$(printf %s {} | base64 -d)\"'", base64(line.as_bytes()))
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() { ALPHABET[(n >> shift) as usize & 63] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod quoting_tests {
    use super::*;

    #[test]
    fn base64_as_the_rfc_says() {
        for (plain, coded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foobar", "Zm9vYmFy")] {
            assert_eq!(base64(plain.as_bytes()), coded);
        }
        assert_eq!(posix_line("echo 'a\\b'"), "/bin/sh -c 'eval \"$(printf %s ZWNobyAnYVxiJw== | base64 -d)\"'");
    }
}

/// One argument for the remote shell, single-quoted.
pub fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod server_tests;

#[cfg(test)]
mod tests {
    use super::sh_quote;

    #[test]
    fn quoting_survives_quotes_and_spaces() {
        assert_eq!(sh_quote("~/a b"), "'~/a b'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
    }
}
