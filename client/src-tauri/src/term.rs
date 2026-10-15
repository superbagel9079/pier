//! Terminals on the VM, one per tab, each a channel of the one SSH connection: no
//! new login, no password asked again. Output goes to the tab's xterm.js through a
//! Tauri channel as raw bytes; keystrokes come back through `write`.
//!
//! Two kinds. A plain terminal is a pseudo-terminal running a command (the picker, a
//! shell). A Pi terminal talks to tmux in control mode (`tmux -C`): tmux keeps Pi
//! running on the VM but draws nothing; it hands over Pi's own output, untouched,
//! which xterm.js then renders as if Pi ran here. Pi's history therefore lands in this
//! terminal's scrollback, and scrolling, selecting and copying happen on this computer.
//! Through a pseudo-terminal, tmux would redraw its own screen instead, and the
//! history would never reach here.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use tauri::ipc::{Channel as Output, InvokeResponseBody};
use tokio::sync::Mutex;

/// Most bytes put in one message to the page.
const BATCH_MAX: usize = 256 * 1024;
/// Bytes per tmux send-keys command.
const KEYS_PER_COMMAND: usize = 2048;
/// Most bytes of a tmux line kept while waiting for its end: a Pi that writes without
/// a line break cannot grow this without limit.
const LINE_MAX: usize = 8 * 1024 * 1024;

/// Each terminal has its own lock: a big paste into one, slowed by the SSH window,
/// never holds up typing or resizing in the others.
type Writer = Arc<Mutex<ChannelWriteHalf<Msg>>>;

struct Open {
    writer: Writer,
    /// tmux control mode: input and size go as tmux commands.
    control: bool,
}

#[derive(Default)]
pub struct Terminals {
    next: AtomicU32,
    open: Mutex<HashMap<u32, Open>>,
}

