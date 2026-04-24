//! User-imported MDict dictionary metadata and DB-owned files.
//!
//! The MDX index is stored as a blob in the WordBrain SQLite DB. The MDict
//! parser still needs a filesystem path, so command code hydrates that blob to
//! an app-owned cache file before opening it.

use serde::Serialize;
use turso::Connection;

use super::{get_connection, now_ms, DbResult};

#[derive(Debug, Clone, Serialize)]
pub struct CustomDictionary {
    pub id: i64,
    pub name: String,
    pub source_path: String,
    pub mdx_path: String,
    pub entry_count: i64,
    pub imported_at: i64,
    pub updated_at: i64,
    pub storage_kind: String,
    pub mdx_size: i64,
    pub asset_count: i64,
    pub resource_archive_count: i64,
    pub resource_archive_size: i64,
    pub cloud_file_count: i64,
    pub cloud_file_size: i64,
}

pub struct DictionaryFileInput {
    pub role: String,
    pub file_name: String,
    pub media_type: String,
    pub content: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct DictionaryFileMeta {
    pub file_name: String,
    pub media_type: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone)]
pub struct DictionaryFile {
    pub file_name: String,
    pub media_type: String,
    pub content: Vec<u8>,
    pub byte_size: i64,
}

pub struct DictionaryResourceArchiveInput {
    pub file_name: String,
    pub source_path: String,
    pub cache_path: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DictionaryResourceArchive {
    pub file_name: String,
    pub source_path: String,
    pub cache_path: String,
    pub byte_size: i64,
}

#[derive(Debug, Clone)]
pub struct DictionaryCloudFile {
    pub file_name: String,
    pub media_type: String,
    pub public_url: String,
    pub byte_size: i64,
}

const DICTIONARY_SELECT: &str = "\
    SELECT d.id, d.name, d.source_path, d.mdx_path, d.entry_count, d.imported_at, d.updated_at, \
           CASE WHEN EXISTS ( \
             SELECT 1 FROM custom_dictionary_files f \
              WHERE f.dictionary_id = d.id AND f.role = 'mdx' \
           ) THEN 'database' ELSE 'external' END AS storage_kind, \
           COALESCE(( \
             SELECT f.byte_size FROM custom_dictionary_files f \
              WHERE f.dictionary_id = d.id AND f.role = 'mdx' \
              ORDER BY f.file_name LIMIT 1 \
           ), 0) AS mdx_size, \
           ( \
             SELECT COUNT(*) FROM custom_dictionary_files f \
              WHERE f.dictionary_id = d.id AND f.role = 'asset' \
           ) AS asset_count, \
           ( \
             SELECT COUNT(*) FROM custom_dictionary_resource_archives a \
              WHERE a.dictionary_id = d.id \
           ) AS resource_archive_count, \
           COALESCE(( \
             SELECT SUM(a.byte_size) FROM custom_dictionary_resource_archives a \
              WHERE a.dictionary_id = d.id \
           ), 0) AS resource_archive_size, \
           ( \
             SELECT COUNT(*) FROM custom_dictionary_cloud_files c \
              WHERE c.dictionary_id = d.id \
           ) AS cloud_file_count, \
           COALESCE(( \
             SELECT SUM(c.byte_size) FROM custom_dictionary_cloud_files c \
              WHERE c.dictionary_id = d.id \
           ), 0) AS cloud_file_size \
      FROM custom_dictionaries d";

pub async fn upsert_on_conn(
    conn: &Connection,
    name: &str,
    source_path: &str,
    mdx_path: &str,
    entry_count: i64,
) -> DbResult<CustomDictionary> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO custom_dictionaries \
           (name, source_path, mdx_path, entry_count, imported_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
         ON CONFLICT(source_path) DO UPDATE SET \
           name = excluded.name, \
           mdx_path = excluded.mdx_path, \
           entry_count = excluded.entry_count, \
           updated_at = excluded.updated_at",
        turso::params![name, source_path, mdx_path, entry_count, now],
    )
    .await?;

    get_by_source_on_conn(conn, source_path)
        .await?
        .ok_or_else(|| "custom dictionary upsert did not return a row".into())
}

