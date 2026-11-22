use std::{
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};

const DEBOUNCE: Duration = Duration::from_millis(150);

struct ContentHash([u8; 32]);

impl ContentHash {
    fn new(content: &str) -> Self {
        Self(Sha256::digest(content.as_bytes()).into())
    }

    fn changed_on_disk(&mut self, content: &str) -> bool {
        let hash = Self::new(content);
        if self.0 == hash.0 {
            return false;
        }
        *self = hash;
        true
    }
}

#[derive(Clone)]
pub struct DocumentWrites {
    path: PathBuf,
    hash: Arc<Mutex<ContentHash>>,
}

impl DocumentWrites {
    pub fn write(
        &self,
        path: &Path,
        content: &str,
        save: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
        let absolute = absolute.canonicalize().unwrap_or(absolute);
        if absolute != self.path {
            return save();
        }
        // Serialize the write and hash update with the watcher's disk read.
        let mut hash = self.hash.lock().map_err(|error| error.to_string())?;
        save()?;
        *hash = ContentHash::new(content);
        Ok(())
    }
}

pub struct DocumentWatcher {
    _watcher: RecommendedWatcher,
    pub writes: DocumentWrites,
}

fn affects_document(event: &Event, path: &Path) -> bool {
    !matches!(event.kind, EventKind::Access(_))
        && event.paths.iter().any(|changed| {
            changed.file_name() == path.file_name() && changed.parent() == path.parent()
        })
}

impl DocumentWatcher {
    pub fn start(
        path: PathBuf,
        content: &str,
        on_change: impl Fn(String) + Send + 'static,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|error| error.to_string())?;
        let parent = path.parent().ok_or("Document has no parent directory")?;
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(|error| error.to_string())?;

        let writes = DocumentWrites {
            path: path.clone(),
            hash: Arc::new(Mutex::new(ContentHash::new(content))),
        };
        let hash = Arc::clone(&writes.hash);
        std::thread::Builder::new()
            .name("mdw-file-watcher".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    match event {
                        Ok(event) if affects_document(&event, &path) => {}
                        Ok(_) => continue,
                        Err(error) => {
                            eprintln!("Cannot watch {}: {error}", path.display());
                            continue;
                        }
                    }
                    let mut deadline = Instant::now() + DEBOUNCE;
                    loop {
                        match receiver
                            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                        {
                            Ok(Ok(event)) if affects_document(&event, &path) => {
                                deadline = Instant::now() + DEBOUNCE
                            }
                            Ok(_) => {}
                            Err(mpsc::RecvTimeoutError::Timeout) => break,
                            Err(mpsc::RecvTimeoutError::Disconnected) => return,
                        }
                    }
                    let Ok(mut hash) = hash.lock() else { return };
                    match fs::read_to_string(&path) {
                        Ok(content) if hash.changed_on_disk(&content) => on_change(content),
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => eprintln!("Cannot reload {}: {error}", path.display()),
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            _watcher: watcher,
            writes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_check_ignores_self_writes_and_duplicate_notifications() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let writes = DocumentWrites {
            path: path.clone(),
            hash: Arc::new(Mutex::new(ContentHash::new("initial"))),
        };
        assert!(!writes.hash.lock().unwrap().changed_on_disk("initial"));
        writes.write(&path, "saved", || Ok(())).unwrap();
        let mut hash = writes.hash.lock().unwrap();
        assert!(!hash.changed_on_disk("saved"));
        assert!(!hash.changed_on_disk("saved"));
        assert!(hash.changed_on_disk("external"));
        assert!(!hash.changed_on_disk("external"));
        assert!(hash.changed_on_disk("saved"));
    }

    #[test]
    fn failed_and_unrelated_writes_do_not_suppress_external_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        let writes = DocumentWrites {
            path: path.clone(),
            hash: Arc::new(Mutex::new(ContentHash::new("initial"))),
        };
        assert!(writes
            .write(&path, "failed", || Err("disk full".into()))
            .is_err());
        assert!(writes.hash.lock().unwrap().changed_on_disk("failed"));
        writes
            .write(&temp.path().join("other.md"), "other", || Ok(()))
            .unwrap();
        assert!(writes.hash.lock().unwrap().changed_on_disk("other"));
    }

    #[test]
    fn event_filter_accepts_rename_targets_but_ignores_other_files_and_reads() {
        use notify::event::{AccessKind, ModifyKind, RenameMode};
        let path = Path::new("/notes/note.md");
        let rename = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
            .add_path("/notes/.temporary".into())
            .add_path(path.into());
        assert!(affects_document(&rename, path));
        assert!(!affects_document(
            &Event::new(EventKind::Create(notify::event::CreateKind::File))
                .add_path("/notes/other.md".into()),
            path
        ));
        assert!(!affects_document(
            &Event::new(EventKind::Access(AccessKind::Read)).add_path(path.into()),
            path
        ));
    }

    #[test]
    fn watcher_reads_external_edits_and_replacements_and_ignores_own_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("note.md");
        fs::write(&path, "initial").unwrap();
        let (sender, receiver) = mpsc::channel();
        let watcher = DocumentWatcher::start(path.clone(), "initial", move |content| {
            sender.send(content).unwrap();
        })
        .unwrap();
        watcher
            .writes
            .write(&path, "saved", || {
                fs::write(&path, "saved").map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(matches!(
            receiver.recv_timeout(DEBOUNCE * 3),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        fs::write(&path, "external").unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
            "external"
        );
        for content in ["replacement", "next replacement"] {
            let replacement = temp.path().join(".replacement");
            fs::write(&replacement, content).unwrap();
            fs::rename(replacement, &path).unwrap();
            assert_eq!(
                receiver.recv_timeout(Duration::from_secs(3)).unwrap(),
                content
            );
        }
    }
}
