use crate::{
    commands::{
        config::{InitialSession, WindowState},
        file::DocumentSession,
    },
    protocol::Marks,
};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{mpsc::Sender, Mutex},
};

#[derive(Default)]
pub struct Startup {
    pub timing: bool,
    pub shown_at: Option<f64>,
    pub reply: Option<Sender<Result<Marks, String>>>,
    pub standalone_quit: bool,
    pub close_pending: bool,
}

#[derive(Default)]
pub struct Slot {
    pub doc: Option<DocumentSession>,
    pub initial: Option<InitialSession>,
    pub listening: bool,
    pub ready: bool,
    pub boot_error: Option<String>,
    pub bounds: Option<WindowState>,
    pub startup: Startup,
    pub stop: Option<(u64, Sender<Result<bool, String>>)>,
}

impl Slot {
    pub fn document(&self) -> Result<&DocumentSession, String> {
        self.doc
            .as_ref()
            .ok_or_else(|| "Window has no document yet".into())
    }
}

#[derive(Default)]
pub struct Sessions {
    slots: Mutex<BTreeMap<String, Slot>>,
    // Open, navigation and rename change ownership of paths. Only worker threads
    // take this lock; JS bootstrap and GTK lifecycle callbacks only need slots.
    pub changing_paths: Mutex<()>,
}

impl Sessions {
    pub fn insert(&self, label: &str, slot: Slot) {
        self.slots.lock().unwrap().insert(label.into(), slot);
    }

    pub fn remove(&self, label: &str) {
        self.slots.lock().unwrap().remove(label);
    }

    pub fn with<T>(
        &self,
        label: &str,
        f: impl FnOnce(&mut Slot) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut slots = self.slots.lock().unwrap();
        f(slots
            .get_mut(label)
            .ok_or_else(|| format!("Unknown window {label}"))?)
    }

    pub fn windows(&self) -> Vec<(String, PathBuf)> {
        self.slots
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(label, slot)| {
                Some((label.clone(), slot.doc.as_ref()?.document.path.clone()))
            })
            .collect()
    }

    pub fn find(&self, path: &Path) -> Option<String> {
        self.slots.lock().unwrap().iter().find_map(|(label, slot)| {
            (slot.doc.as_ref()?.document.path == path).then(|| label.clone())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_lookup_is_scoped_to_the_window() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = Sessions::default();
        for (label, filename) in [("doc-1", "first.md"), ("doc-2", "second.md")] {
            let path = temp.path().join(filename);
            let document = crate::commands::file::load_document(&path).unwrap();
            let watcher = crate::watcher::DocumentWatcher::start(path, "", |_| {}).unwrap();
            sessions.insert(
                label,
                Slot {
                    doc: Some(DocumentSession { document, watcher }),
                    ..Slot::default()
                },
            );
        }
        sessions.insert("doc-3", Slot::default());
        let path = |label| sessions.with(label, |s| Ok(s.document()?.document.path.clone()));
        assert_eq!(path("doc-1").unwrap(), temp.path().join("first.md"));
        assert_eq!(path("doc-2").unwrap(), temp.path().join("second.md"));
        assert!(path("doc-3").is_err());
        assert_eq!(sessions.windows().len(), 2);
        sessions.remove("doc-1");
        assert!(path("doc-1").is_err());
        assert_eq!(
            sessions.find(&temp.path().join("second.md")).as_deref(),
            Some("doc-2")
        );
    }
}
