//! Keeps Windows from sleeping while a run is going. The screen may still turn off; only system sleep is held.

/// Holds the "system required" request while `on`; released on `set(false)` and when dropped.
/// Windows ties the request to the calling thread: always call from the same (UI) thread.
#[derive(Default)]
pub struct KeepAwake {
    on: bool,
}

impl KeepAwake {
    /// Calls Windows only when the hold changes. A failure is returned, not hidden.
    pub fn set(&mut self, on: bool) -> std::io::Result<()> {
        if on != self.on {
            request(on)?;
            self.on = on;
        }
        Ok(())
    }

    pub fn is_on(&self) -> bool {
        self.on
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        if self.on {
            let _ = request(false); // the process is ending anyway; Windows drops the request with it
        }
    }
}

#[cfg(windows)]
fn request(on: bool) -> std::io::Result<()> {
    use windows_sys::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
    let flags = if on { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS };
    // SAFETY: plain Win32 call with documented flags; returns 0 on failure.
    if unsafe { SetThreadExecutionState(flags) } == 0 {
        return Err(std::io::Error::other("SetThreadExecutionState failed"));
    }
    Ok(())
}

// shortcut: no-op outside Windows, use the platform's sleep inhibitor if Pier ships elsewhere.
#[cfg(not(windows))]
fn request(_on: bool) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn holds_and_releases() {
        let mut k = KeepAwake::default();
        k.set(true).unwrap();
        assert!(k.is_on());
        k.set(true).unwrap(); // no change, no second call
        k.set(false).unwrap();
        assert!(!k.is_on());
    }
}
