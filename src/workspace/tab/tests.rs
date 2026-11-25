use super::*;
use crate::checkpoint::Repo;

#[test]
fn the_session_name_titles_the_tab() {
    use crate::pi::process::parse_line;
    let mut tab = Tab::detached("a");
    let feed = |tab: &mut Tab, line: &str| tab.t.apply_event(&parse_line(line.as_bytes()).unwrap().unwrap());
    feed(&mut tab, r#"{"type":"message_start","message":{"role":"user","content":"run the tests"}}"#);
    assert_eq!(tab.title(), "run the tests");
    feed(&mut tab, r#"{"type":"response","command":"get_state","success":true,"data":{"sessionName":"Parser tests"}}"#);
    assert_eq!(tab.title(), "Parser tests", "a name beats the first prompt");
    feed(&mut tab, r#"{"type":"session_info_changed","name":"A name that is far too long for a tab"}"#);
    assert_eq!(tab.title(), "A name that is far too l…");
    feed(&mut tab, r#"{"type":"session_info_changed"}"#);
    assert_eq!(tab.title(), "run the tests", "cleared name: back to the prompt");
    feed(&mut tab, r#"{"type":"response","command":"set_session_name","success":true}"#);
    assert_eq!(tab.t.outbox, [Command::GetState], "the name is read back from Pi");
}

#[test]
fn nothing_is_sent_before_supervision() {
    let mut tab = Tab::detached("a");
    tab.input = "rm -rf".into();
    tab.submit();
    assert_eq!(tab.input, "rm -rf", "kept for later, not sent");
    assert_eq!(tab.t.entries.last().map(|e| e.text.as_str()), Some("Not sent: Pi is not supervised."));
}

#[test]
fn a_message_waits_for_its_checkpoint_and_restore_waits_for_the_run() {
    let root = std::env::temp_dir().join(format!("pier-ws-checkpoint-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let work = root.join("project");
    std::fs::create_dir_all(&work).unwrap();
    std::fs::write(work.join("a.txt"), "one").unwrap();
    let mut tab = Tab::detached(work.to_str().unwrap());
    tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
    tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
    let settle = |tab: &mut Tab| {
        for _ in 0..200 {
            tab.update(Instant::now());
            if tab.waiting.is_empty() && !tab.restoring {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("checkpoint never finished");
    };

    tab.input = "change a.txt".into();
    tab.submit();
    assert_eq!(tab.waiting.len(), 1, "held until the files are saved");
    tab.input = "and b".into();
    tab.submit();
    assert!(
        matches!(tab.waiting.back(), Some(Command::Prompt { streaming_behavior: Some(_), .. })),
        "a second message before the first reached Pi is a steer"
    );
    settle(&mut tab);
    let saved: Vec<_> = tab.t.entries.iter().filter_map(|e| e.checkpoint.clone()).collect();
    assert_eq!(saved.len(), 2);

    std::fs::write(work.join("a.txt"), "two").unwrap();
    tab.t.state = State::Running;
    tab.restore(&saved[0]);
    assert!(!tab.restoring, "refused during a run");
    assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "two");

    tab.t.state = State::Completed;
    tab.restore(&saved[0]);
    settle(&mut tab);
    assert_eq!(std::fs::read_to_string(work.join("a.txt")).unwrap(), "one");
    assert_eq!(tab.t.entries.iter().filter(|e| e.kind == Kind::Checkpoint).count(), 3, "plus the undo point");
    assert!(tab.t.journal.iter().any(|r| matches!(r, Record::CheckpointRestored { .. })));
    drop(tab);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn images_wait_for_a_model_that_reads_them_and_mentions_complete() {
    use crate::pi::protocol::ModelInfo;
    let mut tab = Tab::detached("a");
    tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
    let model = |input: &[&str]| ModelInfo {
        id: "m".into(),
        provider: "p".into(),
        name: None,
        reasoning: false,
        input: input.iter().map(|s| s.to_string()).collect(),
    };
    tab.t.model = Some(model(&["text"]));
    tab.attach(Image::from_rgba(1, 1, &[0, 0, 0, 255]));
    tab.attach(Err("big.png: too big".into()));
    assert_eq!(tab.images.len(), 1);
    tab.submit();
    assert_eq!(tab.images.len(), 1, "kept: the model would not see it");
    assert!(tab.t.entries.last().unwrap().text.contains("does not read images"));
    tab.t.model = Some(model(&["text", "image"]));
    tab.submit();
    assert!(tab.images.is_empty(), "an image alone, without text, is a message too");

    let (go, wait) = std::sync::mpsc::channel::<()>();
    tab.attach_later(move || {
        let _ = wait.recv(); // held until the test lets it finish
        Image::from_rgba(1, 1, &[0, 0, 0, 255])
    });
    tab.input = "look".into();
    tab.submit();
    assert_eq!(tab.input, "look", "not sent while the image is being prepared");
    go.send(()).unwrap();
    for _ in 0..100 {
        tab.update(Instant::now());
        if tab.preparing_images() == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(tab.images.len(), 1, "the prepared image joins the next message");

    tab.files = ["src/main.rs", "src/app/mod.rs"].map(String::from).to_vec();
    tab.input = "look at @mai".into();
    assert_eq!(tab.file_suggestions(8), Some((vec!["src/main.rs".to_owned()], 1)));
    tab.mention("src/main.rs");
    assert_eq!(tab.input, "look at @src/main.rs ");
    assert_eq!(tab.file_suggestions(8), None);
    assert!(!tab.files_asked, "the next @ asks for a fresh list");
}

#[test]
fn the_queue_is_edited_away_from_pi_and_sent_back_in_order() {
    use crate::session::transcript::QueueItem;
    let root = std::env::temp_dir().join(format!("pier-ws-queue-{}", std::process::id()));
    let work = root.join("project");
    std::fs::create_dir_all(&work).unwrap();
    let mut tab = Tab::detached(work.to_str().unwrap());
    // A checkpoint worker holds each message in `waiting`, where the test can read what would go to Pi.
    tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
    tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
    tab.t.state = State::Running;
    tab.input = "after you're done".into();
    tab.queue_after();
    assert!(matches!(tab.waiting.back(), Some(Command::Prompt { streaming_behavior: Some(StreamingBehavior::FollowUp), .. })));

    tab.t.queued = vec![QueueItem { text: "x".into(), after: false }];
    tab.edit_queue();
    assert!(tab.t.queue_edit_pending);
    for _ in 0..200 {
        tab.update(Instant::now());
        if tab.waiting.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    tab.t.state = State::Completed; // the run ended while the user was editing
    tab.t.queue_draft = Some(vec![
        QueueItem { text: "first".into(), after: false },
        QueueItem { text: "  ".into(), after: false },
        QueueItem { text: "last".into(), after: true },
    ]);
    tab.send_queue_back();
    let sent: Vec<_> = tab
        .waiting
        .iter()
        .map(|c| match c {
            Command::Prompt { message, streaming_behavior, .. } => (message.as_str(), *streaming_behavior),
            _ => unreachable!(),
        })
        .collect();
    assert_eq!(sent, [("first", None), ("last", Some(StreamingBehavior::FollowUp))], "blank dropped; the first starts a run");
    assert!(tab.t.queue_draft.is_none());
    drop(tab);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn checkpoints_pair_with_their_message_by_text_even_after_stop() {
    let root = std::env::temp_dir().join(format!("pier-ws-pairing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let work = root.join("project");
    std::fs::create_dir_all(&work).unwrap();
    let mut tab = Tab::detached(work.to_str().unwrap());
    tab.checkpoints = Some(Checkpoints::new(Worker::start(Repo::new(&root.join("shadow"), &work), || {})));
    tab.t.status.insert(crate::session::transcript::SUPERVISION_KEY.into(), "Supervised".into());
    let settle = |tab: &mut Tab| {
        for _ in 0..300 {
            tab.update(Instant::now());
            if tab.waiting.is_empty() && tab.orphan_snapshots == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("checkpoints never came back");
    };
    tab.t.state = State::Running;
    tab.input = "X".into();
    tab.submit(); // a steer…
    tab.stop(); // …taken back before it reached Pi
    assert!(tab.waiting.is_empty() && tab.t.restored == ["X"], "back to the editor, not sent after the Stop");
    tab.t.state = State::Stopped;
    tab.t.restored.clear();
    for text in ["A", "B"] {
        tab.input = text.into();
        tab.submit();
        settle(&mut tab);
    }
    let pairs = tab.checkpoints_by_message();
    let a = pairs.get("A").copied().expect("A has its checkpoint");
    let b = pairs.get("B").copied().expect("B has its checkpoint");
    assert_ne!(a, b, "B is not paired with A's checkpoint");
    assert!(!pairs.contains_key("X"), "the message taken back owns no checkpoint");
    let orphan = tab.t.entries.iter().filter(|e| e.text == "Files saved (message not sent)").count();
    assert_eq!(orphan, 1);
    drop(tab);
    let _ = std::fs::remove_dir_all(&root);
}
