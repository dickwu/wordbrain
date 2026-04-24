//! BYOK secret vault backed by `tauri-plugin-stronghold`.
//!
//! The stronghold crate encrypts a snapshot file at rest using an IOTA-derived
//! key; we keep exactly one snapshot at `<app_data_dir>/wordbrain.stronghold`
//! and one client named `wordbrain-keys`. Keys never leave the Rust side — the
//! only frontend-facing commands are `save_api_key` (write) and
//! `has_api_key` (boolean probe). A `get_api_key` command is intentionally
//! *not* exposed; `lookup_online` and `lookup_ai` read secrets internally via
//! [`KeyVault::get`].
//!
//! Why not the plugin's JS bindings? Those expose `plugin:stronghold|*` IPC
//! commands that would let the renderer read secrets back. Keeping all
//! stronghold ops in Rust honors AC5 ("keys never reach renderer").
//!
//! Master password: derived from a compiled-in salt plus the app data dir so
//! two WordBrain installs on the same user do not share stronghold snapshots.
//! The password is not user-visible; a user wanting to rotate keys can simply
//! delete the snapshot file.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use sha1::{Digest, Sha1};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use tauri_plugin_stronghold::stronghold::Stronghold;

const CLIENT_NAME: &[u8] = b"wordbrain-keys";
const SALT: &[u8] = b"wordbrain-stronghold-salt-v1";

/// Logical key name for each BYOK provider. Keep stable — changing the string
/// would orphan existing stored secrets.
pub fn provider_key(provider: &str) -> String {
    format!("api_key::{}", provider.to_lowercase())
}

#[derive(Clone)]
pub struct KeyVault {
    inner: Arc<Mutex<Stronghold>>,
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

        let password = derive_password(&snapshot_path);
        let sh = Stronghold::new(snapshot_path.clone(), password)
            .map_err(|e| anyhow!("load stronghold snapshot: {e}"))?;

        // Ensure a client exists. `load_client` fails if the client has not
        // been created yet; on fresh install we create one.
        let create_or_load = sh.load_client(CLIENT_NAME).or_else(|_| sh.create_client(CLIENT_NAME));
        create_or_load.map_err(|e| anyhow!("stronghold client: {e}"))?;

        // Flush a fresh snapshot so subsequent starts find the client record.
        sh.save().map_err(|e| anyhow!("save stronghold: {e}"))?;

        Ok(Self {
            inner: Arc::new(Mutex::new(sh)),
            snapshot_path,
        })
    }

    /// Persist `value` under logical key `provider_key(provider)`.
    pub async fn save(&self, provider: &str, value: &[u8]) -> Result<()> {
        let key = provider_key(provider);
        let sh = self.inner.lock().await;
        let client = sh
            .load_client(CLIENT_NAME)
            .or_else(|_| sh.create_client(CLIENT_NAME))
            .map_err(|e| anyhow!("stronghold client (save): {e}"))?;
        client
            .store()
            .insert(key.as_bytes().to_vec(), value.to_vec(), None)
            .map_err(|e| anyhow!("stronghold insert: {e}"))?;
        sh.save().map_err(|e| anyhow!("stronghold save snapshot: {e}"))?;
        Ok(())
    }

    /// Look up a previously-saved secret.
    pub async fn get(&self, provider: &str) -> Result<Option<Vec<u8>>> {
        let key = provider_key(provider);
        let sh = self.inner.lock().await;
        let client = sh
            .load_client(CLIENT_NAME)
            .or_else(|_| sh.create_client(CLIENT_NAME))
            .map_err(|e| anyhow!("stronghold client (get): {e}"))?;
        let v = client
            .store()
            .get(key.as_bytes())
            .map_err(|e| anyhow!("stronghold get: {e}"))?;
        Ok(v)
    }

    /// Fast `Option::is_some`-style probe for UI indicators. Does not expose
    /// the secret itself.
    pub async fn has(&self, provider: &str) -> Result<bool> {
        Ok(self.get(provider).await?.is_some())
    }

    /// Delete a stored secret; no-op if absent.
    pub async fn remove(&self, provider: &str) -> Result<()> {
        let key = provider_key(provider);
        let sh = self.inner.lock().await;
        let client = sh
            .load_client(CLIENT_NAME)
            .or_else(|_| sh.create_client(CLIENT_NAME))
            .map_err(|e| anyhow!("stronghold client (remove): {e}"))?;
        let _ = client
            .store()
            .delete(key.as_bytes())
            .map_err(|e| anyhow!("stronghold delete: {e}"))?;
        sh.save().map_err(|e| anyhow!("stronghold save snapshot: {e}"))?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn snapshot_path(&self) -> &PathBuf {
        &self.snapshot_path
    }
}

/// Derive a 32-byte password for the stronghold snapshot. Not user-visible —
/// this is a "fernet key derivation" style anchor. Anyone with filesystem
/// access to the app dir can already decrypt the snapshot; stronghold's value
/// is defence-in-depth against non-privileged leaks (backup archives, cloud
/// sync snapshots, etc.).
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
