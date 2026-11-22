use std::{
    fs,
    path::{Path, PathBuf},
};

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;

const MARKDOWN_PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'(')
    .add(b')')
    .add(b'%')
    .add(b'#')
    .add(b'?')
    .add(b'[')
    .add(b']')
    .add(b'<')
    .add(b'>')
    .add(b'"')
    .add(b'`')
    .add(b'\\');

pub(super) fn document_dir(doc_path: &Path) -> Result<PathBuf, String> {
    let path = std::path::absolute(doc_path).map_err(|error| error.to_string())?;
    let parent = path.parent().ok_or("Document has no parent directory")?;
    Ok(parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf()))
}

fn resolve_relative(doc_path: &Path, relative: &str) -> Result<PathBuf, String> {
    let decoded = percent_decode_str(relative)
        .decode_utf8()
        .map_err(|error| error.to_string())?;
    let path = Path::new(decoded.as_ref());
    if path.is_absolute() {
        return Err("Expected a relative path".into());
    }
    Ok(document_dir(doc_path)?.join(path))
}

pub(super) fn markdown_path(directory: &Path, target: &Path) -> Result<String, String> {
    let relative = pathdiff::diff_paths(target, directory)
        .ok_or("Cannot make a relative path between these locations")?;
    let relative = relative.to_str().ok_or("Path is not valid UTF-8")?;
    #[cfg(windows)]
    let normalized = relative.replace('\\', "/");
    #[cfg(windows)]
    let relative = normalized.as_str();
    Ok(utf8_percent_encode(relative, MARKDOWN_PATH).to_string())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn list_dir(doc_path: PathBuf, rel_dir: String) -> Result<Vec<DirectoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_directory(&doc_path, &rel_dir))
        .await
        .map_err(|error| error.to_string())?
}

fn list_directory(doc_path: &Path, rel_dir: &str) -> Result<Vec<DirectoryEntry>, String> {
    let directory = resolve_relative(doc_path, rel_dir)?;
    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("Cannot list {}: {error}", directory.display()))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Filename is not valid UTF-8")?;
        if name.starts_with('.') {
            continue;
        }
        result.push(DirectoryEntry {
            name,
            is_dir: entry.path().is_dir(),
        });
    }
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    result.truncate(500);
    Ok(result)
}

#[tauri::command]
pub async fn path_exists(doc_path: PathBuf, rel: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_relative(&doc_path, &rel)?
            .try_exists()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_external_url(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err("Only http, https, and mailto URLs may be opened".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_listing_hides_dotfiles_and_sorts_directories_first() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["z-dir", "b-dir", ".hidden-dir"] {
            fs::create_dir(temp.path().join(name)).unwrap();
        }
        for name in ["z.md", "a.md", ".hidden"] {
            fs::write(temp.path().join(name), "").unwrap();
        }
        let entries = list_directory(&temp.path().join("note.md"), "").unwrap();
        assert_eq!(
            entries,
            vec![
                DirectoryEntry {
                    name: "b-dir".into(),
                    is_dir: true
                },
                DirectoryEntry {
                    name: "z-dir".into(),
                    is_dir: true
                },
                DirectoryEntry {
                    name: "a.md".into(),
                    is_dir: false
                },
                DirectoryEntry {
                    name: "z.md".into(),
                    is_dir: false
                },
            ]
        );
    }

    #[test]
    fn directory_limit_is_applied_after_sorting() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..505 {
            fs::write(temp.path().join(format!("{index:03}.md")), "").unwrap();
        }
        fs::create_dir(temp.path().join("z-dir")).unwrap();
        let entries = list_directory(&temp.path().join("note.md"), ".").unwrap();
        assert_eq!(entries.len(), 500);
        assert_eq!(entries[0].name, "z-dir");
        assert_eq!(entries[499].name, "498.md");
    }

    #[test]
    fn encoded_markdown_paths_resolve_for_existence_and_listing() {
        let temp = tempfile::tempdir().unwrap();
        let document = temp.path().join("note.md");
        fs::create_dir(temp.path().join("assets (1)")).unwrap();
        fs::write(temp.path().join("assets (1)/a #%.png"), "image").unwrap();
        let path = resolve_relative(&document, "assets%20%281%29/a%20%23%25.png").unwrap();
        assert!(path.try_exists().unwrap());
        assert!(!resolve_relative(&document, "missing")
            .unwrap()
            .try_exists()
            .unwrap());
        assert_eq!(
            list_directory(&document, "assets%20%281%29").unwrap()[0].name,
            "a #%.png"
        );
    }

    #[test]
    fn external_urls_allow_only_web_and_email_schemes() {
        for url in [
            "https://example.com/a",
            "http://example.com",
            "mailto:a@example.com",
            "HTTPS://example.com",
        ] {
            assert!(validate_external_url(url).is_ok(), "{url}");
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/plain,hello",
            "ftp://example.com",
            "relative.md",
            "",
        ] {
            assert!(validate_external_url(url).is_err(), "{url}");
        }
    }
}
