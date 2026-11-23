//! Session state machine, driven by Pi events.

use crate::pi::protocol::Event;

/// shortcut: no `Spawned` (Pi sends no ready event); add it with tabs.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum State {
    /// Waiting for a first prompt.
    #[default]
    Ready,
    Running,
    /// A run waits on a tool approval. Set by the transcript, not by Pi events.
    Blocked,
    /// Last run finished normally.
    Completed,
    /// Last run was aborted (Stop).
    Stopped,
    /// Last run ended on a provider error.
    Failed,
    /// The Pi process is gone; terminal.
    Crashed,
}

impl State {
    /// A run is in progress (Stop and steer apply), blocked or not.
    pub fn is_running(self) -> bool {
        matches!(self, State::Running | State::Blocked)
    }

    /// `run_failed`: the last assistant message of the current run ended in error.
    pub fn on_event(self, ev: &Event, run_failed: bool) -> State {
        match (self, ev) {
            (State::Crashed, _) => State::Crashed,
            (_, Event::AgentStart) => State::Running,
            (_, Event::AgentSettled { aborted: true }) => State::Stopped,
            (_, Event::AgentSettled { .. }) if run_failed => State::Failed,
            (_, Event::AgentSettled { .. }) => State::Completed,
            (s, _) => s,
        }
    }

    /// Why going from `prev` to `self` needs the user, if it does.
    pub fn attention(self, prev: State) -> Option<Attention> {
        match (prev, self) {
            (p, State::Blocked) if p != State::Blocked => Some(Attention::Approval),
            (p, State::Completed | State::Failed | State::Stopped | State::Crashed) if p.is_running() => Some(Attention::RunEnded),
            (p, State::Crashed) if p != State::Crashed => Some(Attention::RunEnded),
            _ => None,
        }
    }
}

/// A reason to call the user back to a session.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Attention {
    /// A tool call waits for Autoriser / Refuser, and expires otherwise.
    Approval,
    /// A run finished, failed, was stopped, or Pi died.
    RunEnded,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_only_on_the_change_that_needs_the_user() {
        use State::*;
        assert_eq!(Blocked.attention(Running), Some(Attention::Approval));
        assert_eq!(Blocked.attention(Blocked), None, "once per approval, not every frame");
        assert_eq!(Running.attention(Blocked), None, "answered");
        assert_eq!(Completed.attention(Running), Some(Attention::RunEnded));
        assert_eq!(Failed.attention(Blocked), Some(Attention::RunEnded));
        assert_eq!(Stopped.attention(Running), Some(Attention::RunEnded));
        assert_eq!(Crashed.attention(Ready), Some(Attention::RunEnded), "Pi dying is news even when idle");
        assert_eq!(Completed.attention(Completed), None);
        assert_eq!(Running.attention(Ready), None);
        assert_eq!(Crashed.attention(Crashed), None);
    }

    #[test]
    fn transitions() {
        let settled = |aborted| Event::AgentSettled { aborted };
        assert_eq!(State::Ready.on_event(&Event::AgentStart, false), State::Running);
        assert_eq!(State::Running.on_event(&Event::Unknown, false), State::Running);
        assert_eq!(State::Running.on_event(&settled(false), false), State::Completed);
        assert_eq!(State::Running.on_event(&settled(false), true), State::Failed);
        assert_eq!(State::Running.on_event(&settled(true), true), State::Stopped);
        assert_eq!(State::Failed.on_event(&Event::AgentStart, false), State::Running);
        assert_eq!(State::Crashed.on_event(&Event::AgentStart, false), State::Crashed);
    }
}
