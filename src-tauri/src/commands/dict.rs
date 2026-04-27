//! Three-tier dictionary IPC:
//!   * `lookup_offline` — bundled ECDICT (≤1 ms after bootstrap).
//!   * `lookup_online`  — Youdao / DeepL via reqwest + `word_translations_cache`.
//!   * `lookup_ai`      — OpenAI / Anthropic / Ollama via reqwest, cached by
//!                        `sha1(context_sentence)`.
//!
//! Every tier writes back into `word_translations_cache` so the second hit is
//! served locally in < 10 ms. API keys are read from `KeyVault` — never from
//! the frontend.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use mdict_rs::{MddFile, MdxFile};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha1::{Digest as _, Sha1};
use sha2::Sha256;
use tauri::{AppHandle, Manager, State};
use wordbrain_resource_manager::{
    clean_resource_path, cloud_config_draft_from_value, public_url_for_file, ResourceCloudConfig,
    ResourceCloudConfigDraft, ResourceCloudCredentials, ResourceCloudSettings,
};

use crate::db;
use crate::keys::KeyVault;

static MDX_CACHE: OnceLock<Mutex<HashMap<String, MdxFile>>> = OnceLock::new();
static MDD_CACHE: OnceLock<Mutex<HashMap<String, MddFile>>> = OnceLock::new();
const MAX_DATABASE_ASSET_BYTES: u64 = 5 * 1024 * 1024;
const MAX_INLINE_RENDER_ASSET_BYTES: usize = 5 * 1024 * 1024;

