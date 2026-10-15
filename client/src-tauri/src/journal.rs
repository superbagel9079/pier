//! Pier's log: one line per event, in the app's log folder (on Windows,
//! %LOCALAPPDATA%\app.devbox.client\logs\pier.log):
//!
//!   2026-10-12T14:32:01.123Z INFO  vm.paste-image req=7f3a-12 ms=41 sent=48213
//!
//! The same shape as the picker's log on the VM, in UTC like it, and the `req` of a call
//! is written on both sides: the two logs read side by side. Values are bare words, or
//! quoted like JSON strings when they hold spaces or quotes. Lines below a line,
//! indented, belong to it (a panic's details).
//!
//! What never comes here: passwords, what is typed in a terminal, what is typed into
//! Pi (only its length), the content of files. Paths, host names and user names do:
//! they are what a bug report needs, and the report says so before it is shared.
//!
//! Debug lines (every read the interface polls, terminal sizes...) are written only
//! when "Detailed logs" is on. The file is rotated at 5 MB, 3 files kept.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Error = 0,
    Warn = 1,
    Info = 2,
    Debug = 3,
}

impl Level {
    pub fn name(self) -> &'static str {
        ["ERROR", "WARN", "INFO", "DEBUG"][self as usize]
    }

    pub fn parse(text: &str) -> Option<Level> {
        match text.to_ascii_lowercase().as_str() {
            "error" => Some(Level::Error),
            "warn" | "warning" => Some(Level::Warn),
            "info" => Some(Level::Info),
            "debug" => Some(Level::Debug),
            _ => None,
        }
    }
}

pub const MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const KEEP: usize = 3;
const FILE_NAME: &str = "pier.log";

struct Sink {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

type Listener = Box<dyn Fn(&str) + Send + Sync>;

struct Logger {
    sink: Mutex<Sink>,
    listener: Mutex<Option<Listener>>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();
static LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

/// Opens the log in `dir`, and logs panics there before the program dies.
pub fn init(dir: &Path) -> PathBuf {
    let path = dir.join(FILE_NAME);
    let _ = fs::create_dir_all(dir);
    let file = OpenOptions::new().create(true).append(true).open(&path).ok();
    let size = file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
    let _ = LOGGER.set(Logger { sink: Mutex::new(Sink { path: path.clone(), file, size }), listener: Mutex::new(None) });
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let place = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "?".into());
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        write(Level::Error, "app.panic", &[("at", place), ("thread", thread), ("err", what)]);
        previous(info);
    }));
    path
}

pub fn path() -> Option<PathBuf> {
    LOGGER.get().map(|l| l.sink.lock().unwrap().path.clone())
}

pub fn set_debug(on: bool) {
    LEVEL.store(if on { Level::Debug } else { Level::Info } as u8, Ordering::Relaxed);
}

pub fn debug_enabled() -> bool {
    enabled(Level::Debug)
}

pub fn enabled(level: Level) -> bool {
    level as u8 <= LEVEL.load(Ordering::Relaxed)
}

/// Called with every line written: the Logs tab follows the log live.
pub fn set_listener(listener: impl Fn(&str) + Send + Sync + 'static) {
    if let Some(logger) = LOGGER.get() {
        *logger.listener.lock().unwrap() = Some(Box::new(listener));
    }
}

pub fn write(level: Level, event: &str, fields: &[(&str, String)]) {
    if !enabled(level) {
        return;
    }
    let line = format_line(SystemTime::now(), level, event, fields);
    let Some(logger) = LOGGER.get() else {
        eprint!("{line}");
        return;
    };
    {
        let mut sink = logger.sink.lock().unwrap();
        if sink.size + line.len() as u64 > MAX_BYTES && sink.size > 0 {
            rotate(&mut sink);
        }
        if let Some(file) = sink.file.as_mut() {
            if file.write_all(line.as_bytes()).is_ok() {
                sink.size += line.len() as u64;
            }
        }
    }
    if let Some(listener) = logger.listener.lock().unwrap().as_ref() {
        listener(line.trim_end());
    }
}

/// pier.log becomes pier.1.log, pier.1.log pier.2.log, and so on.
fn rotate(sink: &mut Sink) {
    sink.file = None; // closed first: Windows renames no open file
    for n in (1..KEEP).rev() {
        let from = if n == 1 { sink.path.clone() } else { numbered(&sink.path, n - 1) };
        let _ = fs::rename(&from, numbered(&sink.path, n));
    }
    sink.file = OpenOptions::new().create(true).append(true).open(&sink.path).ok();
    sink.size = 0;
}

fn numbered(path: &Path, n: usize) -> PathBuf {
    path.with_file_name(format!("pier.{n}.log"))
}

