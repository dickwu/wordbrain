//! Phase-6 word-network builder integration tests.
//!
//! Exercises the `db::network::*_on_conn` surface against a real Turso file so
//! the exact SQL path the Tauri command uses at runtime is covered end to end.

use std::path::PathBuf;

use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{materials, network, schema, words};

async fn open(path: &PathBuf) -> turso::Connection {
    let db = Builder::new_local(path.to_str().expect("utf8 path"))
        .build()
        .await
        .expect("build turso db");
    db.connect().expect("connect turso db")
}

fn token(lemma: &str, pos: i64, preview: &str) -> materials::TokenEdge {
    materials::TokenEdge {
        lemma: lemma.to_string(),
        occurrence_count: 1,
        first_position: pos,
        sentence_preview: Some(preview.to_string()),
    }
}

fn mk_input(title: &str, raw: &str, tokens: Vec<materials::TokenEdge>) -> materials::SaveMaterialInput {
    let unique = tokens.len() as i64;
    materials::SaveMaterialInput {
        title: title.to_string(),
        source_kind: "paste".to_string(),
        origin_path: None,
        tiptap_json: "{}".to_string(),
        raw_text: raw.to_string(),
        total_tokens: unique,
        unique_tokens: unique,
        tokens,
        parent_material_id: None,
        chapter_index: None,
    }
}

// ---------------------------------------------------------------------------
// AC1: build_network returns nodes (state + exposure_count) + edges
// (shared-material weight).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn build_network_returns_nodes_and_weighted_edges() {
    let dir = TempDir::new().unwrap();
    let conn = open(&dir.path().join("wb.db")).await;
    schema::apply(&conn).await.unwrap();

    // Pre-seed "the" as known so at least one node carries state='known'.
    words::mark_known_on_conn(&conn, "the", Some("seed_freq"))
        .await
        .unwrap();

    // Two materials that overlap on {the, fox}. A third with an isolated word
    // that has no neighbours — it should still be queryable but won't appear in
    // the returned node list because we filter to words with ≥1 edge.
    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-a",
            "the quick fox",
            vec![
                token("the", 0, "the quick fox"),
                token("quick", 4, "the quick fox"),
                token("fox", 10, "the quick fox"),
            ],
        ),
    )
    .await
    .unwrap();

    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-b",
            "the slow fox",
            vec![
                token("the", 0, "the slow fox"),
                token("slow", 4, "the slow fox"),
                token("fox", 9, "the slow fox"),
            ],
        ),
    )
    .await
    .unwrap();

    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-c",
            "loner",
            vec![token("loner", 0, "loner")],
        ),
    )
    .await
    .unwrap();

    let net = network::build_network_on_conn(&conn, 500).await.unwrap();

    // 4 words (the, quick, fox, slow) are in at least one material with
    // another word. `loner` has no co-occurrence so it's excluded.
    let lemmas: Vec<&str> = net.nodes.iter().map(|n| n.lemma.as_str()).collect();
    assert!(lemmas.contains(&"the"));
    assert!(lemmas.contains(&"quick"));
    assert!(lemmas.contains(&"fox"));
    assert!(lemmas.contains(&"slow"));
    assert!(!lemmas.contains(&"loner"));
    assert_eq!(net.nodes.len(), 4);

    // state + exposure_count carried correctly.
    let the = net.nodes.iter().find(|n| n.lemma == "the").unwrap();
    assert_eq!(the.state, "known");

    // Edge (the, fox) appears in both docs → weight=2. (the, quick) weight=1.
    let id_of = |lemma: &str| -> i64 {
        net.nodes
            .iter()
            .find(|n| n.lemma == lemma)
            .unwrap()
            .id
    };
    let the_id = id_of("the");
    let fox_id = id_of("fox");
    let quick_id = id_of("quick");

    let find_edge = |a: i64, b: i64| -> Option<&network::NetworkEdge> {
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        net.edges.iter().find(|e| e.source == lo && e.target == hi)
    };

    let the_fox = find_edge(the_id, fox_id).expect("the–fox edge missing");
    assert_eq!(the_fox.weight, 2, "the–fox should span two materials");

    let the_quick = find_edge(the_id, quick_id).expect("the–quick edge missing");
    assert_eq!(the_quick.weight, 1);

    // total_words reports every row, even the isolated `loner`.
    assert_eq!(net.total_words, 5);

    // material_ids attribution: "the" appears in both docs, "quick" only in doc-a.
    let fox_node = net.nodes.iter().find(|n| n.lemma == "fox").unwrap();
    assert_eq!(fox_node.material_ids.len(), 2);
    let quick_node = net.nodes.iter().find(|n| n.lemma == "quick").unwrap();
    assert_eq!(quick_node.material_ids.len(), 1);
}

