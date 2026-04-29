//! BYOK secret vault.
//!
//! On macOS this uses the system Keychain, which keeps reads and writes fast
//! while still encrypting secrets at rest. Other targets use
//! `tauri-plugin-stronghold` with one snapshot at
//! `<app_data_dir>/wordbrain.stronghold` and one client named `wordbrain-keys`.
//! Keys never leave the Rust side — the frontend-facing commands write keys or
//! list configured provider slots, but never return key material. A
//! `get_api_key` command is intentionally *not* exposed; Rust commands read
//! secrets internally via [`KeyVault::get`].
//!
//! Why not the plugin's JS bindings? Those expose `plugin:stronghold|*` IPC
//! commands that would let the renderer read secrets back. Keeping all secret
//! ops in Rust honors AC5 ("keys never reach renderer").
//!
//! Stronghold master password: derived from a compiled-in salt plus the app
//! data dir so two WordBrain installs on the same user do not share stronghold
//! snapshots. The password is not user-visible; a user wanting to rotate keys
//! can simply delete the snapshot file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
#[cfg(not(target_os = "macos"))]
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_stronghold::stronghold::Stronghold;
#[cfg(not(target_os = "macos"))]
use tokio::sync::Mutex;
use tokio::sync::RwLock;

#[cfg(not(target_os = "macos"))]
const CLIENT_NAME: &[u8] = b"wordbrain-keys";
#[cfg(not(target_os = "macos"))]
const SALT: &[u8] = b"wordbrain-stronghold-salt-v1";

/// Logical key name for each BYOK provider. Keep stable — changing the string
/// would orphan existing stored secrets.
pub fn provider_key(provider: &str) -> String {
    format!("api_key::{}", provider.to_lowercase())
}

#[derive(Clone)]
pub struct KeyVault {
    #[cfg(not(target_os = "macos"))]
    inner: Arc<Mutex<Stronghold>>,
    cache: Arc<RwLock<HashMap<String, Option<Vec<u8>>>>>,
    snapshot_path: PathBuf,
}

impl KeyVault {
    pub fn init(app: &AppHandle) -> Result<Self> {
        let app_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| anyhow!("resolve app data dir: {e}"))?;
        std::fs::create_dir_all(&app_dir).map_err(|e| anyhow!("mkdir app data: {e}"))?;
        let snapshot_path = app_dir.join("wordbrain.stronghold");

        #[cfg(target_os = "macos")]
        {
            return Ok(Self {
                cache: Arc::new(RwLock::new(HashMap::new())),
                snapshot_path,
            });
        }

