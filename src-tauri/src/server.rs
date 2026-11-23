use crate::{
    commands::{
        config::{self, AppState, InitialSession},
        file::DocumentSession,
    },
    memory,
    protocol::{self, Marks, Request, Response},
    sessions::{Sessions, Slot, Startup},
    timing, windows,
};
use std::{
    os::unix::net::{UnixListener, UnixStream},
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

struct Call {
    stream: UnixStream,
    request: Request,
    received: f64,
}

fn reply(stream: &mut UnixStream, result: Result<Response, String>) {
    let response = result.unwrap_or_else(|error| Response {
        error: Some(error),
        ..Response::default()
    });
    let _ = protocol::send(stream, response);
}

pub fn serve(app: AppHandle, listener: UnixListener, socket: PathBuf) {
    let (send, receive) = mpsc::channel();
    let handler = app.clone();
    thread::spawn(move || {
        Server {
            app: handler,
            next: 0,
            spare: None,
            stop_id: 0,
        }
        .run(receive, &socket)
    });
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = match stream {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("Cannot accept mdw connection: {e}");
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let (app, send) = (app.clone(), send.clone());
            thread::spawn(move || {
                let request = protocol::receive::<Request>(&stream);
                let received = timing::epoch_ms();
                let request = match request {
                    Ok(Request::Open {
                        path: None,
                        timing,
                        quit,
                    }) => {
                        let choice = app
                            .dialog()
                            .file()
                            .add_filter("Markdown", &["md", "markdown", "txt"])
                            .blocking_pick_file();
                        match choice.map(|p| p.into_path()).transpose() {
                            Ok(Some(path)) => Request::Open {
                                path: Some(path),
                                timing,
                                quit,
                            },
                            Ok(None) => {
                                reply(&mut stream, Ok(Response::default()));
                                return;
                            }
                            Err(e) => {
                                reply(&mut stream, Err(e.to_string()));
                                return;
                            }
                        }
                    }
                    Ok(request) => request,
                    Err(e) => {
                        reply(&mut stream, Err(e));
                        return;
                    }
                };
                let _ = send.send(Call {
                    stream,
                    request,
                    received,
                });
            });
        }
    });
}

struct Server {
    app: AppHandle,
    next: usize,
    spare: Option<(String, AppState)>,
    stop_id: u64,
}

impl Server {
    fn warm(&mut self) -> Result<(), String> {
        if self.spare.is_none() {
            self.next += 1;
            let label = format!("doc-{}", self.next);
            let state = config::saved_state();
            windows::build(&self.app, &label, Slot::default(), &state)?;
            self.spare = Some((label, state));
        }
        Ok(())
    }

    fn run(&mut self, calls: Receiver<Call>, socket: &Path) {
        if let Err(e) = self.warm() {
            eprintln!("Cannot preload window: {e}");
        }
        for Call {
            mut stream,
            request,
            received,
        } in calls
        {
            match request {
                Request::Open {
                    path: Some(path),
                    timing,
                    quit,
                } => {
                    let result = self.open(&path, timing, quit, received);
                    reply(
                        &mut stream,
                        result.map(|marks| Response {
                            marks,
                            ..Response::default()
                        }),
                    );
                    if let Err(e) = self.warm() {
                        eprintln!("Cannot preload window: {e}");
                    }
                }
                Request::Open { path: None, .. } => unreachable!("dialog already handled"),
                Request::Status => {
                    let pid = std::process::id();
                    let paths = self.app.state::<Sessions>().windows();
                    let mut message = format!(
                        "mdw server running (PID {pid})\n{}\nOpen windows: {}",
                        memory::summary(pid),
                        paths.len()
                    );
                    for (_, path) in paths {
                        message.push_str(&format!("\n  {}", path.display()));
                    }
                    reply(
                        &mut stream,
                        Ok(Response {
                            message: Some(message),
                            ..Response::default()
                        }),
                    );
                }
                Request::Stop { force } => {
                    if let Err(e) = self.prepare_stop(force) {
                        reply(&mut stream, Err(e));
                        continue;
                    }
                    // The listener is still live and exclusively owns this pathname.
                    let _ = std::fs::remove_file(socket);
                    reply(&mut stream, Ok(Response::default()));
                    self.app.exit(0);
                    break;
                }
            }
        }
    }

