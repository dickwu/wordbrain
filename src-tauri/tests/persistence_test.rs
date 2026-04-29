//! AC7 — mark-known persists across a full app restart.
//!
//! Opens a Turso-backed SQLite file at a tempdir path, applies the WordBrain
//! schema, marks a lemma as known via the same helper the Tauri command uses,
//! drops the connection, re-opens the file, and confirms the lemma survived.
//! This exercises the exact `db::schema::apply` + `db::words::mark_known_on_conn`
//! code path the production `mark_known` IPC handler calls.

use std::path::PathBuf;

use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{lookup_history, names, schema, words};

async fn open(path: &PathBuf) -> turso::Connection {
    let db = Builder::new_local(path.to_str().expect("utf8 path"))
        .build()
        .await
        .expect("build turso db");
    let conn = db.connect().expect("connect turso db");
    // Match the pragmas used by the app's `db::init`.
    let _ = conn.execute("PRAGMA journal_mode = WAL;", ()).await;
    let _ = conn.execute("PRAGMA synchronous = NORMAL;", ()).await;
    conn
}

#[tokio::test]
async fn mark_known_survives_connection_close_and_reopen() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");

    // --- Session 1: install schema, mark two lemmas as known, close. ---
    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.expect("apply schema (fresh)");
        words::mark_known_on_conn(&conn, "serendipity", Some("manual"))
            .await
            .expect("mark_known (session 1)");
        words::mark_known_on_conn(&conn, "quixotic", None)
            .await
            .expect("mark_known default source (session 1)");
        let known = words::get_all_known_lemmas_on_conn(&conn)
            .await
            .expect("read back before close");
        assert!(known.contains(&"serendipity".to_string()));
        assert!(known.contains(&"quixotic".to_string()));
        // `conn` dropped at the end of this block — simulates app shutdown.
    }

    // --- Session 2: re-open the same file, verify persistence. ---
    {
        let conn = open(&db_path).await;
        // Schema apply is idempotent — re-running it must succeed.
        schema::apply(&conn).await.expect("apply schema (reopen)");
        let known = words::get_all_known_lemmas_on_conn(&conn)
            .await
            .expect("read back after reopen");
        assert!(
            known.contains(&"serendipity".to_string()),
            "manually-marked lemma did not survive restart; got {known:?}"
        );
        assert!(known.contains(&"quixotic".to_string()));
        let count = words::count_known_on_conn(&conn)
            .await
            .expect("count known after reopen");
        assert_eq!(
            count, 2,
            "expected exactly the two marked lemmas to persist"
        );
    }
}

#[tokio::test]
async fn unmark_known_is_persistent_too() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        words::mark_known_on_conn(&conn, "ephemeral", Some("manual"))
            .await
            .unwrap();
        words::unmark_known_on_conn(&conn, "ephemeral")
            .await
            .unwrap();
    }

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let known = words::get_all_known_lemmas_on_conn(&conn).await.unwrap();
        assert!(
            !known.contains(&"ephemeral".to_string()),
            "unmark must also persist across restart"
        );
    }
}

#[tokio::test]
async fn seed_then_restart_preserves_freq_seed() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");

    let sample: Vec<(String, u32)> = (1u32..=50)
        .map(|rank| (format!("word{:04}", rank), rank))
        .collect();

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let n = words::seed_known_from_frequency_on_conn(&conn, &sample)
            .await
            .unwrap();
        assert_eq!(n, 50, "all 50 fresh rows should insert");

        // Second pass should be a no-op since `INSERT OR IGNORE` skips existing rows.
        let n2 = words::seed_known_from_frequency_on_conn(&conn, &sample)
            .await
            .unwrap();
        assert_eq!(n2, 0, "second seed must not double-insert");
    }

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let known = words::get_all_known_lemmas_on_conn(&conn).await.unwrap();
        assert_eq!(known.len(), 50, "seeded rows must survive restart");
        assert!(known.iter().any(|l| l == "word0001"));
        assert!(known.iter().any(|l| l == "word0050"));
    }
}

#[tokio::test]
async fn known_names_seed_and_manual_entries_survive_restart() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let seeded = names::get_all_known_names_on_conn(&conn).await.unwrap();
        assert!(seeded.contains(&"mia".to_string()));

        names::mark_known_name_on_conn(&conn, "Juniper's", Some("manual"))
            .await
            .unwrap();
    }

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let known_names = names::get_all_known_names_on_conn(&conn).await.unwrap();
        assert!(known_names.contains(&"mia".to_string()));
        assert!(known_names.contains(&"juniper".to_string()));
    }
}

#[tokio::test]
async fn lookup_history_survives_connection_close_and_reopen() {
    let dir = TempDir::new().expect("tempdir");
    let db_path = dir.path().join("wordbrain.db");

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        lookup_history::record_lookup_on_conn(&conn, "automatic")
            .await
            .unwrap();
        lookup_history::record_lookup_on_conn(&conn, "serendipity")
            .await
            .unwrap();
        lookup_history::record_lookup_on_conn(&conn, "automatic")
            .await
            .unwrap();
    }

    {
        let conn = open(&db_path).await;
        schema::apply(&conn).await.unwrap();
        let rows = lookup_history::list_lookup_history_on_conn(&conn, 20)
            .await
            .unwrap();
        let automatic = rows.iter().find(|row| row.lemma == "automatic").unwrap();
        assert_eq!(automatic.lookup_count, 2);
        assert!(rows.iter().any(|row| row.lemma == "serendipity"));
    }
}
