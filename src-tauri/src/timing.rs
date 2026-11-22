use std::{
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

static START_MS: OnceLock<Option<f64>> = OnceLock::new();

pub fn epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or_default()
}

pub fn init() {
    let enabled = std::env::var_os("MDW_TIMING").is_some_and(|value| value == "1");
    START_MS.get_or_init(|| enabled.then(epoch_ms));
}

pub fn enabled() -> bool {
    matches!(START_MS.get(), Some(Some(_)))
}

pub fn mark_at(label: &str, at_ms: f64) {
    if let Some(Some(start)) = START_MS.get() {
        eprintln!("mdw: {:>7.1} ms  {label}", at_ms - start);
    }
}

pub fn mark(label: &str) {
    mark_at(label, epoch_ms());
}

pub fn quit() -> bool {
    enabled() && std::env::var_os("MDW_TIMING_QUIT").is_some_and(|v| v == "1")
}