pub async fn upsert(
    name: &str,
    source_path: &str,
    mdx_path: &str,
    entry_count: i64,
) -> DbResult<CustomDictionary> {
    let conn = get_connection()?.lock().await;
    upsert_on_conn(&conn, name, source_path, mdx_path, entry_count).await
}

pub async fn upsert_import(
    name: &str,
    source_path: &str,
    mdx_path: &str,
    entry_count: i64,
    files: Vec<DictionaryFileInput>,
) -> DbResult<CustomDictionary> {
    let conn = get_connection()?.lock().await;
    let dict = upsert_on_conn(&conn, name, source_path, mdx_path, entry_count).await?;
    conn.execute(
        "DELETE FROM custom_dictionary_files WHERE dictionary_id = ?1",
        turso::params![dict.id],
    )
    .await?;

    let now = now_ms();
    for file in files {
        let byte_size = file.content.len() as i64;
        conn.execute(
            "INSERT INTO custom_dictionary_files \
               (dictionary_id, role, file_name, media_type, content, byte_size, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            turso::params![
                dict.id,
                file.role,
                file.file_name,
                file.media_type,
                file.content,
                byte_size,
                now
            ],
        )
        .await?;
    }

    get_on_conn(&conn, dict.id)
        .await?
        .ok_or_else(|| "custom dictionary import did not return a row".into())
}

pub async fn list_on_conn(conn: &Connection) -> DbResult<Vec<CustomDictionary>> {
    let sql = format!("{DICTIONARY_SELECT} ORDER BY d.updated_at DESC, d.id DESC");
    let mut rows = conn.query(sql.as_str(), ()).await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row_to_dictionary(&row)?);
    }
    Ok(out)
}

pub async fn list() -> DbResult<Vec<CustomDictionary>> {
    let conn = get_connection()?.lock().await;
    list_on_conn(&conn).await
}

pub async fn get_on_conn(conn: &Connection, id: i64) -> DbResult<Option<CustomDictionary>> {
    let sql = format!("{DICTIONARY_SELECT} WHERE d.id = ?1");
    let mut rows = conn.query(sql.as_str(), turso::params![id]).await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(row_to_dictionary(&row)?))
    } else {
        Ok(None)
    }
}

pub async fn get(id: i64) -> DbResult<Option<CustomDictionary>> {
    let conn = get_connection()?.lock().await;
    get_on_conn(&conn, id).await
}

async fn get_by_source_on_conn(
    conn: &Connection,
    source_path: &str,
) -> DbResult<Option<CustomDictionary>> {
    let sql = format!("{DICTIONARY_SELECT} WHERE d.source_path = ?1");
    let mut rows = conn
        .query(sql.as_str(), turso::params![source_path])
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(row_to_dictionary(&row)?))
    } else {
        Ok(None)
    }
}

fn row_to_dictionary(row: &turso::Row) -> DbResult<CustomDictionary> {
    Ok(CustomDictionary {
        id: row.get::<i64>(0)?,
        name: row.get::<String>(1)?,
        source_path: row.get::<String>(2)?,
        mdx_path: row.get::<String>(3)?,
        entry_count: row.get::<i64>(4)?,
        imported_at: row.get::<i64>(5)?,
        updated_at: row.get::<i64>(6)?,
        storage_kind: row.get::<String>(7)?,
        mdx_size: row.get::<i64>(8)?,
        asset_count: row.get::<i64>(9)?,
        resource_archive_count: row.get::<i64>(10)?,
        resource_archive_size: row.get::<i64>(11)?,
        cloud_file_count: row.get::<i64>(12)?,
        cloud_file_size: row.get::<i64>(13)?,
    })
}

pub async fn replace_resource_archives(
    dictionary_id: i64,
    archives: Vec<DictionaryResourceArchiveInput>,
) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    conn.execute(
        "DELETE FROM custom_dictionary_resource_archives WHERE dictionary_id = ?1",
        turso::params![dictionary_id],
    )
    .await?;

    let now = now_ms();
    for archive in archives {
        conn.execute(
            "INSERT INTO custom_dictionary_resource_archives \
               (dictionary_id, file_name, source_path, cache_path, byte_size, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            turso::params![
                dictionary_id,
                archive.file_name,
                archive.source_path,
                archive.cache_path,
                archive.byte_size,
                now
            ],
        )
        .await?;
    }

    Ok(())
}

