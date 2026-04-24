//! Phase-5 integration test — builds a Gutenberg-shaped 12-chapter EPUB on
//! disk, runs it through `parse_epub`, saves each chapter as a child of a
//! book-level material, and verifies the resulting `materials` rows.
//!
//! This is the AC2 proxy — Project Gutenberg's real Alice-in-Wonderland
//! fixture is ~180 KB; our synthetic one is the same shape (12 `<h1>` +
//! prose chapters) and verifies every DB-touching code path introduced in
//! this phase (`parent_material_id`, `chapter_index`, `list_child_materials`).
//!
//! Parsing time is asserted against the 3 s budget from the plan.

use std::io::Write;
use std::time::Instant;

use tempfile::TempDir;
use turso::Builder;
use wordbrain_lib::db::{materials, schema};
use wordbrain_lib::parsers::epub;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

async fn open_db(dir: &TempDir) -> turso::Connection {
    let db_path = dir.path().join("wordbrain.db");
    let db = Builder::new_local(db_path.to_str().unwrap())
        .build()
        .await
        .unwrap();
    let conn = db.connect().unwrap();
    schema::apply(&conn).await.unwrap();
    conn
}

fn write_alice_shaped_epub(path: &std::path::Path, chapter_count: usize) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = ZipWriter::new(file);
    let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflate = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("mimetype", store).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();

    zip.start_file("META-INF/container.xml", deflate).unwrap();
    zip.write_all(
        br#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
 <rootfiles>
  <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
 </rootfiles>
</container>"#,
    )
    .unwrap();

    let mut manifest = String::new();
    let mut spine = String::new();
    for i in 1..=chapter_count {
        manifest.push_str(&format!(
            r#"<item id="ch{i}" href="chap{i}.xhtml" media-type="application/xhtml+xml"/>"#
        ));
        spine.push_str(&format!(r#"<itemref idref="ch{i}"/>"#));
    }
    let opf = format!(
        r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Alice's Adventures in Wonderland</dc:title>
  <dc:creator>Lewis Carroll</dc:creator>
  <dc:identifier id="pub-id">urn:gutenberg:11</dc:identifier>
 </metadata>
 <manifest>{manifest}</manifest>
 <spine>{spine}</spine>
</package>"#
    );
    zip.start_file("OEBPS/content.opf", deflate).unwrap();
    zip.write_all(opf.as_bytes()).unwrap();

    let titles = [
        "Down the Rabbit-Hole",
        "The Pool of Tears",
        "A Caucus-Race and a Long Tale",
        "The Rabbit Sends in a Little Bill",
        "Advice from a Caterpillar",
        "Pig and Pepper",
        "A Mad Tea-Party",
        "The Queen's Croquet-Ground",
        "The Mock Turtle's Story",
        "The Lobster Quadrille",
        "Who Stole the Tarts?",
        "Alice's Evidence",
    ];

    for i in 1..=chapter_count {
        let title = titles.get(i - 1).copied().unwrap_or("Chapter");
        let body = format!(
            r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title}</title></head>
<body>
 <h1>CHAPTER {i}. {title}</h1>
 <p>Alice was beginning to get very tired of sitting by her sister on the bank. Chapter {i} continues the story with substantive English prose suitable for tokenisation.</p>
 <p>&ldquo;Curiouser and curiouser!&rdquo; cried Alice. The {i}th chapter unfolds with rabbits, teacups, and playing-card soldiers dancing through the scene.</p>
 <p>Additional text ensures this chapter clears the 200-character minimum filter imposed by the parser, keeping every spine item as a real chapter entry.</p>
</body>
</html>"#
        );
        zip.start_file(format!("OEBPS/chap{i}.xhtml"), deflate)
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

#[tokio::test]
async fn alice_shaped_epub_imports_as_twelve_linked_chapters_within_budget() {
    let tmp = TempDir::new().unwrap();
    let epub_path = tmp.path().join("alice.epub");
    write_alice_shaped_epub(&epub_path, 12);

    // AC2: parse_epub must return the chapters within 3 s.
    let start = Instant::now();
    let chapters = epub::parse_epub(&epub_path).expect("parse_epub ok");
    let elapsed_ms = start.elapsed().as_millis();
    assert!(
        elapsed_ms < 3000,
        "parse_epub took {elapsed_ms} ms, exceeds 3000 ms budget"
    );
    assert!(
        chapters.len() >= 12,
        "expected >= 12 chapters, got {}",
        chapters.len()
    );

    // Save the book-level parent, then each chapter linked via
    // parent_material_id. Mirrors the frontend save order.
    let conn = open_db(&tmp).await;

    let aggregate = chapters
        .iter()
        .map(|c| c.raw_text.clone())
        .collect::<Vec<_>>()
        .join("\n\n");
    let tokens = chapters
        .iter()
        .enumerate()
        .map(|(i, c)| materials::TokenEdge {
            lemma: format!("bookword{i}"),
            occurrence_count: 1,
            first_position: i as i64,
            sentence_preview: Some(c.title.clone()),
        })
        .collect::<Vec<_>>();
    let book_input = materials::SaveMaterialInput {
        title: "Alice's Adventures in Wonderland".to_string(),
        source_kind: "epub".to_string(),
        origin_path: Some(epub_path.to_string_lossy().to_string()),
        tiptap_json: "{\"type\":\"doc\",\"content\":[]}".to_string(),
        raw_text: aggregate,
        total_tokens: tokens.len() as i64,
        unique_tokens: tokens.len() as i64,
        tokens,
        parent_material_id: None,
        chapter_index: None,
    };
    let book_out = materials::save_material_on_conn(&conn, &book_input)
        .await
        .unwrap();

    for chapter in &chapters {
        let tokens = chapter
            .raw_text
            .split_whitespace()
            .enumerate()
            .map(|(i, w)| materials::TokenEdge {
                lemma: w.trim_matches(|c: char| !c.is_alphabetic()).to_lowercase(),
                occurrence_count: 1,
                first_position: i as i64,
                sentence_preview: Some(chapter.title.clone()),
            })
            .filter(|t| !t.lemma.is_empty())
            .collect::<Vec<_>>();
        let ch_input = materials::SaveMaterialInput {
            title: chapter.title.clone(),
            source_kind: "epub_chapter".to_string(),
            origin_path: Some(epub_path.to_string_lossy().to_string()),
            tiptap_json: chapter.tiptap_json.clone(),
            raw_text: chapter.raw_text.clone(),
            total_tokens: tokens.len() as i64,
            unique_tokens: tokens.len() as i64,
            tokens,
            parent_material_id: Some(book_out.material_id),
            chapter_index: Some(chapter.index),
        };
        materials::save_material_on_conn(&conn, &ch_input)
            .await
            .unwrap();
    }

    // list_materials returns only the parent (library view hides chapters).
    let roots = materials::list_materials_on_conn(&conn).await.unwrap();
    assert_eq!(roots.len(), 1, "library view must hide chapter rows");
    assert_eq!(roots[0].source_kind, "epub");
    assert_eq!(roots[0].id, book_out.material_id);

    // list_child_materials returns ≥ 12 chapters in `chapter_index` order.
    let children = materials::list_child_materials_on_conn(&conn, book_out.material_id)
        .await
        .unwrap();
    assert!(
        children.len() >= 12,
        "expected >= 12 chapter rows, got {}",
        children.len()
    );
    for (i, row) in children.iter().enumerate() {
        assert_eq!(row.parent_material_id, Some(book_out.material_id));
        assert_eq!(row.chapter_index, Some(i as i64));
    }

    // load_material round-trips the full body + tiptap JSON.
    let full = materials::load_material_on_conn(&conn, children[0].id)
        .await
        .unwrap()
        .expect("child row must load");
    assert_eq!(full.parent_material_id, Some(book_out.material_id));
    assert!(full.raw_text.contains("Alice"));
}
