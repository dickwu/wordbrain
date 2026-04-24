//! `word_translations_cache` helpers shared by online + AI lookup commands.
//!
//! Cache key = (lemma, provider, context_hash). `context_hash` is an empty
//! string for context-free translations (offline/online) and `sha1(sentence)`
//! for AI lookups so the same word in a different sentence gets a fresh gloss.

use serde::Serialize;
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

#[derive(Debug, Clone, Serialize)]
pub struct CachedTranslation {
    pub lemma: String,
    pub provider: String,
    pub context_hash: String,
    pub translation_zh: String,
    pub example: Option<String>,
    pub raw_response: Option<String>,
    pub cached_at: i64,
}

/// Fetch a cached row, if any.
pub async fn get_cached_on_conn(
    conn: &Connection,
    lemma: &str,
    provider: &str,
    context_hash: &str,
) -> DbResult<Option<CachedTranslation>> {
    let lemma = lemma.to_lowercase();
    let mut rows = conn
        .query(
            "SELECT lemma, provider, context_hash, translation_zh, example, raw_response, cached_at \
             FROM word_translations_cache \
             WHERE lemma = ?1 AND provider = ?2 AND context_hash = ?3",
            turso::params![lemma.as_str(), provider, context_hash],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(CachedTranslation {
            lemma: row.get::<String>(0)?,
            provider: row.get::<String>(1)?,
            context_hash: row.get::<String>(2)?,
            translation_zh: row.get::<String>(3)?,
            example: row.get::<Option<String>>(4)?,
            raw_response: row.get::<Option<String>>(5)?,
            cached_at: row.get::<i64>(6)?,
        }))
    } else {
        Ok(None)
    }
}

pub async fn get_cached(
    lemma: &str,
    provider: &str,
    context_hash: &str,
) -> DbResult<Option<CachedTranslation>> {
    let conn = get_connection()?.lock().await;
    get_cached_on_conn(&conn, lemma, provider, context_hash).await
}

/// Upsert a cache row. Keys on `(lemma, provider, context_hash)`.
pub async fn put_cached_on_conn(
    conn: &Connection,
    lemma: &str,
    provider: &str,
    context_hash: &str,
    translation_zh: &str,
    example: Option<&str>,
    raw_response: Option<&str>,
) -> DbResult<()> {
    let lemma = lemma.to_lowercase();
    let now = now_ms();
    conn.execute(
        "INSERT INTO word_translations_cache \
           (lemma, provider, context_hash, translation_zh, example, raw_response, cached_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(lemma, provider, context_hash) DO UPDATE SET \
           translation_zh = excluded.translation_zh, \
           example = excluded.example, \
           raw_response = excluded.raw_response, \
           cached_at = excluded.cached_at",
        turso::params![
            lemma.as_str(),
            provider,
            context_hash,
            translation_zh,
            example,
            raw_response,
            now
        ],
    )
    .await?;
    Ok(())
}

pub async fn put_cached(
    lemma: &str,
    provider: &str,
    context_hash: &str,
    translation_zh: &str,
    example: Option<&str>,
    raw_response: Option<&str>,
) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    put_cached_on_conn(
        &conn,
        lemma,
        provider,
        context_hash,
        translation_zh,
        example,
        raw_response,
    )
    .await
}
