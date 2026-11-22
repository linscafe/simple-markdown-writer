use tauri::Manager;

pub mod assets;
pub mod config;
pub mod file;
pub mod fs;
pub mod housekeeping;

#[tauri::command]
pub fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    config::save_on_exit(&window)?;
    window.destroy().map_err(|e| e.to_string())?;
    window
        .state::<crate::sessions::Sessions>()
        .remove(window.label());
    Ok(())
}

#[tauri::command]
pub fn stop_result(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, crate::sessions::Sessions>,
    id: u64,
    dirty: bool,
    error: Option<String>,
) -> Result<(), String> {
    sessions.with(window.label(), |s| {
        if let Some((_, tx)) = s.stop.take_if(|(pending, _)| *pending == id) {
            let _ = tx.send(error.map_or(Ok(dirty), Err));
        }
        Ok(())
    })
}