// ---------------------------------------------------------------------------
// AC2: limit pre-filters to top-N most-connected words.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn build_network_respects_limit_and_picks_most_connected() {
    let dir = TempDir::new().unwrap();
    let conn = open(&dir.path().join("wb.db")).await;
    schema::apply(&conn).await.unwrap();

    // Build a hub: "hub" is in 10 materials with 10 distinct companions. Each
    // companion has degree 1 (just hub). If we ask for limit=3, we expect hub
    // plus two companions (tiebreak by lemma).
    for i in 0..10 {
        let partner = format!("partner{i:02}");
        materials::save_material_on_conn(
            &conn,
            &mk_input(
                &format!("doc-{i}"),
                "hub partner",
                vec![token("hub", 0, "hub partner"), token(&partner, 4, "hub partner")],
            ),
        )
        .await
        .unwrap();
    }

    let net = network::build_network_on_conn(&conn, 3).await.unwrap();
    assert_eq!(net.nodes.len(), 3);
    assert_eq!(net.nodes[0].lemma, "hub", "hub should dominate degree ordering");
    assert_eq!(net.nodes[0].degree, 10);

    // Companion nodes each have degree 1; exactly two survive the cap.
    for n in &net.nodes[1..] {
        assert_eq!(n.degree, 1);
    }
    // Every edge touches hub and nothing else.
    let hub_id = net.nodes[0].id;
    for e in &net.edges {
        assert!(
            e.source == hub_id || e.target == hub_id,
            "stray edge not touching hub: {e:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// AC3: cluster_for_word returns 1-hop + 2-hop neighbours and shared materials.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cluster_for_word_returns_hops_and_shared_materials() {
    let dir = TempDir::new().unwrap();
    let conn = open(&dir.path().join("wb.db")).await;
    schema::apply(&conn).await.unwrap();

    // Graph: anchor–alpha (doc-a), alpha–beta (doc-b), beta–gamma (doc-c).
    // From anchor's POV: 1-hop={alpha}, 2-hop={beta} (but NOT gamma, which is 3
    // hops away).
    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-a",
            "anchor alpha",
            vec![
                token("anchor", 0, "anchor alpha together."),
                token("alpha", 7, "anchor alpha together."),
            ],
        ),
    )
    .await
    .unwrap();
    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-b",
            "alpha beta",
            vec![
                token("alpha", 0, "alpha beta together."),
                token("beta", 6, "alpha beta together."),
            ],
        ),
    )
    .await
    .unwrap();
    materials::save_material_on_conn(
        &conn,
        &mk_input(
            "doc-c",
            "beta gamma",
            vec![
                token("beta", 0, "beta gamma together."),
                token("gamma", 5, "beta gamma together."),
            ],
        ),
    )
    .await
    .unwrap();

    let cluster = network::cluster_for_word_on_conn(&conn, "anchor", 10)
        .await
        .unwrap()
        .expect("cluster for anchor");

    assert_eq!(cluster.anchor, "anchor");
    let hops: Vec<(String, i64)> = cluster
        .neighbours
        .iter()
        .map(|n| (n.lemma.clone(), n.hop))
        .collect();
    assert!(hops.contains(&("alpha".to_string(), 1)), "{hops:?}");
    assert!(hops.contains(&("beta".to_string(), 2)), "{hops:?}");
    assert!(!hops.iter().any(|(l, _)| l == "gamma"), "gamma leaked: {hops:?}");

    // The 1-hop neighbour carries shared-material previews.
    let alpha = cluster.neighbours.iter().find(|n| n.lemma == "alpha").unwrap();
    assert_eq!(alpha.shared_materials.len(), 1);
    assert_eq!(alpha.shared_materials[0].title, "doc-a");
    assert_eq!(
        alpha.shared_materials[0].sentence_preview.as_deref(),
        Some("anchor alpha together.")
    );

    // 2-hop neighbours leave shared_materials empty to keep the payload bounded.
    let beta = cluster.neighbours.iter().find(|n| n.lemma == "beta").unwrap();
    assert!(beta.shared_materials.is_empty());
}

#[tokio::test]
async fn cluster_for_word_returns_none_for_missing_lemma() {
    let dir = TempDir::new().unwrap();
    let conn = open(&dir.path().join("wb.db")).await;
    schema::apply(&conn).await.unwrap();

    let got = network::cluster_for_word_on_conn(&conn, "nonesuch", 5)
        .await
        .unwrap();
    assert!(got.is_none());
}
