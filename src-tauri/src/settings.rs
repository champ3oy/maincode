use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_SETTINGS: &str = r#"{
  "theme": "system",
  "editor": { "fontSize": 13, "fontFamily": "app-mono", "tabSize": 2, "wordWrap": false, "autocomplete": true, "linting": true },
  "terminal": { "fontSize": 12 },
  "diff": { "fontSize": 13, "fontFamily": "app-mono", "wordWrap": false }
}"#;

pub fn settings_file_path_inner(config_dir: &Path) -> PathBuf {
    config_dir.join("maincode").join("settings.json")
}

pub fn read_settings_inner(config_dir: &Path) -> Result<String, String> {
    let path = settings_file_path_inner(config_dir);
    if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        let dir = config_dir.join("maincode");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(&path, DEFAULT_SETTINGS).map_err(|e| e.to_string())?;
        Ok(DEFAULT_SETTINGS.to_string())
    }
}

pub fn write_settings_inner(config_dir: &Path, json: &str) -> Result<(), String> {
    let dir = config_dir.join("maincode");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = settings_file_path_inner(config_dir);
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn config_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(PathBuf::from(home).join(".config"))
}

#[tauri::command]
pub fn read_settings() -> Result<String, String> {
    read_settings_inner(&config_dir()?)
}

#[tauri::command]
pub fn write_settings(json: String) -> Result<(), String> {
    write_settings_inner(&config_dir()?, &json)
}

#[tauri::command]
pub fn settings_path() -> Result<String, String> {
    let path = settings_file_path_inner(&config_dir()?);
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_creates_defaults_when_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let result = read_settings_inner(tmp.path()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["theme"], "system");
        assert!(settings_file_path_inner(tmp.path()).exists());
    }

    #[test]
    fn write_then_read_roundtrips() {
        let tmp = tempfile::tempdir().unwrap();
        write_settings_inner(tmp.path(), "{\"theme\":\"dark\"}").unwrap();
        let result = read_settings_inner(tmp.path()).unwrap();
        assert_eq!(result, "{\"theme\":\"dark\"}");
    }
}
