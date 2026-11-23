//! Tests against the real Pi over the network, ignored by default:
//! `$env:PIER_TEST_MODEL='openrouter/...'; cargo test -- --ignored --nocapture`.

use pier::pi::process::Process;
use pier::pi::protocol::{Command, StreamingBehavior};
use pier::session::state::State;
use pier::session::transcript::{Kind, Transcript};
use std::time::{Duration, Instant};

#[test]
#[ignore]
fn live_prompt_steer_and_stop() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    let pump = |p: &mut Process, t: &mut Transcript, until: &dyn Fn(&Transcript) -> bool, secs: u64| {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end && !until(t) {
            if let Ok(m) = p.rx.recv_timeout(Duration::from_millis(200)) {
                t.apply(m);
            }
            for r in std::mem::take(&mut t.outbox) {
                p.send(&r).unwrap();
            }
        }
    };

    p.send(&prompt("Reply with exactly the word: bonjour")).unwrap();
    pump(&mut p, &mut t, &|t| t.entries.iter().any(|e| e.kind == Kind::Assistant) && !t.state.is_running(), 60);
    let reply: String = t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.clone()).collect();
    assert!(reply.to_lowercase().contains("bonjour"), "reply: {reply:?} errors: {:?}", t.entries);

    p.send(&prompt("Count from 1 to 3000 in words, one per line.")).unwrap();
    pump(&mut p, &mut t, &|t| t.state.is_running() && t.entries.last().is_some_and(|e| e.text.len() > 200), 60);
    p.send(&Command::Prompt { message: "STEER-MARK".into(), streaming_behavior: Some(StreamingBehavior::Steer) }).unwrap();
    pump(&mut p, &mut t, &|t| !t.queued.is_empty(), 15);
    assert_eq!(t.queued, ["STEER-MARK"], "steer should be visible as queued");

    p.send(&Command::ClearQueue).unwrap();
    p.send(&Command::Abort).unwrap();
    pump(&mut p, &mut t, &|t| !t.state.is_running() && !t.restored.is_empty(), 30);
    assert_eq!(t.state, State::Stopped);
    assert_eq!(t.restored, ["STEER-MARK"], "cleared steer must come back to the editor");
    assert!(t.entries.iter().any(|e| e.text == "Run interrompu."));
    let unreadable: Vec<_> = t.stderr.iter().filter(|l| l.starts_with("événement illisible")).collect();
    assert!(unreadable.is_empty(), "typed events must match real Pi output: {unreadable:#?}");
    eprintln!("{} entries, status {:?}", t.entries.len(), t.status);
}

fn prompt(message: &str) -> Command {
    Command::Prompt { message: message.into(), streaming_behavior: None }
}

/// Pier's extension is active, an allowed bash call runs, a refused one does not.
#[test]
#[ignore]
fn live_tool_approval_allow_and_deny() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    assert!(t.supervised(), "approval extension never reported in; stderr: {:#?}", t.stderr);

    // Each command leaves a file, so the test sees what really ran, not only the reported status.
    for (marker, approve, expected) in [("pier-allow-probe.tmp", true, "bash → ok"), ("pier-deny-probe.tmp", false, "bash → erreur")] {
        let probe = std::path::Path::new(marker);
        let _ = std::fs::remove_file(probe);
        let before = t.entries.len();
        p.send(&prompt(&format!("Use the bash tool to run exactly: touch {marker}. Do nothing else, do not retry."))).unwrap();
        pump(&mut p, &mut t, &|t| !t.approvals.is_empty(), 60);
        let a = t.approvals.front().expect("bash must wait for an approval").clone();
        assert_eq!(a.title, "Autoriser bash ?");
        assert!(a.message.contains(marker), "approval shows the command: {:?}", a.message);
        assert_eq!(t.state, State::Blocked);
        t.answer(approve);
        pump(&mut p, &mut t, &|t| t.state == State::Completed && t.approvals.is_empty(), 60);
        let tools: Vec<_> = t.entries[before..].iter().filter(|e| e.text.starts_with("bash →")).map(|e| e.text.as_str()).collect();
        assert_eq!(tools.first().copied(), Some(expected), "entries: {:#?}", &t.entries[before..]);
        assert_eq!(probe.exists(), approve, "{marker}: the command must run if and only if approved");
        let _ = std::fs::remove_file(probe);
    }
}

