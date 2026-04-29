//! BYOK management IPC. The renderer can **write** keys and list which provider
//! slots are configured — it can never read a key back. Backend commands that
//! need a provider credential pull the secret from stronghold on demand.

use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::keys::KeyVault;

/// Persist a provider key into the Rust-side vault. `provider` is one of
/// `"openai" | "anthropic" | "ollama"`. Pass an empty string to clear the slot.
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

/// Return the set of providers that have a key configured. Used by the
/// Settings panel to render green "✓ configured" chips without revealing the
/// actual secret.
#[tauri::command]
pub async fn list_configured_providers(vault: State<'_, KeyVault>) -> Result<Vec<String>, String> {
    const KNOWN: &[&str] = &["openai", "anthropic", "ollama"];
    let mut out = Vec::new();
    for p in KNOWN {
        if vault.has(p).await.map_err(|e| format!("probe {p}: {e}"))? {
            out.push((*p).to_string());
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub auth_file_found: bool,
    pub auth_path: Option<String>,
    pub has_api_key: bool,
    pub has_oauth_token: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthImportResult {
    pub imported: bool,
    pub status: CodexAuthStatus,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelInfo {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    pub supported_in_api: bool,
    pub visibility: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModelListResult {
    pub models: Vec<CodexModelInfo>,
    pub source: String,
}

#[tauri::command]
pub async fn codex_auth_status() -> Result<CodexAuthStatus, String> {
    inspect_codex_auth()
}

#[tauri::command]
pub async fn list_codex_models_from_auth() -> Result<CodexModelListResult, String> {
    let Some((_path, value)) = read_codex_auth_file()? else {
        return Err("Codex auth file was not found.".to_string());
    };

    if let Some(token) = extract_codex_access_token(&value) {
        return fetch_codex_model_catalog(&token, extract_codex_account_id(&value).as_deref())
            .await;
    }

    if let Some(api_key) = extract_openai_api_key(&value) {
        return fetch_openai_model_catalog(&api_key).await;
    }

    Err("Codex auth was found, but it does not contain a usable API token.".to_string())
}

#[tauri::command]
pub async fn import_openai_key_from_codex_auth(
    vault: State<'_, KeyVault>,
) -> Result<CodexAuthImportResult, String> {
    let Some((path, value)) = read_codex_auth_file()? else {
        let status = CodexAuthStatus {
            auth_file_found: false,
            auth_path: codex_auth_path().map(|path| path.to_string_lossy().into_owned()),
            has_api_key: false,
            has_oauth_token: false,
        };
        return Ok(CodexAuthImportResult {
            imported: false,
            status,
            message: "Codex auth file was not found.".to_string(),
        });
    };

    let Some(api_key) = extract_openai_api_key(&value) else {
        let status = status_from_auth_value(path, &value);
        let message = if status.has_oauth_token {
            "Codex CLI auth is ready. WordBrain will let the local Codex CLI use ~/.codex/auth.json automatically."
        } else {
            "Codex auth was found, but it does not contain an OpenAI API key."
        };
        return Ok(CodexAuthImportResult {
            imported: false,
            status,
            message: message.to_string(),
        });
    };

    vault
        .save("openai", api_key.as_bytes())
        .await
        .map_err(|e| format!("save Codex OpenAI key: {e}"))?;

    let status = status_from_auth_value(path, &value);
    Ok(CodexAuthImportResult {
        imported: true,
        status,
        message: "OpenAI key imported from Codex auth.".to_string(),
    })
}

fn inspect_codex_auth() -> Result<CodexAuthStatus, String> {
    let Some((path, value)) = read_codex_auth_file()? else {
        return Ok(CodexAuthStatus {
            auth_file_found: false,
            auth_path: codex_auth_path().map(|path| path.to_string_lossy().into_owned()),
            has_api_key: false,
            has_oauth_token: false,
        });
    };
    Ok(status_from_auth_value(path, &value))
}

fn status_from_auth_value(path: PathBuf, value: &Value) -> CodexAuthStatus {
    CodexAuthStatus {
        auth_file_found: true,
        auth_path: Some(path.to_string_lossy().into_owned()),
        has_api_key: extract_openai_api_key(value).is_some(),
        has_oauth_token: has_codex_oauth_token(value),
    }
}

fn read_codex_auth_file() -> Result<Option<(PathBuf, Value)>, String> {
    let Some(path) = codex_auth_path() else {
        return Ok(None);
    };
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read Codex auth {}: {e}", path.display()))?;
    let value = serde_json::from_str::<Value>(&raw)
        .map_err(|e| format!("parse Codex auth {}: {e}", path.display()))?;
    Ok(Some((path, value)))
}

fn codex_auth_path() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let trimmed = codex_home.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            return Some(
                if path
                    .file_name()
                    .is_some_and(|name| name == OsStr::new("auth.json"))
                {
                    path
                } else {
                    path.join("auth.json")
                },
            );
        }
    }

    std::env::var("HOME")
        .ok()
        .map(|home| PathBuf::from(home).join(".codex").join("auth.json"))
}

fn extract_openai_api_key(value: &Value) -> Option<String> {
    let mut preferred = Vec::new();
    let mut fallback = Vec::new();
    collect_openai_api_keys(value, None, &mut preferred, &mut fallback);
    preferred
        .into_iter()
        .next()
        .or_else(|| fallback.into_iter().next())
}

async fn fetch_codex_model_catalog(
    access_token: &str,
    account_id: Option<&str>,
) -> Result<CodexModelListResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("create Codex models client: {e}"))?;
    let mut request = client
        .get("https://chatgpt.com/backend-api/codex/models?client_version=0.125.0")
        .bearer_auth(access_token)
        .header("Accept", "application/json");
    if let Some(account_id) = account_id.filter(|id| !id.trim().is_empty()) {
        request = request.header("ChatGPT-Account-Id", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("fetch Codex models: {e}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("parse Codex models response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Codex models request failed ({status}): {}",
            error_message_from_value(&body)
        ));
    }
    Ok(CodexModelListResult {
        models: parse_model_catalog(&body),
        source: "codex-auth-token".to_string(),
    })
}