/// The last `lines` lines, from the older files too when the current one is short.
pub fn tail(lines: usize) -> Vec<String> {
    let Some(path) = path() else { return Vec::new() };
    let lines = lines.clamp(1, 20000);
    let mut rows: Vec<String> = Vec::new();
    for n in 0..KEEP {
        let file = if n == 0 { path.clone() } else { numbered(&path, n) };
        let Ok(mut handle) = File::open(&file) else { continue };
        let size = handle.metadata().map_or(0, |m| m.len());
        let budget = (lines as u64) * 400;
        let start = size.saturating_sub(budget);
        let _ = handle.seek(SeekFrom::Start(start));
        let mut bytes = Vec::new();
        let _ = handle.read_to_end(&mut bytes);
        let text = String::from_utf8_lossy(&bytes);
        let mut chunk: Vec<String> = text.lines().map(str::to_owned).collect();
        if start > 0 && !chunk.is_empty() {
            chunk.remove(0); // cut in the middle of a line
        }
        chunk.extend(rows);
        rows = chunk;
        if rows.len() >= lines {
            break;
        }
    }
    let skip = rows.len().saturating_sub(lines);
    rows.split_off(skip)
}

pub fn format_line(now: SystemTime, level: Level, event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("{} {:<5} {}", timestamp(now), level.name(), event);
    let mut trace = None;
    for (key, value) in fields {
        if *key == "trace" {
            trace = Some(value);
            continue;
        }
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&quote(value));
    }
    line.push('\n');
    if let Some(trace) = trace {
        for row in trace.lines() {
            line.push_str("    ");
            line.push_str(row);
            line.push('\n');
        }
    }
    line
}

/// A value as one token: bare when simple, else a JSON string.
pub fn quote(value: &str) -> String {
    let simple = !value.is_empty() && value.chars().all(|c| !c.is_whitespace() && !c.is_control() && !matches!(c, '"' | '=' | '\\'));
    if simple { value.to_string() } else { serde_json::to_string(value).unwrap_or_else(|_| "\"?\"".into()) }
}

/// "2026-10-12T14:32:01.123Z", in UTC.
pub fn timestamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let (days, rest) = ((secs / 86400) as i64, secs % 86400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60,
        since.subsec_millis()
    )
}

/// Days since 1970-01-01 to a date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Logs at a level, with fields: `log_info!("vm.paste", req = id, ms = 41)`. A field's
/// value is anything Display; the line is built only when the level is on.
macro_rules! log_at {
    ($level:expr, $event:expr $(, $key:ident = $value:expr)* $(,)?) => {{
        let level = $level;
        if $crate::journal::enabled(level) {
            $crate::journal::write(level, &$event, &[$((stringify!($key), ($value).to_string())),*]);
        }
    }};
}
macro_rules! log_error { ($($t:tt)*) => { log_at!($crate::journal::Level::Error, $($t)*) } }
macro_rules! log_warn { ($($t:tt)*) => { log_at!($crate::journal::Level::Warn, $($t)*) } }
macro_rules! log_info { ($($t:tt)*) => { log_at!($crate::journal::Level::Info, $($t)*) } }
macro_rules! log_debug { ($($t:tt)*) => { log_at!($crate::journal::Level::Debug, $($t)*) } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps_are_utc_iso() {
        assert_eq!(timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        // 2026-10-12T14:32:01.123Z
        let t = UNIX_EPOCH + Duration::from_millis(1_791_815_521_123);
        assert_eq!(timestamp(t), "2026-10-12T14:32:01.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400); // 2000-02-29
        assert!(timestamp(leap).starts_with("2000-02-29T"));
    }

    #[test]
    fn lines_quote_what_needs_it() {
        let line = format_line(UNIX_EPOCH, Level::Warn, "vm.ls", &[("path", "/home/leo/a b".into()), ("ms", "41".into()), ("q", "say \"hi\"".into())]);
        assert_eq!(line, "1970-01-01T00:00:00.000Z WARN  vm.ls path=\"/home/leo/a b\" ms=41 q=\"say \\\"hi\\\"\"\n");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("été"), "été");
        assert_eq!(quote("a=b"), "\"a=b\"");
        assert_eq!(quote("C:\\x"), "\"C:\\\\x\"");
        let traced = format_line(UNIX_EPOCH, Level::Error, "app.panic", &[("trace", "one\ntwo".into())]);
        assert!(traced.ends_with("app.panic\n    one\n    two\n"), "{traced}");
    }

    #[test]
    fn levels() {
        assert_eq!(Level::parse("WARNING"), Some(Level::Warn));
        assert_eq!(Level::parse("loud"), None);
        assert!(Level::Error < Level::Debug);
    }

    #[test]
    fn rotation_and_tail() {
        let dir = std::env::temp_dir().join(format!("pier-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        let mut sink = Sink { path: path.clone(), file: OpenOptions::new().create(true).append(true).open(&path).ok(), size: 0 };
        sink.file.as_mut().unwrap().write_all(b"first\n").unwrap();
        rotate(&mut sink);
        sink.file.as_mut().unwrap().write_all(b"second\n").unwrap();
        rotate(&mut sink);
        sink.file.as_mut().unwrap().write_all(b"third\n").unwrap();
        rotate(&mut sink);
        assert_eq!(fs::read_to_string(numbered(&path, 1)).unwrap(), "third\n");
        assert_eq!(fs::read_to_string(numbered(&path, 2)).unwrap(), "second\n");
        assert!(!numbered(&path, 3).exists(), "only {KEEP} files are kept");
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        drop(sink);
        let _ = fs::remove_dir_all(dir);
    }
}