pub async fn list_resource_archives(
    dictionary_id: i64,
) -> DbResult<Vec<DictionaryResourceArchive>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT file_name, source_path, cache_path, byte_size \
               FROM custom_dictionary_resource_archives \
              WHERE dictionary_id = ?1 \
              ORDER BY file_name",
            turso::params![dictionary_id],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(DictionaryResourceArchive {
            file_name: row.get::<String>(0)?,
            source_path: row.get::<String>(1)?,
            cache_path: row.get::<String>(2)?,
            byte_size: row.get::<i64>(3)?,
        });
    }
    Ok(out)
}

pub async fn upsert_cloud_file(
    dictionary_id: i64,
    file_name: &str,
    media_type: &str,
    public_url: &str,
    byte_size: i64,
) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    let now = now_ms();
    conn.execute(
        "INSERT INTO custom_dictionary_cloud_files \
           (dictionary_id, file_name, media_type, public_url, byte_size, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT(dictionary_id, file_name) DO UPDATE SET \
           media_type = excluded.media_type, \
           public_url = excluded.public_url, \
           byte_size = excluded.byte_size, \
           updated_at = excluded.updated_at",
        turso::params![
            dictionary_id,
            file_name,
            media_type,
            public_url,
            byte_size,
            now
        ],
    )
    .await?;
    Ok(())
}

pub async fn list_cloud_files(dictionary_id: i64) -> DbResult<Vec<DictionaryCloudFile>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT file_name, media_type, public_url, byte_size \
               FROM custom_dictionary_cloud_files \
              WHERE dictionary_id = ?1 \
              ORDER BY file_name",
            turso::params![dictionary_id],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(DictionaryCloudFile {
            file_name: row.get::<String>(0)?,
            media_type: row.get::<String>(1)?,
            public_url: row.get::<String>(2)?,
            byte_size: row.get::<i64>(3)?,
        });
    }
    Ok(out)
}

pub async fn get_file_meta(dictionary_id: i64, role: &str) -> DbResult<Option<DictionaryFileMeta>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT file_name, media_type, byte_size \
               FROM custom_dictionary_files \
              WHERE dictionary_id = ?1 AND role = ?2 \
              ORDER BY file_name \
              LIMIT 1",
            turso::params![dictionary_id, role],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(DictionaryFileMeta {
            file_name: row.get::<String>(0)?,
            media_type: row.get::<String>(1)?,
            byte_size: row.get::<i64>(2)?,
        }))
    } else {
        Ok(None)
    }
}

pub async fn get_file(
    dictionary_id: i64,
    role: &str,
    file_name: &str,
) -> DbResult<Option<DictionaryFile>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT file_name, media_type, content, byte_size \
               FROM custom_dictionary_files \
              WHERE dictionary_id = ?1 AND role = ?2 AND file_name = ?3",
            turso::params![dictionary_id, role, file_name],
        )
        .await?;
    if let Some(row) = rows.next().await? {
        Ok(Some(DictionaryFile {
            file_name: row.get::<String>(0)?,
            media_type: row.get::<String>(1)?,
            content: row.get::<Vec<u8>>(2)?,
            byte_size: row.get::<i64>(3)?,
        }))
    } else {
        Ok(None)
    }
}

pub async fn list_assets(dictionary_id: i64) -> DbResult<Vec<DictionaryFile>> {
    let conn = get_connection()?.lock().await;
    let mut rows = conn
        .query(
            "SELECT file_name, media_type, content, byte_size \
               FROM custom_dictionary_files \
              WHERE dictionary_id = ?1 AND role = 'asset' \
              ORDER BY file_name",
            turso::params![dictionary_id],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(DictionaryFile {
            file_name: row.get::<String>(0)?,
            media_type: row.get::<String>(1)?,
            content: row.get::<Vec<u8>>(2)?,
            byte_size: row.get::<i64>(3)?,
        });
    }
    Ok(out)
}
