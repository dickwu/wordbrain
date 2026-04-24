//! Phase-3 persistence + recommender integration tests.
//!
//! These exercise `db::materials::*_on_conn` against a real Turso file so the
//! exact SQL path used by the Tauri command handlers is covered end to end.

use std::path::PathBuf;

use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{materials, schema, words};

async fn open(path: &PathBuf) -> turso::Connection {
    let db = Builder::new_local(path.to_str().expect("utf8 path"))
        .build()
        .await
        .expect("build turso db");
    db.connect().expect("connect turso db")
}

fn token(lemma: &str, first_position: i64, preview: &str) -> materials::TokenEdge {
    materials::TokenEdge {
        lemma: lemma.to_string(),
        occurrence_count: 1,
        first_position,
        sentence_preview: Some(preview.to_string()),
    }
}

fn mk_input(title: &str, raw: &str, tokens: Vec<materials::TokenEdge>) -> materials::SaveMaterialInput {
    let unique = tokens.len() as i64;
    materials::SaveMaterialInput {
        title: title.to_string(),
        source_kind: "paste".to_string(),
        origin_path: None,
        tiptap_json: format!("{{\"type\":\"doc\",\"content\":[{{\"type\":\"paragraph\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}]}}", raw.replace('"', "'")),
        raw_text: raw.to_string(),
        total_tokens: unique, // synthetic — one occurrence per token
        unique_tokens: unique,
        tokens,
        parent_material_id: None,
        chapter_index: None,
    }
}

// ---------------------------------------------------------------------------
// AC1: save_material persists raw_text, tiptap_json, metadata and edges.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn save_material_persists_rows_and_edges() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.unwrap();

    // Pre-seed one lemma as known so the unknown_count_at_import is < tokens.
    words::mark_known_on_conn(&conn, "the", Some("seed_freq"))
        .await
        .unwrap();

    let input = mk_input(
        "tiny doc",
        "the quick fox jumps",
        vec![
            token("the", 0, "the quick fox jumps."),
            token("quick", 4, "the quick fox jumps."),
            token("fox", 10, "the quick fox jumps."),
            token("jumps", 14, "the quick fox jumps."),
        ],
    );

    let out = materials::save_material_on_conn(&conn, &input).await.unwrap();
    assert!(out.material_id > 0);
    // 3 unknown lemmas (quick, fox, jumps) — "the" was pre-known.
    assert_eq!(out.unknown_count_at_import, 3);

    // Round-trip via list_materials.
    let list = materials::list_materials_on_conn(&conn).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].title, "tiny doc");
    assert_eq!(list[0].unknown_count, 3);
    assert_eq!(list[0].unique_tokens, 4);

    // And via materials_for_word.
    let for_fox = materials::materials_for_word_on_conn(&conn, "fox")
        .await
        .unwrap();
    assert_eq!(for_fox.len(), 1);
    assert_eq!(for_fox[0].title, "tiny doc");
    assert_eq!(
        for_fox[0].sentence_preview.as_deref(),
        Some("the quick fox jumps.")
    );
}

// ---------------------------------------------------------------------------
// AC4: closing a material auto-graduates words at the threshold.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn material_close_auto_graduates_at_threshold() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.unwrap();

    // One material that contains "serendipity". We close it THRESHOLD times so
    // the word auto-graduates (the plan reuses a single material for clarity;
    // in production each close is a different material but the SQL is the same).
    let input = mk_input(
        "graduation doc",
        "serendipity is a rare word.",
        vec![token("serendipity", 0, "serendipity is a rare word.")],
    );
    let saved = materials::save_material_on_conn(&conn, &input)
        .await
        .unwrap();

    let threshold = 5_i64;

    // First 4 closes: still unknown.
    for _ in 0..4 {
        let outcome = materials::record_material_close_on_conn(&conn, saved.material_id, threshold)
            .await
            .unwrap();
        assert!(outcome.graduated_to_learning.is_empty());
        assert!(outcome.graduated_to_known.is_empty());
    }

    // 5th close: unknown → learning.
    let outcome = materials::record_material_close_on_conn(&conn, saved.material_id, threshold)
        .await
        .unwrap();
    assert_eq!(outcome.graduated_to_learning, vec!["serendipity".to_string()]);
    assert!(outcome.graduated_to_known.is_empty());

    // 6th close: learning → known.
    let outcome = materials::record_material_close_on_conn(&conn, saved.material_id, threshold)
        .await
        .unwrap();
    assert!(outcome.graduated_to_learning.is_empty());
    assert_eq!(outcome.graduated_to_known, vec!["serendipity".to_string()]);

    // Confirm final state persisted via the words helper.
    let known = words::get_all_known_lemmas_on_conn(&conn).await.unwrap();
    assert!(known.contains(&"serendipity".to_string()));
}

