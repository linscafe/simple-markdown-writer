use crate::{
    commands::config::{self, AppState},
    windows,
};
use gtk::{gio, glib::ToVariant, prelude::*};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const WIDTH_NAME: &str = "mdw-width";
fn text_width() -> f64 {
    config::load_config().map(|c| c.line_width).unwrap_or(760.0)
}

/// Replaces the default title bar with a header bar that has the main menu button,
/// a source toggle (S) and the text width box (W).
/// Safe to call from any thread; the GTK work runs on the main thread.
pub fn install(window: &WebviewWindow, state: &AppState) {
    let target = window.clone();
    let toc = state.toc;
    let width = text_width();
    let result = window.run_on_main_thread(move || {
        if let Err(e) = build(&target, toc, width) {
            eprintln!("Cannot add the window menu: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("Cannot add the window menu: {e}");
    }
}

/// Brings the table-of-contents check mark and the width box in line with saved state.
pub fn sync(window: &WebviewWindow, state: &AppState) {
    let target = window.clone();
    let toc = state.toc;
    let width = text_width();
    let _ = window.run_on_main_thread(move || {
        let Ok(gtk_window) = target.gtk_window() else {
            return;
        };
        let action = gtk_window
            .lookup_action("toc")
            .and_then(|a| a.downcast::<gio::SimpleAction>().ok());
        if let Some(action) = action {
            action.set_state(&toc.to_variant());
        }
        let entry = gtk_window
            .titlebar()
            .and_then(|bar| find_named(&bar, WIDTH_NAME))
            .and_then(|w| w.downcast::<gtk::Entry>().ok());
        if let Some(entry) = entry {
            entry.set_text(&format!("{width:.0}"));
        }
    });
}

fn find_named(widget: &gtk::Widget, name: &str) -> Option<gtk::Widget> {
    if widget.widget_name() == name {
        return Some(widget.clone());
    }
    let container = widget.downcast_ref::<gtk::Container>()?;
    container
        .children()
        .iter()
        .find_map(|child| find_named(child, name))
}

fn item(section: &gio::Menu, label: &str, action: &str) {
    section.append_item(&gio::MenuItem::new(Some(label), Some(action)));
}

type MenuAction = dyn Fn(&AppHandle, &str);

fn build(window: &WebviewWindow, toc: bool, width: f64) -> Result<(), String> {
    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;

    let menu = gio::Menu::new();
    let document = gio::Menu::new();
    item(&document, "Open File…", "win.open");
    item(&document, "Show Table of Contents", "win.toc");
    menu.append_section(None, &document);
    let zoom = gio::Menu::new();
    item(&zoom, "Zoom In", "win.zoom-in");
    item(&zoom, "Zoom Out", "win.zoom-out");
    item(&zoom, "Reset Zoom", "win.zoom-reset");
    menu.append_section(None, &zoom);
    let settings = gio::Menu::new();
    item(&settings, "Preferences", "win.preferences");
    menu.append_section(None, &settings);

    let button = gtk::MenuButton::new();
    button.set_menu_model(Some(&menu));
    button.set_image(Some(&gtk::Image::from_icon_name(
        Some("open-menu-symbolic"),
        gtk::IconSize::Button,
    )));
    button.set_tooltip_text(Some("Main Menu"));
    // Keep keyboard focus in the editor after the menu closes.
    button.set_focus_on_click(false);
    let header = gtk::HeaderBar::new();
    header.set_show_close_button(true);
    header.set_has_subtitle(false);
    header.set_title(gtk_window.title().as_deref());
    header.pack_end(&button);

    let app = window.app_handle().clone();
    let label = window.label().to_string();

    // Per window and not remembered: a quick look at the raw Markdown.
    let source = gtk::ToggleButton::with_label("S");
    source.set_tooltip_text(Some("Show source: Markdown without rendering"));
    source.set_focus_on_click(false);
    let (source_app, source_label) = (app.clone(), label.clone());
    source.connect_toggled(move |button| {
        let _ = source_app.emit_to(source_label.as_str(), "mdw-source", button.is_active());
    });
    header.pack_end(&source);

    let entry = gtk::Entry::new();
    entry.set_widget_name(WIDTH_NAME);
    entry.set_width_chars(5);
    entry.set_max_width_chars(5);
    entry.set_input_purpose(gtk::InputPurpose::Digits);
    entry.set_text(&format!("{width:.0}"));
    entry.set_tooltip_text(Some("Text width in pixels. Press Enter to apply and save."));
    let (width_app, width_window) = (app.clone(), window.clone());
    entry.connect_activate(move |entry| {
        let label = width_window.label();
        let parsed = entry
            .text()
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|w| (MIN_WIDTH..=MAX_WIDTH).contains(w));
        let Some(width) = parsed else {
            entry.set_text(&format!("{:.0}", text_width()));
            message(
                &width_app,
                label,
                format!("Width must be a number from {MIN_WIDTH} to {MAX_WIDTH}"),
            );
            return;
        };
        let _ = width_app.emit_to(label, "mdw-width", width);
        match config::save_line_width(width) {
            Ok(()) => message(&width_app, label, format!("Width {width} px saved")),
            Err(e) => message(&width_app, label, format!("Cannot save width: {e}")),
        }
        // Return the keyboard to the editor.
        if let Some(webview) = width_window
            .default_vbox()
            .ok()
            .and_then(|vbox| vbox.children().into_iter().next())
        {
            webview.grab_focus();
        }
    });
    let width_label = gtk::Label::new(Some("W"));
    width_label.set_tooltip_text(Some("Text width in pixels"));
    let width_box = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    width_box.pack_start(&width_label, false, false, 0);
    width_box.pack_start(&entry, false, false, 0);
    header.pack_end(&width_box);

    header.show_all();
    gtk_window.set_titlebar(Some(&header));
    let simple = |name: &str, run: Box<MenuAction>| {
        let action = gio::SimpleAction::new(name, None);
        let (app, label) = (app.clone(), label.clone());
        action.connect_activate(move |_, _| run(&app, &label));
        gtk_window.add_action(&action);
    };
    simple("open", Box::new(pick_and_open));
    simple("preferences", Box::new(open_preferences));
    for (name, step) in [("zoom-in", 1), ("zoom-out", -1), ("zoom-reset", 0)] {
        simple(
            name,
            Box::new(move |app, label| {
                if let Err(e) = config::change_zoom(app, label, step) {
                    message(app, label, format!("Cannot zoom: {e}"));
                }
            }),
        );
    }

    let toc_action = gio::SimpleAction::new_stateful("toc", None, &toc.to_variant());
    toc_action.connect_activate(move |action, _| {
        let visible = !toggled(action);
        action.set_state(&visible.to_variant());
        let _ = app.emit_to(label.as_str(), "mdw-toc", visible);
        if let Err(e) = config::update_saved_state(|state| state.toc = visible) {
            eprintln!("Cannot save state: {e}");
        }
    });
    gtk_window.add_action(&toc_action);
    Ok(())
}

const MIN_WIDTH: u32 = 200;
const MAX_WIDTH: u32 = 4000;

fn toggled(action: &gio::SimpleAction) -> bool {
    action
        .state()
        .and_then(|state| state.get::<bool>())
        .unwrap_or(false)
}

fn message(app: &AppHandle, label: &str, text: String) {
    if app.emit_to(label, "mdw-message", &text).is_err() {
        eprintln!("mdw: {text}");
    }
}

fn pick_and_open(app: &AppHandle, label: &str) {
    let (handle, label) = (app.clone(), label.to_string());
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "txt"]);
    if let Some(window) = app.get_webview_window(&label) {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_file(move |selection| {
        let Some(selection) = selection else { return };
        match selection.into_path() {
            Ok(path) => windows::open_from_menu(&handle, &label, path),
            Err(e) => message(&handle, &label, format!("Cannot open: {e}")),
        }
    });
}

fn open_preferences(app: &AppHandle, label: &str) {
    match config::config_file() {
        Ok(path) => windows::open_from_menu(app, label, path),
        Err(e) => message(app, label, format!("Cannot open config.toml: {e}")),
    }
}
