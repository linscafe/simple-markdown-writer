use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use crate::sessions::Sessions;
use crate::watcher::DocumentWatcher;
use serde::Serialize;
use tauri::{Emitter, Manager};

pub struct DocumentSession {
    pub document: InitialDoc,
    pub watcher: DocumentWatcher,
}

pub fn allow_document_assets(app: &tauri::AppHandle, document: &InitialDoc) -> Result<(), String> {
    let directory = document.path.parent().ok_or("Document has no directory")?;
    app.asset_protocol_scope()
        .allow_directory(directory, true)
        .map_err(|error| format!("Cannot enable images in {}: {error}", directory.display()))
}

pub fn watch_document(
    app: &tauri::AppHandle,
    label: &str,
    document: &InitialDoc,
) -> Result<DocumentWatcher, String> {
    let handle = app.clone();
    let path = document.path.clone();
    let label = label.to_owned();
    DocumentWatcher::start(path.clone(), &document.content, move |content| {
        if let Err(error) = handle.emit_to(
            label.as_str(),
            "doc-changed-on-disk",
            InitialDoc {
                path: path.clone(),
                content,
            },
        ) {
            eprintln!("Cannot notify editor of disk change: {error}");
        }
    })
}

#[derive(Clone, Serialize)]
pub struct InitialDoc {
    pub path: PathBuf,
    pub content: String,
}

pub fn load_document(path: &Path) -> Result<InitialDoc, String> {
    let path = crate::client::resolve_path(path)?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => match path.parent() {
            Some(directory) if !directory.is_dir() => {
                return Err(format!("Directory does not exist: {}", directory.display()))
            }
            _ => String::new(),
        },
        Err(error) => return Err(format!("Cannot read {}: {error}", path.display())),
    };
    Ok(InitialDoc { path, content })
}

impl DocumentSession {
    pub fn load(app: &tauri::AppHandle, label: &str, path: &Path) -> Result<Self, String> {
        let document = load_document(path)?;
        allow_document_assets(app, &document)?;
        crate::timing::mark("document loaded");
        let watcher = watch_document(app, label, &document)?;
        crate::timing::mark("watcher started");
        Ok(Self { document, watcher })
    }
}

#[tauri::command]
pub fn get_initial_doc(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
) -> Result<InitialDoc, String> {
    sessions.with(window.label(), |s| Ok(s.document()?.document.clone()))
}

#[tauri::command]
pub async fn open_document(
    window: tauri::WebviewWindow,
    path: PathBuf,
) -> Result<InitialDoc, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let sessions = window.state::<Sessions>();
        let _ownership = sessions.changing_paths.lock().unwrap();
        switch_document(&window, &sessions, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) fn switch_document(
    window: &tauri::WebviewWindow,
    sessions: &Sessions,
    path: &Path,
) -> Result<InitialDoc, String> {
    let session = DocumentSession::load(window.app_handle(), window.label(), path)?;
    let doc = session.document.clone();
    if let Some(label) = sessions.find(&doc.path).filter(|l| l != window.label()) {
        if let Some(existing) = window.app_handle().get_webview_window(&label) {
            existing.set_focus().map_err(|e| e.to_string())?;
        }
        return Err(format!("Already open: {}", doc.path.display()));
    }
    window
        .set_title(&doc.path.file_name().unwrap_or_default().to_string_lossy())
        .map_err(|e| e.to_string())?;
    sessions.with(window.label(), |s| {
        s.doc = Some(session);
        Ok(())
    })?;
    Ok(doc)
}

#[tauri::command]
pub async fn read_file(path: PathBuf) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_file(
    path: PathBuf,
    content: String,
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
) -> Result<(), String> {
    let writes = sessions.with(window.label(), |s| Ok(s.document()?.watcher.writes.clone()))?;
    tauri::async_runtime::spawn_blocking(move || {
        writes.write(&path, &content, || atomic_write(&path, &content))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(super) fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let directory = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let permissions = match fs::metadata(path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Cannot inspect {}: {error}", path.display())),
    };
    let mut builder = tempfile::Builder::new();
    builder.prefix(".mdw-save-");
    #[cfg(unix)]
    if permissions.is_none() {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o666));
    }
    let save = || -> std::io::Result<()> {
        let mut temporary = builder.tempfile_in(directory)?;
        temporary.write_all(content.as_bytes())?;
        if let Some(mode) = permissions {
            temporary.as_file().set_permissions(mode)?;
        }
        temporary.as_file().sync_all()?;
        temporary.persist(path)?;
        Ok(())
    };
    save().map_err(|error| format!("Cannot save {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdw-test-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn new_document_is_created_only_on_save_and_can_be_replaced() {
        let directory = TestDirectory::new();
        let path = directory.0.join("new.md");
        let document = load_document(&path).unwrap();
        assert!(document.path.is_absolute());
        assert_eq!(document.content, "");
        assert!(!path.exists());

        atomic_write(&path, "# First\n").unwrap();
        atomic_write(&path, "# Updated\n").unwrap();
        assert_eq!(load_document(&path).unwrap().content, "# Updated\n");
        assert!(!directory.0.join("new.md.mdw-tmp").exists());
    }

    #[test]
    fn document_in_missing_directory_is_rejected() {
        let directory = TestDirectory::new();
        let Err(error) = load_document(&directory.0.join("absent/new.md")) else {
            panic!("expected an error");
        };
        assert!(error.starts_with("Directory does not exist:"), "{error}");
    }

    #[test]
    fn stale_temporary_file_from_crash_does_not_block_saving() {
        let directory = TestDirectory::new();
        let path = directory.0.join("note.md");
        fs::write(&path, "original").unwrap();
        fs::write(
            directory.0.join("note.md.mdw-tmp"),
            "stale leftover that is longer",
        )
        .unwrap();

        atomic_write(&path, "replacement").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "replacement");
        assert_eq!(
            fs::read_to_string(directory.0.join("note.md.mdw-tmp")).unwrap(),
            "stale leftover that is longer"
        );
    }

    #[test]
    fn concurrent_saves_publish_complete_documents() {
        let directory = TestDirectory::new();
        let path = directory.0.join("shared.md");
        let texts: Vec<_> = (0..8)
            .map(|i| format!("writer {i}\n").repeat(16384))
            .collect();
        let barrier = std::sync::Barrier::new(texts.len());
        std::thread::scope(|scope| {
            for content in &texts {
                scope.spawn(|| {
                    barrier.wait();
                    atomic_write(&path, content).unwrap();
                    assert!(texts.contains(&fs::read_to_string(&path).unwrap()));
                });
            }
        });
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }
}