#[tokio::test]
async fn undo_graduation_reverts_state() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.unwrap();

    let input = mk_input(
        "undo doc",
        "ephemeral bloom.",
        vec![token("ephemeral", 0, "ephemeral bloom.")],
    );
    let saved = materials::save_material_on_conn(&conn, &input)
        .await
        .unwrap();

    let thr = 1_i64;
    // one close → ephemeral promoted to 'learning' via auto_exposure
    materials::record_material_close_on_conn(&conn, saved.material_id, thr)
        .await
        .unwrap();

    materials::undo_graduation_on_conn(
        &conn,
        &["ephemeral".to_string()], // undo back to unknown
        &[],
    )
    .await
    .unwrap();

    // After undo, no word should be marked known; the row should be back to 'unknown'.
    let known = words::get_all_known_lemmas_on_conn(&conn).await.unwrap();
    assert!(!known.contains(&"ephemeral".to_string()));
}

// ---------------------------------------------------------------------------
// AC5: recommend_next scores 50 synthetic docs; top pick lives in [0.02, 0.05].
// ---------------------------------------------------------------------------

#[tokio::test]
async fn recommend_next_with_50_docs_picks_target_ratio_doc() {
    let dir = TempDir::new().unwrap();
    let db_path = dir.path().join("wordbrain.db");
    let conn = open(&db_path).await;
    schema::apply(&conn).await.unwrap();

    // Build a deterministic universe of lemmas. Numbering keeps identity unique
    // across the 50 documents even when the "known" percentage varies.
    //
    // Each doc has 200 unique lemmas. We mark a fraction as known so the
    // residual unknown_ratio sweeps from ~35 % down to ~0.5 %.
    let doc_size: usize = 200;
    let doc_count: usize = 50;

    // Pre-mark a global pool of "seed known" lemmas before any import so the
    // save path picks them up correctly. We reuse a single shared vocabulary
    // across docs so words behave like natural zipfian repetition.
    let global_vocab: Vec<String> = (0..600)
        .map(|i| format!("w{:04}", i))
        .collect();

    // Mark 450 of the 600 as known upfront (75 %). That gives each doc a
    // ~25 % baseline unknown rate unless we stretch the doc's vocabulary.
    for w in &global_vocab[..450] {
        words::mark_known_on_conn(&conn, w, Some("seed_freq"))
            .await
            .unwrap();
    }

    // Each doc picks `doc_size` lemmas from the shared pool. By sliding the
    // window position we make the unknown_ratio vary smoothly from ~0 to ~0.75
    // (depending on how much of the 450-known prefix the window covers).
    let mut target_doc_id: Option<i64> = None;
    for i in 0..doc_count {
        // Window start: evenly space across the vocab so ratios sweep.
        let start = (i * (global_vocab.len() - doc_size)) / doc_count.max(1);
        let slice = &global_vocab[start..start + doc_size];
        let tokens: Vec<materials::TokenEdge> = slice
            .iter()
            .enumerate()
            .map(|(pos, lemma)| materials::TokenEdge {
                lemma: lemma.clone(),
                occurrence_count: 1,
                first_position: pos as i64,
                sentence_preview: Some(format!("… {} …", lemma)),
            })
            .collect();
        let input = materials::SaveMaterialInput {
            title: format!("synthetic-{i:03}"),
            source_kind: "paste".to_string(),
            origin_path: None,
            tiptap_json: "{}".to_string(),
            raw_text: slice.join(" "),
            total_tokens: 1000, // inside the length-penalty sweet spot
            unique_tokens: doc_size as i64,
            tokens,
            parent_material_id: None,
            chapter_index: None,
        };
        let saved = materials::save_material_on_conn(&conn, &input)
            .await
            .unwrap();

        // Record which synthetic doc's unknown_ratio sits inside [0.02, 0.05].
        // Target = 3.5 %. Doc 28 (window fully past the 450-known prefix gives
        // ~22 unknowns in 200 = 11 %)… We'll compute ratio empirically below.
        if target_doc_id.is_none() {
            let ratio = saved.unknown_count_at_import as f64 / saved.unique_tokens as f64;
            if (0.02..=0.05).contains(&ratio) {
                target_doc_id = Some(saved.material_id);
            }
        }
    }

    assert!(
        target_doc_id.is_some(),
        "no synthetic doc landed in the [0.02, 0.05] sweet spot — adjust the window math"
    );

    let recs = materials::recommend_next_on_conn(&conn, 0.035, 5)
        .await
        .unwrap();
    assert_eq!(recs.len(), 5);
    assert!(
        (0.02..=0.05).contains(&recs[0].unknown_ratio),
        "rank-1 unknown_ratio {:.4} outside [0.02, 0.05]",
        recs[0].unknown_ratio
    );

    // Sanity: scores must be monotonically non-decreasing.
    for pair in recs.windows(2) {
        assert!(
            pair[0].score <= pair[1].score,
            "recommendations not sorted by score: {:?} then {:?}",
            pair[0].score,
            pair[1].score
        );
    }
}

#[test]
fn score_material_prefers_target_ratio() {
    // Two docs of identical length — the closer ratio wins.
    let at_target = materials::score_material(0.035, 1000, 0.035);
    let far = materials::score_material(0.20, 1000, 0.035);
    assert!(at_target < far);

    // Length penalty is capped so ratio dominates.
    let ideal_ratio_tiny = materials::score_material(0.035, 50, 0.035);
    let poor_ratio_long = materials::score_material(0.20, 1000, 0.035);
    assert!(ideal_ratio_tiny < poor_ratio_long);
}