async fn fetch_openai_model_catalog(api_key: &str) -> Result<CodexModelListResult, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("create OpenAI models client: {e}"))?;
    let response = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("fetch OpenAI models: {e}"))?;
    let status = response.status();
    let body = response
        .json::<Value>()
        .await
        .map_err(|e| format!("parse OpenAI models response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OpenAI models request failed ({status}): {}",
            error_message_from_value(&body)
        ));
    }
    Ok(CodexModelListResult {
        models: parse_model_catalog(&body),
        source: "openai-api-key".to_string(),
    })
}

fn parse_model_catalog(value: &Value) -> Vec<CodexModelInfo> {
    let Some(items) = value
        .get("models")
        .or_else(|| value.get("data"))
        .and_then(|models| models.as_array())
    else {
        return Vec::new();
    };

    let mut models: Vec<CodexModelInfo> = items
        .iter()
        .filter_map(|item| {
            let id = item
                .get("slug")
                .or_else(|| item.get("id"))
                .and_then(|value| value.as_str())?
                .trim();
            if id.is_empty() {
                return None;
            }
            let label = item
                .get("display_name")
                .or_else(|| item.get("name"))
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(id);
            Some(CodexModelInfo {
                id: id.to_string(),
                label: label.to_string(),
                description: item
                    .get("description")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
                supported_in_api: item
                    .get("supported_in_api")
                    .or_else(|| item.get("supportedInApi"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true),
                visibility: item
                    .get("visibility")
                    .and_then(|value| value.as_str())
                    .map(str::to_string),
            })
        })
        .collect();
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    models
}

fn error_message_from_value(value: &Value) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.get("error"))
        .and_then(|value| value.as_str())
        .unwrap_or("unknown error")
        .to_string()
}

fn extract_codex_access_token(value: &Value) -> Option<String> {
    value
        .pointer("/tokens/access_token")
        .or_else(|| value.get("access_token"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_codex_account_id(value: &Value) -> Option<String> {
    value
        .pointer("/tokens/account_id")
        .or_else(|| value.get("account_id"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn collect_openai_api_keys(
    value: &Value,
    key_hint: Option<&str>,
    preferred: &mut Vec<String>,
    fallback: &mut Vec<String>,
) {
    match value {
        Value::String(s) => {
            if looks_like_openai_api_key(s) {
                let key = s.trim().to_string();
                if key_hint.is_some_and(is_api_key_field) {
                    preferred.push(key);
                } else {
                    fallback.push(key);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_openai_api_keys(item, key_hint, preferred, fallback);
            }
        }
        Value::Object(map) => {
            for (key, child) in map {
                collect_openai_api_keys(child, Some(key), preferred, fallback);
            }
        }
        _ => {}
    }
}

fn looks_like_openai_api_key(value: &str) -> bool {
    let value = value.trim();
    value.starts_with("sk-") && value.len() >= 24
}

fn is_api_key_field(key: &str) -> bool {
    let normalized = normalize_field_name(key);
    normalized == "apikey" || normalized == "openaiapikey"
}

fn has_codex_oauth_token(value: &Value) -> bool {
    has_codex_oauth_token_with_key(value, None)
}

fn has_codex_oauth_token_with_key(value: &Value, key_hint: Option<&str>) -> bool {
    match value {
        Value::String(s) => key_hint.is_some_and(is_oauth_token_field) && !s.trim().is_empty(),
        Value::Array(items) => items
            .iter()
            .any(|item| has_codex_oauth_token_with_key(item, key_hint)),
        Value::Object(map) => map
            .iter()
            .any(|(key, child)| has_codex_oauth_token_with_key(child, Some(key))),
        _ => false,
    }
}

fn is_oauth_token_field(key: &str) -> bool {
    matches!(
        normalize_field_name(key).as_str(),
        "accesstoken" | "idtoken" | "refreshtoken"
    )
}

fn normalize_field_name(key: &str) -> String {
    key.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_api_key_from_codex_auth_shape() {
        let value = json!({
            "OPENAI_API_KEY": "sk-proj-abcdefghijklmnopqrstuvwxyz",
            "tokens": {
                "access_token": "oauth-token"
            }
        });

        assert_eq!(
            extract_openai_api_key(&value),
            Some("sk-proj-abcdefghijklmnopqrstuvwxyz".to_string())
        );
        assert!(has_codex_oauth_token(&value));
    }

    #[test]
    fn oauth_token_is_not_treated_as_api_key() {
        let value = json!({
            "tokens": {
                "access_token": "eyJhbGciOi..."
            }
        });

        assert_eq!(extract_openai_api_key(&value), None);
        assert!(has_codex_oauth_token(&value));
    }

    #[test]
    fn parses_codex_model_catalog_shape() {
        let value = json!({
            "models": [
                {
                    "slug": "gpt-5.5",
                    "display_name": "GPT-5.5",
                    "description": "Frontier model",
                    "supported_in_api": true,
                    "visibility": "list"
                },
                {
                    "slug": "gpt-5.3-codex-spark",
                    "display_name": "GPT-5.3-Codex-Spark",
                    "supported_in_api": false
                }
            ]
        });

        let models = parse_model_catalog(&value);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.5");
        assert!(models[0].supported_in_api);
        assert_eq!(models[1].id, "gpt-5.3-codex-spark");
        assert!(!models[1].supported_in_api);
    }
}
