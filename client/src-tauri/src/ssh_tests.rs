//! The SSH client against real SSH servers, run in-process: russh's server side plays
//! the VM and the bastion. Covers what cannot be tried without the user's password:
//! first contact, wrong password, a changed host key, a bastion, stdin delivery.

use std::sync::Arc;

use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::net::{TcpListener, TcpStream};

use super::{open, Endpoint, Outcome};

const PASSWORD: &str = "correct horse";

fn host_key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

fn fingerprint_of(key: &PrivateKey) -> String {
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

/// A VM (or a bastion) that runs no shell: each exec answers with the command it got
/// and how many bytes arrived on stdin, as JSON, like the picker's API would.
#[derive(Clone, Default)]
struct FakeServer {
    command: String,
    stdin: usize,
}

impl server::Handler for FakeServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == PASSWORD { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        self.command = String::from_utf8_lossy(data).into_owned();
        session.channel_success(channel)?;
        Ok(())
    }

    async fn data(&mut self, _channel: ChannelId, data: &[u8], _session: &mut Session) -> Result<(), Self::Error> {
        self.stdin += data.len();
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        let reply = serde_json::json!({ "api": 1, "command": self.command, "stdin": self.stdin });
        session.data(channel, reply.to_string().into_bytes())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    /// The bastion's job: connect the tunnel to the requested host and port.
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _originator: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = TcpStream::connect((host.to_string(), port as u16)).await;
        match target {
            Ok(mut target) => {
                reply.accept().await;
                tokio::spawn(async move {
                    let mut tunnel = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tunnel, &mut target).await;
                });
            }
            Err(_) => drop(reply),
        }
        Ok(())
    }
}

/// Starts a server on 127.0.0.1 with the given host key; returns its port.
async fn serve(key: PrivateKey) -> u16 {
    serve_with(key, FakeServer::default()).await
}

/// Same, with any handler: each connection gets a clone of it.
async fn serve_with<H: server::Handler + Clone + Send + 'static>(key: PrivateKey, handler: H) -> u16 {
    let config = Arc::new(server::Config {
        keys: vec![key],
        auth_rejection_time: std::time::Duration::from_millis(10),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((socket, _)) = listener.accept().await else { return };
            let config = config.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                if let Ok(session) = server::run_stream(config, socket, handler).await {
                    let _ = session.await;
                }
            });
        }
    });
    port
}

fn endpoint(port: u16, password: &str) -> Endpoint {
    Endpoint { host: "127.0.0.1".into(), port, user: "leo".into(), password: password.to_string().into() }
}

#[tokio::test]
async fn first_contact_then_trusted_exec_with_stdin() {
    let key = host_key(1);
    let expected = fingerprint_of(&key);
    let port = serve(key).await;
    let target = endpoint(port, PASSWORD);

    match open(&target, None, |_| None).await.unwrap() {
        Outcome::Unknown { which, host, fingerprint } => {
            assert_eq!(which, "target");
            assert_eq!(host, format!("127.0.0.1:{port}"));
            assert_eq!(fingerprint, expected);
        }
        _ => panic!("an unknown server must be reported, not connected"),
    }

    let Outcome::Connected(connection) = open(&target, None, |_| Some(expected.clone())).await.unwrap() else {
        panic!("a trusted server must connect");
    };
    let image = vec![7u8; 300_000]; // larger than one SSH window: exercises flow control
    let output = connection.exec("~/bin/pi-pick --api 'paste-image'", &image).await.unwrap();
    assert_eq!(output.status, Some(0));
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["command"], "~/bin/pi-pick --api 'paste-image'");
    assert_eq!(reply["stdin"], 300_000);
    connection.close().await;
}

#[tokio::test]
async fn wrong_password_is_refused() {
    let key = host_key(2);
    let trusted = fingerprint_of(&key);
    let port = serve(key).await;
    let result = open(&endpoint(port, "nope"), None, |_| Some(trusted.clone())).await;
    let error = format!("{:#}", result.err().expect("must fail"));
    assert!(error.contains("password refused"), "{error}");
}

