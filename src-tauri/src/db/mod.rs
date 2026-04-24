//! Turso SQLite connection + schema bootstrap for WordBrain.
//!
//! Single globally-shared `turso::Connection` guarded by a tokio Mutex. The
//! connection is opened once on app start at
//! `<app_data_dir>/wordbrain.db`; schema creation is idempotent.
//!
//! The offline ECDICT bundle lives in its own SQLite file (see [`dict`]) so
//! we do not pay a 770k-row import on first launch.

use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::Result;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;
use turso::{Builder, Connection};

pub mod cache;
pub mod dict;
pub mod materials;
pub mod schema;
pub mod settings;
pub mod srs;
pub mod words;

pub type DbResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

static DB_CONNECTION: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Return the shared connection, or an error if `init` has not run yet.
pub fn get_connection() -> DbResult<&'static Mutex<Connection>> {
    DB_CONNECTION
        .get()
        .ok_or_else(|| "wordbrain db not initialised".into())
}

/// Ensure `<app_data_dir>/` exists, open the SQLite file, apply schema.
pub async fn init(app: &AppHandle) -> Result<()> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("resolving app data dir: {e}"))?;
    tokio::fs::create_dir_all(&app_dir).await?;
    let db_path: PathBuf = app_dir.join("wordbrain.db");
    log::info!("WordBrain db: {}", db_path.display());

    let db = Builder::new_local(db_path.to_str().expect("utf-8 db path"))
        .build()
        .await
        .map_err(|e| anyhow::anyhow!("open db: {e}"))?;
    let conn = db
        .connect()
        .map_err(|e| anyhow::anyhow!("connect db: {e}"))?;

    // Baseline pragmas — ignore errors (some return result rows which `execute`
    // does not like, but that is not fatal).
    let _ = conn.execute("PRAGMA foreign_keys = ON;", ()).await;
    let _ = conn.execute("PRAGMA journal_mode = WAL;", ()).await;
    let _ = conn.execute("PRAGMA synchronous = NORMAL;", ()).await;
    let _ = conn.execute("PRAGMA cache_size = -64000;", ()).await;
    let _ = conn.execute("PRAGMA temp_store = MEMORY;", ()).await;

    schema::apply(&conn)
        .await
        .map_err(|e| anyhow::anyhow!("apply schema: {e}"))?;

    DB_CONNECTION
        .set(Mutex::new(conn))
        .map_err(|_| anyhow::anyhow!("wordbrain db already initialised"))?;

    // Then bootstrap the bundled offline dictionary (separate sqlite file).
    dict::bootstrap(app)
        .await
        .map_err(|e| anyhow::anyhow!("bootstrap ecdict: {e}"))?;

    Ok(())
}

/// Milliseconds since the unix epoch, the canonical WordBrain timestamp unit.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
