use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct AiCli {
    pub id: String,
    pub label: String,
    pub bin: String,
}

const CANDIDATES: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("opencode", "OpenCode", "opencode"),
    ("gemini", "Gemini CLI", "gemini"),
    ("aider", "Aider", "aider"),
    ("codex", "Codex", "codex"),
    ("agy", "Antigravity", "agy"),
];

/// Pure: keep candidates whose `bin` exists in one of the PATH entries,
/// per the provided `exists` probe (so tests don't touch the filesystem).
fn detect(path: &str, exists: &dyn Fn(&std::path::Path) -> bool) -> Vec<AiCli> {
    let entries: Vec<&str> = path.split(':').filter(|s| !s.is_empty()).collect();
    CANDIDATES
        .iter()
        .filter(|(_, _, bin)| entries.iter().any(|dir| exists(&std::path::Path::new(dir).join(bin))))
        .map(|(id, label, bin)| AiCli { id: id.to_string(), label: label.to_string(), bin: bin.to_string() })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_only_present_bins() {
        let present = ["/opt/homebrew/bin/claude", "/usr/local/bin/agy"];
        let exists = |p: &std::path::Path| present.contains(&p.to_string_lossy().as_ref());
        let got = detect("/opt/homebrew/bin:/usr/local/bin", &exists);
        let ids: Vec<&str> = got.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["claude", "agy"]);
    }
}

/// List AI coding CLIs found on the user's login-shell PATH. Reuses the LSP
/// module's cached login PATH so Homebrew / npm-global / ~/.local/bin installs
/// resolve even when the app was launched from Finder.
#[tauri::command]
pub fn list_ai_clis() -> Vec<AiCli> {
    let path = crate::lsp::login_path().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    detect(&path, &|p| p.is_file())
}
