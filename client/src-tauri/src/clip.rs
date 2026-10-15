//! The image on the system clipboard, as PNG bytes.

use anyhow::{anyhow, Result};

pub fn clipboard_png() -> Result<Vec<u8>> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| anyhow!("clipboard unavailable: {e}"))?;
    let image = clipboard
        .get_image()
        .map_err(|_| anyhow!("The clipboard holds no image."))?;
    encode_png(image.width as u32, image.height as u32, &image.bytes)
}

/// Files and folders copied in the file manager (Explorer's Ctrl+C), as paths.
/// Empty when the clipboard holds none.
pub fn clipboard_paths() -> Vec<String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get().file_list())
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// RGBA pixels to PNG.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(rgba)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn encodes_a_valid_png() {
        let pixels = vec![255u8; 4 * 3 * 2];
        let png = super::encode_png(3, 2, &pixels).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