#[tokio::test]
async fn changed_host_key_is_refused_before_the_password() {
    let port = serve(host_key(3)).await;
    let previously = fingerprint_of(&host_key(4));
    match open(&endpoint(port, PASSWORD), None, |_| Some(previously.clone())).await.unwrap() {
        Outcome::Changed { known, fingerprint, .. } => {
            assert_eq!(known, previously);
            assert_eq!(fingerprint, fingerprint_of(&host_key(3)));
        }
        _ => panic!("a changed key must refuse the connection"),
    }
}

#[tokio::test]
async fn through_a_bastion() {
    let vm_key = host_key(5);
    let bastion_key = host_key(6);
    let vm_fp = fingerprint_of(&vm_key);
    let bastion_fp = fingerprint_of(&bastion_key);
    let vm_port = serve(vm_key).await;
    let bastion_port = serve(bastion_key).await;
    let target = endpoint(vm_port, PASSWORD);
    let jump = endpoint(bastion_port, PASSWORD);

    // Unknown bastion first: reported as such, the VM is not contacted yet.
    match open(&target, Some(&jump), |_| None).await.unwrap() {
        Outcome::Unknown { which, fingerprint, .. } => {
            assert_eq!(which, "bastion");
            assert_eq!(fingerprint, bastion_fp);
        }
        _ => panic!("the bastion's key must be confirmed first"),
    }
    // Bastion trusted, VM unknown: the VM's own key is asked for, through the tunnel.
    let only_bastion = |id: &str| (id == jump.id()).then(|| bastion_fp.clone());
    match open(&target, Some(&jump), only_bastion).await.unwrap() {
        Outcome::Unknown { which, fingerprint, .. } => {
            assert_eq!(which, "target");
            assert_eq!(fingerprint, vm_fp);
        }
        _ => panic!("the VM's key must be confirmed too"),
    }
    let both = |id: &str| if id == jump.id() { Some(bastion_fp.clone()) } else { Some(vm_fp.clone()) };
    let Outcome::Connected(connection) = open(&target, Some(&jump), both).await.unwrap() else {
        panic!("both trusted: must connect");
    };
    let output = connection.exec("echo", b"abc").await.unwrap();
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["stdin"], 3);

    // Wrong bastion password: the error names the bastion.
    let bad_jump = endpoint(bastion_port, "nope");
    let error = format!("{:#}", open(&target, Some(&bad_jump), both).await.err().expect("must fail"));
    assert!(error.contains("bastion"), "{error}");
}

/// Plays sshfs on the VM: for "--share-serve", it reads the shared folder as an SFTP
/// client over the exec channel, then reports what it could and could not do.
#[derive(Clone)]
struct SshfsLikeVm {
    channels: Arc<std::sync::Mutex<std::collections::HashMap<ChannelId, Channel<Msg>>>>,
    report: tokio::sync::mpsc::UnboundedSender<String>,
}

impl server::Handler for SshfsLikeVm {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == PASSWORD { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().unwrap().insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        session.channel_success(channel)?;
        let Some(channel) = self.channels.lock().unwrap().remove(&channel) else { return Ok(()) };
        if !command.contains("--share-serve") {
            return Ok(());
        }
        let report = self.report.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let outcome = async {
                let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await?;
                let mut names: Vec<String> = sftp.read_dir("/").await?.map(|e| e.file_name()).collect();
                names.sort();
                let mut content = String::new();
                sftp.open("/a.txt").await?.read_to_string(&mut content).await.ok();
                let escaped = sftp.open("/../secret.txt").await.is_ok();
                let wrote = sftp.create("/new.txt").await.is_ok();
                Ok::<_, russh_sftp::client::error::Error>(format!("{command}|{names:?}|{content}|escaped={escaped}|wrote={wrote}"))
            }
            .await;
            let _ = report.send(outcome.unwrap_or_else(|e| format!("sftp error: {e}")));
        });
        Ok(())
    }
}

