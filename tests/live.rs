//! Tests against the real Pi over the network, ignored by default (each costs a little):
//! `$env:PIER_TEST_MODEL='openrouter/...'; cargo test --test live -- --ignored --test-threads=1`.
//! Run one at a time: several Pi starting together compete for the same session folder and the network.

use pier::pi::process::Process;
use pier::pi::protocol::{Command, StreamingBehavior};
use pier::session::journal::Record;
use pier::session::state::State;
use pier::session::transcript::{Kind, Transcript};
use std::time::{Duration, Instant};

#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_prompt_steer_and_stop() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();

    p.send(&prompt("Reply with exactly the word: bonjour")).unwrap();
    pump(&mut p, &mut t, &|t| t.entries.iter().any(|e| e.kind == Kind::Assistant) && !t.state.is_running(), 60);
    let reply: String = t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.clone()).collect();
    assert!(reply.to_lowercase().contains("bonjour"), "reply: {reply:?} errors: {:?}", t.entries);

    p.send(&prompt("Count from 1 to 3000 in words, one per line.")).unwrap();
    pump(&mut p, &mut t, &|t| t.state.is_running() && t.entries.last().is_some_and(|e| e.text.len() > 200), 60);
    p.send(&Command::prompt("STEER-MARK", Some(StreamingBehavior::Steer))).unwrap();
    pump(&mut p, &mut t, &|t| !t.queued.is_empty(), 15);
    assert_eq!(t.queued.iter().map(|q| q.text.as_str()).collect::<Vec<_>>(), ["STEER-MARK"], "steer should be visible as queued");

    p.send(&Command::ClearQueue).unwrap();
    p.send(&Command::Abort).unwrap();
    pump(&mut p, &mut t, &|t| !t.state.is_running() && !t.restored.is_empty(), 30);
    assert_eq!(t.state, State::Stopped);
    assert_eq!(t.restored, ["STEER-MARK"], "cleared steer must come back to the editor");
    assert!(t.entries.iter().any(|e| e.text == "Run stopped."));
    let unreadable: Vec<_> = t.stderr.iter().filter(|l| l.starts_with("unreadable event")).collect();
    assert!(unreadable.is_empty(), "typed events must match real Pi output: {unreadable:#?}");
    eprintln!("{} entries, status {:?}", t.entries.len(), t.status);
}

fn prompt(message: &str) -> Command {
    Command::prompt(message, None)
}

/// Pier's extension is active, an allowed bash call runs, a refused one does not.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_tool_approval_allow_and_deny() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    assert!(t.supervised(), "approval extension never reported in; stderr: {:#?}", t.stderr);

    // Each command leaves a file, so the test sees what really ran, not only the reported status.
    for (marker, approve, expected) in [("pier-allow-probe.tmp", true, "bash → ok"), ("pier-deny-probe.tmp", false, "bash → error")] {
        let probe = std::path::Path::new(marker);
        let _ = std::fs::remove_file(probe);
        let before = t.entries.len();
        p.send(&prompt(&format!("Use the bash tool to run exactly: touch {marker}. Do nothing else, do not retry."))).unwrap();
        pump(&mut p, &mut t, &|t| !t.approvals.is_empty(), 60);
        let a = t.approvals.front().expect("bash must wait for an approval").clone();
        assert_eq!(a.title, "Allow bash?");
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
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
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
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
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
    pump(&mut p, &mut t, &|t| t.supervised() && t.entries.iter().any(|e| e.text == "— session resumed —"), 30);
    assert!(t.entries.iter().any(|e| e.kind == Kind::User && e.text.contains("zebra-42")), "history: {:#?}", t.entries);

    p.send(&prompt("What was the code word? Reply with it only.")).unwrap();
    pump(&mut p, &mut t, &|t| t.state == State::Completed, 60);
    let last = t.entries.iter().rev().find(|e| e.kind == Kind::Assistant).map(|e| e.text.to_lowercase());
    drop(p);
    let _ = std::fs::remove_file(&file); // test session, not the user's
    // The model may write "Zebra 42" or "zebra_42": what matters is that it remembers, not the exact spelling.
    assert!(last.as_ref().is_some_and(|l| l.contains("zebra") && l.contains("42")), "reply {last:?}; entries {:#?}", t.entries);
}

