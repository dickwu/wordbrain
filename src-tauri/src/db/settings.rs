//! Key-value settings helpers. Values are stored as raw JSON strings so the
//! frontend can round-trip arbitrary shapes.

use super::{get_connection, now_ms, DbResult};

pub async fn get(key: &str) -> DbResult<Option<String>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT value FROM settings WHERE key = ?1",
            turso::params![key],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(row.get::<String>(0)?))
    } else {
        Ok(None)
    }
}

pub async fn set(key: &str, value: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    let now = now_ms();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        turso::params![key, value, now],
    )
    .await?;
    Ok(())
}
