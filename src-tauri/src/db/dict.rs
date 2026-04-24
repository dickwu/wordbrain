//! Offline ECDICT dictionary bundle.
//!
//! The upstream ECDICT project (Apache-2.0) is shipped as
//! `src-tauri/assets/ecdict.db`. On first launch we copy that file into
//! `<app_data_dir>/ecdict.db` so we can open it with write pragmas (WAL) and
//! keep it independent of the app bundle (which may be read-only on macOS).
//! Subsequent launches reuse the local copy.
//!
//! `dictionary_entries` is the same schema as the main wordbrain DB — the
//! bundle file is effectively a pre-populated view of that table. We keep it
//! in a separate SQLite file so the main DB stays slim and we do not need to
//! import ~770k rows on first launch.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::Result;
use serde::Serialize;
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::sync::Mutex;
use turso::{Builder, Connection};

use super::DbResult;

static DICT_CONNECTION: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Minimum row count we accept before considering the bundle healthy. Any
/// smaller and we treat the file as corrupt and re-copy from the asset.
const MIN_ROWS: i64 = 700_000;

/// Offline dictionary entry returned to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct OfflineEntry {
    pub lemma: String,
    pub pos: Option<String>,
    pub ipa: Option<String>,
    pub definitions_zh: Option<String>,
    pub definitions_en: Option<String>,
    pub source: String,
}

/// Return the handle to the dictionary connection. Fails if `bootstrap` has
/// not run yet.
pub fn get_connection() -> DbResult<&'static Mutex<Connection>> {
    DICT_CONNECTION
        .get()
        .ok_or_else(|| "offline dictionary not bootstrapped".into())
}

/// Resolve the bundled ECDICT asset path. In dev mode Tauri resolves
/// `BaseDirectory::Resource` to `src-tauri/`; in prod it resolves to the
/// platform resource dir inside the bundle.
fn bundled_asset_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .resolve("assets/ecdict.db", BaseDirectory::Resource)
        .map_err(|e| anyhow::anyhow!("resolve ecdict asset: {e}"))?)
}

/// Copy the bundled asset into `<app_data_dir>/ecdict.db` when necessary.
///
/// Copy policy:
///   * target missing                → copy.
///   * target present but smaller than bundled → copy (bundle upgrade).
///   * target present with matching bundle length → keep as-is.
async fn ensure_local_copy(app: &AppHandle) -> Result<PathBuf> {
    let bundle = bundled_asset_path(app)?;
    if !bundle.exists() {
        return Err(anyhow::anyhow!(
            "bundled ecdict.db missing at {}",
            bundle.display()
        ));
    }

    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("resolving app data dir: {e}"))?;
    tokio::fs::create_dir_all(&app_dir).await?;
    let target = app_dir.join("ecdict.db");

    let need_copy = match tokio::fs::metadata(&target).await {
        Ok(meta) => {
            let bundle_meta = tokio::fs::metadata(&bundle).await?;
            meta.len() != bundle_meta.len()
        }
        Err(_) => true,
    };
    if need_copy {
        log::info!(
            "[wordbrain] copying bundled ecdict.db ({} MB) → {}",
            bundle.metadata().map(|m| m.len() / 1024 / 1024).unwrap_or(0),
            target.display()
        );
        tokio::fs::copy(&bundle, &target).await?;
    }
    Ok(target)
}

async fn open(path: &Path) -> Result<Connection> {
    let db = Builder::new_local(path.to_str().expect("utf-8 dict path"))
        .build()
        .await
        .map_err(|e| anyhow::anyhow!("open ecdict: {e}"))?;
    let conn = db
        .connect()
        .map_err(|e| anyhow::anyhow!("connect ecdict: {e}"))?;
    // Read-heavy workload; WAL + relaxed sync keep first-run smooth.
    let _ = conn.execute("PRAGMA journal_mode = WAL;", ()).await;
    let _ = conn.execute("PRAGMA synchronous = NORMAL;", ()).await;
    let _ = conn.execute("PRAGMA temp_store = MEMORY;", ()).await;
    Ok(conn)
}

/// Open the bundled ECDICT db, verify it has ≥ `MIN_ROWS` rows, and stash the
/// connection as a singleton.
pub async fn bootstrap(app: &AppHandle) -> Result<()> {
    let path = ensure_local_copy(app).await?;
    let conn = open(&path).await?;

    // Defensive: confirm the bundle actually carries dictionary_entries rows.
    let mut rows = conn
        .query("SELECT COUNT(*) FROM dictionary_entries", ())
        .await
        .map_err(|e| anyhow::anyhow!("count ecdict rows: {e}"))?;
    let count: i64 = rows
        .next()
        .await
        .map_err(|e| anyhow::anyhow!("read ecdict count: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("empty count(*) result"))?
        .get(0)
        .map_err(|e| anyhow::anyhow!("count(*) cast: {e}"))?;
    if count < MIN_ROWS {
        return Err(anyhow::anyhow!(
            "ecdict bundle only has {count} rows (< {MIN_ROWS}); asset may be corrupt"
        ));
    }
    log::info!("[wordbrain] offline dict ready: {count} entries");

    DICT_CONNECTION
        .set(Mutex::new(conn))
        .map_err(|_| anyhow::anyhow!("offline dict already bootstrapped"))?;
    Ok(())
}

/// Fetch the first ECDICT entry for `lemma` (case-insensitive). If the lemma
/// has multiple POS rows we return the first one — richer layouts can stitch
/// the rest client-side later.
pub async fn lookup_offline_on_conn(conn: &Connection, lemma: &str) -> DbResult<Option<OfflineEntry>> {
    let needle = lemma.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(None);
    }
    let mut rows = conn
        .query(
            "SELECT lemma, pos, ipa, definitions_zh, definitions_en, source \
             FROM dictionary_entries \
             WHERE lemma = ?1 \
             ORDER BY CASE WHEN pos IS NULL OR pos = '' THEN 1 ELSE 0 END, pos \
             LIMIT 1",
            turso::params![needle.as_str()],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        let pos: Option<String> = row.get::<Option<String>>(1)?;
        let ipa: Option<String> = row.get::<Option<String>>(2)?;
        let zh: Option<String> = row.get::<Option<String>>(3)?;
        let en: Option<String> = row.get::<Option<String>>(4)?;
        let pos = pos.filter(|s| !s.is_empty());
        Ok(Some(OfflineEntry {
            lemma: row.get::<String>(0)?,
            pos,
            ipa: ipa.filter(|s| !s.is_empty()),
            definitions_zh: zh.filter(|s| !s.is_empty()),
            definitions_en: en.filter(|s| !s.is_empty()),
            source: row.get::<String>(5)?,
        }))
    } else {
        Ok(None)
    }
}

pub async fn lookup_offline(lemma: &str) -> DbResult<Option<OfflineEntry>> {
    let conn = get_connection()?.lock().await;
    lookup_offline_on_conn(&conn, lemma).await
}
