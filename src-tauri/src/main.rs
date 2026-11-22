#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod client;
mod commands;
mod memory;
mod protocol;
mod server;
mod sessions;
mod timing;
mod watcher;
mod windows;

use client::Mode;
use protocol::Request;
use std::{os::unix::net::UnixListener, path::PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

fn main() {
    timing::init();
    timing::mark("main");
    if let Err(error) = run() {
        eprintln!("mdw: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    match client::arguments(std::env::args_os().skip(1))? {
        Mode::Open { path, standalone } => {
            let path = path.as_deref().map(client::resolve_path).transpose()?;
            if standalone || !commands::config::load_config()?.server {
                gui(path, None)
            } else {
                client::request(Request::Open {
                    path,
                    timing: timing::enabled(),
                    quit: timing::quit(),
                })
            }
        }
        Mode::Help => {
            print!("{}", client::HELP);
            Ok(())
        }
        Mode::Status => client::request(Request::Status),
        Mode::Stop(force) => client::request(Request::Stop { force }),
        Mode::Server => {
            let path = client::socket_path().map_err(|e| e.to_string())?;
            let listener =
                client::bind(&path).map_err(|e| format!("Cannot bind {}: {e}", path.display()))?;
            gui(None, Some((listener, path)))
        }
    }
}

fn gui(path: Option<PathBuf>, server: Option<(UnixListener, PathBuf)>) -> Result<(), String> {
    // WebKitGTK's DMABUF renderer adds ~250 ms before the first frame on Fedora; respect an explicit user setting.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    let resident = server.is_some();
    let app = tauri::Builder::default()
        .manage(sessions::Sessions::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                commands::config::request_close(window, api);
            } else if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<sessions::Sessions>().remove(window.label());
            }
        })
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::get_initial_doc,
            commands::file::open_document,
            commands::file::read_file,
            commands::file::write_file,
            commands::assets::save_image_bytes,
            commands::assets::save_image_file,
            commands::fs::list_dir,
            commands::fs::path_exists,
            commands::fs::open_external,
            commands::housekeeping::rename_document,
            commands::housekeeping::paths_exist,
            commands::housekeeping::list_files,
            commands::housekeeping::delete_files,
            commands::close_window,
            commands::stop_result,
            commands::config::load_config,
            commands::config::load_state,
            commands::config::save_state,
            commands::config::get_initial_session,
            commands::config::show_window,
            commands::config::finish_startup,
        ])
        .setup(move |app| {
            timing::mark("setup");
            if let Some((listener, path)) = server {
                server::serve(app.handle().clone(), listener, path);
            } else if let Some(path) = path {
                if let Err(e) = windows::standalone(app.handle(), &path) {
                    eprintln!("mdw: {e}");
                    app.handle().exit(1);
                }
            } else {
                let handle = app.handle().clone();
                app.dialog()
                    .file()
                    .add_filter("Markdown", &["md", "markdown", "txt"])
                    .pick_file(move |selection| {
                        let Some(selection) = selection else {
                            handle.exit(0);
                            return;
                        };
                        let result = selection
                            .into_path()
                            .map_err(|error| error.to_string())
                            .and_then(|path| windows::standalone(&handle, &path));
                        if let Err(error) = result {
                            eprintln!("{error}");
                            handle.exit(1);
                        }
                    });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|e| e.to_string())?;
    let code = app.run_return(move |_, event| {
        if let tauri::RunEvent::ExitRequested {
            api, code: None, ..
        } = event
        {
            if resident {
                api.prevent_exit();
            }
        }
    });
    std::process::exit(code)
}
