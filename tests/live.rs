//! Tests against the real Pi over the network, ignored by default:
//! `$env:PIER_TEST_MODEL='openrouter/...'; cargo test -- --ignored --nocapture`.

use pier::pi::process::Process;
use pier::pi::protocol::{Command, StreamingBehavior};
use pier::session::journal::Record;
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
        assert!(t.answer(&a.id, approve));
        pump(&mut p, &mut t, &|t| t.state == State::Completed && t.approvals.is_empty(), 60);
        let tools: Vec<_> = t.entries[before..].iter().filter(|e| e.text.starts_with("bash →")).map(|e| e.text.as_str()).collect();
        assert_eq!(tools.first().copied(), Some(expected), "entries: {:#?}", &t.entries[before..]);
        assert_eq!(probe.exists(), approve, "{marker}: the command must run if and only if approved");
        let _ = std::fs::remove_file(probe);
    }
    let decisions: Vec<_> = t
        .journal
        .iter()
        .filter_map(|r| match r {
            Record::ApprovalDecided { decision, .. } => Some(*decision),
            _ => None,
        })
        .collect();
    assert_eq!(decisions, ["allowed", "refused"], "journal keeps every decision");
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

/// A preset's options reach Pi and Pi works in the preset's folder (its session file lands under that folder's name).
#[test]
#[ignore]
fn live_preset_cwd_and_args() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let dir = std::env::temp_dir().join(format!("pier-preset-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let preset = pier::presets::Preset {
        name: "test".into(),
        cwd: Some(dir.clone()),
        model: Some(model),
        thinking: Some("off".into()),
        tools: Some("read".into()),
        append_system_prompt: Some("Always answer in uppercase.".into()),
    };
    let mut p = Process::spawn_in(&preset.args(), preset.cwd.as_deref(), || {}).unwrap();
    let mut t = Transcript::default();
    p.send(&Command::GetState).unwrap();
    p.send(&prompt("Say hello.")).unwrap();
    pump(&mut p, &mut t, &|t| t.state == State::Completed && t.session_file.is_some(), 60);
    let file = t.session_file.clone().expect("session file");
    drop(p);
    let reply: String = t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.clone()).collect();
    let _ = std::fs::remove_file(&file);
    let _ = std::fs::remove_dir(file.parent().unwrap());
    let _ = std::fs::remove_dir(&dir);
    let expected = pier::pi::sessions::dir_for(&std::fs::canonicalize(&dir).unwrap_or(dir.clone()));
    assert_eq!(file.parent().unwrap().file_name(), expected.file_name(), "Pi ran in the preset folder");
    assert!(reply.contains("HELLO"), "appended system prompt applied: {reply:?}");
}

/// A write outside the working folder carries the warning (refused), one inside does not (approved, and written).
#[test]
#[ignore]
fn live_outside_folder_warning() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    pump(&mut p, &mut t, &|t| t.supervised(), 30);

    for (path, outside) in [("../pier-outside-probe.txt", true), ("pier-inside-probe.txt", false)] {
        p.send(&prompt(&format!("Use the write tool to create the file {path} containing x. Do nothing else, do not retry."))).unwrap();
        pump(&mut p, &mut t, &|t| !t.approvals.is_empty(), 60);
        let a = t.approvals.front().expect("write must wait for an approval").clone();
        assert_eq!(a.title, "Autoriser write ?");
        assert_eq!(a.outside.is_some(), outside, "{path}: warning {:?}", a.outside);
        // The inside write is approved: it proves the input freeze after approval does not break Pi's write tool.
        let approve = !outside;
        assert!(t.answer(&a.id, approve));
        pump(&mut p, &mut t, &|t| t.state == State::Completed && t.approvals.is_empty(), 60);
        let probe = std::path::Path::new(path);
        assert_eq!(probe.exists(), approve, "{path}: written if and only if approved; entries {:#?}", t.entries);
        let _ = std::fs::remove_file(probe);
    }
}

/// The current model and thinking level are read from Pi, the model list loads, and a level change is read back.
#[test]
#[ignore]
fn live_model_and_thinking_switch() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    for c in [Command::GetState, Command::GetAvailableModels, Command::GetAvailableThinkingLevels] {
        p.send(&c).unwrap();
    }
    pump(&mut p, &mut t, &|t| t.model.is_some() && !t.models.is_empty() && !t.thinking_levels.is_empty(), 30);
    let current = t.model.clone().expect("get_state gives the model");
    assert_eq!(current.key(), model, "the --model we launched with");
    assert!(t.models.iter().any(|m| m.key() == model), "{} models listed", t.models.len());
    eprintln!("{} models, levels {:?}, thinking {:?}", t.models.len(), t.thinking_levels, t.thinking);

    // Switch to another model of the same provider (its auth is set) that has thinking levels. No prompt: costs nothing.
    let other = t
        .models
        .iter()
        .find(|m| m.provider == current.provider && m.reasoning && m.key() != current.key())
        .cloned()
        .expect("a reasoning model on the same provider");
    p.send(&Command::SetModel { provider: other.provider.clone(), model_id: other.id.clone() }).unwrap();
    pump(&mut p, &mut t, &|t| t.model.as_ref().map(|m| m.key()) == Some(other.key()) && t.thinking_levels.len() > 1, 30);
    assert_eq!(t.model.as_ref().map(|m| m.key()), Some(other.key()), "errors: {:?}", t.entries);
    assert!(t.thinking_levels.len() > 1, "levels re-read after the switch: {:?}", t.thinking_levels);

    let target = t.thinking_levels.iter().find(|l| Some(*l) != t.thinking.as_ref()).cloned().unwrap();
    p.send(&Command::SetThinkingLevel { level: target.clone() }).unwrap();
    pump(&mut p, &mut t, &|t| t.thinking.as_ref() == Some(&target), 30);
    assert_eq!(t.thinking.as_ref(), Some(&target), "errors: {:?}", t.entries);
    assert!(!t.entries.iter().any(|e| e.kind == Kind::Error), "{:?}", t.entries);
    eprintln!("switched to {} at thinking {target}", other.key());
}

/// Closing a tab leaves no process behind: the launcher, the real Pi it starts, and their children all go.
#[test]
#[ignore]
fn live_close_leaves_no_orphan() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    let tree = descendants(p.id());
    assert!(tree.len() >= 2, "launcher and the real Pi: {tree:?}");
    drop(p);
    std::thread::sleep(Duration::from_millis(500));
    let alive: Vec<u32> = tree.into_iter().filter(|pid| is_alive(*pid)).collect();
    assert!(alive.is_empty(), "still running after close: {alive:?}");
}

/// `root` and every process below it.
fn descendants(root: u32) -> Vec<u32> {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"])
        .output()
        .unwrap();
    let pairs: Vec<(u32, u32)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(|n| n.parse::<u32>().ok());
            Some((it.next()??, it.next()??))
        })
        .collect();
    let mut tree = vec![root];
    let mut i = 0;
    while i < tree.len() {
        let parent = tree[i];
        tree.extend(pairs.iter().filter(|(_, pp)| *pp == parent).map(|(pid, _)| *pid));
        i += 1;
    }
    tree
}

fn is_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist").args(["/fi", &format!("PID eq {pid}"), "/nh"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}
