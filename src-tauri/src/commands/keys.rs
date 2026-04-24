//! BYOK management IPC. The renderer can **write** a key and **probe** whether
//! one exists — it can never read a key back. Actual usage happens inside
//! [`crate::commands::dict::lookup_online`] / `lookup_ai`, which pull the
//! secret from stronghold on demand.

use tauri::State;

use crate::keys::KeyVault;

/// Persist a provider key into stronghold. `provider` is one of
/// `"youdao" | "deepl" | "openai" | "anthropic" | "ollama"`. Pass an empty
/// string to clear the slot.
#[tauri::command]
pub async fn save_api_key(
    vault: State<'_, KeyVault>,
    provider: String,
    value: String,
) -> Result<(), String> {
    if value.is_empty() {
        return vault
            .remove(&provider)
            .await
            .map_err(|e| format!("clear key: {e}"));
    }
    vault
        .save(&provider, value.as_bytes())
        .await
        .map_err(|e| format!("save key: {e}"))
}

#[tauri::command]
pub async fn has_api_key(
    vault: State<'_, KeyVault>,
    provider: String,
) -> Result<bool, String> {
    vault
        .has(&provider)
        .await
        .map_err(|e| format!("probe key: {e}"))
}

/// Return the set of providers that have a key configured. Used by the
/// Settings panel to render green "✓ configured" chips without revealing the
/// actual secret.
#[tauri::command]
pub async fn list_configured_providers(
    vault: State<'_, KeyVault>,
) -> Result<Vec<String>, String> {
    const KNOWN: &[&str] = &["youdao", "deepl", "openai", "anthropic", "ollama"];
    let mut out = Vec::new();
    for p in KNOWN {
        if vault
            .has(p)
            .await
            .map_err(|e| format!("probe {p}: {e}"))?
        {
            out.push((*p).to_string());
        }
    }
    Ok(out)
}
