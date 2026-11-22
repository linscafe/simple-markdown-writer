use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

use crate::sessions::Sessions;
use serde::Deserialize;
use tauri::Manager;

use super::file::{atomic_write, switch_document, InitialDoc};

#[derive(Debug, Clone, Deserialize)]
pub struct AssetMove {
    pub from: PathBuf,
    pub to: PathBuf,
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub from: PathBuf,
    pub to: PathBuf,
    pub overwrite: bool,
    pub copy: bool,
    pub content: Option<String>,
    pub assets: Option<AssetMove>,
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    let path = std::path::absolute(path).map_err(|error| error.to_string())?;
    if let Ok(existing) = path.canonicalize() {
        return Ok(existing);
    }
    if let (Some(directory), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = directory.canonicalize() {
            return Ok(parent.join(name));
        }
    }
    Ok(path)
}

fn exists(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map_err(|error| format!("Cannot inspect {}: {error}", path.display()))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn move_path(from: &Path, to: &Path) -> std::io::Result<()> {
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(error)
            if error.kind() == ErrorKind::CrossesDevices || (from.is_dir() && to.is_dir()) =>
        {
            if from.is_dir() {
                copy_dir(from, to)?;
                fs::remove_dir_all(from)
            } else {
                fs::copy(from, to)?;
                fs::remove_file(from)
            }
        }
        Err(error) => Err(error),
    }
}

fn relocate(request: &RenameRequest) -> Result<PathBuf, String> {
    let from = absolute(&request.from)?;
    let to = absolute(&request.to)?;
    if from == to {
        return Err("Target is the current document".into());
    }
    if to.is_dir() {
        return Err(format!("{} is a directory", to.display()));
    }
    if !request.overwrite && exists(&to)? {
        return Err(format!(
            "{} already exists (add ! to overwrite)",
            to.display()
        ));
    }
    let assets = match &request.assets {
        Some(assets) => {
            let moving = AssetMove {
                from: absolute(&assets.from)?,
                to: absolute(&assets.to)?,
            };
            if !moving.from.is_dir() {
                return Err(format!("{} is not a directory", moving.from.display()));
            }
            if moving.to.starts_with(&moving.from) || moving.from.starts_with(&moving.to) {
                return Err("Asset directories overlap".into());
            }
            let existed = exists(&moving.to)?;
            if existed && !request.overwrite {
                return Err(format!(
                    "{} already exists (add ! to overwrite)",
                    moving.to.display()
                ));
            }
            Some((moving, existed))
        }
        None => None,
    };
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    }
    if let Some((assets, _)) = &assets {
        let result = if request.copy {
            copy_dir(&assets.from, &assets.to)
        } else {
            move_path(&assets.from, &assets.to)
        };
        result.map_err(|error| {
            format!(
                "Cannot {} {}: {error}",
                if request.copy { "copy" } else { "move" },
                assets.from.display()
            )
        })?;
    }
    let result = if request.copy || !exists(&from)? {
        let content = match &request.content {
            Some(content) => Ok(content.clone()),
            None if request.copy => fs::read_to_string(&from)
                .map_err(|error| format!("Cannot read {}: {error}", from.display())),
            None => Ok(String::new()),
        };
        content.and_then(|content| atomic_write(&to, &content))
    } else {
        move_path(&from, &to)
            .map_err(|error| format!("Cannot rename {}: {error}", from.display()))
            .and_then(|()| match &request.content {
                Some(content) => atomic_write(&to, content).inspect_err(|_| {
                    let _ = move_path(&to, &from);
                }),
                None => Ok(()),
            })
    };
    if let Err(error) = result {
        if let Some((assets, false)) = &assets {
            let _ = if request.copy {
                fs::remove_dir_all(&assets.to)
            } else {
                move_path(&assets.to, &assets.from)
            };
        }
        return Err(error);
    }
    absolute(&to)
}

#[tauri::command]
pub async fn rename_document(
    window: tauri::WebviewWindow,
    request: RenameRequest,
) -> Result<InitialDoc, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = window.state::<Sessions>();
        let _ownership = sessions.changing_paths.lock().unwrap();
        let current = sessions.with(window.label(), |s| Ok(s.document()?.document.path.clone()))?;
        if current != absolute(&request.from)? {
            return Err("Document has changed".into());
        }
        if sessions
            .find(&absolute(&request.to)?)
            .is_some_and(|label| label != window.label())
        {
            return Err("Target is open in another window".into());
        }
        let target = relocate(&request)?;
        switch_document(&window, &sessions, &target)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn check_paths(paths: &[PathBuf]) -> Vec<bool> {
    paths
        .iter()
        .map(|path| path.try_exists().unwrap_or(false))
        .collect()
}

#[tauri::command]
pub async fn paths_exist(paths: Vec<PathBuf>) -> Result<Vec<bool>, String> {
    tauri::async_runtime::spawn_blocking(move || check_paths(&paths))
        .await
        .map_err(|error| error.to_string())
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("Cannot list {}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            collect_files(root, &path, files)?;
            continue;
        }
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let parts: Option<Vec<&str>> = relative
            .components()
            .map(|component| component.as_os_str().to_str())
            .collect();
        files.push(parts.ok_or("Filename is not valid UTF-8")?.join("/"));
    }
    Ok(())
}

fn list_tree(directory: &Path) -> Result<Option<Vec<String>>, String> {
    if !directory.is_dir() {
        return Ok(None);
    }
    let mut files = Vec::new();
    collect_files(directory, directory, &mut files)?;
    files.sort();
    Ok(Some(files))
}

