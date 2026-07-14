use std::fs;
use std::io::Write;
use std::path::Path;

/// Download `url` to `dest` (streamed). Overwrites.
pub fn download(url: &str, dest: &Path) -> Result<(), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("download failed: {e}"))?;
    let mut reader = resp.into_reader();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = fs::File::create(dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
    Ok(())
}

/// gunzip a single-file `.gz` archive into `dest_bin`, marking it executable.
///
/// Decompresses into a temp sibling (`dest_bin.partial`) and only atomically
/// renames it onto `dest_bin` after the copy fully succeeds. A partial/failed
/// extract therefore never leaves a truncated binary at `dest_bin` (which would
/// poison the cache: the next ensure sees `exists()==true` and skips
/// re-download, so every spawn fails forever). Any error removes the temp file
/// first. `rename` within the same directory is atomic, so `dest_bin` only ever
/// exists complete. A fixed `.partial` name is safe because installs are
/// serialized per server id (see `install_locks` in lsp.rs); a stale `.partial`
/// from a prior crash is overwritten by the fresh `File::create`.
pub fn extract_gz(archive: &Path, dest_bin: &Path) -> Result<(), String> {
    if let Some(parent) = dest_bin.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest_bin.with_extension("partial");
    let result = (|| -> Result<(), String> {
        let f = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut gz = flate2::read::GzDecoder::new(f);
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        std::io::copy(&mut gz, &mut out).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        drop(out);
        // Set the exec bit on the temp file so `dest_bin` is executable the
        // instant it appears (no window where it exists but isn't +x).
        set_executable(&tmp)?;
        fs::rename(&tmp, dest_bin).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Extract a `.zip` into `dest_dir`, preserving entry paths + exec bits.
pub fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<(), String> {
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest_dir.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut w = fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            if entry.unix_mode().map(|m| m & 0o111 != 0).unwrap_or(false) {
                set_executable(&out)?;
            }
        }
    }
    Ok(())
}

fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_gz_roundtrips_a_binary() {
        let dir = std::env::temp_dir().join(format!("sa-gz-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let gz_path = dir.join("bin.gz");
        // gzip the bytes "HELLO"
        let mut enc = flate2::write::GzEncoder::new(fs::File::create(&gz_path).unwrap(), flate2::Compression::default());
        enc.write_all(b"HELLO").unwrap();
        enc.finish().unwrap();
        let out = dir.join("bin");
        extract_gz(&gz_path, &out).unwrap();
        assert_eq!(fs::read(&out).unwrap(), b"HELLO");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(fs::metadata(&out).unwrap().permissions().mode() & 0o111 != 0);
        }
        // The temp sibling used by the atomic rename must not linger.
        assert!(!out.with_extension("partial").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn extract_zip_confines_entries_and_sets_exec_bit() {
        use std::io::Cursor;
        use zip::write::SimpleFileOptions;

        // Build a small zip in-memory: (1) a normal exec file with a known
        // payload, (2) a zip-slip entry named `../escape.txt`.
        let mut cursor = Cursor::new(Vec::<u8>::new());
        {
            let mut zw = zip::ZipWriter::new(&mut cursor);
            let exec_opts = SimpleFileOptions::default().unix_permissions(0o755);
            zw.start_file("bin/tool", exec_opts).unwrap();
            zw.write_all(b"PAYLOAD").unwrap();
            let plain_opts = SimpleFileOptions::default().unix_permissions(0o644);
            zw.start_file("../escape.txt", plain_opts).unwrap();
            zw.write_all(b"PWNED").unwrap();
            zw.finish().unwrap();
        }
        let bytes = cursor.into_inner();

        // Hermetic temp layout: a parent dir with a `dest` subdir. `../escape.txt`
        // would land in the parent if confinement failed.
        let base = std::env::temp_dir().join(format!("sa-zip-{}", std::process::id()));
        fs::remove_dir_all(&base).ok();
        let parent = base.join("parent");
        let dest = parent.join("dest");
        fs::create_dir_all(&dest).unwrap();
        let archive = base.join("test.zip");
        fs::write(&archive, &bytes).unwrap();

        extract_zip(&archive, &dest).unwrap();

        // Normal entry landed inside dest with correct contents.
        let tool = dest.join("bin").join("tool");
        assert_eq!(fs::read(&tool).unwrap(), b"PAYLOAD");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert!(fs::metadata(&tool).unwrap().permissions().mode() & 0o111 != 0);
        }
        // The malicious `../escape.txt` was skipped (enclosed_name() → None), so
        // nothing was written outside dest.
        assert!(!parent.join("escape.txt").exists());
        assert!(!dest.join("escape.txt").exists());

        fs::remove_dir_all(&base).ok();
    }
}
