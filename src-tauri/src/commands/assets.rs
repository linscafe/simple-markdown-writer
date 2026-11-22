use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use chrono::Local;
use sha2::{Digest, Sha256};

use super::fs::{document_dir, markdown_path};

const TEMPORARY_PREFIX: &str = ".mdw-asset-";

fn asset_directory(doc_path: &Path, pattern: Option<&str>) -> Result<PathBuf, String> {
    let name = doc_path
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or("Invalid document name")?;
    let expanded = pattern.unwrap_or("{name}.assets").replace("{name}", name);
    if expanded.is_empty() || Path::new(&expanded).is_absolute() {
        return Err("Image directory pattern must be a nonempty relative path".into());
    }
    let directory = document_dir(doc_path)?.join(expanded);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
    directory.canonicalize().map_err(|error| error.to_string())
}

fn sanitized_filename(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim_end_matches([' ', '.']);
    if sanitized.is_empty() {
        return "image".into();
    }
    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return format!("_{sanitized}");
    }
    sanitized.into()
}

fn save_asset(directory: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let hash = Sha256::digest(bytes);
    let mut entries = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(TEMPORARY_PREFIX)
        {
            continue;
        }
        let path = entry.path();
        if path.is_file()
            && entry.metadata().map_err(|error| error.to_string())?.len() == bytes.len() as u64
        {
            let existing = fs::read(&path).map_err(|error| error.to_string())?;
            if Sha256::digest(&existing) == hash {
                return Ok(path);
            }
        }
    }

    let mut temporary = tempfile::Builder::new()
        .prefix(TEMPORARY_PREFIX)
        .tempfile_in(directory)
        .map_err(|error| error.to_string())?;
    temporary
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let filename_path = Path::new(filename);
    let stem = filename_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("Invalid image filename")?;
    let extension = filename_path.extension().and_then(|ext| ext.to_str());
    for suffix in 0u64.. {
        let name = if suffix == 0 {
            filename.into()
        } else {
            match extension {
                Some(extension) => format!("{stem}-{suffix}.{extension}"),
                None => format!("{stem}-{suffix}"),
            }
        };
        let target = directory.join(name);
        match temporary.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temporary = error.file;
                if target.is_file() {
                    let existing = fs::read(&target).map_err(|error| error.to_string())?;
                    if Sha256::digest(&existing) == hash {
                        return Ok(target);
                    }
                }
            }
            Err(error) => return Err(format!("Cannot save {}: {}", target.display(), error.error)),
        }
    }
    Err("Image filename suffix exhausted".into())
}

fn save_bytes(
    doc_path: &Path,
    bytes: &[u8],
    ext: &str,
    pattern: Option<&str>,
) -> Result<String, String> {
    let ext = ext.trim_start_matches('.');
    if ext.is_empty()
        || !ext
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("Image extension must contain only letters and numbers".into());
    }
    let filename = format!(
        "image-{}.{}",
        Local::now().format("%Y%m%d-%H%M%S"),
        ext.to_ascii_lowercase()
    );
    let directory = asset_directory(doc_path, pattern)?;
    let target = save_asset(&directory, &filename, bytes)?;
    markdown_path(&document_dir(doc_path)?, &target)
}

fn save_file(
    doc_path: &Path,
    src_path: &Path,
    copy: bool,
    pattern: Option<&str>,
) -> Result<String, String> {
    let source = src_path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve {}: {error}", src_path.display()))?;
    if !source.is_file() {
        return Err("Image source must be a file".into());
    }
    let directory = document_dir(doc_path)?;
    if !copy {
        return markdown_path(&directory, &source);
    }
    let filename = src_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid image filename")?;
    let bytes =
        fs::read(&source).map_err(|error| format!("Cannot read {}: {error}", source.display()))?;
    let target = save_asset(
        &asset_directory(doc_path, pattern)?,
        &sanitized_filename(filename),
        &bytes,
    )?;
    markdown_path(&directory, &target)
}

fn image_request(
    body: &tauri::ipc::InvokeBody,
    headers: &tauri::http::HeaderMap,
) -> Result<(PathBuf, Vec<u8>, String, String), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = body else {
        return Err("Expected a raw binary image body".into());
    };
    let header = |name: &str| -> Result<String, String> {
        let value = headers
            .get(name)
            .ok_or_else(|| format!("Missing {name} header"))?
            .to_str()
            .map_err(|error| error.to_string())?;
        if value.as_bytes().iter().enumerate().any(|(index, byte)| {
            *byte == b'%'
                && (index + 2 >= value.len()
                    || !value.as_bytes()[index + 1..index + 3]
                        .iter()
                        .all(u8::is_ascii_hexdigit))
        }) {
            return Err(format!("Invalid percent encoding in {name}"));
        }
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|value| value.into_owned())
            .map_err(|error| error.to_string())
    };
    let doc_path = header("x-doc-path")?;
    let ext = header("x-ext")?;
    let pattern = header("x-pattern")?;
    if doc_path.is_empty() || ext.is_empty() || pattern.is_empty() {
        return Err("Image headers must not be empty".into());
    }
    Ok((PathBuf::from(doc_path), bytes.clone(), ext, pattern))
}

