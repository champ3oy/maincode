use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ReadFileResult {
    pub content: Option<String>,
    pub reason: Option<String>, // "binary" | "too_large"
}

pub fn read_dir_inner(path: &Path) -> Result<Vec<DirEntryInfo>, String> {
    let mut entries: Vec<DirEntryInfo> = fs::read_dir(path)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            Some(DirEntryInfo {
                path: entry.path().to_string_lossy().to_string(),
                name,
                is_dir,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub fn read_file_inner(path: &Path) -> Result<ReadFileResult, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Ok(ReadFileResult { content: None, reason: Some("too_large".into()) });
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.contains(&0) {
        return Ok(ReadFileResult { content: None, reason: Some("binary".into()) });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(ReadFileResult { content: Some(content), reason: None }),
        Err(_) => Ok(ReadFileResult { content: None, reason: Some("binary".into()) }),
    }
}

#[tauri::command]
pub fn read_dir(path: String) -> Result<Vec<DirEntryInfo>, String> {
    read_dir_inner(Path::new(&path))
}

#[tauri::command]
pub fn read_file(path: String) -> Result<ReadFileResult, String> {
    read_file_inner(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_dir_sorts_dirs_first_and_skips_git() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join(".git")).unwrap();
        fs::create_dir(tmp.path().join("src")).unwrap();
        fs::write(tmp.path().join("a.txt"), "a").unwrap();
        fs::write(tmp.path().join("B.txt"), "b").unwrap();
        let entries = read_dir_inner(tmp.path()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "a.txt", "B.txt"]);
        assert!(entries[0].is_dir);
    }

    #[test]
    fn read_file_returns_text_content() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.txt");
        fs::write(&p, "hello").unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content.as_deref(), Some("hello"));
        assert_eq!(r.reason, None);
    }

    #[test]
    fn read_file_flags_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.bin");
        fs::write(&p, [0u8, 159, 146, 150]).unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content, None);
        assert_eq!(r.reason.as_deref(), Some("binary"));
    }

    #[test]
    fn read_file_flags_too_large() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("big.txt");
        fs::write(&p, vec![b'x'; (MAX_FILE_BYTES + 1) as usize]).unwrap();
        let r = read_file_inner(&p).unwrap();
        assert_eq!(r.content, None);
        assert_eq!(r.reason.as_deref(), Some("too_large"));
    }
}
