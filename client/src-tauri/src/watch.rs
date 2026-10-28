//! The watch: one SSH channel, kept open, on which the picker tells what changes on the
//! VM ("pi-pick --api watch", JSON lines both ways). It replaces the interface asking
//! every few seconds, each time with a new command: see api_watch in the picker.

use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{anyhow, Result};
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelWriteHalf};
use serde_json::Value;
use tokio::sync::Mutex;

/// Largest line accepted from the picker; a longer one means something is wrong.
const LINE_MAX: usize = 16 * 1024 * 1024;

#[derive(Default)]
pub struct Watch {
    next: AtomicU32,
    open: Mutex<Option<(u32, ChannelWriteHalf<Msg>)>>,
}

impl Watch {
    /// Runs `command` on `channel` and calls `on_message` with every line it prints, then
    /// `on_end` once it is over. A watch already open is closed first.
    pub async fn start(
        &self,
        channel: Channel<Msg>,
        command: &str,
        on_message: impl Fn(Value) + Send + 'static,
        on_end: impl FnOnce(u32, &str) + Send + 'static,
    ) -> Result<u32> {
        let (mut reader, writer) = channel.split();
        writer.exec(true, command).await?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        if let Some((old, previous)) = self.open.lock().await.replace((id, writer)) {
            log_debug!("watch.replaced", id = old);
            let _ = previous.eof().await; // the old picker exits, its channel closes
        }
        tokio::spawn(async move {
            // A part of several MB arrives in many SSH packets: read linearly (lines.rs).
            let mut lines = crate::lines::Lines::new(LINE_MAX);
            let mut why = "closed";
            while let Some(message) = reader.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        let too_long = lines.feed(&data, |line| match serde_json::from_slice::<Value>(line) {
                            Ok(value) => on_message(value),
                            Err(err) => {
                                log_warn!("watch.bad-line", id = id, err = err, line = String::from_utf8_lossy(line).chars().take(200).collect::<String>())
                            }
                        });
                        if too_long {
                            why = "a line too long";
                            break;
                        }
                    }
                    ChannelMsg::ExtendedData { data, .. } => {
                        log_warn!("watch.stderr", id = id, text = String::from_utf8_lossy(&data).trim().chars().take(2000).collect::<String>());
                    }
                    ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                        why = "the picker stopped";
                        log_warn!("watch.exit", id = id, status = exit_status);
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
            on_end(id, why);
        });
        Ok(id)
    }

    /// What to follow, one JSON line to the picker.
    pub async fn send(&self, want: &Value) -> Result<()> {
        let open = self.open.lock().await;
        let (_, writer) = open.as_ref().ok_or_else(|| anyhow!("the watch is not running"))?;
        let mut line = serde_json::to_vec(want)?;
        line.push(b'\n');
        writer.data(line.as_slice()).await?;
        Ok(())
    }

    /// Forgets watch `id` once it ended (a newer one may have replaced it).
    pub async fn ended(&self, id: u32) {
        let mut open = self.open.lock().await;
        if open.as_ref().is_some_and(|(current, _)| *current == id) {
            *open = None;
        }
    }

    /// Ends the watch: the picker exits when its input closes, and the channel with it.
    pub async fn stop(&self) {
        if let Some((_, writer)) = self.open.lock().await.take() {
            let _ = writer.eof().await;
        }
    }
}