#[tauri::command]
pub async fn list_files(dir: PathBuf) -> Result<Option<Vec<String>>, String> {
    tauri::async_runtime::spawn_blocking(move || list_tree(&dir))
        .await
        .map_err(|error| error.to_string())?
}

fn remove_files(paths: &[PathBuf]) -> Result<(), String> {
    let failures: Vec<String> = paths
        .iter()
        .filter_map(|path| {
            fs::remove_file(path)
                .err()
                .map(|error| format!("{}: {error}", path.display()))
        })
        .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("Cannot delete {}", failures.join(", ")))
    }
}

#[tauri::command]
pub async fn delete_files(paths: Vec<PathBuf>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_files(&paths))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_rename_targets_match_open_documents_through_a_directory_alias() {
        let temp = tempfile::tempdir().unwrap();
        let alias = temp.path().join("alias");
        std::os::unix::fs::symlink(temp.path(), &alias).unwrap();
        let path = temp.path().join("new.md");
        assert_eq!(absolute(&alias.join("new.md")).unwrap(), path);
    }

    fn request(from: &Path, to: &Path, copy: bool) -> RenameRequest {
        RenameRequest {
            from: from.into(),
            to: to.into(),
            overwrite: false,
            copy,
            content: None,
            assets: None,
        }
    }

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let document = temp.path().join("notes.md");
        fs::write(&document, "![](notes.assets/a.png)").unwrap();
        fs::create_dir_all(temp.path().join("notes.assets/sub")).unwrap();
        fs::write(temp.path().join("notes.assets/a.png"), "a").unwrap();
        fs::write(temp.path().join("notes.assets/sub/b.png"), "b").unwrap();
        (temp, document)
    }

    #[test]
    fn rename_across_directories_moves_assets_and_writes_content() {
        let (temp, document) = fixture();
        let target = temp.path().join("archive/new.md");
        let mut rename = request(&document, &target, false);
        rename.content = Some("![](new.assets/a.png)".into());
        rename.assets = Some(AssetMove {
            from: temp.path().join("notes.assets"),
            to: temp.path().join("archive/new.assets"),
        });
        let result = relocate(&rename).unwrap();
        assert_eq!(result, target.canonicalize().unwrap());
        assert!(!document.exists());
        assert!(!temp.path().join("notes.assets").exists());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "![](new.assets/a.png)"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("archive/new.assets/sub/b.png")).unwrap(),
            "b"
        );
    }

    #[test]
    fn save_as_copies_document_and_assets_leaving_originals() {
        let (temp, document) = fixture();
        let target = temp.path().join("other/copy.md");
        let mut save = request(&document, &target, true);
        save.content = Some("buffer".into());
        save.assets = Some(AssetMove {
            from: temp.path().join("notes.assets"),
            to: temp.path().join("other/copy.assets"),
        });
        relocate(&save).unwrap();
        assert_eq!(
            fs::read_to_string(&document).unwrap(),
            "![](notes.assets/a.png)"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "buffer");
        assert!(temp.path().join("notes.assets/sub/b.png").exists());
        assert!(temp.path().join("other/copy.assets/sub/b.png").exists());
    }

    #[test]
    fn existing_target_is_refused_without_overwrite() {
        let (temp, document) = fixture();
        let target = temp.path().join("taken.md");
        fs::write(&target, "keep").unwrap();
        let mut rename = request(&document, &target, false);
        assert!(relocate(&rename).unwrap_err().contains("already exists"));
        assert!(document.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep");
        rename.overwrite = true;
        relocate(&rename).unwrap();
        assert!(!document.exists());
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "![](notes.assets/a.png)"
        );
        assert!(relocate(&request(&target, &target, false)).is_err());
    }

    #[test]
    fn existing_asset_target_is_refused_without_overwrite() {
        let (temp, document) = fixture();
        fs::create_dir(temp.path().join("new.assets")).unwrap();
        let mut rename = request(&document, &temp.path().join("new.md"), false);
        rename.assets = Some(AssetMove {
            from: temp.path().join("notes.assets"),
            to: temp.path().join("new.assets"),
        });
        assert!(relocate(&rename).is_err());
        assert!(document.exists());
        assert!(temp.path().join("notes.assets/a.png").exists());
    }

    #[test]
    fn unsaved_document_is_written_at_target() {
        let temp = tempfile::tempdir().unwrap();
        let mut rename = request(
            &temp.path().join("missing.md"),
            &temp.path().join("new.md"),
            false,
        );
        rename.content = Some("draft".into());
        relocate(&rename).unwrap();
        assert_eq!(
            fs::read_to_string(temp.path().join("new.md")).unwrap(),
            "draft"
        );
    }

    #[test]
    fn batch_existence_check_and_recursive_listing() {
        let (temp, document) = fixture();
        assert_eq!(
            check_paths(&[
                document.clone(),
                temp.path().join("notes.assets"),
                temp.path().join("missing.png"),
            ]),
            vec![true, true, false]
        );
        fs::write(temp.path().join("notes.assets/.hidden"), "").unwrap();
        assert_eq!(
            list_tree(&temp.path().join("notes.assets")).unwrap(),
            Some(vec!["a.png".into(), "sub/b.png".into()])
        );
        assert_eq!(list_tree(&temp.path().join("none")).unwrap(), None);
        remove_files(&[temp.path().join("notes.assets/a.png")]).unwrap();
        assert!(!temp.path().join("notes.assets/a.png").exists());
        assert!(remove_files(&[temp.path().join("missing.png")]).is_err());
    }
}
