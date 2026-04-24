//! Settings IPC. Values round-trip as raw JSON strings so the frontend can
//! serialise arbitrary shapes (including primitives).

use crate::db;

#[tauri::command]
pub async fn get_setting(key: String) -> Result<Option<String>, String> {
    if key.starts_with("secret::") {
        return Err("protected setting cannot be read from the renderer".to_string());
    }
    db::settings::get(&key)
        .await
        .map_err(|e| format!("get setting: {e}"))
}

#[tauri::command]
pub async fn set_setting(key: String, value: String) -> Result<(), String> {
    db::settings::set(&key, &value)
        .await
        .map_err(|e| format!("set setting: {e}"))
}
