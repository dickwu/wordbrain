//! Format-specific parsers for ingesting reading material.
//!
//! Each submodule exposes a pure function (`path → Vec<SomeShape>`). The
//! Tauri command layer wraps these in `#[tauri::command]` handlers and the
//! frontend persists the result through `save_material`.

pub mod epub;