impl Terminals {
    /// Starts `command` (or the login shell) in a pseudo-terminal of cols x rows.
    /// `on_exit` runs once the remote side has finished, with its exit status if it
    /// gave one.
    pub async fn open(
        &self,
        channel: Channel<Msg>,
        command: Option<&str>,
        cols: u32,
        rows: u32,
        output: Output<InvokeResponseBody>,
        on_exit: impl FnOnce(u32, Option<u32>) + Send + 'static,
    ) -> Result<u32> {
        let (reader, writer) = channel.split();
        writer.request_pty(true, "xterm-256color", cols.max(2), rows.max(2), 0, 0, &[]).await?;
        match command {
            Some(command) => writer.exec(true, command).await?,
            None => writer.request_shell(true).await?,
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().await.insert(id, Open { writer: Arc::new(Mutex::new(writer)), control: false });
        tokio::spawn(pump(id, reader, output, None, on_exit));
        Ok(id)
    }

    /// Runs `command`, which ends in `tmux -C attach` (the picker's --attach-control),
    /// without a pseudo-terminal: tmux reads commands on its input and writes
    /// notifications on its output. Pi is then made to redraw everything (see below).
    pub async fn open_control(
        &self,
        channel: Channel<Msg>,
        command: &str,
        cols: u32,
        rows: u32,
        output: Output<InvokeResponseBody>,
        on_exit: impl FnOnce(u32, Option<u32>) + Send + 'static,
    ) -> Result<u32> {
        let (reader, writer) = channel.split();
        writer.exec(true, command).await?;
        // Attaching shows nothing until Pi writes. Two sizes in a row make it redraw
        // the whole screen, and in its regular mode the whole conversation, which thus
        // arrives in this terminal's history.
        let (cols, rows) = (cols.max(2), rows.max(3));
        writer.data(resize_command(cols, rows - 1).as_bytes()).await?;
        writer.data(resize_command(cols, rows).as_bytes()).await?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.open.lock().await.insert(id, Open { writer: Arc::new(Mutex::new(writer)), control: true });
        tokio::spawn(pump(id, reader, output, Some(ControlParser::default()), on_exit));
        Ok(id)
    }

    /// The terminal's writer, taken out of the table: the table is not held while
    /// sending.
    async fn writer(&self, id: u32) -> Result<(Writer, bool)> {
        let open = self.open.lock().await;
        let terminal = open.get(&id).ok_or_else(|| anyhow!("terminal closed"))?;
        Ok((terminal.writer.clone(), terminal.control))
    }

    pub async fn write(&self, id: u32, bytes: &[u8]) -> Result<()> {
        let (writer, control) = self.writer(id).await?;
        let writer = writer.lock().await;
        if control {
            writer.data(send_keys_commands(bytes).as_bytes()).await?;
        } else {
            writer.data(bytes).await?;
        }
        Ok(())
    }

    pub async fn resize(&self, id: u32, cols: u32, rows: u32) -> Result<()> {
        let (writer, control) = self.writer(id).await?;
        let writer = writer.lock().await;
        if control {
            writer.data(resize_command(cols.max(2), rows.max(2)).as_bytes()).await?;
        } else {
            writer.window_change(cols.max(2), rows.max(2), 0, 0).await?;
        }
        Ok(())
    }

    /// Closes the terminal. A Pi started from it lives on in tmux. In control mode,
    /// tmux is asked to detach: it then exits, and the channel closes with it.
    pub async fn close(&self, id: u32) {
        if let Some(terminal) = self.open.lock().await.remove(&id) {
            end(terminal).await;
        }
    }

    pub async fn forget(&self, id: u32) {
        self.open.lock().await.remove(&id);
    }

    pub async fn close_all(&self) {
        let all: Vec<Open> = self.open.lock().await.drain().map(|(_, t)| t).collect();
        for terminal in all {
            end(terminal).await;
        }
    }
}

/// Ends a terminal, within 3 s: a connection already dead must not hold up quitting.
async fn end(terminal: Open) {
    let finish = async {
        let writer = terminal.writer.lock().await;
        if terminal.control {
            let _ = writer.data(&b"detach-client\n"[..]).await;
            let _ = writer.eof().await;
        } else {
            let _ = writer.close().await;
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(3), finish).await;
}

/// Reads a terminal's channel until it closes, sending its output to the page. With a
/// parser, the channel speaks tmux's control mode and only what Pi wrote is sent.
async fn pump(
    id: u32,
    mut reader: ChannelReadHalf,
    output: Output<InvokeResponseBody>,
    mut control: Option<ControlParser>,
    on_exit: impl FnOnce(u32, Option<u32>),
) {
    let mut status = None;
    let mut stats = (0u64, 0u64, 0u64); // SSH packets, messages to the page, bytes
    let mut next = reader.wait().await;
    'reading: while let Some(message) = next.take() {
        match message {
            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, ext: 0 } => {
                // Every message to the page costs a script run, or an IPC round trip
                // above 1 KB: a screen redraw arriving as dozens of SSH packets made
                // dozens of them. What has already arrived goes out as one message;
                // nothing waits for more.
                let mut incoming = data.to_vec();
                stats.0 += 1;
                let mut ended = false;
                while incoming.len() < BATCH_MAX {
                    match tokio::time::timeout(Duration::ZERO, reader.wait()).await {
                        Ok(Some(ChannelMsg::Data { data })) => {
                            incoming.extend_from_slice(&data);
                            stats.0 += 1;
                        }
                        Ok(other) => {
                            next = other;
                            ended = next.is_none();
                            break;
                        }
                        Err(_) => break, // nothing more for now
                    }
                }
                let batch = match control.as_mut() {
                    Some(parser) => parser.feed(&incoming),
                    None => incoming,
                };
                if !batch.is_empty() {
                    stats.1 += 1;
                    stats.2 += batch.len() as u64;
                    if output.send(InvokeResponseBody::Raw(batch)).is_err() {
                        break; // the tab is gone
                    }
                }
                if ended || control.as_ref().is_some_and(|p| p.exited.is_some()) {
                    break 'reading;
                }
            }
            // Errors before tmux runs (the picker refusing, tmux missing): shown as they are.
            ChannelMsg::ExtendedData { data, .. } => {
                let text = String::from_utf8_lossy(&data).replace('\n', "\r\n");
                let _ = output.send(InvokeResponseBody::Raw(text.into_bytes()));
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
        if next.is_none() {
            next = reader.wait().await;
        }
    }
    if let Some(parser) = &control {
        if let Some(reason) = &parser.exited {
            log_info!("term.control-exit", id = id, reason = reason);
        }
    }
    log_debug!("term.output", id = id, packets = stats.0, messages = stats.1, bytes = stats.2);
    // tmux said goodbye (Pi ended, or detached): a normal end, like an exit status.
    // Neither: the connection went away under the terminal.
    if status.is_none() && control.as_ref().is_some_and(|p| p.exited.is_some()) {
        status = Some(0);
    }
    on_exit(id, status);
}

fn resize_command(cols: u32, rows: u32) -> String {
    format!("refresh-client -C {cols}x{rows}\n")
}

/// What is typed, as tmux commands: the bytes go to Pi exactly as they are (-H: each
/// argument is one byte in hexadecimal), so tmux interprets nothing on the way, not
/// even its prefix key.
pub fn send_keys_commands(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut commands = String::with_capacity(bytes.len() * 3 + bytes.len() / KEYS_PER_COMMAND * 14 + 14);
    for chunk in bytes.chunks(KEYS_PER_COMMAND) {
        commands.push_str("send-keys -H");
        for &byte in chunk {
            commands.push(' ');
            commands.push(HEX[usize::from(byte >> 4)] as char);
            commands.push(HEX[usize::from(byte & 15)] as char);
        }
        commands.push('\n');
    }
    commands
}

/// Pier's own sequence: only Pier may say which session a tab shows. Written by Pi,
/// it is defused on the way (also when split across two writes).
const OWN_OSC: &[u8] = b"\x1b]7770;";

/// tmux control mode, as it comes: one line per notification. "%output %PANE DATA" is
/// what the program wrote, with bytes below space and backslashes written as \ooo
/// (octal). Answers to commands come between "%begin" and "%end" (or "%error"); "%exit"
/// says the client is detached (the session ended, or someone detached it).
#[derive(Default)]
pub struct ControlParser {
    pending: Vec<u8>,
    in_block: bool,
    block: Vec<String>,
    pub exited: Option<String>,
    /// The last bytes of Pi's output, to catch Pier's sequence split across writes.
    tail: Vec<u8>,
}

impl ControlParser {
    /// The program's output found in `data`; an incomplete last line waits for the rest.
    /// Lines are walked in place and the consumed part dropped once (linear in the data).
    pub fn feed(&mut self, data: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(data);
        let mut out = Vec::new();
        let pending = std::mem::take(&mut self.pending);
        let mut start = 0;
        while let Some(at) = pending[start..].iter().position(|&b| b == b'\n') {
            let mut line = &pending[start..start + at];
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            self.line(line, &mut out);
            start += at + 1;
        }
        self.pending = pending[start..].to_vec();
        if self.pending.len() > LINE_MAX {
            log_warn!("term.line-too-long", bytes = self.pending.len());
            self.pending.clear();
        }
        out
    }

    /// Pi's bytes, with Pier's own sequence defused.
    fn program_output(&mut self, decoded: &mut Vec<u8>, out: &mut Vec<u8>) {
        // Split across writes: the end of the last output and the start of this one.
        for k in 1..OWN_OSC.len() {
            if self.tail.ends_with(&OWN_OSC[..k]) && decoded.starts_with(&OWN_OSC[k..]) {
                decoded[0] = b'_';
            }
        }
        let mut i = 0;
        while let Some(at) = decoded[i..].windows(OWN_OSC.len()).position(|w| w == OWN_OSC) {
            decoded[i + at + 1] = b'_'; // ESC _ : an ignored sequence, not Pier's
            i += at + 1;
        }
        self.tail.extend_from_slice(decoded);
        if self.tail.len() > OWN_OSC.len() {
            self.tail.drain(..self.tail.len() - OWN_OSC.len());
        }
        out.extend_from_slice(decoded);
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<u8>) {
        if self.in_block {
            if line.starts_with(b"%end") || line.starts_with(b"%error") {
                self.in_block = false;
                if line.starts_with(b"%error") {
                    log_warn!("term.tmux-error", answer = self.block.join(" | "));
                }
                self.block.clear();
            } else if self.block.len() < 20 {
                self.block.push(String::from_utf8_lossy(line).into_owned());
            }
            return;
        }
        if line.starts_with(b"%begin") {
            self.in_block = true;
            return;
        }
        if let Some(rest) = line.strip_prefix(b"%output ") {
            if let Some(space) = rest.iter().position(|&b| b == b' ') {
                let mut decoded = Vec::with_capacity(rest.len());
                unescape(&rest[space + 1..], &mut decoded);
                self.program_output(&mut decoded, out);
            }
            return;
        }
        if let Some(rest) = line.strip_prefix(b"%extended-output ") {
            if let Some(at) = rest.windows(3).position(|w| w == b" : ") {
                let mut decoded = Vec::with_capacity(rest.len());
                unescape(&rest[at + 3..], &mut decoded);
                self.program_output(&mut decoded, out);
            }
            return;
        }
        // "%session-changed $ID NAME": which tmux session (which Pi) this tab shows,
        // passed on to the tab as Pier's own OSC sequence (see terminal.js).
        if let Some(rest) = line.strip_prefix(b"%session-changed ") {
            if let Some(space) = rest.iter().position(|&b| b == b' ') {
                let name = &rest[space + 1..];
                if !name.is_empty() && name.iter().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(b)) {
                    out.extend_from_slice(b"\x1b]7770;session;");
                    out.extend_from_slice(name);
                    out.push(0x07);
                }
            }
            return;
        }
        if line.starts_with(b"%exit") {
            self.exited = Some(String::from_utf8_lossy(line.get(6..).unwrap_or_default()).trim().to_string());
        }
        // Other notifications (windows, layouts, sessions) concern nothing here.
    }
}

fn unescape(data: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\\' {
            let octal = data.get(i + 1..i + 4).filter(|d| d.iter().all(|c| (b'0'..=b'7').contains(c)));
            if let Some(digits) = octal {
                out.push(digits.iter().fold(0u32, |n, d| n * 8 + u32::from(d - b'0')) as u8);
                i += 4;
                continue;
            }
            if data.get(i + 1) == Some(&b'\\') {
                out.push(b'\\');
                i += 2;
                continue;
            }
        }
        out.push(data[i]);
        i += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_output_is_unescaped() {
        let mut parser = ControlParser::default();
        let out = parser.feed(b"%output %3 hello\\015\\012world \\033[1mbold\\033[0m \\134 \xc3\xa9\n");
        assert_eq!(out, b"hello\r\nworld \x1b[1mbold\x1b[0m \\ \xc3\xa9");
    }