        #[cfg(not(target_os = "macos"))]
        {
            let snapshot_exists = snapshot_path.exists();
            let password = derive_password(&snapshot_path);
            let sh = Stronghold::new(snapshot_path.clone(), password)
                .map_err(|e| anyhow!("load stronghold snapshot: {e}"))?;

            // Ensure a client exists. `load_client` fails if the client has not
            // been created yet; on fresh install we create one.
            let client_loaded = sh.load_client(CLIENT_NAME).is_ok();
            if !client_loaded {
                sh.create_client(CLIENT_NAME)
                    .map_err(|e| anyhow!("stronghold client: {e}"))?;
            }

            // Flush only when the snapshot/client is new. Rewriting it on every
            // launch adds avoidable startup I/O.
            if !snapshot_exists || !client_loaded {
                sh.save().map_err(|e| anyhow!("save stronghold: {e}"))?;
            }

            Ok(Self {
                inner: Arc::new(Mutex::new(sh)),
                cache: Arc::new(RwLock::new(HashMap::new())),
                snapshot_path,
            })
        }
    }

    /// Persist `value` under logical key `provider_key(provider)`.
    pub async fn save(&self, provider: &str, value: &[u8]) -> Result<()> {
        let key = provider_key(provider);
        self.cache
            .write()
            .await
            .insert(key.clone(), Some(value.to_vec()));

        #[cfg(target_os = "macos")]
        {
            macos_keychain::save(&key, value)?;
            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        {
            persist_key_in_background(self.inner.clone(), key, Some(value.to_vec()));
            Ok(())
        }
    }

    /// Persist multiple logical secrets with one snapshot flush.
    pub async fn save_many(&self, entries: Vec<(String, Vec<u8>)>) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        {
            let mut cache = self.cache.write().await;
            for (provider, value) in &entries {
                cache.insert(provider_key(provider), Some(value.clone()));
            }
        }

        #[cfg(target_os = "macos")]
        {
            for (provider, value) in entries {
                macos_keychain::save(&provider_key(&provider), &value)?;
            }
            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        {
            persist_keys_in_background(
                self.inner.clone(),
                entries
                    .into_iter()
                    .map(|(provider, value)| (provider_key(&provider), Some(value)))
                    .collect(),
            );
            Ok(())
        }
    }

    /// Look up a previously-saved secret.
    pub async fn get(&self, provider: &str) -> Result<Option<Vec<u8>>> {
        let key = provider_key(provider);
        if let Some(value) = self.cache.read().await.get(&key) {
            return Ok(value.clone());
        }

        #[cfg(target_os = "macos")]
        {
            let value = macos_keychain::get(&key)?;
            self.cache.write().await.insert(key, value.clone());
            return Ok(value);
        }

        #[cfg(not(target_os = "macos"))]
        {
            let sh = self.inner.lock().await;
            let client = sh
                .load_client(CLIENT_NAME)
                .or_else(|_| sh.create_client(CLIENT_NAME))
                .map_err(|e| anyhow!("stronghold client (get): {e}"))?;
            let v = client
                .store()
                .get(key.as_bytes())
                .map_err(|e| anyhow!("stronghold get: {e}"))?;
            self.cache.write().await.insert(key, v.clone());
            Ok(v)
        }
    }

    /// Fast `Option::is_some`-style probe for UI indicators. Does not expose
    /// the secret itself.
    pub async fn has(&self, provider: &str) -> Result<bool> {
        Ok(self.get(provider).await?.is_some())
    }

    /// Delete a stored secret; no-op if absent.
    pub async fn remove(&self, provider: &str) -> Result<()> {
        let key = provider_key(provider);
        self.cache.write().await.insert(key.clone(), None);

        #[cfg(target_os = "macos")]
        {
            macos_keychain::remove(&key)?;
            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        {
            persist_key_in_background(self.inner.clone(), key, None);
            Ok(())
        }
    }

    #[allow(dead_code)]
    pub fn snapshot_path(&self) -> &PathBuf {
        &self.snapshot_path
    }
}

#[cfg(not(target_os = "macos"))]
fn persist_key_in_background(inner: Arc<Mutex<Stronghold>>, key: String, value: Option<Vec<u8>>) {
    persist_keys_in_background(inner, vec![(key, value)]);
}

#[cfg(not(target_os = "macos"))]
fn persist_keys_in_background(
    inner: Arc<Mutex<Stronghold>>,
    entries: Vec<(String, Option<Vec<u8>>)>,
) {
    tauri::async_runtime::spawn(async move {
        let result = async {
            let sh = inner.lock().await;
            let client = sh
                .load_client(CLIENT_NAME)
                .or_else(|_| sh.create_client(CLIENT_NAME))
                .map_err(|e| anyhow!("stronghold client (background save): {e}"))?;
            for (key, value) in entries {
                match value {
                    Some(value) => {
                        let _ = client
                            .store()
                            .insert(key.as_bytes().to_vec(), value, None)
                            .map_err(|e| anyhow!("stronghold insert: {e}"))?;
                    }
                    None => {
                        let _ = client
                            .store()
                            .delete(key.as_bytes())
                            .map_err(|e| anyhow!("stronghold delete: {e}"))?;
                    }
                }
            }
            sh.save()
                .map_err(|e| anyhow!("stronghold save snapshot: {e}"))?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(err) = result {
            log::error!("stronghold background save failed: {err}");
        }
    });
}

#[cfg(target_os = "macos")]
mod macos_keychain {
    use std::process::Command;

    use anyhow::{anyhow, Result};

    const KEYCHAIN_ACCOUNT: &str = "wordbrain";
    const KEYCHAIN_SERVICE_PREFIX: &str = "com.lifefarmer.wordbrain.v2";

    pub fn save(key: &str, value: &[u8]) -> Result<()> {
        let service = service_name(key);
        let password = String::from_utf8(value.to_vec())
            .map_err(|e| anyhow!("save key: secret must be UTF-8: {e}"))?;
        let output = Command::new("security")
            .args([
                "add-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                &service,
                "-w",
                &password,
                "-U",
                "-A",
            ])
            .output()
            .map_err(|e| anyhow!("run macOS security add-generic-password: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(command_error("save key", output))
        }
    }

    pub fn get(key: &str) -> Result<Option<Vec<u8>>> {
        let service = service_name(key);
        let output = Command::new("security")
            .args([
                "find-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                &service,
                "-w",
            ])
            .output()
            .map_err(|e| anyhow!("run macOS security find-generic-password: {e}"))?;
        if output.status.success() {
            let mut value = output.stdout;
            if value.last() == Some(&b'\n') {
                value.pop();
                if value.last() == Some(&b'\r') {
                    value.pop();
                }
            }
            return Ok(Some(value));
        }
        if is_not_found(&output) {
            return Ok(None);
        }
        Err(command_error("read key", output))
    }

    pub fn remove(key: &str) -> Result<()> {
        let service = service_name(key);
        let output = Command::new("security")
            .args([
                "delete-generic-password",
                "-a",
                KEYCHAIN_ACCOUNT,
                "-s",
                &service,
            ])
            .output()
            .map_err(|e| anyhow!("run macOS security delete-generic-password: {e}"))?;
        if output.status.success() || is_not_found(&output) {
            Ok(())
        } else {
            Err(command_error("delete key", output))
        }
    }

    fn service_name(key: &str) -> String {
        let suffix = key
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '.'
                }
            })
            .collect::<String>();
        format!("{KEYCHAIN_SERVICE_PREFIX}.{suffix}")
    }

    fn is_not_found(output: &std::process::Output) -> bool {
        String::from_utf8_lossy(&output.stderr)
            .to_lowercase()
            .contains("could not be found")
    }

    fn command_error(action: &str, output: std::process::Output) -> anyhow::Error {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow!(
            "{action}: macOS Keychain command failed with status {:?}: {}",
            output.status.code(),
            stderr.trim()
        )
    }
}

/// Derive a 32-byte password for the stronghold snapshot. Not user-visible —
/// this is a "fernet key derivation" style anchor. Anyone with filesystem
/// access to the app dir can already decrypt the snapshot; stronghold's value
/// is defence-in-depth against non-privileged leaks (backup archives, cloud
/// sync snapshots, etc.).
#[cfg(not(target_os = "macos"))]
fn derive_password(snapshot_path: &PathBuf) -> Vec<u8> {
    let mut hasher = Sha1::new();
    hasher.update(SALT);
    hasher.update(snapshot_path.to_string_lossy().as_bytes());
    // SHA-1 → 20 bytes; stronghold wants 32. Double-round to 32.
    let first = hasher.finalize_reset();
    hasher.update(SALT);
    hasher.update(&first);
    let second = hasher.finalize();
    let mut out = Vec::with_capacity(32);
    out.extend_from_slice(&first);
    out.extend_from_slice(&second[..12]);
    out
}
