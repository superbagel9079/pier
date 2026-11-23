//! Typed Pi RPC records: commands Pier sends, events Pier reads. Events Pier does not use land in `Unknown`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Commands written to Pi's stdin. `Process::send` adds a fresh `id` to those that have none.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Command {
    Prompt {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    ClearQueue,
    Abort,
    GetState,
    /// The whole conversation, used to show a resumed session's history.
    GetMessages,
    GetAvailableModels,
    SetModel {
        provider: String,
        model_id: String,
    },
    /// Levels the current model accepts (`["off"]` without reasoning support).
    GetAvailableThinkingLevels,
    SetThinkingLevel {
        level: String,
    },
    /// Cost and context-window usage of the session.
    GetSessionStats,
    /// Extension commands, prompt templates and skills; one runs by sending `/name` as a prompt.
    GetCommands,
    /// Display name of the session, shown by Reprendre and by Pi's own /resume.
    SetSessionName {
        name: String,
    },
    /// Reply to a dialog; must echo the request id. Set `confirmed` for a confirm, `cancelled` to refuse any dialog.
    ExtensionUiResponse {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        confirmed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
}

impl Command {
    pub fn confirm(id: &str, confirmed: bool) -> Self {
        Command::ExtensionUiResponse { id: id.to_owned(), confirmed: Some(confirmed), cancelled: None }
    }

    pub fn cancel_dialog(id: &str) -> Self {
        Command::ExtensionUiResponse { id: id.to_owned(), confirmed: None, cancelled: Some(true) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamingBehavior {
    /// Delivered after the current turn's tool calls.
    Steer,
}

/// Events read from Pi's stdout.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Event {
    AgentStart,
    /// No more automatic work (retry, steer, follow-up) will follow.
    AgentSettled {
        #[serde(default)]
        aborted: bool,
    },
    MessageStart {
        message: Message,
    },
    MessageUpdate {
        assistant_message_event: StreamEvent,
    },
    MessageEnd {
        message: Message,
    },
    ToolExecutionEnd {
        #[serde(default)]
        tool_call_id: Option<String>,
        tool_name: String,
        #[serde(default)]
        is_error: bool,
    },
    /// Full current queues, not a delta.
    QueueUpdate {
        #[serde(default)]
        steering: Vec<Queued>,
        #[serde(default)]
        follow_up: Vec<Queued>,
    },
    AutoRetryStart {
        #[serde(default)]
        attempt: u64,
    },
    ThinkingLevelChanged {
        level: String,
    },
    /// The session's display name changed; absent = cleared.
    SessionInfoChanged {
        #[serde(default)]
        name: Option<String>,
    },
    Response {
        command: String,
        success: bool,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        data: Value,
    },
    ExtensionUiRequest(UiRequest),
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    #[serde(default)]
    pub content: Content,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

impl Message {
    pub fn is_error(&self) -> bool {
        self.role == Role::Assistant && self.stop_reason.as_deref() == Some("error")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    User,
    Assistant,
    #[serde(other)]
    Other,
}

/// Message content: a plain string or a list of typed parts (only text parts are read).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Parts(Vec<Part>),
}

impl Default for Content {
    fn default() -> Self {
        Content::Text(String::new())
    }
}

impl Content {
    pub fn text(&self) -> String {
        match self {
            Content::Text(s) => s.clone(),
            Content::Parts(parts) => parts.iter().filter_map(|p| p.text.as_deref()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Part {
    #[serde(default)]
    pub text: Option<String>,
}

/// A queued steer or follow-up: Pi sends either the text or a message object.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Queued {
    Text(String),
    Message { content: Content },
}

impl Queued {
    pub fn text(&self) -> String {
        match self {
            Queued::Text(s) => s.clone(),
            Queued::Message { content } => content.text(),
        }
    }
}

/// `data` of a successful `clear_queue` response: what was taken back.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedQueue {
    #[serde(default)]
    pub steering: Vec<Queued>,
    #[serde(default)]
    pub follow_up: Vec<Queued>,
}

/// `data` of a `get_state` response (only what Pier uses).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateData {
    #[serde(default)]
    pub session_file: Option<String>,
    #[serde(default)]
    pub model: Option<ModelInfo>,
    #[serde(default)]
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub session_name: Option<String>,
}

/// One entry of `get_commands`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct PiCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// `extension`, `prompt` (template) or `skill`.
    #[serde(default)]
    pub source: String,
}

/// `data` of a `get_session_stats` response (only what Pier shows).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    /// US dollars for the whole session.
    #[serde(default)]
    pub cost: f64,
    /// Absent when no model or context window is known.
    #[serde(default)]
    pub context_usage: Option<ContextUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    /// `None` right after a compaction, until the next answer gives real numbers.
    #[serde(default)]
    pub tokens: Option<u64>,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub percent: Option<f64>,
}

/// The parts of Pi's Model object that Pier shows or sends back.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Supports thinking levels beyond `off`.
    #[serde(default)]
    pub reasoning: bool,
}

impl ModelInfo {
    /// `provider/id`, the form `--model` takes.
    pub fn key(&self) -> String {
        format!("{}/{}", self.provider, self.id)
    }
}

/// One message of `get_messages`, i.e. a resumed session's history.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum HistoryMessage {
    User {
        #[serde(default)]
        content: Content,
    },
    Assistant {
        #[serde(default)]
        content: Vec<AssistantPart>,
        #[serde(default)]
        stop_reason: Option<String>,
        #[serde(default)]
        error_message: Option<String>,
    },
    ToolResult {
        #[serde(default)]
        tool_call_id: Option<String>,
        tool_name: String,
        #[serde(default)]
        is_error: bool,
    },
    /// system, bashExecution, custom, summaries: not shown.
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantPart {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolCall {
        #[serde(default)]
        id: Option<String>,
        name: String,
        #[serde(default)]
        arguments: Value,
    },
    #[serde(other)]
    Other,
}

/// One content-block delta of the assistant message being streamed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    TextStart {
        #[serde(default)]
        content_index: u64,
    },
    ThinkingStart {
        #[serde(default)]
        content_index: u64,
    },
    ToolcallStart {
        #[serde(default)]
        content_index: u64,
        /// Tool call id, matching `toolCallId` of its execution events.
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        tool_name: Option<String>,
    },
    TextDelta {
        #[serde(default)]
        content_index: u64,
        delta: String,
    },
    ThinkingDelta {
        #[serde(default)]
        content_index: u64,
        delta: String,
    },
    ToolcallDelta {
        #[serde(default)]
        content_index: u64,
        delta: String,
    },
    /// `content` is authoritative and replaces the streamed deltas.
    TextEnd {
        #[serde(default)]
        content_index: u64,
        content: Option<String>,
    },
    ThinkingEnd {
        #[serde(default)]
        content_index: u64,
        content: Option<String>,
    },
    ToolcallEnd {
        #[serde(default)]
        content_index: u64,
        tool_call: ToolCall,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ToolCall {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
}

/// `extension_ui_request`. Dialogs block Pi until Pier answers with the same id.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum UiRequest {
    Select {
        id: String,
        title: String,
    },
    Confirm {
        id: String,
        title: String,
        #[serde(default)]
        message: String,
        /// Milliseconds before Pi resolves the dialog to "not confirmed" on its own.
        #[serde(default)]
        timeout: Option<u64>,
    },
    Input {
        id: String,
        title: String,
    },
    Editor {
        id: String,
        title: String,
    },
    /// `status_text` absent = clear this key.
    SetStatus {
        status_key: String,
        status_text: Option<String>,
    },
    Notify {
        message: String,
    },
    /// setWidget, setTitle, set_editor_text: not shown yet.
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(s: &str) -> Event {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn model_commands_serialize_to_pi_shapes() {
        let set = Command::SetModel { provider: "openrouter".into(), model_id: "deepseek/x".into() };
        assert_eq!(serde_json::to_value(set).unwrap(), json!({"type": "set_model", "provider": "openrouter", "modelId": "deepseek/x"}));
        let level = Command::SetThinkingLevel { level: "high".into() };
        assert_eq!(serde_json::to_value(level).unwrap(), json!({"type": "set_thinking_level", "level": "high"}));
        assert_eq!(serde_json::to_value(Command::GetAvailableModels).unwrap(), json!({"type": "get_available_models"}));
    }

    #[test]
    fn commands_serialize_to_pi_shapes() {
        let steer = Command::Prompt { message: "go".into(), streaming_behavior: Some(StreamingBehavior::Steer) };
        assert_eq!(serde_json::to_value(steer).unwrap(), json!({"type": "prompt", "message": "go", "streamingBehavior": "steer"}));
        let plain = Command::Prompt { message: "go".into(), streaming_behavior: None };
        assert_eq!(serde_json::to_value(plain).unwrap(), json!({"type": "prompt", "message": "go"}));
        assert_eq!(serde_json::to_value(Command::ClearQueue).unwrap(), json!({"type": "clear_queue"}));
        let refuse = Command::cancel_dialog("u1");
        assert_eq!(serde_json::to_value(refuse).unwrap(), json!({"type": "extension_ui_response", "id": "u1", "cancelled": true}));
        let allow = Command::confirm("u2", true);
        assert_eq!(serde_json::to_value(allow).unwrap(), json!({"type": "extension_ui_response", "id": "u2", "confirmed": true}));
    }

    #[test]
    fn events_parse_and_unknown_ones_do_not_fail() {
        assert_eq!(ev(r#"{"type":"turn_start","whatever":1}"#), Event::Unknown);
        assert_eq!(ev(r#"{"type":"agent_settled"}"#), Event::AgentSettled { aborted: false });
        assert_eq!(
            ev(r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"Allow?","timeout":5000}"#),
            Event::ExtensionUiRequest(UiRequest::Confirm {
                id: "u1".into(),
                title: "Allow?".into(),
                message: String::new(),
                timeout: Some(5000)
            })
        );
        assert_eq!(ev(r#"{"type":"extension_ui_request","id":"u3","method":"setWidget"}"#), Event::ExtensionUiRequest(UiRequest::Other));
        let Event::MessageStart { message } = ev(
            r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]}}"#,
        ) else {
            panic!()
        };
        assert_eq!(message.content.text(), "ab");
        assert_eq!(
            ev(r#"{"type":"message_update","assistantMessageEvent":{"type":"start"}}"#),
            Event::MessageUpdate { assistant_message_event: StreamEvent::Other }
        );
    }
}