/// A preset's options reach Pi and Pi works in the preset's folder (its session file lands under that folder's name).
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
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
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
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
        assert_eq!(a.title, "Allow write?");
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
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
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

/// Closing a tab while an approved command runs leaves no process behind: the launcher, the real Pi and the
/// command it started (which would never stop by itself) all go, through the Job Object.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_close_leaves_no_orphan() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--model", &model].map(String::from);
    let mut p = Process::spawn(&args, || {}).unwrap();
    let mut t = Transcript::default();
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    p.send(&prompt("Use the bash tool to run exactly: sleep 30. Do nothing else.")).unwrap();
    pump(&mut p, &mut t, &|t| !t.approvals.is_empty(), 60);
    let id = t.approvals.front().expect("bash waits for an approval").id.clone();
    assert!(t.answer(&id, true));
    pump(&mut p, &mut t, &|_| false, 3); // let bash start sleep
    let tree = descendants(p.id());
    assert!(tree.len() >= 3, "launcher, Pi and the running command: {tree:?}");

    drop(p);
    let end = Instant::now() + Duration::from_secs(5);
    let mut alive: Vec<u32> = tree.clone();
    while !alive.is_empty() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(200));
        alive.retain(|pid| is_alive(*pid));
    }
    assert!(alive.is_empty(), "still running 5 s after close: {alive:?} (tree was {tree:?})");
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

/// A name given in Pier is confirmed by Pi, written to the session file, and shown by Resume.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_session_name_reaches_resume() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-tools", "--model", &model].map(String::from);
    let (mut p, mut t) = (Process::spawn(&args, || {}).unwrap(), Transcript::default());
    p.send(&Command::GetState).unwrap();
    pump(&mut p, &mut t, &|t| t.supervised() && t.session_file.is_some(), 30);
    p.send(&prompt("Reply only: ok")).unwrap();
    pump(&mut p, &mut t, &|t| t.state == State::Completed, 60);

    let name = format!("Test Pier {}", std::process::id());
    p.send(&Command::SetSessionName { name: name.clone() }).unwrap();
    pump(&mut p, &mut t, &|t| t.session_name.is_some(), 30);
    for c in std::mem::take(&mut t.outbox) {
        p.send(&c).unwrap();
    }
    pump(&mut p, &mut t, &|t| t.session_name.as_deref() == Some(name.as_str()), 30);
    assert_eq!(t.session_name.as_deref(), Some(name.as_str()), "Pi confirms the name; {:?}", t.entries);
    let file = t.session_file.clone().unwrap();
    drop(p);

    let cwd = std::env::current_dir().unwrap();
    let listed = pier::pi::sessions::list(&cwd, 50);
    let title = listed.iter().find(|s| s.path.file_name() == file.file_name()).map(|s| s.title.clone());
    let _ = std::fs::remove_file(&file); // test session, not the user's
    assert_eq!(title.as_deref(), Some(name.as_str()), "Resume shows the name");
}

/// After an answer, Pi's session stats give a context gauge (percent of a known window) and a cost.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_context_gauge_and_cost() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let (mut p, mut t) = (Process::spawn(&args, || {}).unwrap(), Transcript::default());
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    p.send(&prompt("Reply only: ok")).unwrap();
    // The finished answer makes the transcript ask for stats; pump sends that request.
    pump(&mut p, &mut t, &|t| t.stats.as_ref().and_then(|s| s.context_usage.as_ref()).is_some_and(|c| c.percent.is_some()), 60);
    let s = t.stats.clone().expect("stats after an answer");
    let c = s.context_usage.clone().expect("context usage for a known model");
    eprintln!("context {:?} / {} ({:?} %), cost ${}", c.tokens, c.context_window, c.percent, s.cost);
    assert!(c.context_window > 0 && c.tokens.unwrap_or(0) > 0, "{c:?}");
    assert!(c.percent.unwrap() > 0.0 && c.percent.unwrap() < 100.0, "{c:?}");
    assert!(s.cost >= 0.0);
}

