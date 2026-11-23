//! Session state machine, driven by Pi events.

use crate::pi::protocol::Event;

/// shortcut: no `Blocked` (dialogs are auto-refused until A.6) and no `Spawned` (Pi sends no ready event);
/// add them with approvals and tabs.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum State {
    /// Waiting for a first prompt.
    #[default]
    Ready,
    Running,
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
    pub fn is_running(self) -> bool {
        self == State::Running
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