/// Helper: sha1(s) as a lowercase hex string.
fn sha1_hex(s: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(s.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug, Clone, Serialize)]
pub struct OfflineLookupResult {
    pub entry: Option<db::dict::OfflineEntry>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OnlineLookupResult {
    pub lemma: String,
    pub provider: String,
    pub translation_zh: String,
    pub example: Option<String>,
    pub cached: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiLookupResult {
    pub lemma: String,
    pub provider: String,
    pub model: String,
    pub context_hash: String,
    pub translation_zh: String,
    pub cached: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomDictionaryLookupEntry {
    pub dictionary_id: i64,
    pub dictionary_name: String,
    pub headword: String,
    pub definition_html: String,
    pub definition_page_html: String,
    pub definition_text: String,
    pub resolved_from: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CustomDictionaryLookupResult {
    pub query: String,
    pub entries: Vec<CustomDictionaryLookupEntry>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCloudConfigView {
    pub name: String,
    pub enabled: bool,
    pub upload_enabled: bool,
    pub endpoint_scheme: String,
    pub endpoint_host: String,
    pub bucket: String,
    pub public_domain_scheme: String,
    pub public_domain_host: String,
    pub prefix: String,
    pub has_access_key_id: bool,
    pub has_secret_access_key: bool,
    pub has_api_token: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryResourceUploadResult {
    pub dictionary_count: i64,
    pub page_asset_count: i64,
    pub archive_resource_count: i64,
    pub uploaded_count: i64,
    pub skipped_count: i64,
    pub failed_count: i64,
    pub uploaded_bytes: i64,
    pub first_error: Option<String>,
}

type DictionaryCloudConfigStored = ResourceCloudSettings;
type DictionaryCloudConfigResolved = ResourceCloudConfig;

const DICTIONARY_CLOUD_SETTING_KEY: &str = "upload_server_config";
const DICTIONARY_CLOUD_ACCESS_KEY: &str = "secret::dictionary_cloud_access_key_id";
const DICTIONARY_CLOUD_SECRET_KEY: &str = "secret::dictionary_cloud_secret_access_key";
const DICTIONARY_CLOUD_API_TOKEN_KEY: &str = "secret::dictionary_cloud_api_token";
const MAX_CLOUD_RESOURCE_UPLOAD_BYTES: usize = 64 * 1024 * 1024;
const DICTIONARY_CLOUD_DEFAULT_PREFIX: &str = "wordbrain/resources";
const DICTIONARY_CLOUD_LEGACY_SETTING_KEYS: &[&str] = &[
    "custom_dictionary_cloud_config",
    "dictionary_resource_cloud_config",
    "dictionary_r2_config",
    "resource_cloud_config",
    "r2_config",
];

// ---------------------------------------------------------------------------
// Offline
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn lookup_offline(app: AppHandle, lemma: String) -> Result<OfflineLookupResult, String> {
    let start = Instant::now();
    let entry = db::dict::lookup_offline(&app, &lemma)
        .await
        .map_err(|e| format!("lookup_offline: {e}"))?;
    Ok(OfflineLookupResult {
        entry,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// User MDict dictionaries
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_upload_server_config(
    _vault: State<'_, KeyVault>,
) -> Result<DictionaryCloudConfigView, String> {
    dictionary_cloud_config_view()
        .await
        .map_err(|e| format!("load upload server config: {e}"))
}

#[tauri::command]
pub async fn save_upload_server_config(
    _vault: State<'_, KeyVault>,
    config: serde_json::Value,
) -> Result<DictionaryCloudConfigView, String> {
    let draft = cloud_config_draft_from_value(config, DICTIONARY_CLOUD_DEFAULT_PREFIX)
        .map_err(|e| format!("parse upload server config: {e}"))?;
    let stored = draft.settings.clone();

    validate_cloud_stored_config(&stored).map_err(|e| format!("upload server config: {e}"))?;

    persist_dictionary_cloud_config_draft(draft).await?;

    dictionary_cloud_config_view()
        .await
        .map_err(|e| format!("reload upload server config: {e}"))
}

#[tauri::command]
pub async fn get_dictionary_cloud_config(
    _vault: State<'_, KeyVault>,
) -> Result<DictionaryCloudConfigView, String> {
    dictionary_cloud_config_view()
        .await
        .map_err(|e| format!("load dictionary resource cloud config: {e}"))
}

#[tauri::command]
pub async fn save_dictionary_cloud_config(
    _vault: State<'_, KeyVault>,
    config: serde_json::Value,
) -> Result<DictionaryCloudConfigView, String> {
    let draft = cloud_config_draft_from_value(config, DICTIONARY_CLOUD_DEFAULT_PREFIX)
        .map_err(|e| format!("parse dictionary resource cloud config: {e}"))?;
    let stored = draft.settings.clone();

    validate_cloud_stored_config(&stored)
        .map_err(|e| format!("dictionary resource cloud config: {e}"))?;

    persist_dictionary_cloud_config_draft(draft).await?;

    dictionary_cloud_config_view()
        .await
        .map_err(|e| format!("reload dictionary resource cloud config: {e}"))
}

fn validate_cloud_stored_config(config: &DictionaryCloudConfigStored) -> Result<(), String> {
    if !config.enabled {
        return Ok(());
    }
    config.validate_public().map_err(|e| e.to_string())?;
    config.validate_upload().map_err(|e| e.to_string())?;
    Ok(())
}

async fn dictionary_cloud_config_view() -> Result<DictionaryCloudConfigView, String> {
    let stored = load_dictionary_cloud_config().await?;
    Ok(DictionaryCloudConfigView {
        name: stored.name,
        enabled: stored.enabled,
        upload_enabled: stored.upload_enabled,
        endpoint_scheme: stored.endpoint_scheme,
        endpoint_host: stored.endpoint_host,
        bucket: stored.bucket,
        public_domain_scheme: stored.public_domain_scheme,
        public_domain_host: stored.public_domain_host,
        prefix: stored.prefix,
        has_access_key_id: has_dictionary_secret(DICTIONARY_CLOUD_ACCESS_KEY).await?,
        has_secret_access_key: has_dictionary_secret(DICTIONARY_CLOUD_SECRET_KEY).await?,
        has_api_token: has_dictionary_secret(DICTIONARY_CLOUD_API_TOKEN_KEY).await?,
    })
}

async fn load_dictionary_cloud_config() -> Result<DictionaryCloudConfigStored, String> {
    let Some((setting_key, raw)) = load_dictionary_cloud_config_raw().await? else {
        return Ok(default_dictionary_cloud_settings());
    };
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse cloud config setting: {e}"))?;
    let draft = cloud_config_draft_from_value(value, DICTIONARY_CLOUD_DEFAULT_PREFIX)
        .map_err(|e| format!("parse cloud config setting: {e}"))?;
    let mut config = draft.settings.clone();
    if config.prefix.trim().is_empty() {
        config.prefix = DICTIONARY_CLOUD_DEFAULT_PREFIX.to_string();
    }
    if setting_key != DICTIONARY_CLOUD_SETTING_KEY
        || draft.access_key_id.is_some()
        || draft.secret_access_key.is_some()
        || draft.api_token.is_some()
    {
        persist_dictionary_cloud_config_draft(ResourceCloudConfigDraft {
            settings: config.clone(),
            ..draft
        })
        .await?;
    }
    Ok(config)
}

async fn load_dictionary_cloud_config_raw() -> Result<Option<(String, String)>, String> {
    if let Some(raw) = db::settings::get(DICTIONARY_CLOUD_SETTING_KEY)
        .await
        .map_err(|e| format!("load cloud config setting: {e}"))?
    {
        return Ok(Some((DICTIONARY_CLOUD_SETTING_KEY.to_string(), raw)));
    }

    for key in DICTIONARY_CLOUD_LEGACY_SETTING_KEYS {
        if let Some(raw) = db::settings::get(key)
            .await
            .map_err(|e| format!("load legacy cloud config setting: {e}"))?
        {
            return Ok(Some(((*key).to_string(), raw)));
        }
    }

    Ok(None)
}

async fn persist_dictionary_cloud_config_draft(
    draft: ResourceCloudConfigDraft,
) -> Result<DictionaryCloudConfigStored, String> {
    let stored = draft.settings;
    db::settings::set(
        DICTIONARY_CLOUD_SETTING_KEY,
        &serde_json::to_string(&stored).map_err(|e| format!("serialize cloud config: {e}"))?,
    )
    .await
    .map_err(|e| format!("save dictionary resource cloud config: {e}"))?;

    let mut secrets = Vec::new();
    if let Some(value) = draft.access_key_id {
        secrets.push((DICTIONARY_CLOUD_ACCESS_KEY.to_string(), value));
    }
    if let Some(value) = draft.secret_access_key {
        secrets.push((DICTIONARY_CLOUD_SECRET_KEY.to_string(), value));
    }
    if let Some(value) = draft.api_token {
        secrets.push((DICTIONARY_CLOUD_API_TOKEN_KEY.to_string(), value));
    }
    for (key, value) in secrets {
        save_dictionary_secret(&key, &value).await?;
    }

    Ok(stored)
}

async fn dictionary_cloud_config_resolved() -> Result<Option<DictionaryCloudConfigResolved>, String>
{
    let stored = load_dictionary_cloud_config().await?;
    if !stored.enabled {
        return Ok(None);
    }
    validate_cloud_stored_config(&stored)?;

    let access_key_id = dictionary_secret_string(DICTIONARY_CLOUD_ACCESS_KEY).await?;
    let secret_access_key = dictionary_secret_string(DICTIONARY_CLOUD_SECRET_KEY).await?;
    let credentials = match (access_key_id, secret_access_key) {
        (Some(access_key_id), Some(secret_access_key))
            if !access_key_id.trim().is_empty() && !secret_access_key.trim().is_empty() =>
        {
            Some(ResourceCloudCredentials {
                access_key_id,
                secret_access_key,
            })
        }
        _ => None,
    };

    Ok(Some(ResourceCloudConfig {
        settings: stored,
        credentials,
    }))
}

async fn save_dictionary_secret(key: &str, value: &str) -> Result<(), String> {
    db::settings::set(key, value)
        .await
        .map_err(|e| format!("save cloud credential: {e}"))
}

async fn has_dictionary_secret(key: &str) -> Result<bool, String> {
    db::settings::get(key)
        .await
        .map(|value| value.is_some_and(|value| !value.trim().is_empty()))
        .map_err(|e| format!("check cloud credential: {e}"))
}

async fn dictionary_secret_string(key: &str) -> Result<Option<String>, String> {
    db::settings::get(key)
        .await
        .map(|value| value.filter(|value| !value.trim().is_empty()))
        .map_err(|e| format!("read cloud credential: {e}"))
}

fn default_dictionary_cloud_settings() -> ResourceCloudSettings {
    ResourceCloudSettings {
        prefix: DICTIONARY_CLOUD_DEFAULT_PREFIX.to_string(),
        ..ResourceCloudSettings::default()
    }
}

#[tauri::command]
pub async fn import_custom_dictionary(
    app: AppHandle,
    _vault: State<'_, KeyVault>,
    path: String,
    css_path: Option<String>,
) -> Result<db::custom_dicts::CustomDictionary, String> {
    let source_path = canonical_path(&path)?;
    let explicit_css_path = css_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(canonical_path)
        .transpose()?;
    let mdx_path = find_mdx_path(&source_path)?;
    let resource_archive_paths = find_related_mdd_paths(&source_path, &mdx_path)?;
    let source_path_str = path_to_string(&source_path)?;
    let mdx_path_str = path_to_string(&mdx_path)?;
    let name = dictionary_name(&source_path, &mdx_path);

    let entry_count = mdx_keyword_count(mdx_path_str.clone()).await?;
    let files = read_dictionary_files_for_database(
        source_path.clone(),
        mdx_path.clone(),
        explicit_css_path,
    )
    .await?;

    let imported =
        db::custom_dicts::upsert_import(&name, &source_path_str, &mdx_path_str, entry_count, files)
            .await
            .map_err(|e| format!("save custom dictionary: {e}"))?;

    let resource_archives =
        materialize_resource_archives(&app, imported.id, resource_archive_paths).await?;
    db::custom_dicts::replace_resource_archives(imported.id, resource_archives)
        .await
        .map_err(|e| format!("save dictionary resource libraries: {e}"))?;

    if let Some(cloud_config) = dictionary_cloud_config_resolved().await? {
        upload_imported_database_assets(imported.id, &cloud_config).await?;
    }

    let _ = materialized_mdx_path(&app, &imported).await;
    db::custom_dicts::get(imported.id)
        .await
        .map_err(|e| format!("reload custom dictionary: {e}"))?
        .ok_or_else(|| "custom dictionary disappeared after import".to_string())
}

#[tauri::command]
pub async fn list_custom_dictionaries() -> Result<Vec<db::custom_dicts::CustomDictionary>, String> {
    db::custom_dicts::list()
        .await
        .map_err(|e| format!("list custom dictionaries: {e}"))
}

#[tauri::command]
pub async fn upload_dictionary_resources(
    app: AppHandle,
    _vault: State<'_, KeyVault>,
    dictionary_id: Option<i64>,
    force: Option<bool>,
) -> Result<DictionaryResourceUploadResult, String> {
    let cloud_config = dictionary_cloud_config_resolved()
        .await?
        .ok_or_else(|| "dictionary cloud upload is not configured".to_string())?;
    if !cloud_config.can_upload() {
        return Err(
            "dictionary cloud upload needs endpoint, bucket, access key, and secret key"
                .to_string(),
        );
    }

    let dictionaries = if let Some(id) = dictionary_id {
        db::custom_dicts::get(id)
            .await
            .map_err(|e| format!("load custom dictionary: {e}"))?
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        db::custom_dicts::list()
            .await
            .map_err(|e| format!("list custom dictionaries: {e}"))?
    };

    let mut summary = DictionaryResourceUploadResult {
        dictionary_count: dictionaries.len() as i64,
        page_asset_count: 0,
        archive_resource_count: 0,
        uploaded_count: 0,
        skipped_count: 0,
        failed_count: 0,
        uploaded_bytes: 0,
        first_error: None,
    };
    let force = force.unwrap_or(false);

    for dictionary in dictionaries {
        upload_dictionary_resources_for(&app, &dictionary, &cloud_config, force, &mut summary)
            .await?;
    }

    Ok(summary)
}

#[tauri::command]
pub async fn lookup_custom_dictionary(
    app: AppHandle,
    vault: State<'_, KeyVault>,
    query: String,
    dictionary_id: Option<i64>,
    limit: Option<usize>,
) -> Result<CustomDictionaryLookupResult, String> {
    let start = Instant::now();
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(CustomDictionaryLookupResult {
            query,
            entries: Vec::new(),
            elapsed_ms: 0,
        });
    }

    let max_results = limit.unwrap_or(4).clamp(1, 10);
    let dictionaries = if let Some(id) = dictionary_id {
        db::custom_dicts::get(id)
            .await
            .map_err(|e| format!("load custom dictionary: {e}"))?
            .into_iter()
            .collect::<Vec<_>>()
    } else {
        db::custom_dicts::list()
            .await
            .map_err(|e| format!("list custom dictionaries: {e}"))?
    };

    let mut entries = Vec::new();
    for dict in dictionaries {
        if entries.len() >= max_results {
            break;
        }
        let _ = ensure_dictionary_resource_archives(&app, &dict).await?;
        let remaining = max_results - entries.len();
        let mdx_path = materialized_mdx_path(&app, &dict).await?;
        let cache_key = format!("{}:{}:{}", dict.id, dict.updated_at, mdx_path);
        let query_for_lookup = query.clone();
        let raw_entries = with_cached_mdx(cache_key, mdx_path, move |mdx| {
            Ok(lookup_mdx_entries(mdx, &query_for_lookup, remaining))
        })
        .await?;
        let page_assets = dictionary_page_assets(dict.id, &vault).await?;

        for entry in raw_entries {
            let definition_page_html =
                build_definition_page_html(&entry.definition, &page_assets).await;
            entries.push(CustomDictionaryLookupEntry {
                dictionary_id: dict.id,
                dictionary_name: dict.name.clone(),
                definition_text: html_to_text(&entry.definition),
                definition_page_html,
                headword: entry.key_text,
                definition_html: entry.definition,
                resolved_from: entry.resolved_from,
            });
        }
    }

    Ok(CustomDictionaryLookupResult {
        query,
        entries,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

#[derive(Debug, Clone)]
struct MdxLookupEntry {
    key_text: String,
    definition: String,
    resolved_from: Option<String>,
}

async fn with_cached_mdx<T, F>(cache_key: String, mdx_path: String, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&MdxFile) -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let cache = MDX_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache
            .lock()
            .map_err(|_| "custom dictionary cache lock poisoned".to_string())?;
        if !cache.contains_key(&cache_key) {
            let mdx = MdxFile::open(&mdx_path)
                .map_err(|e| format!("open mdx {}: {e}", mdx_path.as_str()))?;
            cache.insert(cache_key.clone(), mdx);
        }
        let mdx = cache
            .get(&cache_key)
            .ok_or_else(|| "custom dictionary cache insert failed".to_string())?;
        f(mdx)
    })
    .await
    .map_err(|e| format!("custom dictionary worker failed: {e}"))?
}

async fn mdx_keyword_count(mdx_path: String) -> Result<i64, String> {
    tokio::task::spawn_blocking(move || read_mdx_keyword_count(&PathBuf::from(mdx_path)))
        .await
        .map_err(|e| format!("custom dictionary import worker failed: {e}"))?
}

fn read_mdx_keyword_count(path: &Path) -> Result<i64, String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = std::fs::File::open(path).map_err(|e| format!("open mdx header: {e}"))?;
    let mut header_len_buf = [0u8; 4];
    file.read_exact(&mut header_len_buf)
        .map_err(|e| format!("read mdx header length: {e}"))?;
    let header_len = u32::from_be_bytes(header_len_buf) as usize;
    let mut header_buf = vec![0u8; header_len];
    file.read_exact(&mut header_buf)
        .map_err(|e| format!("read mdx header: {e}"))?;
    let header_text = utf16le_lossy(&header_buf);
    let version = header_attr(&header_text, "GeneratedByEngineVersion")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(1.2);
    let num_width = if version >= 2.0 { 8 } else { 4 };
    let key_header_size = if version >= 2.0 { 8 * 5 } else { 4 * 4 };
    let key_header_start = header_len as u64 + 8;

    file.seek(SeekFrom::Start(key_header_start))
        .map_err(|e| format!("seek mdx key header: {e}"))?;
    let mut key_header = vec![0u8; key_header_size];
    file.read_exact(&mut key_header)
        .map_err(|e| format!("read mdx key header: {e}"))?;
    let count = read_be_number(&key_header[num_width..num_width * 2])?;
    i64::try_from(count).map_err(|_| "mdx keyword count is too large".to_string())
}

fn utf16le_lossy(bytes: &[u8]) -> String {
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}

fn header_attr(header: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=\"");
    let start = header.find(&prefix)? + prefix.len();
    let end = header[start..].find('"')?;
    Some(header[start..start + end].to_string())
}

fn read_be_number(bytes: &[u8]) -> Result<u64, String> {
    match bytes.len() {
        4 => Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as u64),
        8 => Ok(u64::from_be_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ])),
        _ => Err("unsupported mdx number width".to_string()),
    }
}

async fn materialized_mdx_path(
    app: &AppHandle,
    dict: &db::custom_dicts::CustomDictionary,
) -> Result<String, String> {
    let Some(meta) = db::custom_dicts::get_file_meta(dict.id, "mdx")
        .await
        .map_err(|e| format!("load dictionary mdx metadata: {e}"))?
    else {
        if Path::new(&dict.mdx_path).is_file() {
            return Ok(dict.mdx_path.clone());
        }
        return Err(format!(
            "{} is missing its local database MDX; reimport the dictionary",
            dict.name
        ));
    };

    let file_name = safe_file_name(&meta.file_name)?;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    let cache_root = app_dir.join("custom-dictionary-cache");
    let keep_dir_name = format!("{}-{}", dict.id, dict.updated_at);
    let cache_dir = cache_root.join(&keep_dir_name);
    let target = cache_dir.join(file_name);

    let current_size = std::fs::metadata(&target).map(|m| m.len() as i64).ok();
    if current_size != Some(meta.byte_size) {
        let file = db::custom_dicts::get_file(dict.id, "mdx", &meta.file_name)
            .await
            .map_err(|e| format!("load dictionary mdx from database: {e}"))?
            .ok_or_else(|| "dictionary mdx blob disappeared during lookup".to_string())?;
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|e| format!("create dictionary cache dir: {e}"))?;
        tokio::fs::write(&target, file.content)
            .await
            .map_err(|e| format!("write dictionary cache file: {e}"))?;
    }

    prune_dictionary_cache_dirs(&cache_root, dict.id, &keep_dir_name).await;

    path_to_string(&target)
}

async fn prune_dictionary_cache_dirs(cache_root: &Path, dictionary_id: i64, keep_dir_name: &str) {
    let Ok(mut entries) = tokio::fs::read_dir(cache_root).await else {
        return;
    };
    let prefix = format!("{dictionary_id}-");
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == keep_dir_name || !file_name.starts_with(&prefix) {
            continue;
        }
        let _ = tokio::fs::remove_dir_all(entry.path()).await;
    }
}

async fn materialize_resource_archives(
    app: &AppHandle,
    dictionary_id: i64,
    archive_paths: Vec<PathBuf>,
) -> Result<Vec<db::custom_dicts::DictionaryResourceArchiveInput>, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    let cache_dir = app_dir
        .join("custom-dictionary-resources")
        .join(dictionary_id.to_string());
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("create dictionary resource cache dir: {e}"))?;

    let mut keep = HashSet::new();
    let mut archives = Vec::new();
    for source in archive_paths {
        let file_name = path_file_name(&source)?;
        let safe_name = safe_file_name(&file_name)?;
        let target = cache_dir.join(safe_name);
        let source_meta = tokio::fs::metadata(&source)
            .await
            .map_err(|e| format!("read dictionary resource library metadata: {e}"))?;
        let target_size = tokio::fs::metadata(&target).await.map(|m| m.len()).ok();

        if target_size != Some(source_meta.len()) {
            tokio::fs::copy(&source, &target)
                .await
                .map_err(|e| format!("copy dictionary resource library: {e}"))?;
        }

        keep.insert(file_name.clone());
        archives.push(db::custom_dicts::DictionaryResourceArchiveInput {
            file_name,
            source_path: path_to_string(&source)?,
            cache_path: path_to_string(&target)?,
            byte_size: i64::try_from(source_meta.len())
                .map_err(|_| "dictionary resource library is too large".to_string())?,
        });
    }

    prune_resource_archive_dir(&cache_dir, &keep).await;
    Ok(archives)
}

