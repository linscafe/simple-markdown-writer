use crate::{
    commands::{
        config::{self, AppState},
        file::DocumentSession,
    },
    sessions::{Sessions, Slot, Startup},
    timing,
};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Whether this process is the resident server (true) or a standalone window.
pub struct Resident(pub bool);

const DEFAULT_SIZE: (f64, f64) = (960.0, 760.0);
const MIN_SIZE: (f64, f64) = (400.0, 300.0);
// Wayland reports the whole monitor as the work area, so leave room for a
// top bar the compositor does not tell us about.
const PANEL_ALLOWANCE: f64 = 48.0;

/// Fits a logical window size into the logical space available on screen.
pub fn fit_size(size: (f64, f64), available: Option<(f64, f64)>) -> (f64, f64) {
    let (mut w, mut h) = (size.0.max(MIN_SIZE.0), size.1.max(MIN_SIZE.1));
    if let Some((aw, ah)) = available {
        w = w.min(aw.max(MIN_SIZE.0));
        h = h.min(ah.max(MIN_SIZE.1));
    }
    (w, h)
}

fn available_space(window: &WebviewWindow) -> Option<(f64, f64)> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area().size.to_logical::<f64>(scale);
    let full = monitor.size().to_logical::<f64>(scale);
    let allowance = if area.height >= full.height {
        PANEL_ALLOWANCE
    } else {
        0.0
    };
    Some((area.width, area.height - allowance))
}

/// Applies saved zoom and table-of-contents visibility.
pub fn apply_view_state(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    window.set_zoom(state.zoom).map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::menu::sync(window, state);
    Ok(())
}

pub fn restore_bounds(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    let saved = state.window.as_ref();
    if saved.is_some_and(|s| !s.maximized) && window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())?;
    }
    let size = match saved {
        Some(s) if s.logical => (f64::from(s.w), f64::from(s.h)),
        _ => DEFAULT_SIZE,
    };
    let (w, h) = fit_size(size, available_space(window));
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if let Some(saved) = saved {
        window
            .set_position(tauri::PhysicalPosition::new(saved.x, saved.y))
            .map_err(|e| e.to_string())?;
        if saved.maximized {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::fit_size;

    #[test]
    fn fits_saved_size_to_the_screen() {
        assert_eq!(
            fit_size((1223.0, 1258.0), Some((2048.0, 1232.0))),
            (1223.0, 1232.0)
        );
        assert_eq!(
            fit_size((960.0, 760.0), Some((1280.0, 672.0))),
            (960.0, 672.0)
        );
        assert_eq!(fit_size((960.0, 760.0), None), (960.0, 760.0));
        assert_eq!(
            fit_size((100.0, 100.0), Some((300.0, 200.0))),
            (400.0, 300.0)
        );
    }
}

pub fn build(app: &AppHandle, label: &str, mut slot: Slot, state: &AppState) -> Result<(), String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::default());
    if let Some(color) = state
        .background
        .as_deref()
        .and_then(config::parse_hex_color)
    {
        builder = builder.background_color(color);
    }
    if let Some(session) = &slot.doc {
        builder = builder.title(
            session
                .document
                .path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
        );
    }
    slot.bounds = state.window.clone();
    app.state::<Sessions>().insert(label, slot);
    match builder
        .visible(false)
        .inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .build()
    {
        Ok(window) => {
            timing::mark("window built");
            #[cfg(target_os = "linux")]
            crate::menu::install(&window, state);
            if let Err(e) =
                restore_bounds(&window, state).and_then(|_| apply_view_state(&window, state))
            {
                let _ = window.destroy();
                return Err(e);
            }
            Ok(())
        }
        Err(e) => {
            app.state::<Sessions>().remove(label);
            Err(e.to_string())
        }
    }
}

pub fn standalone(app: &AppHandle, path: &Path) -> Result<(), String> {
    let doc = DocumentSession::load(app, "doc-1", path)?;
    build(
        app,
        "doc-1",
        Slot {
            doc: Some(doc),
            startup: Startup {
                timing: timing::enabled(),
                standalone_quit: timing::quit(),
                ..Startup::default()
            },
            ..Slot::default()
        },
        &config::saved_state(),
    )
}

/// Opens a document chosen from the window menu in its own window.
pub fn open_from_menu(app: &AppHandle, from: &str, path: PathBuf) {
    let report = |app: &AppHandle, from: &str, error: String| {
        if app
            .emit_to(from, "mdw-message", format!("Cannot open: {error}"))
            .is_err()
        {
            eprintln!("mdw: {error}");
        }
    };
    if app.state::<Resident>().0 {
        // The server thread waits for the new window's first frame, so never block the GTK thread on it.
        let (app, from) = (app.clone(), from.to_string());
        std::thread::spawn(move || {
            let request = crate::protocol::Request::Open {
                path: Some(path),
                timing: false,
                quit: false,
            };
            if let Err(e) = crate::client::request(request) {
                report(&app, &from, e);
            }
        });
    } else if let Err(e) = open_in_process(app, &path) {
        report(app, from, e);
    }
}

fn open_in_process(app: &AppHandle, path: &Path) -> Result<(), String> {
    let sessions = app.state::<Sessions>();
    let _ownership = sessions.changing_paths.lock().unwrap();
    let path = crate::client::resolve_path(path)?;
    if let Some(label) = sessions.find(&path) {
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("Window {label} closed"))?;
        return window
            .unminimize()
            .and_then(|_| window.set_focus())
            .map_err(|e| e.to_string());
    }
    let label = (1..)
        .map(|n| format!("doc-{n}"))
        .find(|label| app.get_webview_window(label).is_none())
        .expect("a free window label");
    let doc = DocumentSession::load(app, &label, &path)?;
    build(
        app,
        &label,
        Slot {
            doc: Some(doc),
            ..Slot::default()
        },
        &config::saved_state(),
    )
}