/// Pi lists its `/` commands and the palette filter finds them.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_slash_commands_listed() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--no-tools", "--model", &model].map(String::from);
    let (mut p, mut t) = (Process::spawn(&args, || {}).unwrap(), Transcript::default());
    p.send(&Command::GetCommands).unwrap();
    pump(&mut p, &mut t, &|t| !t.commands.is_empty(), 20);
    eprintln!("{} commands: {:?}", t.commands.len(), t.commands.iter().map(|c| (&c.name, &c.source)).collect::<Vec<_>>());
    assert!(!t.commands.is_empty(), "this Pi install has extension commands, templates or skills");
    let first = &t.commands[0].name;
    let typed = format!("/{}", &first[..first.len().min(3)]);
    assert!(t.matching_commands(&typed).iter().any(|c| &c.name == first), "{typed} finds {first}");
    assert!(!t.entries.iter().any(|e| e.kind == Kind::Error), "{:?}", t.entries);
}

/// Write then edit a file: each approval carries a diff preview, and the edit's exact patch from Pi lands in the
/// transcript.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_diff_preview_and_edit_patch() {
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let args = ["--no-session", "--model", &model].map(String::from);
    let (mut p, mut t) = (Process::spawn(&args, || {}).unwrap(), Transcript::default());
    pump(&mut p, &mut t, &|t| t.supervised(), 30);
    let file = format!("pier-diff-probe-{}.txt", std::process::id());
    let _ = std::fs::remove_file(&file);

    let steps = [
        (format!("Use the write tool to create {file} with exactly two lines: alpha and beta. Do nothing else."), "+alpha"),
        (format!("Use the edit tool on {file} to replace the line beta with gamma. Do nothing else."), "+gamma"),
    ];
    for (ask, expected) in steps {
        let before = t.entries.len();
        p.send(&prompt(&ask)).unwrap();
        pump(&mut p, &mut t, &|t| !t.approvals.is_empty(), 60);
        let a = t.approvals.front().expect("waits for an approval").clone();
        let diff = a.diff.clone().unwrap_or_default();
        assert!(diff.contains(expected), "{}: preview {diff:?}", a.title);
        assert!(!diff.contains("approximate"), "exact preview expected: {diff:?}");
        assert!(t.answer(&a.id, true));
        pump(&mut p, &mut t, &|t| t.state == State::Completed && t.approvals.is_empty(), 60);
        if a.title == "Allow edit?" {
            let patched = t.entries[before..].iter().find(|e| e.text == "edit → ok").and_then(|e| e.diff.clone());
            assert!(patched.as_deref().is_some_and(|d| d.contains("-beta") && d.contains("+gamma")), "{:#?}", &t.entries[before..]);
        }
    }
    let content = std::fs::read_to_string(&file).unwrap_or_default();
    let _ = std::fs::remove_file(&file);
    assert!(content.contains("gamma") && !content.contains("beta"), "file: {content:?}");
}