async fn ensure_dictionary_resource_archives(
    app: &AppHandle,
    dictionary: &db::custom_dicts::CustomDictionary,
) -> Result<Vec<db::custom_dicts::DictionaryResourceArchive>, String> {
    let existing = db::custom_dicts::list_resource_archives(dictionary.id)
        .await
        .map_err(|e| format!("load dictionary resource libraries: {e}"))?;
    if resource_archives_are_materialized(&existing) {
        return Ok(existing);
    }

    let source_path = PathBuf::from(&dictionary.source_path);
    let mdx_path = PathBuf::from(&dictionary.mdx_path);
    let archive_paths = match find_related_mdd_paths(&source_path, &mdx_path) {
        Ok(paths) => paths,
        Err(_) => {
            return Ok(existing
                .into_iter()
                .filter(|archive| Path::new(&archive.cache_path).is_file())
                .collect());
        }
    };
    if archive_paths.is_empty() {
        return Ok(existing
            .into_iter()
            .filter(|archive| Path::new(&archive.cache_path).is_file())
            .collect());
    }

    let resource_archives =
        materialize_resource_archives(app, dictionary.id, archive_paths).await?;
    db::custom_dicts::replace_resource_archives(dictionary.id, resource_archives)
        .await
        .map_err(|e| format!("save dictionary resource libraries: {e}"))?;
    db::custom_dicts::list_resource_archives(dictionary.id)
        .await
        .map_err(|e| format!("reload dictionary resource libraries: {e}"))
}

fn resource_archives_are_materialized(
    archives: &[db::custom_dicts::DictionaryResourceArchive],
) -> bool {
    !archives.is_empty()
        && archives
            .iter()
            .all(|archive| Path::new(&archive.cache_path).is_file())
}

