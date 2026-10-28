//! Lines out of a stream that arrives in pieces (tmux's control mode, the watch's JSON).
//!
//! Linear in the data, however it is cut: each byte is looked at once, the lines
//! consumed are dropped once per piece, and a line longer than the limit is dropped
//! whole, up to its end, rather than read on from its middle as if it were a new line.

pub struct Lines {
    pending: Vec<u8>,
    /// Bytes of `pending` already known to hold no line end.
    scanned: usize,
    /// In a line that went past the limit: its bytes are dropped up to its end.
    skipping: bool,
    max: usize,
}

impl Lines {
    pub fn new(max: usize) -> Self {
        Lines { pending: Vec::new(), scanned: 0, skipping: false, max }
    }

    /// Calls `each` with every whole line in `data` (without its "\n"); an incomplete
    /// last one waits for the rest. Returns true when a line went past the limit (it is
    /// then dropped).
    pub fn feed(&mut self, mut data: &[u8], mut each: impl FnMut(&[u8])) -> bool {
        let mut too_long = false;
        if self.skipping {
            match data.iter().position(|&b| b == b'\n') {
                Some(at) => {
                    self.skipping = false;
                    data = &data[at + 1..];
                }
                None => return false,
            }
        }
        self.pending.extend_from_slice(data);
        let mut start = 0;
        let mut from = self.scanned;
        while let Some(at) = self.pending[from..].iter().position(|&b| b == b'\n') {
            each(&self.pending[start..from + at]);
            start = from + at + 1;
            from = start;
        }
        self.pending.drain(..start);
        self.scanned = self.pending.len();
        if self.pending.len() > self.max {
            self.pending.clear();
            self.scanned = 0;
            self.skipping = true;
            too_long = true;
        }
        too_long
    }

    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(lines: &mut Lines, data: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        lines.feed(data, |l| out.push(String::from_utf8_lossy(l).into_owned()));
        out
    }

    #[test]
    fn cut_anywhere() {
        let mut lines = Lines::new(100);
        assert!(all(&mut lines, b"ab").is_empty());
        assert_eq!(all(&mut lines, b"c\nd\ne"), ["abc", "d"]);
        assert_eq!(all(&mut lines, b"\n"), ["e"]);
        assert_eq!(lines.waiting(), 0);
    }

    #[test]
    fn a_long_line_is_dropped_up_to_its_end() {
        let mut lines = Lines::new(10);
        let mut out = Vec::new();
        assert!(lines.feed(b"0123456789abc", |l| out.push(l.to_vec())));
        assert!(!lines.feed(b"still the same line", |l| out.push(l.to_vec())));
        lines.feed(b" end\nnext\n", |l| out.push(l.to_vec()));
        assert_eq!(out, [b"next".to_vec()]);
    }

    #[test]
    fn a_long_line_in_small_pieces_stays_linear() {
        let mut lines = Lines::new(64 * 1024 * 1024);
        let piece = vec![b'x'; 1024];
        let started = std::time::Instant::now();
        for _ in 0..20_000 {
            lines.feed(&piece, |_| {});
        }
        let mut got = 0;
        lines.feed(b"\n", |l| got = l.len());
        assert_eq!(got, 20_000 * 1024);
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
    }
}
