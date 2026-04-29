//! Persistent dictionary lookup history.
//!
//! Mirrors the renderer's localStorage fallback but keeps the canonical Tauri
//! history in SQLite so looked-up words survive app restarts.

use turso::Connection;

use super::{get_connection, now_ms, DbResult};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupHistoryEntry {
    pub lemma: String,
    pub lookup_count: i64,
    pub first_looked_up_at: i64,
    pub last_looked_up_at: i64,
}

pub async fn record_lookup_on_conn(conn: &Connection, raw_lemma: &str) -> DbResult<()> {
    let Some(lemma) = normalize_lookup_lemma(raw_lemma) else {
        return Ok(());
    };
    let now = now_ms();
    conn.execute(
        "INSERT INTO lookup_history \
           (lemma, lookup_count, first_looked_up_at, last_looked_up_at) \
         VALUES (?1, 1, ?2, ?2) \
         ON CONFLICT(lemma) DO UPDATE SET \
           lookup_count = lookup_count + 1, \
           last_looked_up_at = excluded.last_looked_up_at",
        turso::params![lemma, now],
    )
    .await?;
    Ok(())
}

pub async fn record_lookup(raw_lemma: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    record_lookup_on_conn(&conn, raw_lemma).await
}

pub async fn list_lookup_history_on_conn(
    conn: &Connection,
    limit: u32,
) -> DbResult<Vec<LookupHistoryEntry>> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut rows = conn
        .query(
            "SELECT lemma, lookup_count, first_looked_up_at, last_looked_up_at \
               FROM lookup_history \
              ORDER BY last_looked_up_at DESC, lemma ASC \
              LIMIT ?1",
            turso::params![limit as i64],
        )
        .await?;

    let mut out = Vec::with_capacity(limit as usize);
    while let Some(row) = rows.next().await? {
        out.push(LookupHistoryEntry {
            lemma: row.get(0)?,
            lookup_count: row.get(1)?,
            first_looked_up_at: row.get(2)?,
            last_looked_up_at: row.get(3)?,
        });
    }
    Ok(out)
}

pub async fn list_lookup_history(limit: u32) -> DbResult<Vec<LookupHistoryEntry>> {
    let conn = get_connection()?.lock().await;
    list_lookup_history_on_conn(&conn, limit).await
}

pub async fn remove_lookup_on_conn(conn: &Connection, raw_lemma: &str) -> DbResult<()> {
    let Some(lemma) = normalize_lookup_lemma(raw_lemma) else {
        return Ok(());
    };
    conn.execute(
        "DELETE FROM lookup_history WHERE lemma = ?1",
        turso::params![lemma],
    )
    .await?;
    Ok(())
}

pub async fn remove_lookup(raw_lemma: &str) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    remove_lookup_on_conn(&conn, raw_lemma).await
}

pub async fn clear_lookup_history_on_conn(conn: &Connection) -> DbResult<()> {
    conn.execute("DELETE FROM lookup_history", ()).await?;
    Ok(())
}

pub async fn clear_lookup_history() -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    clear_lookup_history_on_conn(&conn).await
}

fn normalize_lookup_lemma(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphabetic() || matches!(c, '\'' | '-' | '\u{2019}'))
    {
        return None;
    }
    Some(trimmed.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use turso::Builder;

    async fn setup_db() -> Connection {
        let db = Builder::new_local(":memory:")
            .build()
            .await
            .expect("build in-memory turso");
        let conn = db.connect().expect("connect in-memory turso");
        crate::db::schema::apply(&conn).await.expect("apply schema");
        conn
    }

    #[tokio::test]
    async fn record_lookup_dedupes_and_moves_latest_to_top() {
        let conn = setup_db().await;

        record_lookup_on_conn(&conn, "Alpha").await.unwrap();
        record_lookup_on_conn(&conn, "bravo").await.unwrap();
        record_lookup_on_conn(&conn, "alpha").await.unwrap();

        let rows = list_lookup_history_on_conn(&conn, 20).await.unwrap();
        let lemmas: Vec<&str> = rows.iter().map(|row| row.lemma.as_str()).collect();
        assert_eq!(lemmas, vec!["alpha", "bravo"]);
        assert_eq!(rows[0].lookup_count, 2);
    }

    #[tokio::test]
    async fn record_lookup_ignores_non_word_queries() {
        let conn = setup_db().await;

        record_lookup_on_conn(&conn, "two words").await.unwrap();
        record_lookup_on_conn(&conn, "123").await.unwrap();

        let rows = list_lookup_history_on_conn(&conn, 20).await.unwrap();
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn remove_and_clear_lookup_history() {
        let conn = setup_db().await;

        record_lookup_on_conn(&conn, "alpha").await.unwrap();
        record_lookup_on_conn(&conn, "bravo").await.unwrap();
        remove_lookup_on_conn(&conn, "alpha").await.unwrap();

        let rows = list_lookup_history_on_conn(&conn, 20).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].lemma, "bravo");

        clear_lookup_history_on_conn(&conn).await.unwrap();
        assert!(list_lookup_history_on_conn(&conn, 20)
            .await
            .unwrap()
            .is_empty());
    }
}
