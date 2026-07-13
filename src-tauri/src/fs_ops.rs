use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use std::fs;
use std::path::Path;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next"];

pub fn list_files_inner(root: &Path, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= max {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= max {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
pub fn list_files_recursive(root: String, max: Option<usize>) -> Result<Vec<String>, String> {
    Ok(list_files_inner(Path::new(&root), max.unwrap_or(5000)))
}

// Skip files larger than this when searching contents (keeps search snappy).
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

/// Recursively search file *contents* for `query` (case-insensitive), skipping
/// ignored dirs and binary/large files. Returns matching relative file paths.
pub fn search_contents_inner(root: &Path, query: &str, max: usize) -> Vec<String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= max {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= max {
                break;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ft.is_file() {
                let path = entry.path();
                let Ok(meta) = fs::metadata(&path) else { continue };
                if meta.len() > MAX_SEARCH_FILE_BYTES {
                    continue;
                }
                let Ok(bytes) = fs::read(&path) else { continue };
                if bytes.contains(&0) {
                    continue; // skip binary files
                }
                let Ok(text) = String::from_utf8(bytes) else { continue };
                if text.to_lowercase().contains(&needle) {
                    if let Ok(rel) = path.strip_prefix(root) {
                        out.push(rel.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
pub fn search_file_contents(
    root: String,
    query: String,
    max: Option<usize>,
) -> Result<Vec<String>, String> {
    Ok(search_contents_inner(Path::new(&root), &query, max.unwrap_or(500)))
}

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

pub fn write_file_inner(path: &Path, contents: &str) -> Result<(), String> {
    fs::write(path, contents).map_err(|e| e.to_string())
}

pub fn create_file_inner(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, "").map_err(|e| e.to_string())
}

pub fn create_dir_inner(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Err(format!("{} already exists", path.display()));
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn rename_path_inner(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}

pub fn delete_path_inner(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    write_file_inner(Path::new(&path), &contents)
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    create_file_inner(Path::new(&path))
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    create_dir_inner(Path::new(&path))
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    rename_path_inner(Path::new(&from), Path::new(&to))
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    delete_path_inner(Path::new(&path))
}

const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

pub fn read_image_base64_inner(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("too_large".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    Ok(STANDARD.encode(&bytes))
}

#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    read_image_base64_inner(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn write_then_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("f.txt");
        write_file_inner(&p, "abc").unwrap();
        assert_eq!(read_file_inner(&p).unwrap().content.as_deref(), Some("abc"));
    }

    #[test]
    fn create_file_fails_if_exists_and_makes_parents() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("nested/dir/new.txt");
        create_file_inner(&p).unwrap();
        assert!(p.exists());
        assert!(create_file_inner(&p).is_err());
    }

    #[test]
    fn create_dir_fails_if_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("d");
        create_dir_inner(&p).unwrap();
        assert!(p.is_dir());
        assert!(create_dir_inner(&p).is_err());
    }

    #[test]
    fn rename_refuses_to_overwrite() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a.txt");
        let b = tmp.path().join("b.txt");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        assert!(rename_path_inner(&a, &b).is_err());
        let c = tmp.path().join("c.txt");
        rename_path_inner(&a, &c).unwrap();
        assert!(c.exists() && !a.exists());
    }

    #[test]
    fn delete_removes_files_and_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f.txt");
        fs::write(&f, "x").unwrap();
        delete_path_inner(&f).unwrap();
        assert!(!f.exists());
        let d = tmp.path().join("d");
        fs::create_dir(&d).unwrap();
        fs::write(d.join("inner.txt"), "y").unwrap();
        delete_path_inner(&d).unwrap();
        assert!(!d.exists());
    }

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

    #[test]
    fn list_files_recursive_skips_ignored_dirs_and_caps() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src/deep")).unwrap();
        fs::create_dir_all(tmp.path().join("node_modules/pkg")).unwrap();
        fs::write(tmp.path().join("src/deep/a.rs"), "x").unwrap();
        fs::write(tmp.path().join("top.txt"), "x").unwrap();
        fs::write(tmp.path().join("node_modules/pkg/skip.js"), "x").unwrap();
        let files = list_files_inner(tmp.path(), 100);
        assert_eq!(files, vec!["src/deep/a.rs", "top.txt"]);
        let capped = list_files_inner(tmp.path(), 1);
        assert_eq!(capped.len(), 1);
    }

    #[test]
    fn read_image_base64_roundtrip_and_size_limit() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};

        let tmp = tempfile::tempdir().unwrap();

        // Small file: encode then decode back to original bytes.
        let p = tmp.path().join("img.png");
        let original = vec![137u8, 80, 78, 71, 13, 10, 26, 10]; // PNG magic bytes
        fs::write(&p, &original).unwrap();
        let b64 = read_image_base64_inner(&p).unwrap();
        assert!(!b64.is_empty());
        let decoded = STANDARD.decode(&b64).unwrap();
        assert_eq!(decoded, original);

        // File exceeding 25 MB limit returns Err("too_large").
        let big = tmp.path().join("big.bin");
        fs::write(&big, vec![0u8; (MAX_IMAGE_BYTES + 1) as usize]).unwrap();
        let err = read_image_base64_inner(&big).unwrap_err();
        assert_eq!(err, "too_large");
    }

    #[test]
    fn search_contents_matches_text_skips_binary_and_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("src")).unwrap();
        fs::create_dir_all(tmp.path().join("node_modules")).unwrap();
        fs::write(tmp.path().join("src/a.ts"), "const needle = 1;").unwrap();
        fs::write(tmp.path().join("src/b.ts"), "no match here").unwrap();
        fs::write(tmp.path().join("bin.dat"), [0u8, b'n', b'e', b'e']).unwrap();
        fs::write(tmp.path().join("node_modules/skip.js"), "needle").unwrap();
        let hits = search_contents_inner(tmp.path(), "NEEDLE", 100);
        assert_eq!(hits, vec!["src/a.ts"]); // case-insensitive; binary + node_modules skipped
        assert!(search_contents_inner(tmp.path(), "", 100).is_empty());
    }
}
