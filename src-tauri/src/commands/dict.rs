//! Dictionary IPC:
//!   * `lookup_remote_dictionary` — private Dictionary API.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db;
use crate::keys::KeyVault;

#[derive(Debug, Clone, Serialize)]
pub struct DictionaryLookupEntry {
    pub dictionary_id: i64,
    pub dictionary_name: String,
    pub headword: String,
    pub definition_html: String,
    pub definition_page_html: String,
    pub definition_text: String,
    pub resolved_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DictionaryLookupResult {
    pub query: String,
    pub entries: Vec<DictionaryLookupEntry>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DictionaryApiConfigStored {
    enabled: bool,
    server_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryApiConfigView {
    pub enabled: bool,
    pub server_url: String,
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DictionaryApiConfigInput {
    enabled: Option<bool>,
    server_url: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDictionary {
    pub slug: String,
    pub name: String,
    #[serde(alias = "index_uid")]
    pub index_uid: String,
    #[serde(alias = "entry_count")]
    pub entry_count: i64,
    #[serde(alias = "updated_at_ms")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryApiStatus {
    pub ok: bool,
    pub dictionary_count: i64,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteDictionaryListResponse {
    dictionaries: Vec<RemoteDictionary>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteDictionaryLookupEntry {
    dictionary_id: i64,
    dictionary_name: String,
    headword: String,
    definition_html: String,
    definition_page_html: String,
    definition_text: String,
    resolved_from: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RemoteDictionaryLookupResult {
    query: String,
    entries: Vec<RemoteDictionaryLookupEntry>,
    elapsed_ms: u64,
}

const DICTIONARY_API_SETTING_KEY: &str = "dictionary_api_config";
const DICTIONARY_API_KEY_PROVIDER: &str = "dictionary_api";

// ---------------------------------------------------------------------------
// Dictionary API
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_dictionary_api_config(
    vault: State<'_, KeyVault>,
) -> Result<DictionaryApiConfigView, String> {
    dictionary_api_config_view(&vault)
        .await
        .map_err(|e| format!("load dictionary API config: {e}"))
}

#[tauri::command]
pub async fn save_dictionary_api_config(
    vault: State<'_, KeyVault>,
    config: serde_json::Value,
) -> Result<DictionaryApiConfigView, String> {
    let input: DictionaryApiConfigInput =
        serde_json::from_value(config).map_err(|e| format!("parse dictionary API config: {e}"))?;
    let mut stored = load_dictionary_api_config()
        .await
        .map_err(|e| format!("load dictionary API config: {e}"))?;
    if let Some(enabled) = input.enabled {
        stored.enabled = enabled;
    }
    if let Some(server_url) = input.server_url {
        stored.server_url = normalize_dictionary_api_server_url(&server_url)
            .map_err(|e| format!("dictionary API server URL: {e}"))?;
    }

    if let Some(api_key) = input.api_key {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            vault
                .remove(DICTIONARY_API_KEY_PROVIDER)
                .await
                .map_err(|e| format!("clear dictionary API key: {e}"))?;
        } else {
            vault
                .save(DICTIONARY_API_KEY_PROVIDER, trimmed.as_bytes())
                .await
                .map_err(|e| format!("save dictionary API key: {e}"))?;
        }
    }

    save_dictionary_api_config_stored(&stored)
        .await
        .map_err(|e| format!("save dictionary API config: {e}"))?;
    dictionary_api_config_view(&vault)
        .await
        .map_err(|e| format!("reload dictionary API config: {e}"))
}

#[tauri::command]
pub async fn test_dictionary_api_config(
    vault: State<'_, KeyVault>,
) -> Result<DictionaryApiStatus, String> {
    let resolved = dictionary_api_resolved_for_test(&vault).await?;
    let dictionaries = fetch_remote_dictionaries_resolved(&resolved).await?;
    Ok(DictionaryApiStatus {
        ok: true,
        dictionary_count: dictionaries.len() as i64,
        message: format!(
            "Connected to dictionary API; {} dictionar{} available.",
            dictionaries.len(),
            if dictionaries.len() == 1 { "y" } else { "ies" }
        ),
    })
}

#[tauri::command]
pub async fn list_remote_dictionaries(
    vault: State<'_, KeyVault>,
) -> Result<Vec<RemoteDictionary>, String> {
    fetch_remote_dictionaries(&vault, false).await
}

#[tauri::command]
pub async fn lookup_remote_dictionary(
    vault: State<'_, KeyVault>,
    query: String,
    dictionary_slug: Option<String>,
    limit: Option<usize>,
) -> Result<DictionaryLookupResult, String> {
    let start = Instant::now();
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(DictionaryLookupResult {
            query,
            entries: Vec::new(),
            elapsed_ms: 0,
        });
    }
    let Some(resolved) = dictionary_api_resolved(&vault, false).await? else {
        return Ok(DictionaryLookupResult {
            query,
            entries: Vec::new(),
            elapsed_ms: 0,
        });
    };
    let max_results = limit.unwrap_or(4).clamp(1, 10);
    let mut url = url::Url::parse(&format!("{}/api/v1/lookup", resolved.server_url))
        .map_err(|e| format!("dictionary API lookup URL: {e}"))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("query", &query);
        pairs.append_pair("limit", &max_results.to_string());
        if let Some(slug) = dictionary_slug
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            pairs.append_pair("dictionary", slug);
        }
    }
    let client = dictionary_api_http_client()?;
    let remote: RemoteDictionaryLookupResult = client
        .get(url)
        .bearer_auth(&resolved.api_key)
        .send()
        .await
        .map_err(|e| format!("dictionary API lookup request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("dictionary API lookup failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("dictionary API lookup JSON: {e}"))?;

    Ok(DictionaryLookupResult {
        query: remote.query,
        entries: remote
            .entries
            .into_iter()
            .map(|entry| DictionaryLookupEntry {
                dictionary_id: entry.dictionary_id,
                dictionary_name: entry.dictionary_name,
                headword: entry.headword,
                definition_html: entry.definition_html,
                definition_page_html: entry.definition_page_html,
                definition_text: entry.definition_text,
                resolved_from: entry.resolved_from,
            })
            .collect(),
        elapsed_ms: remote.elapsed_ms.max(start.elapsed().as_millis() as u64),
    })
}

struct DictionaryApiResolved {
    server_url: String,
    api_key: String,
}

async fn dictionary_api_config_view(
    vault: &State<'_, KeyVault>,
) -> Result<DictionaryApiConfigView, String> {
    let stored = load_dictionary_api_config().await?;
    Ok(DictionaryApiConfigView {
        enabled: stored.enabled,
        server_url: stored.server_url,
        has_api_key: vault
            .has(DICTIONARY_API_KEY_PROVIDER)
            .await
            .map_err(|e| format!("probe dictionary API key: {e}"))?,
    })
}

async fn load_dictionary_api_config() -> Result<DictionaryApiConfigStored, String> {
    let Some(raw) = db::settings::get(DICTIONARY_API_SETTING_KEY)
        .await
        .map_err(|e| format!("read dictionary API config: {e}"))?
    else {
        return Ok(DictionaryApiConfigStored::default());
    };
    serde_json::from_str(&raw).map_err(|e| format!("parse dictionary API config: {e}"))
}

async fn save_dictionary_api_config_stored(
    config: &DictionaryApiConfigStored,
) -> Result<(), String> {
    let raw = serde_json::to_string(config)
        .map_err(|e| format!("serialize dictionary API config: {e}"))?;
    db::settings::set(DICTIONARY_API_SETTING_KEY, &raw)
        .await
        .map_err(|e| format!("write dictionary API config: {e}"))
}

async fn dictionary_api_resolved(
    vault: &State<'_, KeyVault>,
    require_enabled: bool,
) -> Result<Option<DictionaryApiResolved>, String> {
    let stored = load_dictionary_api_config().await?;
    if require_enabled && !stored.enabled {
        return Err("dictionary API is disabled".to_string());
    }
    if !stored.enabled && !require_enabled {
        return Ok(None);
    }
    if stored.server_url.trim().is_empty() {
        if require_enabled {
            return Err("dictionary API server URL is not configured".to_string());
        }
        return Ok(None);
    }
    let Some(api_key) = vault
        .get(DICTIONARY_API_KEY_PROVIDER)
        .await
        .map_err(|e| format!("read dictionary API key: {e}"))?
    else {
        if require_enabled {
            return Err("dictionary API key is not configured".to_string());
        }
        return Ok(None);
    };
    let api_key =
        String::from_utf8(api_key).map_err(|e| format!("dictionary API key UTF-8: {e}"))?;
    Ok(Some(DictionaryApiResolved {
        server_url: stored.server_url,
        api_key,
    }))
}

async fn dictionary_api_resolved_for_test(
    vault: &State<'_, KeyVault>,
) -> Result<DictionaryApiResolved, String> {
    let stored = load_dictionary_api_config().await?;
    if stored.server_url.trim().is_empty() {
        return Err("dictionary API server URL is not configured".to_string());
    }
    let Some(api_key) = vault
        .get(DICTIONARY_API_KEY_PROVIDER)
        .await
        .map_err(|e| format!("read dictionary API key: {e}"))?
    else {
        return Err("dictionary API key is not configured".to_string());
    };
    let api_key =
        String::from_utf8(api_key).map_err(|e| format!("dictionary API key UTF-8: {e}"))?;
    Ok(DictionaryApiResolved {
        server_url: stored.server_url,
        api_key,
    })
}

async fn fetch_remote_dictionaries(
    vault: &State<'_, KeyVault>,
    require_enabled: bool,
) -> Result<Vec<RemoteDictionary>, String> {
    let Some(resolved) = dictionary_api_resolved(vault, require_enabled).await? else {
        return Ok(Vec::new());
    };
    fetch_remote_dictionaries_resolved(&resolved).await
}

async fn fetch_remote_dictionaries_resolved(
    resolved: &DictionaryApiResolved,
) -> Result<Vec<RemoteDictionary>, String> {
    let url = format!("{}/api/v1/dictionaries", resolved.server_url);
    let response: RemoteDictionaryListResponse = dictionary_api_http_client()?
        .get(url)
        .bearer_auth(&resolved.api_key)
        .send()
        .await
        .map_err(|e| format!("dictionary API list request: {e}"))?
        .error_for_status()
        .map_err(|e| format!("dictionary API list failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("dictionary API list JSON: {e}"))?;
    Ok(response.dictionaries)
}

fn dictionary_api_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("dictionary API HTTP client: {e}"))
}

fn normalize_dictionary_api_server_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = url::Url::parse(&with_scheme).map_err(|e| e.to_string())?;
    if parsed.host_str().is_none() {
        return Err("server URL must include a host".to_string());
    }
    Ok(with_scheme)
}

#[cfg(test)]
mod tests {
    use super::{
        fetch_remote_dictionaries_resolved, normalize_dictionary_api_server_url,
        DictionaryApiResolved,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn dictionary_api_server_url_defaults_to_http_and_trims_slash() {
        assert_eq!(
            normalize_dictionary_api_server_url("example.test:8080/").unwrap(),
            "http://example.test:8080"
        );
        assert_eq!(
            normalize_dictionary_api_server_url("https://dict.example.test/").unwrap(),
            "https://dict.example.test"
        );
    }

    #[test]
    fn empty_dictionary_api_server_url_is_allowed_for_disabled_config() {
        assert_eq!(normalize_dictionary_api_server_url("   ").unwrap(), "");
    }

    #[tokio::test]
    async fn dictionary_api_client_lists_dictionaries_with_bearer_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            let request = String::from_utf8_lossy(&buf[..n]).to_lowercase();
            assert!(request.starts_with("get /api/v1/dictionaries "));
            assert!(request.contains("\r\nauthorization: bearer test-key\r\n"));

            let body = r#"{"dictionaries":[{"slug":"oald","name":"Oxford","index_uid":"dict_oald","entry_count":12,"updated_at_ms":34}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        let resolved = DictionaryApiResolved {
            server_url: format!("http://{addr}"),
            api_key: "test-key".to_string(),
        };
        let dictionaries = fetch_remote_dictionaries_resolved(&resolved).await.unwrap();

        assert_eq!(dictionaries.len(), 1);
        assert_eq!(dictionaries[0].slug, "oald");
        assert_eq!(dictionaries[0].index_uid, "dict_oald");
        assert_eq!(dictionaries[0].entry_count, 12);
        server.await.unwrap();
    }
}
