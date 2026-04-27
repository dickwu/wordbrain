//! Phase-2 acceptance verifications for the bundled offline dictionary and
//! the online/AI cache.
//!
//! * AC1: `ecdict.db` present with ≥ 700k rows.
//! * AC2: `lookup_offline` covers ≥ 95% of SUBTLEX-US top-5000 lemmas.
//! * AC3: `word_translations_cache` hit round-trip under 10 ms.

use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::Deserialize;
use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{cache, dict, schema};

fn ecdict_path() -> PathBuf {
    // Tests run with CARGO_MANIFEST_DIR == src-tauri
    let dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    Path::new(&dir).join("assets").join("ecdict.db")
}

async fn open(path: &Path) -> turso::Connection {
    let db = Builder::new_local(path.to_str().expect("utf-8 db path"))
        .build()
        .await
        .expect("open sqlite");
    let conn = db.connect().expect("connect sqlite");
    let _ = conn.execute("PRAGMA journal_mode = WAL;", ()).await;
    let _ = conn.execute("PRAGMA synchronous = NORMAL;", ()).await;
    conn
}

#[tokio::test]
async fn ecdict_bundle_has_at_least_700k_rows() {
    let p = ecdict_path();
    assert!(
        p.exists(),
        "bundled ecdict.db is missing at {} — run scripts/build-ecdict-db.py",
        p.display()
    );
    let conn = open(&p).await;
    let mut rows = conn
        .query("SELECT COUNT(*) FROM dictionary_entries", ())
        .await
        .expect("count");
    let count: i64 = rows
        .next()
        .await
        .unwrap()
        .unwrap()
        .get(0)
        .expect("int cast");
    assert!(count >= 700_000, "expected ≥ 700k rows, got {count}");
}

#[derive(Deserialize)]
struct FrequencyPayload {
    entries: Vec<(String, u32, u64)>,
}

#[tokio::test]
async fn lookup_offline_covers_subtlex_top5000() {
    let p = ecdict_path();
    if !p.exists() {
        eprintln!("skip: ecdict.db missing at {}", p.display());
        return;
    }
    let conn = open(&p).await;

    let freq_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("subtlex_us_freq.json");
    let freq_bytes = std::fs::read(&freq_path).expect("read subtlex json");
    let payload: FrequencyPayload =
        serde_json::from_slice(&freq_bytes).expect("parse subtlex json");
    let top5000: Vec<String> = payload
        .entries
        .into_iter()
        .take(5000)
        .map(|(lemma, _, _)| lemma)
        .collect();
    assert_eq!(top5000.len(), 5000, "need 5000 SUBTLEX rows");

    let mut hits = 0usize;
    for lemma in &top5000 {
        if dict::lookup_offline_on_conn(&conn, lemma)
            .await
            .expect("lookup")
            .is_some()
        {
            hits += 1;
        }
    }
    let coverage = hits as f64 / top5000.len() as f64;
    assert!(
        coverage >= 0.95,
        "coverage {:.3} below 0.95 ({} / 5000 hit)",
        coverage,
        hits
    );
}

#[tokio::test]
async fn cache_round_trip_under_10ms() {
    // Independent temp DB so the test is hermetic.
    let dir = TempDir::new().expect("tempdir");
    let path = dir.path().join("wordbrain.db");
    let conn = open(&path).await;
    schema::apply(&conn).await.expect("schema");

    // Prime the cache with a canned translation.
    cache::put_cached_on_conn(
        &conn,
        "serendipity",
        "youdao",
        "",
        "偶然发现珍宝的运气",
        None,
        Some("{\"canned\": true}"),
    )
    .await
    .expect("put");

    // Warm-up read (compile the statement, fill page cache).
    let _ = cache::get_cached_on_conn(&conn, "serendipity", "youdao", "")
        .await
        .expect("warmup get");

    // Measure. Loop a few iterations and take the median so jitter doesn't
    // blow the budget on cold laptops.
    let mut durations: Vec<u128> = Vec::with_capacity(50);
    for _ in 0..50 {
        let t = Instant::now();
        let row = cache::get_cached_on_conn(&conn, "serendipity", "youdao", "")
            .await
            .expect("get");
        assert!(row.is_some());
        durations.push(t.elapsed().as_micros());
    }
    durations.sort();
    let p50 = durations[durations.len() / 2];
    assert!(p50 < 10_000, "p50 cache hit {p50} µs exceeds 10 ms budget");
}
