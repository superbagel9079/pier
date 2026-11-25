//! Images attached to a message: from a file (picked or dropped) or pasted from the clipboard, sent to Pi as base64.

use crate::pi::protocol::ImageContent;
use std::path::Path;

/// Larger images are refused rather than sent: they cost many tokens and providers reject them.
pub const MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    /// File name, or "pasted image".
    pub name: String,
    pub mime: &'static str,
    pub data: Vec<u8>,
}

/// The image type, read from the file's first bytes (an extension can lie).
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

impl Image {
    pub fn from_file(path: &Path) -> Result<Self, String> {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
        let size = std::fs::metadata(path).map_err(|e| format!("{name}: {e}"))?.len();
        if size > MAX_BYTES as u64 {
            return Err(format!("{name}: {} MB, more than {} MB", size / (1024 * 1024), MAX_BYTES / (1024 * 1024)));
        }
        let data = std::fs::read(path).map_err(|e| format!("{name}: {e}"))?;
        let mime = sniff(&data).ok_or_else(|| format!("{name}: not a PNG, JPEG, GIF or WebP image"))?;
        Ok(Self { name, mime, data })
    }

    /// A pasted image, as egui gives it: `width` × `height` RGBA pixels, encoded to PNG.
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Self, String> {
        let mut data = Vec::new();
        let mut encoder = png::Encoder::new(&mut data, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header().and_then(|mut w| w.write_image_data(rgba)).map_err(|e| format!("pasted image: {e}"))?;
        if data.len() > MAX_BYTES {
            return Err(format!(
                "pasted image: {} MB once encoded, more than {} MB",
                data.len() / (1024 * 1024),
                MAX_BYTES / (1024 * 1024)
            ));
        }
        Ok(Self { name: "pasted image".into(), mime: "image/png", data })
    }

    pub fn to_content(&self) -> ImageContent {
        ImageContent { kind: "image", data: base64(&self.data), mime_type: self.mime.into() }
    }
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_vectors() {
        for (input, expected) in
            [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")]
        {
            assert_eq!(base64(input.as_bytes()), expected, "{input:?}");
        }
        assert_eq!(base64(&[0xFF, 0xFE, 0x00]), "//4A");
    }

    #[test]
    fn pasted_pixels_become_a_png_and_files_are_checked() {
        let img = Image::from_rgba(2, 1, &[255, 0, 0, 255, 0, 255, 0, 255]).unwrap();
        assert_eq!(sniff(&img.data), Some("image/png"));
        assert_eq!(img.to_content().mime_type, "image/png");

        let dir = std::env::temp_dir().join(format!("pier-attach-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("shot.png");
        std::fs::write(&png, &img.data).unwrap();
        assert_eq!(Image::from_file(&png).unwrap().data, img.data);
        let fake = dir.join("notes.png");
        std::fs::write(&fake, "just text").unwrap();
        assert!(Image::from_file(&fake).unwrap_err().contains("not a PNG"), "the content decides, not the extension");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