#[tokio::test]
async fn sharing_a_folder_over_the_connection() {
    let dir = std::env::temp_dir().join(format!("pier-share-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("shared/sub")).unwrap();
    std::fs::write(dir.join("shared/a.txt"), b"hello from the laptop").unwrap();
    std::fs::write(dir.join("secret.txt"), b"must stay home").unwrap();

    let key = host_key(7);
    let trusted = fingerprint_of(&key);
    let (report, mut reports) = tokio::sync::mpsc::unbounded_channel();
    let vm = SshfsLikeVm { channels: Default::default(), report };
    let port = serve_with(key, vm).await;
    let Outcome::Connected(connection) = open(&endpoint(port, PASSWORD), None, |_| Some(trusted.clone())).await.unwrap() else {
        panic!("must connect");
    };

    // What share_start does, minus the picker API around it.
    let channel = connection.channel().await.unwrap();
    channel.exec(true, "~/bin/pi-pick --share-serve '/home/leo/work/.pi-shared/shared' ro").await.unwrap();
    let fs = crate::share::ShareFs::new(&dir.join("shared"), false).unwrap();
    russh_sftp::server::run(channel.into_stream(), fs).await;

    let seen = tokio::time::timeout(std::time::Duration::from_secs(10), reports.recv()).await.unwrap().unwrap();
    assert_eq!(
        seen,
        "~/bin/pi-pick --share-serve '/home/leo/work/.pi-shared/shared' ro|[\"a.txt\", \"sub\"]|hello from the laptop|escaped=false|wrote=false"
    );
    assert!(!dir.join("shared/new.txt").exists());
    connection.close().await;
    let _ = std::fs::remove_dir_all(dir);
}

/// The picker's watch, played by the server: two lines at once (the second cut in the
/// middle), then an echo of every line Pier writes.
#[derive(Clone, Default)]
struct WatchServer;

impl server::Handler for WatchServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, _data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, br#"{"kind":"projects","data":{"running":[]}}"#.to_vec().into_iter().chain(*b"\n{\"kind\":\"lo").collect::<Vec<u8>>())?;
        session.data(channel, b"g\",\"lines\":[\"x\"]}\n".to_vec())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        for line in String::from_utf8_lossy(data).lines() {
            let got: serde_json::Value = serde_json::from_str(line).unwrap_or_default();
            session.data(channel, format!("{}\n", serde_json::json!({ "kind": "echo", "got": got })).into_bytes())?;
        }
        Ok(())
    }

    async fn channel_eof(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }
}

#[tokio::test]
async fn the_watch_reassembles_lines_and_talks_both_ways() {
    let key = host_key(9);
    let known = fingerprint_of(&key);
    let port = serve_with(key, WatchServer).await;
    let Outcome::Connected(connection) = open(&endpoint(port, "x"), None, |_| Some(known.clone())).await.unwrap() else {
        panic!("must connect");
    };
    let watch = crate::watch::Watch::default();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let (ended_tx, ended_rx) = tokio::sync::oneshot::channel();
    let channel = connection.channel().await.unwrap();
    let id = watch
        .start(channel, "pi-pick --api watch", move |message| { let _ = tx.send(message); }, move |id, _| { let _ = ended_tx.send(id); })
        .await
        .unwrap();
    let first = rx.recv().await.unwrap();
    assert_eq!(first["kind"], "projects");
    let second = rx.recv().await.unwrap();
    assert_eq!(second["lines"][0], "x", "a line cut in two packets is put back together");
    watch.send(&serde_json::json!({ "activity": { "project": "/home/leo/work" } })).await.unwrap();
    let echo = rx.recv().await.unwrap();
    assert_eq!(echo["got"]["activity"]["project"], "/home/leo/work");
    watch.stop().await;
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), ended_rx).await.expect("the end is reported").unwrap();
    assert_eq!(ended, id);
    assert!(watch.send(&serde_json::json!({})).await.is_err(), "nothing to send to once stopped");
    connection.close().await;
}