/// Through the real tab: the message gets a checkpoint before Pi sees it, Pi's change is undone by Restore.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_checkpoint_restores_a_change() {
    use pier::workspace::{Launch, Workspace};
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let dir = std::env::temp_dir().join(format!("pier-checkpoint-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.txt"), "one").unwrap();
    let mut ws = Workspace::new(["--no-session", "--model", &model].map(String::from).to_vec(), dir.join("recent.json"));
    ws.open(&dir, Launch::New, || {});
    let run = |ws: &mut Workspace, until: &dyn Fn(&pier::workspace::Tab) -> bool| {
        let end = Instant::now() + Duration::from_secs(90);
        while Instant::now() < end {
            ws.update(Instant::now());
            ws.flush();
            let tab = &mut ws.tabs[0];
            if let Some(id) = tab.t.approvals.front().map(|a| a.id.clone()) {
                tab.approve(&id, true);
            }
            if until(tab) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("timed out: {:#?}", ws.tabs[0].t.entries);
    };
    run(&mut ws, &|t| t.t.supervised());

    ws.tabs[0].input = "Use the write tool to replace the content of a.txt with: two. Do nothing else.".into();
    ws.tabs[0].submit();
    run(&mut ws, &|t| t.t.state == State::Completed);
    assert_eq!(
        std::fs::read_to_string(dir.join("a.txt")).unwrap().trim(),
        "two",
        "Pi made the change (a trailing newline is the model's choice)"
    );
    let entries = &ws.tabs[0].t.entries;
    let saved = entries.iter().position(|e| e.kind == Kind::Checkpoint).expect("a checkpoint");
    assert!(entries[saved..].iter().any(|e| e.kind == Kind::User), "the checkpoint comes before the message");

    let id = entries[saved].checkpoint.clone().unwrap();
    ws.tabs[0].restore(&id);
    run(&mut ws, &|t| t.can_restore());
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one", "restored: {:#?}", ws.tabs[0].t.entries);
    drop(ws);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Fork from the first message with its files restored: the tab moves to a new session holding only what came
/// before, the message returns to the editor, the file written by that message is gone, the original file stays.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_fork_with_files_restored() {
    use pier::workspace::{Launch, Tab, Workspace};
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let dir = std::env::temp_dir().join(format!("pier-fork-live-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut ws = Workspace::new(["--model", &model].map(String::from).to_vec(), dir.join("recent.json"));
    ws.open(&dir, Launch::New, || {});
    let run = |ws: &mut Workspace, until: &dyn Fn(&Tab) -> bool| {
        let end = Instant::now() + Duration::from_secs(90);
        while Instant::now() < end {
            ws.update(Instant::now());
            ws.flush();
            let tab = &mut ws.tabs[0];
            if let Some(id) = tab.t.approvals.front().map(|a| a.id.clone()) {
                tab.approve(&id, true);
            }
            if until(tab) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("timed out: {:#?}", ws.tabs[0].t.entries);
    };
    run(&mut ws, &|t| t.t.supervised());
    let first = "Use the write tool to create the file a.txt containing: one. Do nothing else.";
    for (n, message) in [first, "Reply with just the word: ok"].into_iter().enumerate() {
        ws.tabs[0].input = message.into();
        ws.tabs[0].submit();
        // Pi has shown the message and settled: "not busy" alone is also true just before the run starts.
        let users = |t: &Tab| t.t.entries.iter().filter(|e| e.kind == Kind::User).count();
        run(&mut ws, &|t| users(t) == n + 1 && t.t.state == State::Completed && !t.busy());
    }
    assert!(dir.join("a.txt").exists(), "Pi wrote the file");
    let original = ws.tabs[0].t.session_file.clone().expect("a session file");

    ws.tabs[0].refresh_fork_messages();
    run(&mut ws, &|t| t.t.fork_messages.len() == 2);
    let target = ws.tabs[0].t.fork_messages[0].clone();
    assert_eq!(target.text, first);
    let checkpoint = ws.tabs[0].checkpoint_before(&target.text);
    assert!(checkpoint.is_some(), "the first message has its checkpoint");
    ws.tabs[0].fork(&target.entry_id, checkpoint);
    run(&mut ws, &|t| {
        t.input == first && t.t.session_file.as_ref() != Some(&original) && t.t.entries.iter().any(|e| e.text.starts_with("— forked"))
    });

    let tab = &ws.tabs[0];
    assert!(!dir.join("a.txt").exists(), "files restored to before the first message");
    assert!(!tab.t.entries.iter().any(|e| e.kind == Kind::User), "nothing came before the first message: {:#?}", tab.t.entries);
    assert!(tab.t.entries.iter().any(|e| e.kind == Kind::Checkpoint), "the restore's undo point stays reachable");
    assert!(original.exists(), "the original session stays");
    let fork_file = tab.t.session_file.clone().unwrap();
    drop(ws);
    for f in [&original, &fork_file] {
        let _ = std::fs::remove_file(f);
    }
    let _ = std::fs::remove_dir(original.parent().unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A pasted image reaches the model: a plain red square is described as red, and the message shows it carried one.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_image_reaches_the_model() {
    use pier::attach::Image;
    use pier::workspace::{Launch, Tab, Workspace};
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL (a model that reads images)");
    let dir = std::env::temp_dir().join(format!("pier-image-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut ws = Workspace::new(["--no-session", "--model", &model].map(String::from).to_vec(), dir.join("recent.json"));
    ws.open(&dir, Launch::New, || {});
    let run = |ws: &mut Workspace, until: &dyn Fn(&Tab) -> bool| {
        let end = Instant::now() + Duration::from_secs(90);
        while Instant::now() < end {
            ws.update(Instant::now());
            ws.flush();
            if until(&ws.tabs[0]) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("timed out: {:#?}", ws.tabs[0].t.entries);
    };
    run(&mut ws, &|t| t.t.supervised() && t.t.model.is_some());
    let red: Vec<u8> = (0..32 * 32).flat_map(|_| [220, 20, 20, 255]).collect();
    ws.tabs[0].attach(Image::from_rgba(32, 32, &red));
    ws.tabs[0].input = "What is the main color of this image? Answer with one word.".into();
    ws.tabs[0].submit();
    run(&mut ws, &|t| t.t.state == State::Completed && t.t.entries.iter().any(|e| e.kind == Kind::Assistant));
    let t = &ws.tabs[0].t;
    assert!(t.entries.iter().any(|e| e.kind == Kind::User && e.text.ends_with("(+1 image)")), "{:#?}", t.entries);
    let reply: String = t.entries.iter().filter(|e| e.kind == Kind::Assistant).map(|e| e.text.to_lowercase()).collect();
    assert!(reply.contains("red"), "the model saw the image: {reply:?}");
    drop(ws);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Queue a steer and a follow-up during a long answer, take them back, edit one, send them back: Pi's queue holds
/// the edited text with each kind kept.
#[test]
#[ignore = "calls a real, paid model: set PIER_TEST_MODEL and run with --ignored"]
fn live_queue_edit_and_send_back() {
    use pier::workspace::{Launch, Tab, Workspace};
    let model = std::env::var("PIER_TEST_MODEL").expect("set PIER_TEST_MODEL");
    let dir = std::env::temp_dir().join(format!("pier-queue-live-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut ws = Workspace::new(["--no-session", "--no-tools", "--model", &model].map(String::from).to_vec(), dir.join("recent.json"));
    ws.open(&dir, Launch::New, || {});
    let run = |ws: &mut Workspace, until: &dyn Fn(&Tab) -> bool| {
        let end = Instant::now() + Duration::from_secs(60);
        while Instant::now() < end {
            ws.update(Instant::now());
            ws.flush();
            if until(&ws.tabs[0]) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out: queued {:?} draft {:?} entries {:#?}", ws.tabs[0].t.queued, ws.tabs[0].t.queue_draft, ws.tabs[0].t.entries);
    };
    run(&mut ws, &|t| t.t.supervised());
    ws.tabs[0].input = "Count from 1 to 3000 in words, one per line.".into();
    ws.tabs[0].submit();
    run(&mut ws, &|t| t.t.state.is_running() && t.t.entries.last().is_some_and(|e| e.text.len() > 200));
    ws.tabs[0].input = "STEER-A".into();
    ws.tabs[0].submit();
    ws.tabs[0].input = "AFTER-B".into();
    ws.tabs[0].queue_after();
    run(&mut ws, &|t| t.t.queued.len() == 2);

    ws.tabs[0].edit_queue();
    run(&mut ws, &|t| t.t.queue_draft.is_some() && t.t.queued.is_empty());
    let draft = ws.tabs[0].t.queue_draft.as_mut().unwrap();
    assert_eq!(draft.iter().map(|q| (q.text.as_str(), q.after)).collect::<Vec<_>>(), [("STEER-A", false), ("AFTER-B", true)]);
    draft[0].text = "STEER-EDITED".into();
    ws.tabs[0].send_queue_back();
    run(&mut ws, &|t| t.t.queued.len() == 2);
    let back: Vec<_> = ws.tabs[0].t.queued.iter().map(|q| (q.text.clone(), q.after)).collect();
    assert_eq!(back, [("STEER-EDITED".to_owned(), false), ("AFTER-B".to_owned(), true)]);
    ws.tabs[0].stop();
    run(&mut ws, &|t| !t.t.state.is_running());
    drop(ws);
    let _ = std::fs::remove_dir_all(&dir);
}
