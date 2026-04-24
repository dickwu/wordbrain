//! Query helpers for the `words` table.
//!
//! Every helper has two forms: an `*_on_conn(&Connection, …)` routine that
//! holds the real SQL, and a wrapper that grabs the global connection and
//! delegates. Integration tests drive the `*_on_conn` variants directly so
//! the persistence contract can be exercised across a simulated restart
//! without fighting the `OnceLock`-backed singleton.

use turso::Connection;

use super::{get_connection, now_ms, DbResult};

/// Bulk-insert `(lemma, rank)` pairs with `state='known'`, `state_source='seed_freq'`.
///
/// Uses `INSERT OR IGNORE` so an already-known lemma is left untouched. Runs
/// inside a single transaction for speed — seeding 10k rows should take well
/// under a second on a 2021 MBP.
pub async fn seed_known_from_frequency_on_conn(
    conn: &Connection,
    entries: &[(String, u32)],
) -> DbResult<u32> {
    if entries.is_empty() {
        return Ok(0);
    }
    let now = now_ms();

    conn.execute("BEGIN IMMEDIATE;", ()).await?;
    let mut inserted: u32 = 0;
    let result: DbResult<()> = async {
        for (lemma, rank) in entries {
            // `changes()` reports 1 for inserted and 0 for ignored (already present).
            conn.execute(
                "INSERT OR IGNORE INTO words \
                   (lemma, state, state_source, freq_rank, created_at, updated_at, marked_known_at) \
                 VALUES (?1, 'known', 'seed_freq', ?2, ?3, ?3, ?3)",
                turso::params![lemma.as_str(), *rank as i64, now],
            )
            .await?;
            let mut rows = conn.query("SELECT changes()", ()).await?;
            if let Some(row) = rows.next().await? {
                let changed: i64 = row.get(0)?;
                if changed > 0 {
                    inserted += 1;
                }
            }
        }
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            conn.execute("COMMIT;", ()).await?;
            Ok(inserted)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK;", ()).await;
            Err(e)
        }
    }
}

pub async fn seed_known_from_frequency(entries: &[(String, u32)]) -> DbResult<u32> {
    let conn = get_connection()?.lock().await;
    seed_known_from_frequency_on_conn(&conn, entries).await
}

/// Return every lemma where `state = 'known'`. Used to hydrate the in-memory
/// known-set at app start.
pub async fn get_all_known_lemmas_on_conn(conn: &Connection) -> DbResult<Vec<String>> {
    let mut rows = conn
        .query("SELECT lemma FROM words WHERE state = 'known'", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

pub async fn get_all_known_lemmas() -> DbResult<Vec<String>> {
    let conn = get_connection()?.lock().await;
    get_all_known_lemmas_on_conn(&conn).await
}

/// Upsert `lemma` as known. `source` defaults to `"manual"` when `None`.
pub async fn mark_known_on_conn(
    conn: &Connection,
    lemma: &str,
    source: Option<&str>,
) -> DbResult<()> {
    let now = now_ms();
    let source = source.unwrap_or("manual");
    conn.execute(
        "INSERT INTO words \
           (lemma, state, state_source, created_at, updated_at, marked_known_at) \
         VALUES (?1, 'known', ?2, ?3, ?3, ?3) \
         ON CONFLICT(lemma) DO UPDATE SET \
           state = 'known', \
           state_source = excluded.state_source, \
           marked_known_at = excluded.marked_known_at, \
           updated_at = excluded.updated_at",
        turso::params![lemma, source, now],
    )
    .await?;
    Ok(())
}

pub async fn mark_known(lemma: &str, source: Option<&str>) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    mark_known_on_conn(&conn, lemma, source).await
}

/// Flip `lemma` back to `state = 'unknown'`. No-op if the lemma is absent.
pub async fn unmark_known_on_conn(conn: &Connection, lemma: &str) -> DbResult<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE words SET state = 'unknown', state_source = NULL, marked_known_at = NULL, \
                         updated_at = ?2 \
         WHERE lemma = ?1",
        turso::params![lemma, now],
    )
    .await?;
    Ok(())
}

pub async fn unmark_known(lemma: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    unmark_known_on_conn(&conn, lemma).await
}

/// Total count of rows where `state = 'known'`. Cheap diagnostic for the UI.
pub async fn count_known_on_conn(conn: &Connection) -> DbResult<u64> {
    let mut rows = conn
        .query("SELECT COUNT(*) FROM words WHERE state = 'known'", ())
        .await?;
    if let Some(row) = rows.next().await? {
        let n: i64 = row.get(0)?;
        Ok(n as u64)
    } else {
        Ok(0)
    }
}

pub async fn count_known() -> DbResult<u64> {
    let conn = get_connection()?.lock().await;
    count_known_on_conn(&conn).await
}