/// A server stuck in the past (AES-CTR and SHA-1 only): Pier does not talk to it,
/// and never sends the password.
#[tokio::test]
async fn an_old_server_is_refused() {
    let key = host_key(10);
    let known = fingerprint_of(&key);
    let config = Arc::new(server::Config {
        keys: vec![key],
        preferred: russh::Preferred {
            kex: std::borrow::Cow::Borrowed(&[russh::kex::DH_G14_SHA1]),
            cipher: std::borrow::Cow::Borrowed(&[russh::cipher::AES_128_CTR]),
            mac: std::borrow::Cow::Borrowed(&[russh::mac::HMAC_SHA1]),
            ..russh::Preferred::DEFAULT
        },
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let asked = Arc::new(std::sync::atomic::AtomicBool::new(false));
    #[derive(Clone)]
    struct Spy(Arc<std::sync::atomic::AtomicBool>);
    impl server::Handler for Spy {
        type Error = russh::Error;
        async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Auth::Accept)
        }
    }
    let spy = Spy(asked.clone());
    tokio::spawn(async move {
        if let Ok((socket, _)) = listener.accept().await {
            if let Ok(session) = server::run_stream(config, socket, spy).await {
                let _ = session.await;
            }
        }
    });
    let result = open(&endpoint(port, PASSWORD), None, |_| Some(known.clone())).await;
    assert!(!matches!(result, Ok(Outcome::Connected(_))), "no connection with weak algorithms");
    assert!(!asked.load(std::sync::atomic::Ordering::SeqCst), "the password was never sent");
}

#[test]
fn only_modern_algorithms_are_offered() {
    let preferred = super::preferred();
    assert_eq!(preferred.kex[0], russh::kex::MLKEM768X25519_SHA256, "post-quantum hybrid first");
    assert!(!preferred.kex.contains(&russh::kex::DH_G14_SHA1) && !preferred.kex.contains(&russh::kex::DH_G1_SHA1));
    assert!(preferred.kex.contains(&russh::kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT), "Terrapin fix kept");
    assert!(!preferred.key.contains(&russh::keys::Algorithm::Rsa { hash: None }), "no SHA-1 RSA");
    assert!(preferred.cipher.iter().all(|c| [russh::cipher::CHACHA20_POLY1305, russh::cipher::AES_256_GCM, russh::cipher::AES_128_GCM].contains(c)));
}

/// A redraw arriving as many small SSH packets.
#[derive(Clone, Default)]
struct BurstServer;

impl server::Handler for BurstServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, _data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        for i in 0..200 {
            session.data(channel, format!("line {i:03}\r\n").into_bytes())?;
        }
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

#[tokio::test]
async fn terminal_output_comes_in_order_and_in_few_messages() {
    let key = host_key(11);
    let known = fingerprint_of(&key);
    let port = serve_with(key, BurstServer).await;
    let Outcome::Connected(connection) = open(&endpoint(port, "x"), None, |_| Some(known.clone())).await.unwrap() else {
        panic!("must connect");
    };
    let received = Arc::new(std::sync::Mutex::new(Vec::<Vec<u8>>::new()));
    let sink = received.clone();
    let output = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
            sink.lock().unwrap().push(bytes);
        }
        Ok(())
    });
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let terminals = crate::term::Terminals::default();
    terminals
        .open(connection.channel().await.unwrap(), Some("burst"), 80, 24, output, move |_, status| { let _ = done_tx.send(status); })
        .await
        .unwrap();
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), done_rx).await.unwrap().unwrap();
    assert_eq!(status, Some(0));
    let messages = received.lock().unwrap().clone();
    let all: Vec<u8> = messages.concat();
    let expected: String = (0..200).map(|i| format!("line {i:03}\r\n")).collect();
    assert_eq!(String::from_utf8(all).unwrap(), expected, "every byte, in order");
    assert!(messages.len() < 50, "{} messages for 200 packets", messages.len());
    connection.close().await;
}

