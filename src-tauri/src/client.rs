use crate::{
    protocol::{self, Request, Response},
    timing,
};
use std::{
    env,
    ffi::OsString,
    fs::{self, DirBuilder, File},
    io::{self, ErrorKind},
    os::unix::{
        fs::{DirBuilderExt, FileTypeExt, MetadataExt},
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const HELP: &str = "\
mdw - Markdown editor with live preview

Usage:
  mdw [FILE]                 Open FILE; a missing file is created on first save.
                             Without FILE, a file picker opens.
  mdw --no-server [FILE]     Open FILE in its own process, without the server.

Server (keeps a preloaded window so files open in ~0.1 s; ~200 MB while idle):
  The first `mdw FILE` starts the server in the background.
  mdw --server               Run the server in the foreground (e.g. a systemd user service).
  mdw --server-status        Show the server PID, open files and memory use.
  mdw --stop-server          Stop the server; refuses while files have unsaved changes.
  mdw --stop-server --force  Stop the server and discard unsaved changes.

Options:
  -h, --help                 Show this help.

Configuration: ~/.config/mdw/config.toml (set `server = false` to always run
without the server).
";

pub enum Mode {
    Help,
    Open {
        path: Option<PathBuf>,
        standalone: bool,
    },
    Server,
    Stop(bool),
    Status,
}

pub fn arguments(args: impl Iterator<Item = OsString>) -> Result<Mode, String> {
    let (mut path, mut standalone, mut force, mut literal) = (None, false, false, false);
    let mut action = None;
    for arg in args {
        match arg.to_str().filter(|_| !literal) {
            Some("--") => literal = true,
            Some("-h" | "--help") => return Ok(Mode::Help),
            Some("--no-server") => standalone = true,
            Some("--force") => force = true,
            Some(flag @ ("--server" | "--server-status" | "--stop-server")) if action.is_none() => {
                action = Some(flag.to_owned());
            }
            Some(flag) if flag.starts_with('-') => {
                return Err(format!(
                    "Unexpected argument: {flag}. Run mdw --help for usage."
                ))
            }
            _ if path.is_none() => path = Some(PathBuf::from(arg)),
            _ => return Err("Expected a single document path".into()),
        }
    }
    match action.as_deref() {
        None if !force => Ok(Mode::Open { path, standalone }),
        Some(flag) if path.is_none() && !standalone => match flag {
            "--server" if !force => Ok(Mode::Server),
            "--server-status" if !force => Ok(Mode::Status),
            "--stop-server" => Ok(Mode::Stop(force)),
            _ => Err("--force requires --stop-server".into()),
        },
        _ => Err("Invalid arguments. Run mdw --help for usage.".into()),
    }
}

pub fn resolve_path(path: &Path) -> Result<PathBuf, String> {
    let path = std::path::absolute(path).map_err(|e| e.to_string())?;
    match path.canonicalize() {
        Ok(p) if p.is_file() => Ok(p),
        Ok(p) => Err(format!("Expected a file: {}", p.display())),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            let parent = path.parent().ok_or("Document has no directory")?;
            if !parent.is_dir() {
                return Err(format!("Directory does not exist: {}", parent.display()));
            }
            Ok(parent
                .canonicalize()
                .map_err(|e| e.to_string())?
                .join(path.file_name().ok_or("Missing filename")?))
        }
        Err(e) => Err(format!("Cannot open {}: {e}", path.display())),
    }
}

pub fn socket_path() -> io::Result<PathBuf> {
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    let dir = env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("mdw"))
        .unwrap_or_else(|| PathBuf::from(format!("/tmp/mdw-{uid}")));
    match DirBuilder::new().mode(0o700).create(&dir) {
        Err(e) if e.kind() == ErrorKind::AlreadyExists => (),
        other => other?,
    }
    let meta = fs::symlink_metadata(&dir)?;
    if !meta.is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            format!(
                "Expected a private directory owned by this user: {}",
                dir.display()
            ),
        ));
    }
    Ok(dir.join("server.sock"))
}