async fn prune_resource_archive_dir(cache_dir: &Path, keep: &HashSet<String>) {
    let Ok(mut entries) = tokio::fs::read_dir(cache_dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if keep.contains(&file_name) {
            continue;
        }
        let _ = tokio::fs::remove_file(entry.path()).await;
    }
}

async fn read_dictionary_files_for_database(
    source_path: PathBuf,
    mdx_path: PathBuf,
    explicit_css_path: Option<PathBuf>,
) -> Result<Vec<db::custom_dicts::DictionaryFileInput>, String> {
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        let mdx_file_name = path_file_name(&mdx_path)?;
        let mdx_content = std::fs::read(&mdx_path).map_err(|e| format!("read mdx file: {e}"))?;
        files.push(db::custom_dicts::DictionaryFileInput {
            role: "mdx".to_string(),
            file_name: mdx_file_name,
            media_type: "application/x-mdict-mdx".to_string(),
            content: mdx_content,
        });

        let asset_dir = mdx_path
            .parent()
            .map(Path::to_path_buf)
            .or_else(|| source_path.is_dir().then(|| source_path.clone()));
        if let Some(dir) = asset_dir {
            collect_database_asset_files(&mut files, &dir, &mdx_path, &dir, 2)?;
        }

        if let Some(css_path) = explicit_css_path {
            if !css_path.is_file() {
                return Err("dictionary CSS path must be a file".to_string());
            }
            let is_css = css_path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("css"));
            if !is_css {
                return Err("dictionary CSS file must have a .css extension".to_string());
            }
            let file_name = path_file_name(&css_path)?;
            push_database_asset_file(&mut files, &css_path, file_name)?;
        }

        Ok(files)
    })
    .await
    .map_err(|e| format!("dictionary file import worker failed: {e}"))?
}

fn collect_database_asset_files(
    files: &mut Vec<db::custom_dicts::DictionaryFileInput>,
    dir: &Path,
    mdx_path: &Path,
    root: &Path,
    remaining_depth: usize,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read dictionary folder: {e}"))? {
        let path = entry
            .map_err(|e| format!("read dictionary folder entry: {e}"))?
            .path();
        if path.is_dir() {
            if remaining_depth > 0 {
                collect_database_asset_files(files, &path, mdx_path, root, remaining_depth - 1)?;
            }
            continue;
        }

        if path == mdx_path || !path.is_file() || !is_page_asset(&path) {
            continue;
        }
        let meta =
            std::fs::metadata(&path).map_err(|e| format!("read dictionary asset metadata: {e}"))?;
        if meta.len() > MAX_DATABASE_ASSET_BYTES {
            continue;
        }
        let file_name = relative_asset_name(root, &path).unwrap_or_else(|| {
            path_file_name(&path).unwrap_or_else(|_| "dictionary-asset".to_string())
        });
        push_database_asset_file(files, &path, file_name)?;
    }
    Ok(())
}

