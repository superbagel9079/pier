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
