/// A keyboard shortcut written in config.toml as e.g. "Ctrl+Shift+=" or "Ctrl++".
#[derive(Clone, Debug, PartialEq)]
pub struct Shortcut {
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    /// A single character (letters lowercased) or a CodeMirror key name such as "F5".
    pub key: String,
}

const NAMED_KEYS: [(&str, &str); 19] = [
    ("plus", "+"),
    ("minus", "-"),
    ("equal", "="),
    ("space", "Space"),
    ("enter", "Enter"),
    ("return", "Enter"),
    ("tab", "Tab"),
    ("escape", "Escape"),
    ("esc", "Escape"),
    ("backspace", "Backspace"),
    ("delete", "Delete"),
    ("home", "Home"),
    ("end", "End"),
    ("pageup", "PageUp"),
    ("pagedown", "PageDown"),
    ("up", "ArrowUp"),
    ("down", "ArrowDown"),
    ("left", "ArrowLeft"),
    ("right", "ArrowRight"),
];

impl Shortcut {
    pub fn parse(source: &str) -> Option<Self> {
        let source = source.trim();
        let (modifiers, key) = match source.strip_suffix("++") {
            Some(rest) => (rest, "+"),
            None if source == "+" => ("", "+"),
            None => match source.rsplit_once('+') {
                Some((modifiers, key)) => (modifiers, key),
                None => ("", source),
            },
        };
        let mut shortcut = Self {
            ctrl: false,
            shift: false,
            alt: false,
            meta: false,
            key: normalize_key(key)?,
        };
        for modifier in modifiers.split('+').filter(|m| !m.is_empty()) {
            let flag = match modifier.trim().to_ascii_lowercase().as_str() {
                "ctrl" | "control" => &mut shortcut.ctrl,
                "shift" => &mut shortcut.shift,
                "alt" => &mut shortcut.alt,
                "super" | "meta" | "cmd" => &mut shortcut.meta,
                _ => return None,
            };
            *flag = true;
        }
        Some(shortcut)
    }

    fn modifiers(&self) -> Vec<&'static str> {
        [
            (self.ctrl, "Ctrl"),
            (self.shift, "Shift"),
            (self.alt, "Alt"),
            (self.meta, "Meta"),
        ]
        .into_iter()
        .filter_map(|(on, name)| on.then_some(name))
        .collect()
    }

    pub fn codemirror(&self) -> String {
        let mut parts = self.modifiers();
        parts.push(&self.key);
        parts.join("-")
    }
}

fn normalize_key(key: &str) -> Option<String> {
    let key = key.trim();
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (None, _) => None,
        (Some(c), None) => Some(c.to_lowercase().collect()),
        _ => {
            let lower = key.to_ascii_lowercase();
            if let Some((_, name)) = NAMED_KEYS.iter().find(|(alias, _)| *alias == lower) {
                return Some((*name).into());
            }
            let function = lower
                .strip_prefix('f')
                .and_then(|n| n.parse::<u8>().ok())
                .filter(|n| (1..=24).contains(n));
            function.map(|n| format!("F{n}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Shortcut;

    fn cm(source: &str) -> Option<String> {
        Shortcut::parse(source).map(|s| s.codemirror())
    }

    #[test]
    fn parses_config_shortcuts() {
        assert_eq!(cm("Ctrl+=").as_deref(), Some("Ctrl-="));
        assert_eq!(cm("Ctrl++").as_deref(), Some("Ctrl-+"));
        assert_eq!(cm("ctrl+-").as_deref(), Some("Ctrl--"));
        assert_eq!(cm("Shift+Ctrl+Z").as_deref(), Some("Ctrl-Shift-z"));
        assert_eq!(cm("Super+plus").as_deref(), Some("Meta-+"));
        assert_eq!(cm("Alt+PageUp").as_deref(), Some("Alt-PageUp"));
        assert_eq!(cm("F5").as_deref(), Some("F5"));
        for bad in ["", "Ctrl+", "Hyper+a", "Ctrl+Banana", "F99"] {
            assert_eq!(cm(bad), None, "{bad}");
        }
    }
}