fn push_database_asset_file(
    files: &mut Vec<db::custom_dicts::DictionaryFileInput>,
    path: &Path,
    file_name: String,
) -> Result<(), String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("read dictionary asset metadata: {e}"))?;
    if meta.len() > MAX_DATABASE_ASSET_BYTES {
        return Err(format!(
            "{} is too large to store as a dictionary page asset",
            path.display()
        ));
    }
    let media_type = media_type_for_path(path).to_string();
    let content = std::fs::read(path).map_err(|e| format!("read dictionary asset: {e}"))?;
    let next = db::custom_dicts::DictionaryFileInput {
        role: "asset".to_string(),
        file_name,
        media_type,
        content,
    };

    if let Some(existing) = files
        .iter_mut()
        .find(|file| file.role == next.role && file.file_name == next.file_name)
    {
        *existing = next;
    } else {
        files.push(next);
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct DictionaryRenderAsset {
    media_type: String,
    content: Vec<u8>,
}

#[derive(Debug, Clone)]
struct DictionaryPageAssets {
    dictionary_id: i64,
    database_assets: HashMap<String, DictionaryRenderAsset>,
    resource_archives: Vec<db::custom_dicts::DictionaryResourceArchive>,
    cloud_files: HashMap<String, db::custom_dicts::DictionaryCloudFile>,
    cloud_config: Option<DictionaryCloudConfigResolved>,
}

async fn dictionary_page_assets(
    dictionary_id: i64,
    _vault: &KeyVault,
) -> Result<DictionaryPageAssets, String> {
    let assets = db::custom_dicts::list_assets(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary page assets: {e}"))?;
    let resource_archives = db::custom_dicts::list_resource_archives(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary resource libraries: {e}"))?;
    let cloud_files = db::custom_dicts::list_cloud_files(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary cloud resources: {e}"))?;
    let cloud_config = dictionary_cloud_config_resolved().await?;
    let mut database_assets = HashMap::new();
    for asset in assets {
        database_assets.insert(
            normalized_asset_key(&asset.file_name),
            DictionaryRenderAsset {
                media_type: asset.media_type,
                content: asset.content,
            },
        );
    }
    let cloud_files = cloud_files
        .into_iter()
        .map(|file| (normalized_asset_key(&file.file_name), file))
        .collect::<HashMap<_, _>>();
    Ok(DictionaryPageAssets {
        dictionary_id,
        database_assets,
        resource_archives,
        cloud_files,
        cloud_config,
    })
}

async fn upload_imported_database_assets(
    dictionary_id: i64,
    config: &DictionaryCloudConfigResolved,
) -> Result<(), String> {
    if !config.can_upload() {
        return Ok(());
    }

    let assets = db::custom_dicts::list_assets(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary assets for cloud upload: {e}"))?;
    for asset in assets {
        if asset.content.len() > MAX_CLOUD_RESOURCE_UPLOAD_BYTES {
            continue;
        }
        upload_cloud_resource(
            dictionary_id,
            config,
            &asset.file_name,
            &asset.media_type,
            asset.content,
        )
        .await?;
    }
    Ok(())
}

async fn upload_dictionary_resources_for(
    app: &AppHandle,
    dictionary: &db::custom_dicts::CustomDictionary,
    config: &DictionaryCloudConfigResolved,
    force: bool,
    summary: &mut DictionaryResourceUploadResult,
) -> Result<(), String> {
    let dictionary_id = dictionary.id;
    let mut known_cloud_files = db::custom_dicts::list_cloud_files(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary cloud resources: {e}"))?
        .into_iter()
        .map(|file| normalized_asset_key(&file.file_name))
        .collect::<HashSet<_>>();

    let assets = db::custom_dicts::list_assets(dictionary_id)
        .await
        .map_err(|e| format!("load dictionary assets for cloud upload: {e}"))?;
    summary.page_asset_count += assets.len() as i64;
    for asset in assets {
        upload_dictionary_resource_bytes(
            dictionary_id,
            config,
            force,
            &mut known_cloud_files,
            &asset.file_name,
            &asset.media_type,
            asset.content,
            summary,
        )
        .await;
    }

    let archives = ensure_dictionary_resource_archives(app, dictionary).await?;
    for archive in archives {
        let keys = match mdd_resource_keys(archive.cache_path.clone()).await {
            Ok(keys) => keys,
            Err(error) => {
                record_resource_upload_failure(summary, error);
                continue;
            }
        };
        summary.archive_resource_count += keys.len() as i64;
        for key in keys {
            let lookup = lookup_mdd_resource(archive.cache_path.clone(), key.clone()).await;
            let content = match lookup {
                Ok(Some(content)) => content,
                Ok(None) => {
                    summary.skipped_count += 1;
                    continue;
                }
                Err(error) => {
                    record_resource_upload_failure(summary, error);
                    continue;
                }
            };
            let media_type = media_type_for_reference(&key);
            upload_dictionary_resource_bytes(
                dictionary_id,
                config,
                force,
                &mut known_cloud_files,
                &key,
                &media_type,
                content,
                summary,
            )
            .await;
        }
    }

    Ok(())
}

async fn upload_dictionary_resource_bytes(
    dictionary_id: i64,
    config: &DictionaryCloudConfigResolved,
    force: bool,
    known_cloud_files: &mut HashSet<String>,
    file_name: &str,
    media_type: &str,
    content: Vec<u8>,
    summary: &mut DictionaryResourceUploadResult,
) {
    let resource_path = clean_resource_path(file_name);
    if resource_path.is_empty() {
        summary.skipped_count += 1;
        return;
    }

    let cloud_key = normalized_asset_key(&resource_path);
    if !force && known_cloud_files.contains(&cloud_key) {
        summary.skipped_count += 1;
        return;
    }
    if content.len() > MAX_CLOUD_RESOURCE_UPLOAD_BYTES {
        summary.skipped_count += 1;
        return;
    }

    let byte_size = content.len() as i64;
    match upload_cloud_resource(dictionary_id, config, &resource_path, media_type, content).await {
        Ok(_) => {
            known_cloud_files.insert(cloud_key);
            summary.uploaded_count += 1;
            summary.uploaded_bytes += byte_size;
        }
        Err(error) => record_resource_upload_failure(summary, error),
    }
}

fn record_resource_upload_failure(summary: &mut DictionaryResourceUploadResult, error: String) {
    summary.failed_count += 1;
    if summary.first_error.is_none() {
        summary.first_error = Some(error);
    }
}

async fn upload_cloud_resource(
    dictionary_id: i64,
    config: &DictionaryCloudConfigResolved,
    file_name: &str,
    media_type: &str,
    content: Vec<u8>,
) -> Result<String, String> {
    if !config.can_upload() {
        return Err("dictionary cloud upload is not configured".to_string());
    }
    if content.len() > MAX_CLOUD_RESOURCE_UPLOAD_BYTES {
        return Err(format!(
            "{file_name} is too large to upload as a dictionary resource"
        ));
    }

    let resource_path = clean_resource_path(file_name);
    let uploaded = config
        .upload_bytes(
            &dictionary_id.to_string(),
            &resource_path,
            media_type,
            content.clone(),
        )
        .await
        .map_err(|e| format!("upload dictionary resource {file_name}: {e}"))?;

    db::custom_dicts::upsert_cloud_file(
        dictionary_id,
        &resource_path,
        media_type,
        &uploaded.public_url,
        content.len() as i64,
    )
    .await
    .map_err(|e| format!("save dictionary cloud resource: {e}"))?;
    Ok(uploaded.public_url)
}

async fn mdd_resource_keys(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mdd = MddFile::open(&path).map_err(|e| format!("open resource library {path}: {e}"))?;
        mdd.keys()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read resource library keys: {e}"))
    })
    .await
    .map_err(|e| format!("dictionary resource key worker failed: {e}"))?
}

fn lookup_mdx_entries(mdx: &MdxFile, query: &str, limit: usize) -> Vec<MdxLookupEntry> {
    let mut seen = HashSet::new();
    lookup_mdx_key(mdx, query, limit, None, 0, &mut seen)
}

fn lookup_mdx_key(
    mdx: &MdxFile,
    query: &str,
    limit: usize,
    resolved_from: Option<String>,
    depth: usize,
    seen: &mut HashSet<String>,
) -> Vec<MdxLookupEntry> {
    if limit == 0 || depth > 4 {
        return Vec::new();
    }

    let mut raw = Vec::new();
    if let Ok(Some(result)) = mdx.lookup(query) {
        raw.push(result);
    }

    let normalized = normalize_dict_key(query);
    if raw.is_empty() && normalized.chars().count() >= 3 && depth == 0 {
        let prefix_keys = mdx
            .keys()
            .filter_map(Result::ok)
            .filter(|key| normalize_dict_key(key).starts_with(&normalized))
            .take(limit)
            .collect::<Vec<_>>();
        for key in prefix_keys {
            if let Ok(Some(result)) = mdx.lookup(&key) {
                raw.push(result);
            }
        }
    }

    let mut out = Vec::new();
    for result in raw {
        if out.len() >= limit {
            break;
        }
        let dedupe_key = format!(
            "{}\u{1f}{}",
            normalize_dict_key(&result.key),
            resolved_from.as_deref().unwrap_or("")
        );
        if !seen.insert(dedupe_key) {
            continue;
        }

        if let Some(target) = mdict_redirect_target(&result.text) {
            let redirected = lookup_mdx_key(
                mdx,
                &target,
                limit - out.len(),
                Some(result.key.clone()),
                depth + 1,
                seen,
            );
            if redirected.is_empty() {
                out.push(MdxLookupEntry {
                    key_text: result.key,
                    definition: result.text,
                    resolved_from: resolved_from.clone(),
                });
            } else {
                out.extend(redirected);
            }
            continue;
        }

        out.push(MdxLookupEntry {
            key_text: result.key,
            definition: result.text,
            resolved_from: resolved_from.clone(),
        });
    }
    out
}

fn mdict_redirect_target(definition: &str) -> Option<String> {
    definition
        .trim_matches('\0')
        .trim()
        .strip_prefix("@@@LINK=")
        .map(str::trim)
        .filter(|target| !target.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_dict_key(value: &str) -> String {
    value.trim_matches('\0').trim().to_lowercase()
}

fn canonical_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("dictionary path is empty".to_string());
    }
    std::fs::canonicalize(trimmed).map_err(|e| format!("resolve dictionary path: {e}"))
}

fn find_mdx_path(source_path: &Path) -> Result<PathBuf, String> {
    if source_path.is_file() {
        let is_mdx = source_path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mdx"));
        if is_mdx {
            return Ok(source_path.to_path_buf());
        }
        return Err("dictionary file must have an .mdx extension".to_string());
    }

    if !source_path.is_dir() {
        return Err("dictionary path is neither a file nor a directory".to_string());
    }

    let mut root_candidates = mdx_files_in_dir(source_path)?;
    if root_candidates.is_empty() {
        root_candidates = mdx_files_recursive(source_path, 3)?;
    }
    root_candidates
        .into_iter()
        .max_by_key(|path| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
        .ok_or_else(|| "no .mdx file found in dictionary folder".to_string())
}

fn find_related_mdd_paths(source_path: &Path, mdx_path: &Path) -> Result<Vec<PathBuf>, String> {
    let Some(dir) = mdx_path
        .parent()
        .map(Path::to_path_buf)
        .or_else(|| source_path.is_dir().then(|| source_path.to_path_buf()))
    else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read dictionary folder: {e}"))? {
        let path = entry
            .map_err(|e| format!("read dictionary folder entry: {e}"))?
            .path();
        if path.is_file()
            && path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mdd"))
        {
            out.push(path);
        }
    }
    out.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(out)
}

fn mdx_files_in_dir(dir: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read dictionary folder: {e}"))?;
    let mut out = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("read dictionary folder entry: {e}"))?
            .path();
        if path.is_file()
            && path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mdx"))
        {
            out.push(path);
        }
    }
    Ok(out)
}

fn mdx_files_recursive(root: &Path, max_depth: usize) -> Result<Vec<PathBuf>, String> {
    fn walk(
        path: &Path,
        depth: usize,
        max_depth: usize,
        out: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        if depth > max_depth {
            return Ok(());
        }
        for entry in std::fs::read_dir(path).map_err(|e| format!("read dictionary folder: {e}"))? {
            let path = entry
                .map_err(|e| format!("read dictionary folder entry: {e}"))?
                .path();
            if path.is_dir() {
                walk(&path, depth + 1, max_depth, out)?;
            } else if path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("mdx"))
            {
                out.push(path);
            }
        }
        Ok(())
    }

    let mut out = Vec::new();
    walk(root, 0, max_depth, &mut out)?;
    Ok(out)
}

fn dictionary_name(source_path: &Path, mdx_path: &Path) -> String {
    source_path
        .file_name()
        .or_else(|| mdx_path.file_stem())
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("Custom Dictionary")
        .to_string()
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "dictionary path is not valid UTF-8".to_string())
}

fn path_file_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "dictionary file name is not valid UTF-8".to_string())
}

fn relative_asset_name(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root).ok().and_then(|relative| {
        let parts = relative
            .components()
            .filter_map(|component| match component {
                std::path::Component::Normal(part) => part.to_str().map(ToOwned::to_owned),
                _ => None,
            })
            .collect::<Vec<_>>();
        (!parts.is_empty()).then(|| parts.join("/"))
    })
}

fn safe_file_name(file_name: &str) -> Result<PathBuf, String> {
    let path = Path::new(file_name);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "dictionary database file name is not valid UTF-8".to_string())?;
    Ok(PathBuf::from(name))
}

fn is_page_asset(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_lowercase())
            .as_deref(),
        Some("css")
            | Some("js")
            | Some("png")
            | Some("jpg")
            | Some("jpeg")
            | Some("gif")
            | Some("svg")
            | Some("webp")
            | Some("mp3")
            | Some("wav")
            | Some("ogg")
            | Some("woff")
            | Some("woff2")
            | Some("ttf")
            | Some("otf")
            | Some("eot")
    )
}

fn media_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
}

