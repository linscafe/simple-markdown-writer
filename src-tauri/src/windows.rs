use crate::{
    commands::{
        config::{self, AppState},
        file::DocumentSession,
    },
    sessions::{Sessions, Slot, Startup},
    timing,
};
use std::path::Path;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub fn restore_bounds(window: &WebviewWindow, state: &AppState) -> Result<(), String> {
    if let Some(saved) = &state.window {
        if !saved.maximized && window.is_maximized().map_err(|e| e.to_string())? {
            window.unmaximize().map_err(|e| e.to_string())?;
        }
        window
            .set_size(tauri::PhysicalSize::new(saved.w.max(400), saved.h.max(300)))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(saved.x, saved.y))
            .map_err(|e| e.to_string())?;
        if saved.maximized {
            window.maximize().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
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
        .inner_size(960.0, 760.0)
        .min_inner_size(400.0, 300.0)
        .build()
    {
        Ok(window) => {
            timing::mark("window built");
            if let Err(e) = restore_bounds(&window, state) {
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