    #[test]
    fn lines_cut_anywhere_are_put_back_together() {
        let mut parser = ControlParser::default();
        assert!(parser.feed(b"%output %1 ab").is_empty());
        assert_eq!(parser.feed(b"c\\01").as_slice(), b"");
        assert_eq!(parser.feed(b"2\n%output %1 d\n"), b"abc\nd");
    }

    #[test]
    fn answers_and_notifications_are_not_output() {
        let mut parser = ControlParser::default();
        let out = parser.feed(b"%begin 1 2 0\n%output %1 not output, an answer line\n%end 1 2 0\n%window-add @2\n%output %1 yes\n");
        assert_eq!(out, b"yes");
        assert!(parser.exited.is_none());
        parser.feed(b"%error 1 3 0\n");
        parser.feed(b"%exit detached\n");
        assert_eq!(parser.exited.as_deref(), Some("detached"));
    }

    #[test]
    fn pi_cannot_speak_for_pier() {
        let mut parser = ControlParser::default();
        let out = parser.feed(b"%output %1 \\033]7770;session;pi-other\\007\n");
        assert!(!out.windows(OWN_OSC.len()).any(|w| w == OWN_OSC), "{out:?}");
        // split across two writes
        let mut parser = ControlParser::default();
        let mut out = parser.feed(b"%output %1 \\033]77\n");
        out.extend(parser.feed(b"%output %1 70;session;x\\007\n"));
        assert!(!out.windows(OWN_OSC.len()).any(|w| w == OWN_OSC), "{out:?}");
        // Pier's own still passes
        let mut parser = ControlParser::default();
        assert_eq!(parser.feed(b"%session-changed $1 pi-a\n"), b"\x1b]7770;session;pi-a\x07");
    }