async fn inline_dictionary_css(html: &str, assets: &DictionaryPageAssets) -> String {
    let mut css = Vec::new();
    let mut included = HashSet::new();

    for href in stylesheet_hrefs(html) {
        if let Some((media_type, content)) = resolve_resource_bytes(assets, &href).await {
            if media_type == "text/css" || href.to_lowercase().ends_with(".css") {
                let text = String::from_utf8_lossy(&content).to_string();
                css.push(rewrite_css_urls(&text, assets).await);
                included.insert(normalized_asset_key(&href));
            }
        }
    }

    for (name, asset) in &assets.database_assets {
        if asset.media_type != "text/css" || included.contains(name) {
            continue;
        }
        let text = String::from_utf8_lossy(&asset.content).to_string();
        css.push(rewrite_css_urls(&text, assets).await);
    }

    css.into_iter()
        .map(|chunk| escape_style_text(&chunk))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn rewrite_css_urls(css: &str, assets: &DictionaryPageAssets) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    loop {
        let lower = rest.to_lowercase();
        let Some(start) = lower.find("url(") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_url = &rest[start + "url(".len()..];
        let Some(end) = after_url.find(')') else {
            out.push_str(&rest[start..]);
            break;
        };
        let raw_value = &after_url[..end];
        let cleaned = raw_value.trim().trim_matches('"').trim_matches('\'').trim();
        if let Some(url) = resolve_resource_url(assets, cleaned).await {
            out.push_str("url(\"");
            out.push_str(&url);
            out.push_str("\")");
        } else {
            out.push_str(&rest[start..start + "url(".len() + end + 1]);
        }
        rest = &after_url[end + 1..];
    }
    out
}

async fn rewrite_html_resource_attributes(html: &str, assets: &DictionaryPageAssets) -> String {
    let mut out = html.to_string();
    for attr in [
        "src",
        "href",
        "data-src",
        "data-href",
        "data-file",
        "data-sound",
        "data-audio",
        "data-mp3",
        "data-src-mp3",
        "data-src-ogg",
        "data-pron",
    ] {
        out = rewrite_html_attribute(&out, attr, assets).await;
    }
    out
}

async fn rewrite_html_attribute(html: &str, attr: &str, assets: &DictionaryPageAssets) -> String {
    let pattern = format!("{attr}=");
    let mut out = String::with_capacity(html.len());
    let mut cursor = 0;

    while let Some(found) = find_case_insensitive(&html[cursor..], &pattern) {
        let attr_start = cursor + found;
        if !is_html_attr_boundary(html, attr_start) {
            out.push_str(&html[cursor..attr_start + pattern.len()]);
            cursor = attr_start + pattern.len();
            continue;
        }

        let value_start = attr_start + pattern.len();
        let Some((content_start, content_end, value_end)) =
            html_attr_value_bounds(html, value_start)
        else {
            out.push_str(&html[cursor..]);
            cursor = html.len();
            break;
        };

        out.push_str(&html[cursor..content_start]);
        let original = &html[content_start..content_end];
        if let Some(url) = resolve_resource_url(assets, original).await {
            out.push_str(&escape_html_attr(&url));
        } else {
            out.push_str(original);
        }
        cursor = value_end;
    }

    out.push_str(&html[cursor..]);
    out
}

async fn pronunciation_controls(html: &str, assets: &DictionaryPageAssets) -> String {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for reference in collect_audio_references(html) {
        if out.len() >= 6 {
            break;
        }
        let key = normalized_asset_key(&reference);
        if !seen.insert(key) {
            continue;
        }
        let Some(src) = resolve_resource_url(assets, &reference).await else {
            continue;
        };
        out.push(format!(
            r#"<span class="wb-pronunciation"><span>{}</span><audio controls preload="none" src="{}"></audio></span>"#,
            escape_html_text(&pronunciation_label(&reference)),
            escape_html_attr(&src)
        ));
    }

    if out.is_empty() {
        String::new()
    } else {
        format!(r#"<div class="wb-pronunciations">{}</div>"#, out.join(""))
    }
}

fn collect_audio_references(html: &str) -> Vec<String> {
    collect_resource_references(html)
        .into_iter()
        .filter(|reference| is_audio_reference(reference))
        .collect()
}

fn collect_resource_references(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(eq) = rest.find('=') {
        let after_eq = &rest[eq + 1..];
        let Some((value, consumed)) = parse_html_attr_value(after_eq) else {
            rest = after_eq;
            continue;
        };
        if !value.trim().is_empty() {
            out.push(decode_html_entities(value.trim()));
        }
        rest = &after_eq[consumed..];
    }
    out
}

fn stylesheet_hrefs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    loop {
        let lower = rest.to_lowercase();
        let Some(start) = lower.find("<link") else {
            break;
        };
        let after_start = &rest[start..];
        let Some(end) = after_start.find('>') else {
            break;
        };
        let tag = &after_start[..end + 1];
        let tag_lower = tag.to_lowercase();
        if tag_lower.contains("stylesheet") {
            if let Some(href) = extract_attr_value(tag, "href") {
                out.push(decode_html_entities(href.trim()));
            }
        }
        rest = &after_start[end + 1..];
    }
    out
}

fn strip_stylesheet_links(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let lower = rest.to_lowercase();
        let Some(start) = lower.find("<link") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_start = &rest[start..];
        let Some(end) = after_start.find('>') else {
            out.push_str(after_start);
            break;
        };
        let tag = &after_start[..end + 1];
        if !tag.to_lowercase().contains("stylesheet") {
            out.push_str(tag);
        }
        rest = &after_start[end + 1..];
    }
    out
}

async fn resolve_resource_url(assets: &DictionaryPageAssets, reference: &str) -> Option<String> {
    let reference = clean_resource_reference(reference)?;
    for candidate in asset_candidates(&reference) {
        if let Some(file) = assets.cloud_files.get(&normalized_asset_key(&candidate)) {
            return Some(file.public_url.clone());
        }
    }

    let public_fallback = assets
        .cloud_config
        .as_ref()
        .filter(|config| config.settings.public_base_enabled())
        .and_then(|config| {
            let resource_path = clean_resource_path(&reference);
            (!resource_path.is_empty()).then(|| {
                public_url_for_file(
                    &config.settings,
                    &assets.dictionary_id.to_string(),
                    &resource_path,
                )
            })
        });
    let can_upload = assets
        .cloud_config
        .as_ref()
        .is_some_and(|config| config.can_upload());

    if public_fallback.is_some() && !can_upload {
        return public_fallback;
    }

    let Some((media_type, content)) = resolve_resource_bytes(assets, &reference).await else {
        return public_fallback;
    };
    let resource_path = clean_resource_path(&reference);
    if content.len() <= MAX_CLOUD_RESOURCE_UPLOAD_BYTES {
        if let Some(config) = assets
            .cloud_config
            .as_ref()
            .filter(|config| config.can_upload())
        {
            if let Ok(public_url) = upload_cloud_resource(
                assets.dictionary_id,
                config,
                &resource_path,
                &media_type,
                content.clone(),
            )
            .await
            {
                return Some(public_url);
            }
        }
    }

    if content.len() > MAX_INLINE_RENDER_ASSET_BYTES {
        return public_fallback;
    }
    Some(data_uri_for_bytes(&media_type, &content))
}

async fn resolve_resource_bytes(
    assets: &DictionaryPageAssets,
    reference: &str,
) -> Option<(String, Vec<u8>)> {
    let reference = clean_resource_reference(reference)?;
    for candidate in asset_candidates(&reference) {
        if let Some(asset) = assets
            .database_assets
            .get(&normalized_asset_key(&candidate))
        {
            return Some((asset.media_type.clone(), asset.content.clone()));
        }
    }

    let media_type = media_type_for_reference(&reference);
    for archive in &assets.resource_archives {
        for candidate in mdd_lookup_candidates(&reference) {
            let lookup = lookup_mdd_resource(archive.cache_path.clone(), candidate).await;
            if let Ok(Some(content)) = lookup {
                return Some((media_type.clone(), content));
            }
        }
    }

    None
}

async fn lookup_mdd_resource(path: String, key: String) -> Result<Option<Vec<u8>>, String> {
    tokio::task::spawn_blocking(move || {
        let cache = MDD_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        let mut cache = cache
            .lock()
            .map_err(|_| "dictionary resource library cache lock poisoned".to_string())?;
        if !cache.contains_key(&path) {
            let mdd =
                MddFile::open(&path).map_err(|e| format!("open resource library {path}: {e}"))?;
            cache.insert(path.clone(), mdd);
        }
        let Some(mdd) = cache.get(&path) else {
            return Ok(None);
        };
        mdd.lookup(&key)
            .map(|resource| resource.map(|resource| resource.data))
            .map_err(|e| format!("lookup resource {key}: {e}"))
    })
    .await
    .map_err(|e| format!("dictionary resource worker failed: {e}"))?
}

fn clean_resource_reference(reference: &str) -> Option<String> {
    let decoded = decode_html_entities(reference);
    let mut value = decoded
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if value.is_empty() || value.starts_with('#') {
        return None;
    }

    let lower = value.to_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
    {
        return None;
    }

    if let Some(stripped) = strip_known_resource_scheme(&value) {
        value = stripped.to_string();
    }
    if let Some(hash) = value.find('#') {
        value.truncate(hash);
    }
    if let Some(query) = value.find('?') {
        value.truncate(query);
    }

    let value = value.trim().trim_start_matches("./").to_string();
    (!value.is_empty()).then_some(value)
}

