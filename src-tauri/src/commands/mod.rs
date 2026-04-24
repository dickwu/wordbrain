//! Tauri IPC entry points. Keep each handler thin; push SQL and I/O into
//! `crate::db::*` helpers.

pub mod dict;
pub mod keys;
pub mod settings;
pub mod words;

#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}