fn pump(p: &mut Process, t: &mut Transcript, until: &dyn Fn(&Transcript) -> bool, secs: u64) {
    let end = Instant::now() + Duration::from_secs(secs);
    loop {
        for r in std::mem::take(&mut t.outbox) {
            p.send(&r).unwrap();
        }
        if until(t) || Instant::now() >= end {
            return;
        }
        if let Ok(m) = p.rx.recv_timeout(Duration::from_millis(200)) {
            t.apply(m);
        }
    }
}

/// Two Pi processes run side by side, each reply stays in its own transcript, and closing one leaves the other usable.
#[test]
#[ignore]
fn live_two_parallel_sessions() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let mut sessions: Vec<(Process, Transcript)> = (0..2).map(|_| (Process::spawn(&args, || {}).unwrap(), Transcript::default())).collect();
    let pump_all = |sessions: &mut Vec<(Process, Transcript)>, until: &dyn Fn(&Transcript) -> bool, secs: u64| {
        let end = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < end && !sessions.iter().all(|(_, t)| until(t)) {
            for (p, t) in sessions.iter_mut() {
                while let Ok(m) = p.rx.recv_timeout(Duration::from_millis(20)) {
                    t.apply(m);
                }
            }
        }
    };
    pump_all(&mut sessions, &|t| t.supervised(), 30);

    for ((p, _), word) in sessions.iter_mut().zip(["alpha", "bravo"]) {
        p.send(&prompt(&format!("Reply with exactly the word: {word}"))).unwrap();
    }
    pump_all(&mut sessions, &|t| t.state == State::Completed, 60);
    let replies: Vec<String> = sessions
        .iter()
        .map(|(_, t)| t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.to_lowercase()).collect())
        .collect();
    assert!(replies[0].contains("alpha") && !replies[0].contains("bravo"), "{replies:?}");
    assert!(replies[1].contains("bravo") && !replies[1].contains("alpha"), "{replies:?}");

    drop(sessions.remove(0));
    let (p, t) = &mut sessions[0];
    p.send(&prompt("Reply with exactly the word: charlie")).unwrap();
    pump(p, t, &|t| t.entries.iter().any(|e| e.text.to_lowercase().contains("charlie")) && t.state == State::Completed, 60);
    assert!(t.entries.iter().any(|e| e.kind == Kind::Assistant && e.text.to_lowercase().contains("charlie")), "{:#?}", t.entries);
}

/// A saved session reopened with `--session` shows its history and Pi still knows what was said.
#[test]
#[ignore]
fn live_resume_session() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-tools", "--model", &model].map(String::from);

    let (mut p, mut t) = (Process::spawn(&args, || {}).unwrap(), Transcript::default());
    p.send(&Command::GetState).unwrap();
    pump(&mut p, &mut t, &|t| t.supervised() && t.session_file.is_some(), 30);
    p.send(&prompt("Remember the code word zebra-42. Reply only: ok")).unwrap();
    pump(&mut p, &mut t, &|t| t.state == State::Completed, 60);
    let file = t.session_file.clone().expect("get_state gives the session file");
    drop(p); // Pi exits and its session file stays
    assert!(file.exists(), "session file written: {file:?}");

    let resume = [&args[..], &["--session".into(), file.to_string_lossy().into_owned()]].concat();
    let (mut p, mut t) = (Process::spawn(&resume, || {}).unwrap(), Transcript::default());
    p.send(&Command::GetMessages).unwrap();
    pump(&mut p, &mut t, &|t| t.supervised() && t.entries.iter().any(|e| e.text == "— session reprise —"), 30);
    assert!(t.entries.iter().any(|e| e.kind == Kind::User && e.text.contains("zebra-42")), "history: {:#?}", t.entries);

    p.send(&prompt("What was the code word? Reply with it only.")).unwrap();
    pump(&mut p, &mut t, &|t| t.state == State::Completed, 60);
    let last = t.entries.iter().rev().find(|e| e.kind == Kind::Assistant).map(|e| e.text.to_lowercase());
    drop(p);
    let _ = std::fs::remove_file(&file); // test session, not the user's
    assert!(last.is_some_and(|l| l.contains("zebra-42")), "{:#?}", t.entries);
}