fn strip_known_resource_scheme(value: &str) -> Option<&str> {
    let lower = value.to_lowercase();
    for scheme in ["sound://", "mdd://", "mdict://", "file://"] {
        if lower.starts_with(scheme) {
            return Some(&value[scheme.len()..]);
        }
    }
    None
}

fn asset_candidates(reference: &str) -> Vec<String> {
    let mut out = Vec::new();
    push_unique(&mut out, reference.to_string());
    push_unique(
        &mut out,
        reference
            .trim_start_matches('/')
            .trim_start_matches('\\')
            .to_string(),
    );
    push_unique(&mut out, reference.replace('\\', "/"));
    push_unique(&mut out, reference.replace('/', "\\"));
    if let Some(name) = Path::new(reference.replace('\\', "/").as_str())
        .file_name()
        .and_then(|s| s.to_str())
    {
        push_unique(&mut out, name.to_string());
    }
    out
}

fn mdd_lookup_candidates(reference: &str) -> Vec<String> {
    let mut out = Vec::new();
    for candidate in asset_candidates(reference) {
        let forward = candidate.replace('\\', "/");
        let backslash = candidate.replace('/', "\\");
        push_unique(&mut out, candidate);
        push_unique(&mut out, forward.clone());
        push_unique(&mut out, backslash.clone());
        push_unique(
            &mut out,
            format!("\\{}", backslash.trim_start_matches('\\')),
        );
        push_unique(&mut out, format!("/{}", forward.trim_start_matches('/')));
    }
    out
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn normalized_asset_key(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_start_matches('\\')
        .replace('\\', "/")
        .to_lowercase()
}

fn media_type_for_reference(reference: &str) -> String {
    let extension = reference
        .rsplit(['/', '\\'])
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()));
    match extension.as_deref() {
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("eot") => "application/vnd.ms-fontobject",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn is_audio_reference(reference: &str) -> bool {
    let Some(cleaned) = clean_resource_reference(reference) else {
        return false;
    };
    let lower = cleaned.to_lowercase();
    lower.ends_with(".mp3")
        || lower.ends_with(".wav")
        || lower.ends_with(".ogg")
        || reference.to_lowercase().starts_with("sound://")
}

fn pronunciation_label(reference: &str) -> String {
    let lower = reference.to_lowercase();
    if lower.contains("_gb_") || lower.contains("_uk_") || lower.contains("pron-uk") {
        "UK".to_string()
    } else if lower.contains("_us_") || lower.contains("pron-us") {
        "US".to_string()
    } else {
        "Audio".to_string()
    }
}

fn data_uri_for_bytes(media_type: &str, content: &[u8]) -> String {
    format!(
        "data:{};base64,{}",
        media_type,
        base64::engine::general_purpose::STANDARD.encode(content)
    )
}

fn find_case_insensitive(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_lowercase().find(&needle.to_lowercase())
}

fn is_html_attr_boundary(html: &str, attr_start: usize) -> bool {
    html[..attr_start]
        .chars()
        .last()
        .is_none_or(|ch| ch.is_whitespace() || ch == '<')
}

fn html_attr_value_bounds(html: &str, value_start: usize) -> Option<(usize, usize, usize)> {
    let first = html[value_start..].chars().next()?;
    if first == '"' || first == '\'' {
        let content_start = value_start + first.len_utf8();
        let rest = &html[content_start..];
        let end = rest.find(first)?;
        Some((
            content_start,
            content_start + end,
            content_start + end + first.len_utf8(),
        ))
    } else {
        let rest = &html[value_start..];
        let len = rest
            .find(|ch: char| ch.is_whitespace() || ch == '>')
            .unwrap_or(rest.len());
        Some((value_start, value_start + len, value_start + len))
    }
}

fn parse_html_attr_value(input: &str) -> Option<(&str, usize)> {
    let trimmed_start = input.len() - input.trim_start().len();
    let input = &input[trimmed_start..];
    let first = input.chars().next()?;
    if first == '"' || first == '\'' {
        let content_start = first.len_utf8();
        let rest = &input[content_start..];
        let end = rest.find(first)?;
        Some((
            &input[content_start..content_start + end],
            trimmed_start + content_start + end + 1,
        ))
    } else {
        let len = input
            .find(|ch: char| ch.is_whitespace() || ch == '>')
            .unwrap_or(input.len());
        Some((&input[..len], trimmed_start + len))
    }
}

fn extract_attr_value<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let pattern = format!("{attr}=");
    let start = find_case_insensitive(tag, &pattern)? + pattern.len();
    let (content_start, content_end, _) = html_attr_value_bounds(tag, start)?;
    Some(&tag[content_start..content_end])
}

async fn build_definition_page_html(html: &str, assets: &DictionaryPageAssets) -> String {
    let trimmed = html.trim_matches('\0').trim();
    let css = inline_dictionary_css(trimmed, assets).await;
    let body = strip_stylesheet_links(&strip_script_tags(extract_body_inner(trimmed)));
    let body = rewrite_html_resource_attributes(&body, assets).await;
    let pronunciation_controls = pronunciation_controls(trimmed, assets).await;

    format!(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    :root {{ color-scheme: light; }}
    body {{
      margin: 0;
      padding: 18px;
      color: #202124;
      background: #fff;
      font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    img {{ max-width: 100%; height: auto; }}
    a {{ color: #1677ff; text-decoration: none; }}
    a.audio_play_button {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 1.6em;
      min-height: 1.6em;
      border-radius: 999px;
      color: inherit;
      vertical-align: middle;
    }}
    a.audio_play_button::before {{ content: "\25B6"; font-size: 0.85em; }}
    .wb-pronunciations {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 12px;
      padding: 8px 10px;
      border: 1px solid #e8e8e8;
      border-radius: 6px;
      background: #fafafa;
    }}
    .wb-pronunciation {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #5f6368;
    }}
    .wb-pronunciation audio {{ height: 26px; max-width: 220px; }}
  </style>
  <style>{css}</style>
</head>
<body>{pronunciation_controls}{body}</body>
</html>"#
    )
}

fn extract_body_inner(html: &str) -> &str {
    let lower = html.to_lowercase();
    let Some(body_start) = lower.find("<body") else {
        return html;
    };
    let Some(body_open_end) = lower[body_start..].find('>') else {
        return html;
    };
    let content_start = body_start + body_open_end + 1;
    let content_end = lower[content_start..]
        .find("</body>")
        .map(|idx| content_start + idx)
        .unwrap_or(html.len());
    &html[content_start..content_end]
}

fn strip_script_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    loop {
        let lower = rest.to_lowercase();
        let Some(start) = lower.find("<script") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_start = &rest[start..];
        let after_lower = after_start.to_lowercase();
        if let Some(end) = after_lower.find("</script>") {
            rest = &after_start[end + "</script>".len()..];
        } else {
            break;
        }
    }
    out
}

fn escape_style_text(css: &str) -> String {
    css.replace("</style", "<\\/style")
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_attr(value: &str) -> String {
    escape_html_text(value)
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for ch in html.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let tag_name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
                if matches!(
                    tag_name.as_str(),
                    "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4"
                ) {
                    text.push('\n');
                } else {
                    text.push(' ');
                }
            }
            _ if in_tag => tag.push(ch),
            _ => text.push(ch),
        }
    }

    decode_html_entities(&text)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn decode_html_entities(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '&' {
            out.push(ch);
            continue;
        }

        let mut entity = String::new();
        while let Some(&next) = chars.peek() {
            chars.next();
            if next == ';' || entity.len() > 12 {
                break;
            }
            entity.push(next);
        }

        match entity.as_str() {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            "nbsp" => out.push(' '),
            _ if entity.starts_with("#x") => {
                if let Ok(code) = u32::from_str_radix(&entity[2..], 16) {
                    if let Some(decoded) = char::from_u32(code) {
                        out.push(decoded);
                    }
                }
            }
            _ if entity.starts_with('#') => {
                if let Ok(code) = entity[1..].parse::<u32>() {
                    if let Some(decoded) = char::from_u32(code) {
                        out.push(decoded);
                    }
                }
            }
            _ => {
                out.push('&');
                out.push_str(&entity);
                out.push(';');
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Online (Youdao + DeepL)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnlineProvider {
    Youdao,
    Deepl,
}

impl OnlineProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Youdao => "youdao",
            Self::Deepl => "deepl",
        }
    }
}