#[tauri::command]
pub async fn save_image_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let (doc_path, bytes, ext, pattern) = image_request(request.body(), request.headers())?;
    tauri::async_runtime::spawn_blocking(move || {
        save_bytes(&doc_path, &bytes, &ext, Some(&pattern))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_image_file(
    doc_path: PathBuf,
    src_path: PathBuf,
    copy: bool,
    pattern: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_file(&doc_path, &src_path, copy, pattern.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_image_body_requires_and_decodes_headers() {
        use tauri::{http::HeaderMap, ipc::InvokeBody};
        let mut headers = HeaderMap::new();
        let body = InvokeBody::Raw(vec![0, 255, 42]);
        assert!(image_request(&body, &headers).is_err());
        headers.insert(
            "x-doc-path",
            "%2Fnotes%2Fmy%20%E7%AD%86%E8%A8%98.md".parse().unwrap(),
        );
        headers.insert("x-ext", "png".parse().unwrap());
        headers.insert("x-pattern", "%7Bname%7D.assets".parse().unwrap());
        let (path, bytes, ext, pattern) = image_request(&body, &headers).unwrap();
        assert_eq!(path, PathBuf::from("/notes/my 筆記.md"));
        assert_eq!(bytes, vec![0, 255, 42]);
        assert_eq!(ext, "png");
        assert_eq!(pattern, "{name}.assets");
        assert!(image_request(&InvokeBody::Json(serde_json::json!([0, 255])), &headers).is_err());
        for invalid in ["%FF", "%ZZ", "%", ""] {
            headers.insert("x-doc-path", invalid.parse().unwrap());
            assert!(image_request(&body, &headers).is_err());
        }
    }

    #[test]
    fn bytes_create_default_directory_and_timestamped_file_and_deduplicate() {
        let temp = tempfile::tempdir().unwrap();
        let doc = temp.path().join("notes.md");
        let relative = save_bytes(&doc, b"image", "png", None).unwrap();
        assert!(relative.starts_with("notes.assets/image-"));
        let name = Path::new(&relative).file_name().unwrap().to_str().unwrap();
        assert_eq!(name.len(), "image-YYYYMMDD-HHMMSS.png".len());
        assert!(name[6..14].chars().all(|c| c.is_ascii_digit()));
        assert!(name[15..21].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(fs::read(temp.path().join(&relative)).unwrap(), b"image");
        assert_eq!(save_bytes(&doc, b"image", "png", None).unwrap(), relative);
        assert_eq!(
            fs::read_dir(temp.path().join("notes.assets"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn collisions_increment_suffix_and_reuse_matching_content() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();
        assert_eq!(
            save_asset(directory, "a.png", b"first").unwrap(),
            directory.join("a.png")
        );
        assert_eq!(
            save_asset(directory, "a.png", b"second").unwrap(),
            directory.join("a-1.png")
        );
        assert_eq!(
            save_asset(directory, "a.png", b"third").unwrap(),
            directory.join("a-2.png")
        );
        assert_eq!(
            save_asset(directory, "a.png", b"second").unwrap(),
            directory.join("a-1.png")
        );
        assert_eq!(
            save_asset(directory, "different.png", b"first").unwrap(),
            directory.join("a.png")
        );
        assert_eq!(fs::read_dir(directory).unwrap().count(), 3);
    }

    #[test]
    fn file_copy_uses_pattern_sanitizes_name_and_encodes_markdown_paths() {
        let temp = tempfile::tempdir().unwrap();
        let doc = temp.path().join("my notes.md");
        let source = temp.path().join("a photo (1).png");
        fs::write(&source, "image").unwrap();
        let relative = save_file(&doc, &source, true, Some("images/{name}")).unwrap();
        assert_eq!(relative, "images/my%20notes/a%20photo%20%281%29.png");
        assert_eq!(
            fs::read(temp.path().join("images/my notes/a photo (1).png")).unwrap(),
            b"image"
        );
        assert!(source.exists());
        assert_eq!(sanitized_filename("bad:name?.png"), "bad_name_.png");
        assert_eq!(sanitized_filename("CON.png"), "_CON.png");
        assert_eq!(sanitized_filename(".."), "image");
    }

    #[test]
    fn linking_across_directories_does_not_create_assets() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("docs")).unwrap();
        fs::create_dir(temp.path().join("pictures")).unwrap();
        let doc = temp.path().join("docs/notes.md");
        let source = temp.path().join("pictures/photo (1).png");
        fs::write(&source, "image").unwrap();
        assert_eq!(
            save_file(&doc, &source, false, None).unwrap(),
            "../pictures/photo%20%281%29.png"
        );
        assert!(!temp.path().join("docs/notes.assets").exists());
        assert_eq!(fs::read_dir(temp.path().join("docs")).unwrap().count(), 0);
    }

    #[test]
    fn invalid_extensions_and_absolute_patterns_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let doc = temp.path().join("notes.md");
        assert!(save_bytes(&doc, b"image", "../png", None).is_err());
        assert!(save_bytes(&doc, b"image", "", None).is_err());
        assert!(save_bytes(&doc, b"image", "png", Some(temp.path().to_str().unwrap())).is_err());
        assert!(save_bytes(&doc, b"image", "png", Some("")).is_err());
    }

    #[test]
    fn deduplication_never_links_to_an_uncommitted_temporary_file() {
        let temp = tempfile::tempdir().unwrap();
        let mut pending = tempfile::Builder::new()
            .prefix(TEMPORARY_PREFIX)
            .tempfile_in(temp.path())
            .unwrap();
        pending.write_all(b"image").unwrap();
        let target = save_asset(temp.path(), "a.png", b"image").unwrap();
        drop(pending);
        assert_eq!(target, temp.path().join("a.png"));
        assert_eq!(fs::read(target).unwrap(), b"image");
    }
}