// Binding elects the server. Serialize the probe/unlink/bind sequence so two
// contenders recovering a stale socket cannot unlink the winner's listener.
pub fn bind(path: &Path) -> io::Result<UnixListener> {
    let directory = File::open(path.parent().ok_or(ErrorKind::InvalidInput)?)?;
    directory.lock()?;
    match UnixListener::bind(path) {
        Err(e) if e.kind() == ErrorKind::AddrInUse => match UnixStream::connect(path) {
            Err(probe)
                if probe.kind() == ErrorKind::ConnectionRefused
                    && fs::symlink_metadata(path)?.file_type().is_socket() =>
            {
                fs::remove_file(path)?;
                UnixListener::bind(path)
            }
            _ => Err(e),
        },
        result => result,
    }
}

fn connect(path: &Path) -> Result<Option<UnixStream>, String> {
    match UnixStream::connect(path) {
        Ok(stream) => Ok(Some(stream)),
        Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::ConnectionRefused) => {
            Ok(None)
        }
        Err(e) => Err(format!("Cannot connect to {}: {e}", path.display())),
    }
}

fn start(path: &Path) -> Result<UnixStream, String> {
    let mut command = Command::new(env::current_exe().map_err(|e| e.to_string())?);
    command
        .arg("--server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and uses no shared Rust state after fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start mdw server: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(stream) = connect(path)? {
            return Ok(stream);
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if let Some(stream) = connect(path)? {
                return Ok(stream);
            }
            return Err(format!(
                "Server exited during startup ({status}). Run mdw --server for details."
            ));
        }
        if Instant::now() >= deadline {
            return Err("Timed out waiting for the mdw server socket".into());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

pub fn request(body: Request) -> Result<(), String> {
    let path = socket_path().map_err(|e| e.to_string())?;
    let mut stream = match connect(&path)? {
        Some(stream) => stream,
        None if matches!(body, Request::Open { .. }) => start(&path)?,
        None => {
            println!("mdw server is not running");
            return Ok(());
        }
    };
    timing::mark("client send");
    protocol::send(&mut stream, body)?;
    let response: Response = protocol::receive(&stream)?;
    for (label, at) in response.marks {
        timing::mark_at(&label, at);
    }
    if let Some(error) = response.error {
        return Err(error);
    }
    if let Some(message) = response.message {
        println!("{message}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn help_flags_win_and_point_from_errors() {
        let parse = |args: &[&str]| arguments(args.iter().map(OsString::from));
        assert!(matches!(parse(&["--help"]), Ok(Mode::Help)));
        assert!(matches!(parse(&["notes.md", "-h"]), Ok(Mode::Help)));
        assert!(matches!(parse(&["--", "-h"]), Ok(Mode::Open { .. })));
        assert!(matches!(parse(&["--server", "notes.md"]), Err(e) if e.contains("--help")));
        assert!(parse(&["--bogus"]).is_err());
    }

    #[test]
    fn client_paths_use_its_cwd_and_do_not_create_files() {
        let cwd = std::env::current_dir().unwrap();
        let temp = tempfile::tempdir_in(&cwd).unwrap();
        let relative = temp.path().strip_prefix(&cwd).unwrap();
        fs::create_dir(relative.join("sub")).unwrap();
        let path = resolve_path(&relative.join("sub/../new.md")).unwrap();
        assert_eq!(path, temp.path().join("new.md"));
        assert!(!path.exists());
        fs::write(&path, "data").unwrap();
        assert_eq!(resolve_path(&path).unwrap(), path);
        assert!(resolve_path(&relative.join("absent/new.md"))
            .unwrap_err()
            .contains("Directory does not exist"));
        assert!(resolve_path(&relative.join("sub")).is_err());
    }
    #[test]
    fn concurrent_binders_recover_one_stale_socket() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.sock");
        drop(UnixListener::bind(&path).unwrap());
        let barrier = std::sync::Barrier::new(8);
        let listeners = thread::scope(|scope| {
            let threads: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        bind(&path)
                    })
                })
                .collect();
            threads
                .into_iter()
                .filter_map(|t| t.join().unwrap().ok())
                .collect::<Vec<_>>()
        });
        assert_eq!(listeners.len(), 1);
        assert!(UnixStream::connect(path).is_ok());
    }
}