#[tauri::command]
pub async fn lookup_online(
    vault: State<'_, KeyVault>,
    lemma: String,
    provider: String,
) -> Result<OnlineLookupResult, String> {
    let start = Instant::now();
    let provider_enum = match provider.to_lowercase().as_str() {
        "youdao" => OnlineProvider::Youdao,
        "deepl" => OnlineProvider::Deepl,
        other => return Err(format!("unknown online provider: {other}")),
    };
    let provider_str = provider_enum.as_str();

    // 1. Cache hit? (context_hash is empty for context-free online lookups.)
    if let Some(row) = db::cache::get_cached(&lemma, provider_str, "")
        .await
        .map_err(|e| format!("read cache: {e}"))?
    {
        return Ok(OnlineLookupResult {
            lemma: row.lemma,
            provider: row.provider,
            translation_zh: row.translation_zh,
            example: row.example,
            cached: true,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    // 2. Miss → hit provider. Needs a user-configured API key.
    let key_bytes = vault
        .get(provider_str)
        .await
        .map_err(|e| format!("read api key: {e}"))?;
    let key = key_bytes.ok_or_else(|| format!("no {provider_str} API key configured"))?;
    let key = String::from_utf8(key).map_err(|e| format!("api key utf8: {e}"))?;

    let fetched = match provider_enum {
        OnlineProvider::Youdao => fetch_youdao(&lemma, &key).await,
        OnlineProvider::Deepl => fetch_deepl(&lemma, &key).await,
    }
    .map_err(|e| format!("{provider_str} fetch: {e}"))?;

    // 3. Cache + return.
    db::cache::put_cached(
        &lemma,
        provider_str,
        "",
        &fetched.translation_zh,
        fetched.example.as_deref(),
        fetched.raw_response.as_deref(),
    )
    .await
    .map_err(|e| format!("write cache: {e}"))?;

    Ok(OnlineLookupResult {
        lemma: lemma.to_lowercase(),
        provider: provider_str.to_string(),
        translation_zh: fetched.translation_zh,
        example: fetched.example,
        cached: false,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

struct FetchedTranslation {
    translation_zh: String,
    example: Option<String>,
    raw_response: Option<String>,
}

async fn fetch_youdao(lemma: &str, app_key_pair: &str) -> anyhow::Result<FetchedTranslation> {
    // app_key_pair format: "APP_KEY:APP_SECRET" (documented in Settings UI).
    let (app_key, app_secret) = app_key_pair
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("youdao key must be 'APP_KEY:APP_SECRET'"))?;
    let salt = {
        let mut b = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut b);
        hex::encode(b)
    };
    let curtime = chrono::Utc::now().timestamp().to_string();
    // Youdao v3 input mangling: first 10 + last 10 chars + total len for long
    // queries, else the raw string.
    let q = lemma;
    let input = if q.chars().count() > 20 {
        let chars: Vec<char> = q.chars().collect();
        let first: String = chars.iter().take(10).collect();
        let last: String = chars
            .iter()
            .rev()
            .take(10)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        format!("{first}{}{last}", chars.len())
    } else {
        q.to_string()
    };
    let mut h = <Sha256 as sha2::Digest>::new();
    sha2::Digest::update(
        &mut h,
        format!("{app_key}{input}{salt}{curtime}{app_secret}").as_bytes(),
    );
    let sign = hex::encode(sha2::Digest::finalize(h));

    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", q)
        .append_pair("from", "en")
        .append_pair("to", "zh-CHS")
        .append_pair("appKey", app_key)
        .append_pair("salt", &salt)
        .append_pair("sign", &sign)
        .append_pair("signType", "v3")
        .append_pair("curtime", &curtime)
        .finish();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let resp = client
        .post("https://openapi.youdao.com/api")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let error_code = body.get("errorCode").and_then(|v| v.as_str()).unwrap_or("");
    if error_code != "0" {
        return Err(anyhow::anyhow!("youdao errorCode {error_code}"));
    }
    let translation_zh = body
        .get("translation")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().filter_map(|x| x.as_str()).next())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            body.get("basic")
                .and_then(|b| b.get("explains"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default()
        });
    let example = body
        .get("web")
        .and_then(|w| w.as_array())
        .and_then(|arr| arr.first())
        .and_then(|entry| entry.get("value"))
        .and_then(|v| v.as_array())
        .and_then(|xs| xs.first())
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(FetchedTranslation {
        translation_zh,
        example,
        raw_response: Some(body.to_string()),
    })
}

async fn fetch_deepl(lemma: &str, auth_key: &str) -> anyhow::Result<FetchedTranslation> {
    // Free-tier keys end in `:fx` and must hit api-free.deepl.com.
    let endpoint = if auth_key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("text", lemma)
        .append_pair("source_lang", "EN")
        .append_pair("target_lang", "ZH")
        .finish();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let resp = client
        .post(endpoint)
        .header("Authorization", format!("DeepL-Auth-Key {auth_key}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let translation_zh = body
        .get("translations")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|t| t.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(FetchedTranslation {
        translation_zh,
        example: None,
        raw_response: Some(body.to_string()),
    })
}

// ---------------------------------------------------------------------------
// AI (OpenAI / Anthropic / Ollama)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum AiProvider {
    Openai,
    Anthropic,
    Ollama,
}

impl AiProvider {
    fn parse(s: &str) -> Option<Self> {
        Some(match s.to_lowercase().as_str() {
            "openai" => Self::Openai,
            "anthropic" => Self::Anthropic,
            "ollama" => Self::Ollama,
            _ => return None,
        })
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }
}

#[tauri::command]
pub async fn lookup_ai(
    vault: State<'_, KeyVault>,
    lemma: String,
    context_sentence: String,
    provider: String,
    model: String,
) -> Result<AiLookupResult, String> {
    let start = Instant::now();
    let provider_enum =
        AiProvider::parse(&provider).ok_or_else(|| format!("unknown ai provider: {provider}"))?;
    let provider_str = provider_enum.as_str();
    let context_hash = sha1_hex(&context_sentence);
    let cache_provider = format!("{provider_str}:{model}");

    if let Some(row) = db::cache::get_cached(&lemma, &cache_provider, &context_hash)
        .await
        .map_err(|e| format!("ai cache read: {e}"))?
    {
        return Ok(AiLookupResult {
            lemma: row.lemma,
            provider: provider_str.to_string(),
            model: model.clone(),
            context_hash: row.context_hash,
            translation_zh: row.translation_zh,
            cached: true,
            elapsed_ms: start.elapsed().as_millis() as u64,
        });
    }

    // Ollama does not need a key (local runtime). OpenAI + Anthropic do.
    let api_key = match provider_enum {
        AiProvider::Ollama => None,
        _ => {
            let key = vault
                .get(provider_str)
                .await
                .map_err(|e| format!("read ai key: {e}"))?
                .ok_or_else(|| format!("no {provider_str} API key configured"))?;
            Some(String::from_utf8(key).map_err(|e| format!("key utf8: {e}"))?)
        }
    };

    let translation_zh = match provider_enum {
        AiProvider::Openai => {
            fetch_ai_openai(
                &lemma,
                &context_sentence,
                api_key.as_deref().unwrap_or(""),
                &model,
            )
            .await
        }
        AiProvider::Anthropic => {
            fetch_ai_anthropic(
                &lemma,
                &context_sentence,
                api_key.as_deref().unwrap_or(""),
                &model,
            )
            .await
        }
        AiProvider::Ollama => fetch_ai_ollama(&lemma, &context_sentence, &model).await,
    }
    .map_err(|e| format!("ai fetch: {e}"))?;

    db::cache::put_cached(
        &lemma,
        &cache_provider,
        &context_hash,
        &translation_zh,
        Some(&context_sentence),
        None,
    )
    .await
    .map_err(|e| format!("ai cache write: {e}"))?;

    Ok(AiLookupResult {
        lemma: lemma.to_lowercase(),
        provider: provider_str.to_string(),
        model,
        context_hash,
        translation_zh,
        cached: false,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn ai_prompt(lemma: &str, context: &str) -> String {
    format!(
        "你是一位英语词汇教师。请基于给定句子里的具体语境，给出单词 `{lemma}` 最贴切的中文释义（不超过 40 字，不要输出英文）。\n句子：{context}\n输出格式：仅输出中文释义本身，不要任何前后缀。"
    )
}

async fn fetch_ai_openai(
    lemma: &str,
    context: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": "You are a contextual Chinese glossator." },
            { "role": "user",   "content": ai_prompt(lemma, context) }
        ],
        "temperature": 0.2
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn fetch_ai_anthropic(
    lemma: &str,
    context: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 200,
        "messages": [{ "role": "user", "content": ai_prompt(lemma, context) }]
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .pointer("/content/0/text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}

async fn fetch_ai_ollama(lemma: &str, context: &str, model: &str) -> anyhow::Result<String> {
    let body = serde_json::json!({
        "model": model,
        "prompt": ai_prompt(lemma, context),
        "stream": false
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let resp = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    Ok(body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string())
}
