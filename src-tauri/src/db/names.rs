//! Proper-name allowlist used by reader highlighting.
//!
//! Names live outside the `words` table so people and characters do not pollute
//! the learner's vocabulary list, exposure counters, SRS queue, or word graph.

use turso::Connection;

use super::{get_connection, now_ms, DbResult};

pub const BUILTIN_KNOWN_NAMES: &[&str] = &[
    "aaron",
    "abigail",
    "adam",
    "aiden",
    "alexander",
    "alice",
    "allison",
    "amelia",
    "andrew",
    "anna",
    "anthony",
    "aria",
    "ariana",
    "ashton",
    "aubrey",
    "audrey",
    "aurora",
    "ava",
    "avery",
    "bella",
    "benjamin",
    "brooklyn",
    "caleb",
    "camila",
    "cameron",
    "caroline",
    "charles",
    "charlotte",
    "chloe",
    "christian",
    "claire",
    "connor",
    "cora",
    "daniel",
    "david",
    "dylan",
    "eleanor",
    "elena",
    "eli",
    "elijah",
    "elizabeth",
    "ella",
    "ellie",
    "emilia",
    "emily",
    "emma",
    "ethan",
    "eva",
    "evan",
    "evelyn",
    "ezra",
    "gabriel",
    "gabriella",
    "grayson",
    "hannah",
    "harper",
    "henry",
    "hudson",
    "ian",
    "isabella",
    "isaac",
    "isaiah",
    "jack",
    "jackson",
    "jacob",
    "james",
    "jayden",
    "john",
    "jordan",
    "joseph",
    "josephine",
    "josiah",
    "julian",
    "kennedy",
    "layla",
    "leah",
    "leo",
    "levi",
    "liam",
    "lily",
    "lincoln",
    "logan",
    "lucas",
    "lucy",
    "luke",
    "lydia",
    "madelyn",
    "mason",
    "mateo",
    "matthew",
    "maya",
    "mia",
    "michael",
    "naomi",
    "natalie",
    "nathan",
    "nicholas",
    "noah",
    "nora",
    "oliver",
    "olivia",
    "owen",
    "paisley",
    "penelope",
    "piper",
    "riley",
    "roman",
    "ryan",
    "sadie",
    "samuel",
    "sarah",
    "savannah",
    "scarlett",
    "sebastian",
    "serena",
    "skylar",
    "sofia",
    "sophia",
    "stella",
    "theodore",
    "thomas",
    "victoria",
    "william",
    "wyatt",
    "zoe",
    "zoey",
];

pub async fn seed_builtin_names_on_conn(conn: &Connection) -> DbResult<()> {
    let now = now_ms();
    for name in BUILTIN_KNOWN_NAMES {
        conn.execute(
            "INSERT OR IGNORE INTO known_names (name, source, created_at, updated_at) \
             VALUES (?1, 'builtin', ?2, ?2)",
            turso::params![*name, now],
        )
        .await?;
    }
    Ok(())
}

pub async fn get_all_known_names_on_conn(conn: &Connection) -> DbResult<Vec<String>> {
    let mut rows = conn
        .query("SELECT name FROM known_names ORDER BY name ASC", ())
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}

pub async fn get_all_known_names() -> DbResult<Vec<String>> {
    let conn = get_connection()?.lock().await;
    get_all_known_names_on_conn(&conn).await
}

pub async fn mark_known_name_on_conn(
    conn: &Connection,
    name: &str,
    source: Option<&str>,
) -> DbResult<()> {
    let key = normalize_name_key(name);
    if key.is_empty() {
        return Ok(());
    }
    let now = now_ms();
    let source = source.unwrap_or("manual");
    conn.execute(
        "INSERT INTO known_names (name, source, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?3) \
         ON CONFLICT(name) DO UPDATE SET \
           source = excluded.source, \
           updated_at = excluded.updated_at",
        turso::params![key.as_str(), source, now],
    )
    .await?;
    Ok(())
}

pub async fn mark_known_name(name: &str, source: Option<&str>) -> DbResult<()> {
    let conn = get_connection()?.lock().await;
    mark_known_name_on_conn(&conn, name, source).await
}

fn normalize_name_key(name: &str) -> String {
    let mut key = name.trim().to_lowercase();
    for suffix in ["'s", "\u{2019}s"] {
        if key.ends_with(suffix) {
            let len = key.len() - suffix.len();
            key.truncate(len);
            break;
        }
    }
    key
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
    async fn schema_seed_includes_mia() {
        let conn = setup_db().await;
        let names = get_all_known_names_on_conn(&conn).await.unwrap();
        assert!(names.contains(&"mia".to_string()));
    }

    #[tokio::test]
    async fn mark_known_name_normalizes_possessive_surface() {
        let conn = setup_db().await;
        mark_known_name_on_conn(&conn, "Juniper's", Some("manual"))
            .await
            .unwrap();
        let names = get_all_known_names_on_conn(&conn).await.unwrap();
        assert!(names.contains(&"juniper".to_string()));
    }
}
