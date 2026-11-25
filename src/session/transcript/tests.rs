use super::*;
use crate::pi::process::parse_line;
use std::time::Duration;

fn feed(t: &mut Transcript, lines: &[&str]) {
    for l in lines {
        t.apply_event(&parse_line(l.as_bytes()).unwrap().unwrap());
    }
}

#[test]
fn rebuilds_a_streamed_run() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"agent_start"}"#,
            r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
            r#"{"type":"message_start","message":{"role":"assistant","content":[]}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hmm"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hel"}}"#,
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"lo"}}"#,
        ],
    );
    assert_eq!(t.state, State::Running);
    let kinds: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
    assert_eq!(kinds, [(Kind::User, "hello"), (Kind::Thinking, "hmm"), (Kind::Assistant, "Hello")]);

    feed(
        &mut t,
        &[
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Hello!"}}"#,
            r#"{"type":"agent_settled","aborted":true}"#,
        ],
    );
    assert_eq!(t.state, State::Stopped);
    assert_eq!(t.entries[2].text, "Hello!");
    assert_eq!(t.entries.last().unwrap().kind, Kind::Notice);
}

#[test]
fn queue_errors_and_cleared_queue_are_surfaced() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"agent_start"}"#,
            r#"{"type":"queue_update","steering":["stop"],"followUp":[]}"#,
            r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["stop"],"followUp":["then this"]}}"#,
            r#"{"type":"response","command":"prompt","success":false,"error":"busy"}"#,
            r#"{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"403"}}"#,
            r#"{"type":"agent_settled"}"#,
        ],
    );
    assert_eq!(t.queued, [QueueItem { text: "stop".into(), after: false }]);
    assert_eq!(t.restored, ["stop", "then this"]);

    // Taken back for editing: kept apart, with each message's kind, not dumped into the editor.
    t.restored.clear();
    t.queue_edit_pending = true;
    feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["a"],"followUp":["b"]}}"#]);
    let draft = t.queue_draft.clone().unwrap();
    assert_eq!(draft, [QueueItem { text: "a".into(), after: false }, QueueItem { text: "b".into(), after: true }]);
    assert!(t.restored.is_empty() && !t.queue_edit_pending);
    feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["c"]}}"#]);
    assert_eq!(t.restored, ["c"], "a later Stop goes back to the editor as before");
    t.queue_edit_pending = true;
    feed(&mut t, &[r#"{"type":"response","command":"clear_queue","success":false,"error":"busy"}"#]);
    assert!(!t.queue_edit_pending, "a failed take-back does not leave Edit queue stuck");
    let errs: Vec<_> = t.entries.iter().filter(|e| e.kind == Kind::Error).map(|e| e.text.as_str()).collect();
    assert_eq!(errs, ["prompt: busy", "403", "clear_queue: busy"]);
    assert_eq!(t.state, State::Failed, "a run ending on a provider error is not 'completed'");
}

#[test]
fn unhandled_dialogs_are_refused_and_status_is_kept() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Pick"}"#,
            r#"{"type":"extension_ui_request","id":"u2","method":"setStatus","statusKey":"cost","statusText":"$0"}"#,
            r#"{"type":"extension_ui_request","id":"u3","method":"setWidget","widgetKey":"w"}"#,
        ],
    );
    assert_eq!(t.outbox, [Command::cancel_dialog("u1")]);
    assert_eq!(t.status.get("cost").map(String::as_str), Some("$0"));
    assert_eq!(t.entries.len(), 1);
    feed(&mut t, &[r#"{"type":"extension_ui_request","id":"u4","method":"setStatus","statusKey":"cost"}"#]);
    assert!(t.status.is_empty());
}

#[test]
fn approvals_block_until_answered_or_expired() {
    let mut t = Transcript::default();
    assert!(!t.supervised());
    feed(
        &mut t,
        &[
            r#"{"type":"extension_ui_request","id":"s","method":"setStatus","statusKey":"pier-supervision","statusText":"Supervised"}"#,
            r#"{"type":"agent_start"}"#,
            r#"{"type":"extension_ui_request","id":"a1","method":"confirm","title":"Allow bash?","message":"ls","timeout":60000}"#,
            r#"{"type":"extension_ui_request","id":"a2","method":"confirm","title":"Allow write?","message":"x.txt","timeout":60000}"#,
        ],
    );
    assert!(t.supervised());
    assert_eq!(t.state, State::Blocked);
    assert!(t.outbox.is_empty(), "nothing is answered for the user");

    assert!(t.answer("a1", true));
    assert_eq!(t.outbox, [Command::confirm("a1", true)]);
    assert_eq!(t.state, State::Blocked, "a2 still waits");

    t.expire(Instant::now());
    assert_eq!(t.approvals.len(), 1, "not expired yet");
    t.expire(Instant::now() + Duration::from_secs(59));
    assert_eq!(t.outbox, [Command::confirm("a1", true), Command::confirm("a2", false)]);
    assert_eq!(t.state, State::Running);
    assert_eq!(t.entries.last().unwrap().text, "Allow write? → denied (timed out)");

    feed(&mut t, &[r#"{"type":"extension_ui_request","id":"a3","method":"confirm","title":"Allow bash?"}"#]);
    feed(&mut t, &[r#"{"type":"agent_settled","aborted":true}"#]);
    assert!(t.approvals.is_empty(), "an aborted run drops its pending approvals");
    assert_eq!(t.state, State::Stopped);
}

#[test]
fn risks_and_the_allowlist_proposal_reach_the_approval() {
    let mut t = Transcript::default();
    let env = r#"{\"pier\":1,\"tool\":\"bash\",\"detail\":\"rm -rf build\",\"outside\":[],\"outsideGuessed\":true,\"diff\":null,\"risks\":[\"deletes recursively\"],\"allowAs\":null}"#;
    let ok = r#"{\"pier\":1,\"tool\":\"bash\",\"detail\":\"cargo build\",\"outside\":[],\"diff\":null,\"risks\":[],\"allowAs\":\"cargo build\"}"#;
    feed(
        &mut t,
        &[
            &format!(r#"{{"type":"extension_ui_request","id":"a1","method":"confirm","title":"Allow bash?","message":"{env}"}}"#),
            &format!(r#"{{"type":"extension_ui_request","id":"a2","method":"confirm","title":"Allow bash?","message":"{ok}"}}"#),
        ],
    );
    assert_eq!(t.approvals[0].risks, ["deletes recursively"]);
    assert_eq!(t.approvals[0].allow_as, None);
    assert_eq!(t.approvals[1].allow_as.as_deref(), Some("cargo build"));
    assert!(matches!(&t.journal[0], Record::ApprovalRequested { risks, .. } if risks == &["deletes recursively"]));
}

#[test]
fn decisions_taken_by_a_mode_are_shown_and_journaled() {
    let mut t = Transcript::default();
    let auto = r#"{\"pier\":1,\"auto\":\"allowed\",\"tool\":\"write\",\"detail\":\"src/a.rs\",\"mode\":\"Accept edits\"}"#;
    feed(
        &mut t,
        &[
            &format!(r#"{{"type":"extension_ui_request","id":"n1","method":"notify","message":"{auto}"}}"#),
            r#"{"type":"extension_ui_request","id":"n2","method":"notify","message":"{\"pier\":1,\"auto\":\"rm -rf\"}"}"#,
            r#"{"type":"response","command":"get_commands","success":true,"data":{"commands":[{"name":"pier-mode","source":"extension"},{"name":"plan","source":"prompt"}]}}"#,
        ],
    );
    assert_eq!(t.entries[0].text, "write src/a.rs → allowed (Accept edits)");
    assert_eq!(
        t.journal,
        [Record::AutoDecided { tool: "write".into(), detail: "src/a.rs".into(), decision: "auto-allowed", mode: "Accept edits".into() }]
    );
    assert!(t.entries[1].text.contains("rm -rf"), "anything else stays plain text, never a decision");
    let names: Vec<_> = crate::complete::commands(&t.commands, "/p").iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["plan"], "Pier's own command is not offered in the palette");
}

#[test]
fn a_fork_starts_the_transcript_over_and_gives_the_message_back() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl"}}"#,
            r#"{"type":"message_start","message":{"role":"user","content":"one"}}"#,
            r#"{"type":"message_start","message":{"role":"user","content":"two"}}"#,
            r#"{"type":"response","command":"get_fork_messages","success":true,"data":{"messages":[{"entryId":"e1","text":"one"},{"entryId":"e2","text":"two"}]}}"#,
        ],
    );
    assert_eq!(t.fork_messages.iter().map(|m| m.entry_id.as_str()).collect::<Vec<_>>(), ["e1", "e2"]);
    t.outbox.clear();

    feed(&mut t, &[r#"{"type":"response","command":"fork","success":true,"data":{"text":"two","cancelled":false}}"#]);
    assert!(t.entries.is_empty() && t.fork_messages.is_empty());
    assert_eq!(t.restored, ["two"], "back to the editor");
    assert_eq!(t.outbox, [Command::GetState, Command::GetMessages, Command::GetSessionStats]);
    assert!(t.journal.contains(&Record::Forked { from: Some(PathBuf::from("a.jsonl")) }));

    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"b.jsonl"}}"#,
            r#"{"type":"response","command":"get_messages","success":true,"data":{"messages":[{"role":"user","content":"one"}]}}"#,
        ],
    );
    assert_eq!(t.session_file, Some(PathBuf::from("b.jsonl")));
    assert_eq!(t.entries.len(), 2);
    assert!(t.entries[1].text.starts_with("Forked"), "not 'resumed': {:?}", t.entries[1].text);

    let before = t.entries.len();
    feed(&mut t, &[r#"{"type":"response","command":"fork","success":true,"data":{"cancelled":true}}"#]);
    assert_eq!(t.entries.len(), before + 1, "a cancelled fork keeps everything");
}

#[test]
fn resumed_history_and_session_file() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"C:/s/a.jsonl","isStreaming":false}}"#,
            r#"{"type":"response","command":"get_messages","success":true,"data":{"messages":[
                {"role":"system","content":""},
                {"role":"user","content":"ls please","timestamp":1},
                {"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"toolCall","id":"c1","name":"bash","arguments":{"command":"ls"}}],"stopReason":"toolUse"},
                {"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[],"isError":false},
                {"role":"assistant","content":[{"type":"text","text":"there you go"}],"stopReason":"error","errorMessage":"403"},
                {"role":"bashExecution","command":"x"}
            ]}}"#,
        ],
    );
    assert_eq!(t.session_file, Some(PathBuf::from("C:/s/a.jsonl")));
    let got: Vec<_> = t.entries.iter().map(|e| (e.kind, e.text.as_str())).collect();
    assert_eq!(
        got,
        [
            (Kind::User, "ls please"),
            (Kind::Thinking, "hmm"),
            (Kind::Tool, r#"bash {"command":"ls"}"#),
            (Kind::Tool, "bash → ok"),
            (Kind::Assistant, "there you go"),
            (Kind::Error, "403"),
            (Kind::Notice, "Session resumed."),
        ]
    );
    assert_eq!(t.state, State::Ready, "loading history starts no run");
}