/// tmux in control mode, played by the server: it answers the attach, then prints what
/// Pier sent it as program output, and ends when told to detach.
#[derive(Clone, Default)]
struct ControlServer {
    stdin: Arc<std::sync::Mutex<Vec<u8>>>,
}

impl server::Handler for ControlServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, _data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, b"%begin 1 1 0\n%end 1 1 0\n%session-changed $1 pi-x\n%output %1 pi says hello\\015\\012\n".to_vec())?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let all = {
            let mut stdin = self.stdin.lock().unwrap();
            stdin.extend_from_slice(data);
            String::from_utf8_lossy(&stdin).into_owned()
        };
        if all.contains("detach-client\n") {
            session.data(channel, b"%exit\n".to_vec())?;
            session.close(channel)?;
        } else if all.ends_with("send-keys -H 68 69\n") {
            session.data(channel, b"%output %1 typed\n".to_vec())?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn pi_terminals_speak_tmux_control_mode() {
    let key = host_key(12);
    let known = fingerprint_of(&key);
    let server = ControlServer::default();
    let stdin = server.stdin.clone();
    let port = serve_with(key, server).await;
    let Outcome::Connected(connection) = open(&endpoint(port, "x"), None, |_| Some(known.clone())).await.unwrap() else {
        panic!("must connect");
    };
    let received = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let sink = received.clone();
    let output = tauri::ipc::Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
            sink.lock().unwrap().extend_from_slice(&bytes);
        }
        Ok(())
    });
    let (done_tx, done_rx) = tokio::sync::oneshot::channel();
    let terminals = crate::term::Terminals::default();
    let id = terminals
        .open_control(connection.channel().await.unwrap(), "pi-pick --attach-control /x", 100, 30, output, move |_, _| { let _ = done_tx.send(()); })
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    terminals.write(id, b"hi").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    terminals.close(id).await;
    tokio::time::timeout(std::time::Duration::from_secs(5), done_rx).await.expect("the end is reported").unwrap();
    let sent = String::from_utf8(stdin.lock().unwrap().clone()).unwrap();
    assert!(sent.starts_with("refresh-client -C 100x29\nrefresh-client -C 100x30\n"), "a nudge, then the size: {sent}");
    assert!(sent.contains("send-keys -H 68 69\n"), "{sent}");
    assert_eq!(
        String::from_utf8(received.lock().unwrap().clone()).unwrap(),
        "\x1b]7770;session;pi-x\x07pi says hello\r\ntyped",
        "the session's name for the tab, then only Pi's output"
    );
    connection.close().await;
}

/// A server at its MaxSessions: it refuses every new channel, as OpenSSH does.
#[derive(Clone, Default)]
struct FullServer;

impl server::Handler for FullServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(&mut self, _channel: Channel<Msg>, reply: server::ChannelOpenHandle, _session: &mut Session) -> Result<(), Self::Error> {
        reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
        Ok(())
    }
}

#[tokio::test]
async fn a_refused_channel_is_recognized() {
    let key = host_key(13);
    let known = fingerprint_of(&key);
    let port = serve_with(key, FullServer).await;
    let Outcome::Connected(connection) = open(&endpoint(port, "x"), None, |_| Some(known.clone())).await.unwrap() else {
        panic!("must connect");
    };
    let err = connection.channel().await.expect_err("the server is full");
    assert_eq!(super::refusal(&err).as_deref(), Some("ConnectFailed"), "Pier knows to open another connection");
    assert!(super::refusal(&anyhow::anyhow!("network down")).is_none());
    connection.close().await;
}