    fn open(
        &mut self,
        path: &Path,
        timed: bool,
        quit: bool,
        received: f64,
    ) -> Result<Marks, String> {
        if !path.is_absolute() {
            return Err("Open request requires an absolute path".into());
        }
        let mut marks = Vec::new();
        if timed {
            marks.push(("server receive".into(), received));
        }
        let app = self.app.clone();
        let sessions = app.state::<Sessions>();
        let ownership = sessions.changing_paths.lock().unwrap();
        let path = crate::client::resolve_path(path)?;
        if let Some(label) = sessions.find(&path) {
            let window = self.window(&label)?;
            window
                .unminimize()
                .and_then(|_| window.set_focus())
                .map_err(|e| e.to_string())?;
            if timed {
                marks.push(("existing window focused".into(), timing::epoch_ms()));
            }
            return Ok(marks);
        }
        self.warm()?;
        let (label, _) = self.spare.as_ref().unwrap();
        let doc = DocumentSession::load(&self.app, label, &path)?;
        let session = InitialSession::load(doc.document.clone(), timed)?;
        let (label, old_state) = self.spare.take().unwrap();
        let window = self.window(&label)?;
        let result = (|| {
            if old_state.window != session.state.window {
                windows::restore_bounds(&window, &session.state)?;
            }
            windows::apply_view_state(&window, &session.state)?;
            if old_state.background != session.state.background {
                let color = session
                    .state
                    .background
                    .as_deref()
                    .and_then(config::parse_hex_color);
                window
                    .set_background_color(color)
                    .map_err(|e| e.to_string())?;
            }
            window
                .set_title(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                )
                .map_err(|e| e.to_string())?;
            let (tx, rx) = mpsc::channel();
            if timed {
                marks.push(("assign".into(), timing::epoch_ms()));
            }
            let notification = sessions.with(&label, |s| {
                if let Some(e) = s.boot_error.take() {
                    return Err(e);
                }
                s.doc = Some(doc);
                s.bounds = session.state.window.clone();
                s.startup = Startup {
                    timing: timed,
                    reply: Some(tx),
                    ..Startup::default()
                };
                if s.listening {
                    Ok(Some(session))
                } else {
                    s.initial = Some(session);
                    Ok(None)
                }
            })?;
            drop(ownership);
            if let Some(session) = notification {
                window
                    .emit_to(label.as_str(), "mdw-assign", session)
                    .map_err(|e| e.to_string())?;
            }
            let frame = rx
                .recv_timeout(Duration::from_secs(30))
                .map_err(|e| format!("Window startup failed: {e}"))??;
            if timed {
                marks.extend(frame.into_iter().filter(|(_, at)| *at >= received));
                marks.sort_by(|a, b| a.1.total_cmp(&b.1));
            }
            if quit {
                crate::commands::close_window(window.clone())?;
            }
            Ok(marks)
        })();
        if result.is_err() && !window.is_visible().unwrap_or(true) {
            let _ = window.destroy();
        }
        result
    }

    fn window(&self, label: &str) -> Result<WebviewWindow, String> {
        self.app
            .get_webview_window(label)
            .ok_or_else(|| format!("Window {label} closed"))
    }

    fn prepare_stop(&mut self, force: bool) -> Result<(), String> {
        self.stop_id += 1;
        let id = self.stop_id;
        let sessions = self.app.state::<Sessions>();
        let _ownership = sessions.changing_paths.lock().unwrap();
        let windows = sessions.windows();
        let result = (|| {
            if !force {
                let mut pending = Vec::new();
                for (label, path) in &windows {
                    let (tx, rx) = mpsc::channel();
                    sessions.with(label, |s| {
                        s.stop = Some((id, tx));
                        Ok(())
                    })?;
                    self.app
                        .emit_to(label.as_str(), "mdw-prepare-stop", id)
                        .map_err(|e| e.to_string())?;
                    pending.push((label, path, rx));
                }
                let mut dirty = Vec::new();
                for (label, path, rx) in pending {
                    match rx.recv_timeout(Duration::from_secs(5)) {
                        Ok(Ok(true)) => dirty.push(path.display().to_string()),
                        Ok(Ok(false)) => (),
                        Ok(Err(e)) => return Err(e),
                        Err(_) if self.app.get_webview_window(label).is_none() => (),
                        Err(_) => {
                            return Err(format!(
                                "Could not check unsaved changes in {}",
                                path.display()
                            ))
                        }
                    }
                }
                if !dirty.is_empty() {
                    return Err(format!("Unsaved changes in:\n  {}", dirty.join("\n  ")));
                }
            }
            for (label, _) in &windows {
                if let Some(window) = self.app.get_webview_window(label) {
                    if let Err(e) = config::save_on_exit(&window) {
                        if !force {
                            return Err(e);
                        }
                        eprintln!("Cannot save window geometry: {e}");
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() && !force {
            for (label, _) in windows {
                let _ = sessions.with(&label, |s| {
                    s.stop = None;
                    Ok(())
                });
                let _ = self.app.emit_to(label, "mdw-cancel-stop", id);
            }
        }
        result
    }
}
