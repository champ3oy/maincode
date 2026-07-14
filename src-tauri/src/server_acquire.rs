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
pub fn extract_gz(archive: &Path, dest_bin: &Path) -> Result<(), String> {
    let f = fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut gz = flate2::read::GzDecoder::new(f);
    if let Some(parent) = dest_bin.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = fs::File::create(dest_bin).map_err(|e| e.to_string())?;
    std::io::copy(&mut gz, &mut out).map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())?;
    set_executable(dest_bin)
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
        fs::remove_dir_all(&dir).ok();
    }
}