#[test]
fn journal_records_runs_and_every_approval_decision() {
    let mut t = Transcript::default();
    let confirm = |id: &str| {
        format!(
            r#"{{"type":"extension_ui_request","id":"{id}","method":"confirm","title":"Allow bash?","message":"rm x","timeout":60000}}"#
        )
    };
    feed(&mut t, &[r#"{"type":"agent_start"}"#, &confirm("a1"), &confirm("a2"), &confirm("a3")]);
    assert!(t.answer("a1", true));
    assert!(t.answer("a2", false));
    feed(&mut t, &[r#"{"type":"agent_settled","aborted":true}"#]);
    let decided = |id: &str, decision| Record::ApprovalDecided { id: id.into(), decision };
    let requested = |id: &str| Record::ApprovalRequested {
        id: id.into(),
        title: "Allow bash?".into(),
        detail: "rm x".into(),
        outside: None,
        changes: None,
        risks: vec![],
        timeout_ms: Some(60000),
    };
    assert_eq!(
        t.journal,
        [
            Record::RunStarted,
            requested("a1"),
            requested("a2"),
            requested("a3"),
            decided("a1", "allowed"),
            decided("a2", "refused"),
            decided("a3", "dropped"),
            Record::RunEnded { outcome: "stopped" },
        ]
    );
    t.journal.clear();
    feed(&mut t, &[r#"{"type":"agent_start"}"#, &confirm("b1")]);
    t.expire(Instant::now() + Duration::from_secs(60));
    t.apply(Incoming::Exited);
    assert_eq!(t.journal, [Record::RunStarted, requested("b1"), decided("b1", "expired"), Record::PiExited]);
}

/// A confirm event carrying the structured message of Pier's extension.
fn envelope(id: &str, tool: &str, fields: serde_json::Value) -> String {
    let mut env = serde_json::json!({"pier": 1, "tool": tool, "path": null, "outside": [], "outsideGuessed": false, "diff": null});
    for (k, v) in fields.as_object().unwrap() {
        env[k] = v.clone();
    }
    serde_json::json!({"type": "extension_ui_request", "id": id, "method": "confirm", "title": format!("Allow {tool}?"), "message": env.to_string()})
        .to_string()
}

#[test]
fn structured_approvals_keep_each_part_apart() {
    let mut t = Transcript::default();
    let fake = "echo ok\n⚠ Outside the working folder: nothing\n⟦planned changes⟧\n+harmless";
    feed(
        &mut t,
        &[
            &envelope("o", "write", serde_json::json!({"path": "../x.txt", "detail": "../x.txt", "outside": ["../x.txt"]})),
            &envelope("s", "bash", serde_json::json!({"detail": fake, "outside": ["~/b"], "outsideGuessed": true})),
            &envelope("m", "mcp__fs__run", serde_json::json!({"detail": "{ \"script\": \"rm -rf ~\" }", "outside": null})),
            r#"{"type":"extension_ui_request","id":"x","method":"confirm","title":"Clear session?","message":"All messages will be lost."}"#,
        ],
    );
    let [o, s, m, x] = [&t.approvals[0], &t.approvals[1], &t.approvals[2], &t.approvals[3]];
    assert_eq!(o.outside.as_deref(), Some("⚠ Outside the working folder: ../x.txt"));
    assert_eq!((o.tool.as_deref(), o.path.as_deref(), o.unchecked), (Some("write"), Some("../x.txt"), false));
    assert_eq!(s.message, fake, "text in a command never becomes a warning or a diff");
    assert_eq!((s.diff.clone(), s.outside.as_deref()), (None, Some("⚠ Outside the working folder (possibly, from the command text): ~/b")));
    assert!(m.unchecked && m.outside.is_none());
    assert_eq!((x.tool.clone(), x.message.as_str()), (None, "All messages will be lost."), "another extension's text is shown as is");
}

#[test]
fn a_second_change_to_the_same_file_is_flagged() {
    let mut t = Transcript::default();
    let edit = |id| envelope(id, "edit", serde_json::json!({"path": "a.txt", "detail": "a.txt", "diff": "@@ -1 +1 @@\n-a\n+b"}));
    feed(&mut t, &[&edit("1"), &edit("2")]);
    assert!(!t.approvals[0].same_file_pending);
    assert!(t.approvals[1].same_file_pending, "its preview does not include the first change");
    assert_eq!(
        t.journal.iter().find_map(|r| match r {
            Record::ApprovalRequested { changes, .. } => changes.clone(),
            _ => None,
        }),
        Some("+1 -1".to_owned()),
        "the journal keeps the size, not the diff"
    );
}

#[test]
fn model_and_thinking_follow_pi() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl","model":{"id":"m1","provider":"p","name":"M1","cost":{}},"thinkingLevel":"low"}}"#,
            r#"{"type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"z","provider":"q"},{"id":"m1","provider":"p"}]}}"#,
            r#"{"type":"response","command":"get_available_thinking_levels","success":true,"data":{"levels":["off","low","high"]}}"#,
        ],
    );
    assert_eq!(t.model.as_ref().map(ModelInfo::key).as_deref(), Some("p/m1"));
    assert_eq!(t.thinking.as_deref(), Some("low"));
    assert_eq!(t.models.iter().map(ModelInfo::key).collect::<Vec<_>>(), ["p/m1", "q/z"], "sorted");
    assert_eq!(t.thinking_levels, ["off", "low", "high"]);

    feed(&mut t, &[r#"{"type":"response","command":"set_model","success":true,"data":{"id":"z","provider":"q"}}"#]);
    assert_eq!(t.outbox, [Command::GetState, Command::GetAvailableThinkingLevels, Command::GetSessionStats], "read back, don't guess");
    feed(&mut t, &[r#"{"type":"thinking_level_changed","level":"high"}"#]);
    assert_eq!(t.thinking.as_deref(), Some("high"));
    feed(&mut t, &[r#"{"type":"response","command":"get_state","success":true,"data":{"sessionFile":"a.jsonl"}}"#]);
    assert_eq!(t.model.as_ref().map(|m| m.id.as_str()), Some("m1"), "a state without model keeps the last one");
    let files = t.journal.iter().filter(|r| matches!(r, Record::SessionFile { .. })).count();
    assert_eq!(files, 1, "the session file is journaled once, not on every get_state");
}

#[test]
fn a_click_only_answers_the_approval_shown() {
    let mut t = Transcript::default();
    let confirm = |id: &str| format!(r#"{{"type":"extension_ui_request","id":"{id}","method":"confirm","title":"Allow bash?"}}"#);
    feed(&mut t, &[&confirm("a"), &confirm("b")]);
    assert!(!t.can_answer(Instant::now()), "just arrived: clicks are ignored");
    assert!(t.can_answer(Instant::now() + ARM_DELAY));
    assert!(!t.answer("b", true), "b is not the one on screen");
    assert!(t.answer("a", true));
    assert!(!t.answer("a", true), "a second click on a is not passed on to b");
    assert!(!t.can_answer(Instant::now()), "b just reached the front: armed again");
    assert_eq!(t.outbox, [Command::confirm("a", true)]);

    feed(&mut t, &[r#"{"type":"agent_settled"}"#]);
    assert_eq!(
        t.outbox[1..],
        [Command::cancel_dialog("b"), Command::GetState, Command::GetSessionStats],
        "a dropped dialog is answered, and the session file is re-read after the run"
    );
}

#[test]
fn tool_calls_link_to_results_and_stay_small() {
    let mut t = Transcript::default();
    let big = "x".repeat(10_000);
    feed(
        &mut t,
        &[
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"c1","toolName":"write"}}"#,
            &format!(
                r#"{{"type":"message_update","assistantMessageEvent":{{"type":"toolcall_end","contentIndex":0,"toolCall":{{"id":"c1","name":"write","arguments":{{"content":"{big}"}}}}}}}}"#
            ),
            r#"{"type":"tool_execution_end","toolCallId":"c1","toolName":"write","isError":true}"#,
        ],
    );
    assert_eq!(t.entries[0].tool_id.as_deref(), Some("c1"));
    assert_eq!(t.entries[0].ok, Some(false), "the call knows its result");
    assert!(t.entries[0].text.len() < 2100, "a written file is not kept whole in memory");
    assert_eq!((t.entries[1].text.as_str(), t.entries[1].tool_id.as_deref()), ("write → error", Some("c1")));

    // Two Stops: the second, empty answer must not erase the steer the first one gave back.
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":["keep me"],"followUp":[]}}"#,
            r#"{"type":"response","command":"clear_queue","success":true,"data":{"steering":[],"followUp":[]}}"#,
        ],
    );
    assert_eq!(t.restored, ["keep me"]);
}

#[test]
fn session_stats_are_read_and_refreshed_per_answer() {
    let mut t = Transcript::default();
    feed(&mut t, &[r#"{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"stop"}}"#]);
    assert_eq!(t.outbox, [Command::GetSessionStats], "each finished answer asks for fresh numbers");
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_session_stats","success":true,"data":{"cost":0.45,"tokens":{"total":105000},"contextUsage":{"tokens":60000,"contextWindow":200000,"percent":30}}}"#,
        ],
    );
    let s = t.stats.clone().unwrap();
    assert_eq!(s.cost, 0.45);
    let c = s.context_usage.unwrap();
    assert_eq!((c.tokens, c.context_window, c.percent), (Some(60000), 200000, Some(30.0)));
    feed(
        &mut t,
        &[
            r#"{"type":"response","command":"get_session_stats","success":true,"data":{"cost":0.5,"contextUsage":{"tokens":null,"contextWindow":200000,"percent":null}}}"#,
        ],
    );
    assert_eq!(t.stats.unwrap().context_usage.unwrap().percent, None, "after a compaction: unknown, not 0");
}

#[test]
fn slash_palette_matches_prefix_first() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[r#"{"type":"response","command":"get_commands","success":true,"data":{"commands":[
            {"name":"skill:review","description":"Review code","source":"skill"},
            {"name":"fix-tests","description":"Fix failing tests","source":"prompt"},
            {"name":"prune","source":"extension"}
        ]}}"#],
    );
    let names = |input: &str| crate::complete::commands(&t.commands, input).iter().map(|c| c.name.clone()).collect::<Vec<_>>();
    assert_eq!(names("/"), ["fix-tests", "prune", "skill:review"], "all, sorted");
    assert_eq!(names("/pr"), ["prune"]);
    assert_eq!(names("/RE"), ["skill:review"], "case-insensitive, matches inside the name too");
    assert_eq!(names("/t"), ["fix-tests"], "contains, not only prefix");
    assert!(names("/fix-tests now").is_empty(), "arguments being typed: palette gone");
    assert!(names("fix").is_empty(), "only after a leading /");
}

#[test]
fn diffs_reach_the_approval_and_the_edit_result() {
    let mut t = Transcript::default();
    feed(
        &mut t,
        &[
            &envelope("w", "write", serde_json::json!({"path": "x", "detail": "x", "diff": "--- x\n+++ x\n@@ -0,0 +1 @@\n+hi"})),
            &envelope("b", "bash", serde_json::json!({"detail": "ls"})),
        ],
    );
    let w = &t.approvals[0];
    assert_eq!(w.message, "x", "the path stays apart from the preview");
    assert_eq!(w.diff.as_deref(), Some("--- x\n+++ x\n@@ -0,0 +1 @@\n+hi"));
    assert_eq!(t.approvals[1].diff, None);

    feed(
        &mut t,
        &[
            r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"e1","toolName":"edit"}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"e1","toolName":"edit","isError":false,"result":{"content":[],"details":{"diff":"x","patch":"--- a\n+++ a\n@@ -1 +1 @@\n-b\n+B"}}}"#,
            r#"{"type":"tool_execution_end","toolCallId":"b1","toolName":"bash","isError":false,"result":{"content":[],"details":{}}}"#,
        ],
    );
    let result = t.entries.iter().find(|e| e.text == "edit → ok").unwrap();
    assert_eq!(result.diff.as_deref(), Some("--- a\n+++ a\n@@ -1 +1 @@\n-b\n+B"));
    assert_eq!(t.entries.iter().find(|e| e.text == "bash → ok").unwrap().diff, None);
}

#[test]
fn an_approval_outside_a_run_blocks_then_returns_to_the_previous_state() {
    let mut t = Transcript::default();
    feed(&mut t, &[r#"{"type":"extension_ui_request","id":"x","method":"confirm","title":"Allow bash?","message":"ls"}"#]);
    assert_eq!(t.state, State::Blocked, "an extension command can ask while no run is going");
    assert!(t.answer("x", false));
    assert_eq!(t.state, State::Ready, "back to where it was, not to Running");

    feed(
        &mut t,
        &[
            r#"{"type":"agent_start"}"#,
            r#"{"type":"extension_ui_request","id":"y","method":"confirm","title":"Allow bash?","message":"ls"}"#,
        ],
    );
    assert!(t.answer("y", true));
    assert_eq!(t.state, State::Running);
}

#[test]
fn exit_is_terminal() {
    let mut t = Transcript::default();
    t.apply(Incoming::Exited);
    feed(&mut t, &[r#"{"type":"agent_start"}"#]);
    assert_eq!(t.state, State::Crashed);
}