    #[test]
    fn a_line_without_end_is_capped() {
        let mut parser = ControlParser::default();
        let big = vec![b'x'; LINE_MAX + 10];
        assert!(parser.feed(&big).is_empty());
        assert!(parser.pending.is_empty());
        assert_eq!(parser.feed(b"%output %1 ok\n"), b"ok");
    }

    #[test]
    fn many_lines_at_once() {
        let mut parser = ControlParser::default();
        let mut data = Vec::new();
        for _ in 0..20000 {
            data.extend_from_slice(b"%output %1 ab\n");
        }
        let started = std::time::Instant::now();
        assert_eq!(parser.feed(&data).len(), 40000);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn the_session_is_named_to_the_tab() {
        let mut parser = ControlParser::default();
        assert_eq!(parser.feed(b"%session-changed $3 pi-work-test-a1b2c3-2\n"), b"\x1b]7770;session;pi-work-test-a1b2c3-2\x07");
        assert_eq!(parser.feed(b"%session-changed $3 bad;name\n"), b"", "only plain tmux names");
    }

    #[test]
    fn extended_output_too() {
        let mut parser = ControlParser::default();
        assert_eq!(parser.feed(b"%extended-output %1 120 : x\\012\n"), b"x\n");
    }

    #[test]
    fn keys_go_as_bytes() {
        assert_eq!(send_keys_commands(b"a\x1b[A\xc3\xa9"), "send-keys -H 61 1b 5b 41 c3 a9\n");
        assert_eq!(send_keys_commands(&[0x20; KEYS_PER_COMMAND + 1]).lines().count(), 2, "long pastes are split");
        assert_eq!(send_keys_commands(b""), "");
        assert_eq!(resize_command(120, 40), "refresh-client -C 120x40\n");
    }
}
