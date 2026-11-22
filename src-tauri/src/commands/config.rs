use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::file::InitialDoc;
use crate::{protocol::Marks, sessions::Sessions};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct VimMap {
    pub lhs: String,
    pub rhs: String,
    pub mode: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum VimSetting {
    Enabled(bool),
    Options {
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        map: Vec<VimMap>,
    },
}

fn yes() -> bool {
    true
}
impl Default for VimSetting {
    fn default() -> Self {
        Self::Enabled(true)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct Config {
    pub server: bool,
    pub theme: String,
    pub font_body: Option<String>,
    pub font_mono: Option<String>,
    pub font_size: f64,
    pub line_width: f64,
    pub vim: bool,
    pub vim_maps: Vec<VimMap>,
    pub image_dir: String,
    pub copy_images: bool,
    pub warning: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: true,
            theme: "auto".into(),
            font_body: None,
            font_mono: None,
            font_size: 17.0,
            line_width: 760.0,
            vim: true,
            vim_maps: vec![],
            image_dir: "{name}.assets".into(),
            copy_images: true,
            warning: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct ConfigFile {
    server: bool,
    theme: String,
    font_body: Option<String>,
    font_mono: Option<String>,
    font_size: f64,
    line_width: f64,
    vim: VimSetting,
    image_dir: String,
    copy_images: bool,
}

impl Default for ConfigFile {
    fn default() -> Self {
        let config = Config::default();
        Self {
            server: config.server,
            theme: config.theme,
            font_body: config.font_body,
            font_mono: config.font_mono,
            font_size: config.font_size,
            line_width: config.line_width,
            vim: VimSetting::default(),
            image_dir: config.image_dir,
            copy_images: config.copy_images,
        }
    }
}

fn config_warning(warning: String) -> Config {
    Config {
        warning: Some(warning),
        ..Config::default()
    }
}

fn parse_config(source: &str) -> Config {
    match toml::from_str::<ConfigFile>(source) {
        Ok(file)
            if file.font_size.is_finite()
                && file.font_size > 0.0
                && file.line_width.is_finite()
                && file.line_width > 0.0 =>
        {
            let (vim, vim_maps) = match file.vim {
                VimSetting::Enabled(enabled) => (enabled, vec![]),
                VimSetting::Options { enabled, map } => (enabled, map),
            };
            Config {
                server: file.server,
                theme: file.theme,
                font_body: file.font_body,
                font_mono: file.font_mono,
                font_size: file.font_size,
                line_width: file.line_width,
                vim,
                vim_maps,
                image_dir: file.image_dir,
                copy_images: file.copy_images,
                warning: None,
            }
        }
        Ok(_) => config_warning("Invalid font_size or line_width; using default config".into()),
        Err(error) => config_warning(format!("Cannot parse config.toml; using defaults: {error}")),
    }
}

fn config_directory() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".config/mdw"))
        .ok_or_else(|| "Cannot find home directory".into())
}

#[tauri::command]
pub fn load_config() -> Result<Config, String> {
    let path = config_directory()?.join("config.toml");
    Ok(match fs::read_to_string(&path) {
        Ok(source) => parse_config(&source),
        Err(error) if error.kind() == ErrorKind::NotFound => Config::default(),
        Err(error) => config_warning(format!("Cannot read {}: {error}", path.display())),
    })
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct FileState {
    pub cursor: usize,
    pub scroll_top: f64,
    pub last_used: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct WindowState {
    pub w: u32,
    pub h: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AppState {
    pub theme: Option<String>,
    pub window: Option<WindowState>,
    pub files: BTreeMap<String, FileState>,
    pub background: Option<String>,
}

impl AppState {
    fn cap_files(&mut self) {
        let mut recent: Vec<_> = self
            .files
            .iter()
            .map(|(path, state)| (state.last_used, path.clone()))
            .collect();
        recent.sort();
        let excess = recent.len().saturating_sub(200);
        for (_, path) in recent.into_iter().take(excess) {
            self.files.remove(&path);
        }
    }
}

fn read_state(path: &Path) -> std::io::Result<AppState> {
    match fs::read_to_string(path) {
        Ok(source) => {
            let mut state: AppState = serde_json::from_str(&source)
                .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
            state.cap_files();
            Ok(state)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(AppState::default()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn load_state() -> Result<AppState, String> {
    read_state(&config_directory()?.join("state.json")).map_err(|error| error.to_string())
}

fn write_state(path: &Path, state: &AppState) -> Result<(), String> {
    let parent = path.parent().ok_or("State path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let result = (|| {
        let content = serde_json::to_vec_pretty(state)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        file.write_all(&content)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error: std::io::Error| error.to_string())
}

#[derive(Clone, Serialize)]
pub struct UserTheme {
    pub name: String,
    pub css: String,
}

fn user_themes() -> Result<Vec<UserTheme>, String> {
    let directory = config_directory()?.join("themes");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.to_string()),
    };
    let mut themes = vec![];
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|extension| extension == "css") {
            if let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) {
                match fs::read_to_string(&path) {
                    Ok(css) => themes.push(UserTheme {
                        name: name.into(),
                        css,
                    }),
                    Err(error) => eprintln!("Cannot read theme {}: {error}", path.display()),
                }
            }
        }
    }
    themes.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(themes)
}

pub fn saved_state() -> AppState {
    load_state().unwrap_or_else(|error| {
        eprintln!("Cannot load state; using defaults: {error}");
        AppState::default()
    })
}

#[derive(Clone, Serialize)]
pub struct InitialSession {
    doc: InitialDoc,
    config: Config,
    pub state: AppState,
    themes: Vec<UserTheme>,
    timing: bool,
}

impl InitialSession {
    pub fn load(doc: InitialDoc, timing: bool) -> Result<Self, String> {
        Ok(Self {
            doc,
            config: load_config()?,
            state: saved_state(),
            themes: user_themes().unwrap_or_else(|error| {
                eprintln!("Cannot load user themes: {error}");
                vec![]
            }),
            timing,
        })
    }
}

#[tauri::command]
pub fn get_initial_session(
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
    listening: Option<bool>,
) -> Result<Option<InitialSession>, String> {
    crate::timing::mark("get_initial_session");
    sessions.with(window.label(), |slot| {
        slot.listening |= listening.unwrap_or(false);
        if let Some(initial) = slot.initial.take() {
            return Ok(Some(initial));
        }
        slot.doc
            .as_ref()
            .map(|s| InitialSession::load(s.document.clone(), slot.startup.timing))
            .transpose()
    })
}

fn capture_window(window: &tauri::WebviewWindow) -> Result<Option<WindowState>, String> {
    let sessions = window.state::<Sessions>();
    let mut bounds = sessions.with(window.label(), |s| Ok(s.bounds.clone()))?;
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    // Keep the last normal bounds so unmaximizing restores the user's window.
    if !maximized || bounds.is_none() {
        let size = window.inner_size().map_err(|error| error.to_string())?;
        let position = window.outer_position().map_err(|error| error.to_string())?;
        bounds = Some(WindowState {
            w: size.width,
            h: size.height,
            x: position.x,
            y: position.y,
            maximized,
        });
    } else if let Some(saved) = &mut bounds {
        saved.maximized = true;
    }
    sessions.with(window.label(), |s| {
        s.bounds = bounds.clone();
        Ok(bounds)
    })
}

// The lock lives beside state.json so replacing the JSON file does not replace the lock.
fn update_state(path: &Path, update: impl FnOnce(&mut AppState)) -> Result<(), String> {
    let directory = path.parent().ok_or("State path has no parent")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    let mut latest = match read_state(path) {
        Ok(state) => state,
        Err(error) if error.kind() == ErrorKind::InvalidData => AppState::default(),
        Err(error) => return Err(error.to_string()),
    };
    update(&mut latest);
    latest.cap_files();
    write_state(path, &latest)
}

#[tauri::command]
pub fn save_state(
    state: AppState,
    theme_changed: Option<bool>,
    window: tauri::WebviewWindow,
    sessions: tauri::State<'_, Sessions>,
) -> Result<(), String> {
    let path = sessions.with(window.label(), |s| {
        Ok(s.document()?.document.path.to_string_lossy().into_owned())
    })?;
    capture_window(&window)?;
    update_state(&config_directory()?.join("state.json"), |latest| {
        if let Some(file) = state.files.get(&path) {
            latest.files.insert(path, file.clone());
        }
        if theme_changed.unwrap_or(false) {
            latest.theme = state.theme.clone();
        }
        if latest.theme == state.theme && state.background.is_some() {
            latest.background = state.background;
        }
    })
}

pub fn save_on_exit(window: &tauri::WebviewWindow) -> Result<(), String> {
    let assigned = window
        .state::<Sessions>()
        .with(window.label(), |s| Ok(s.doc.is_some()))?;
    if assigned {
        let bounds = capture_window(window)?;
        update_state(&config_directory()?.join("state.json"), |latest| {
            latest.window = bounds
        })?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .state::<Sessions>()
        .with(window.label(), |s| s.document().map(|_| ()))?;
    window.show().map_err(|e| e.to_string())?;
    window.state::<Sessions>().with(window.label(), |s| {
        if s.startup.timing {
            s.startup.shown_at = Some(crate::timing::epoch_ms());
        }
        Ok(())
    })?;
    crate::timing::mark("window shown");
    Ok(())
}

#[tauri::command]
pub fn finish_startup(
    window: tauri::WebviewWindow,
    ready: bool,
    mut marks: Marks,
    error: Option<String>,
) -> Result<(), String> {
    let sessions = window.state::<Sessions>();
    let completed = sessions.with(window.label(), |s| {
        s.boot_error = error.clone();
        s.ready = ready;
        Ok(s.doc.as_ref().map(|_| std::mem::take(&mut s.startup)))
    })?;
    let Some(startup) = completed else {
        return Ok(());
    };
    if let (Some(tx), Some(e)) = (&startup.reply, error) {
        let _ = window.destroy();
        let _ = tx.send(Err(e));
        return Ok(());
    }
    let shown = window.show().map_err(|e| e.to_string());
    crate::timing::mark("finish_startup");
    if startup.close_pending && ready {
        window
            .emit_to(window.label(), "mdw-before-close", ())
            .map_err(|e| e.to_string())?;
    }
    if let Some(sender) = startup.reply {
        if let Some(at) = startup.shown_at {
            marks.push(("window shown".into(), at));
        }
        if startup.timing {
            marks.push(("finish_startup".into(), crate::timing::epoch_ms()));
        }
        let _ = sender.send(shown.clone().map(|_| marks));
    } else if startup.timing {
        for (label, at) in marks {
            crate::timing::mark_at(&label, at);
        }
        if startup.standalone_quit {
            super::close_window(window)?;
        }
    }
    shown
}

pub fn request_close(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let guarded = window.state::<Sessions>().with(window.label(), |s| {
        if s.doc.is_none() || s.boot_error.is_some() {
            return Ok(None);
        }
        s.startup.close_pending = !s.ready;
        Ok(Some(s.ready))
    });
    if let Ok(Some(ready)) = guarded {
        api.prevent_close();
        if ready {
            if let Err(error) = window.emit_to(window.label(), "mdw-before-close", ()) {
                eprintln!("Cannot request state save: {error}");
            }
        }
    } else if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
        if let Err(error) = save_on_exit(&webview) {
            eprintln!("Cannot save state: {error}");
        }
    }
}

pub fn parse_hex_color(value: &str) -> Option<tauri::window::Color> {
    let hex = value.trim().strip_prefix('#')?;
    let digits: Vec<u8> = match hex.len() {
        3 => hex
            .chars()
            .map(|c| c.to_digit(16).map(|d| d as u8 * 17))
            .collect::<Option<_>>()?,
        6 => (0..3)
            .map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
            .collect::<Option<_>>()?,
        _ => return None,
    };
    Some(tauri::window::Color(digits[0], digits[1], digits[2], 255))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_config_keeps_defaults() {
        let config = parse_config("theme = 'nord'\nfont_size = 19\nvim = false");
        assert_eq!(config.theme, "nord");
        assert_eq!(config.font_size, 19.0);
        assert_eq!(config.line_width, 760.0);
        assert!(!config.vim);
        assert!(config.copy_images);
        assert_eq!(config.image_dir, "{name}.assets");
        assert!(config.warning.is_none());
    }

    #[test]
    fn server_defaults_on_and_can_be_disabled() {
        assert!(parse_config("").server);
        assert!(!parse_config("server = false").server);
    }

    #[test]
    fn vim_maps_can_be_configured() {
        let config = parse_config("[[vim.map]]\nlhs = 'jj'\nrhs = '<Esc>'\nmode = 'insert'");
        assert!(config.vim);
        assert_eq!(config.vim_maps[0].lhs, "jj");
    }

    #[test]
    fn hex_colors_parse() {
        let rgb = |c: tauri::window::Color| (c.0, c.1, c.2, c.3);
        assert_eq!(
            parse_hex_color("#2e3440").map(rgb),
            Some((0x2e, 0x34, 0x40, 255))
        );
        assert_eq!(
            parse_hex_color(" #fff ").map(rgb),
            Some((255, 255, 255, 255))
        );
        for bad in ["", "2e3440", "#12345", "#gggggg", "rgb(1, 2, 3)", "#ééé"] {
            assert!(parse_hex_color(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn example_config_matches_defaults() {
        let example = include_str!("../../../config.example.toml");
        assert_eq!(
            format!("{:?}", parse_config(example)),
            format!("{:?}", Config::default())
        );

        let (head, table) = example.split_once("# [vim]").unwrap();
        let table: String = format!("# [vim]{table}")
            .lines()
            .map(|line| line.strip_prefix("# ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
        let config = parse_config(&format!("{}\n{table}", head.replace("vim = true\n", "")));
        assert!(config.warning.is_none(), "{:?}", config.warning);
        assert!(config.vim);
        assert_eq!(config.vim_maps.len(), 2);
        assert_eq!(config.image_dir, "{name}.assets");
    }

    #[test]
    fn malformed_config_returns_defaults_and_warning() {
        for source in [
            "theme = [",
            "font_size = 'large'",
            "line_width = -1",
            "font_size = nan",
        ] {
            let config = parse_config(source);
            assert_eq!(config.theme, "auto");
            assert!(config.warning.is_some());
        }
    }

    #[test]
    fn state_cap_retains_two_hundred_most_recent_files() {
        let mut state = AppState::default();
        for index in 0..205 {
            state.files.insert(
                format!("{index}.md"),
                FileState {
                    last_used: index,
                    ..FileState::default()
                },
            );
        }
        state.files.get_mut("0.md").unwrap().last_used = 206;
        state.cap_files();
        assert_eq!(state.files.len(), 200);
        assert!(state.files.contains_key("0.md"));
        assert!(!state.files.contains_key("1.md"));
        assert!(!state.files.contains_key("5.md"));
        assert!(state.files.contains_key("6.md"));
    }

    #[test]
    fn simultaneous_state_updates_preserve_other_documents() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for cursor in 0..8 {
                let (path, barrier) = (&path, &barrier);
                scope.spawn(move || {
                    barrier.wait();
                    update_state(path, |state| {
                        state.files.insert(
                            format!("{cursor}.md"),
                            FileState {
                                cursor,
                                ..FileState::default()
                            },
                        );
                    })
                    .unwrap();
                });
            }
        });
        let state = read_state(&path).unwrap();
        for cursor in 0..8 {
            assert_eq!(state.files[&format!("{cursor}.md")].cursor, cursor);
        }
    }

    #[test]
    fn state_round_trips_atomically() {
        let directory = std::env::temp_dir().join(format!("mdw-state-test-{}", std::process::id()));
        let path = directory.join("state.json");
        let state = AppState {
            theme: Some("sepia".into()),
            ..AppState::default()
        };
        write_state(&path, &state).unwrap();
        assert_eq!(read_state(&path).unwrap().theme.as_deref(), Some("sepia"));
        assert!(!path
            .with_extension(format!("json.{}.tmp", std::process::id()))
            .exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
