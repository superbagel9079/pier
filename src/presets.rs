//! Session presets (B.8): a name plus Pi launch options, read from `%APPDATA%\pier\presets.json`.

use serde::Deserialize;
use std::path::{Path, PathBuf};

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// Written on first "Modifier les presets…", so the file has a shape to copy.
const STARTER: &str = r#"[
  {
    "name": "Exemple : réponses rapides",
    "model": "openrouter/deepseek/deepseek-v4.1-flash",
    "thinking": "low"
  },
  {
    "name": "Exemple : revue en lecture seule",
    "tools": "read,grep,find,ls",
    "appendSystemPrompt": "Tu relis le code sans rien modifier et tu listes les problèmes par ordre de gravité."
  }
]
"#;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preset {
    pub name: String,
    /// Folder Pi works in; Pier's own folder when absent.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub thinking: Option<String>,
    /// Pi `--tools` list, e.g. `read,grep,find,ls` or `+codemode,-write`.
    #[serde(default)]
    pub tools: Option<String>,
    /// Added to Pi's system prompt (text or a file path), so Pi's own tool instructions stay.
    #[serde(default)]
    pub append_system_prompt: Option<String>,
}

impl Preset {
    /// Pi arguments for this preset; they come after the command line's, so the preset wins.
    pub fn args(&self) -> Vec<String> {
        let flags = [
            ("--model", &self.model),
            ("--thinking", &self.thinking),
            ("--tools", &self.tools),
            ("--append-system-prompt", &self.append_system_prompt),
        ];
        flags.into_iter().filter_map(|(flag, v)| Some([flag.to_owned(), v.clone()?])).flatten().collect()
    }

    fn check(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("un preset n'a pas de nom".into());
        }
        if let Some(t) = &self.thinking
            && !THINKING_LEVELS.contains(&t.as_str())
        {
            return Err(format!("« {} » : thinking « {t} » inconnu (valeurs : {})", self.name, THINKING_LEVELS.join(", ")));
        }
        if let Some(d) = &self.cwd
            && !d.is_dir()
        {
            return Err(format!("« {} » : le dossier {} n'existe pas", self.name, d.display()));
        }
        Ok(())
    }
}

pub fn path() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pier").join("presets.json")
}

/// No file yet = no presets. A broken file is an error to show, never silently skipped.
pub fn load(path: &Path) -> Result<Vec<Preset>, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(format!("lecture de {} impossible : {e}", path.display())),
    };
    let presets: Vec<Preset> = serde_json::from_str(&text).map_err(|e| format!("{} invalide : {e}", path.display()))?;
    presets.iter().try_for_each(Preset::check)?;
    Ok(presets)
}

/// Creates the starter file if there is none; returns its path for the editor.
pub fn ensure_file() -> std::io::Result<PathBuf> {
    let p = path();
    if !p.exists() {
        std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")))?;
        std::fs::write(&p, STARTER)?;
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn load_str(s: &str) -> Result<Vec<Preset>, String> {
        let p = std::env::temp_dir().join(format!("pier-presets-{}-{}.json", std::process::id(), s.len()));
        std::fs::write(&p, s).unwrap();
        let r = load(&p);
        std::fs::remove_file(&p).unwrap();
        r
    }

    #[test]
    fn starter_file_is_valid_and_maps_to_pi_flags() {
        let presets = load_str(STARTER).unwrap();
        assert_eq!(presets[0].args(), ["--model", "openrouter/deepseek/deepseek-v4.1-flash", "--thinking", "low"]);
        assert_eq!(presets[1].args()[..2], ["--tools", "read,grep,find,ls"]);
        assert_eq!(presets[1].args()[2], "--append-system-prompt");
    }

    #[test]
    fn mistakes_are_reported_not_ignored() {
        assert!(load(Path::new("Z:/does/not/exist.json")).unwrap().is_empty(), "no file = no presets");
        assert!(load_str(r#"[{"name":"a","modle":"x"}]"#).unwrap_err().contains("modle"), "typo in a key");
        assert!(load_str(r#"[{"name":"a","thinking":"huge"}]"#).unwrap_err().contains("huge"));
        assert!(load_str(r#"[{"name":"a","cwd":"Z:/nope/nope"}]"#).unwrap_err().contains("n'existe pas"));
        assert!(load_str(r#"[{"name":" "}]"#).is_err());
        assert!(load_str("not json").is_err());
    }
}
