use anyhow::Result;
use tauri::{AppHandle, Manager};

/// Ensure `<app_data_dir>/` exists for WordBrain's Turso SQLite file.
/// Schema creation lands in Phase 1.5; this Phase-0 stub only validates the data path.
pub async fn init(app: &AppHandle) -> Result<()> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("resolving app data dir: {e}"))?;
    tokio::fs::create_dir_all(&app_dir).await?;
    log::info!("WordBrain data dir: {}", app_dir.display());
    Ok(())
}
