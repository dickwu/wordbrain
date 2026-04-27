//! Minimal, dependency-light EPUB reader.
//!
//! An EPUB is a ZIP archive with:
//!   * `META-INF/container.xml` pointing at the OPF package document
//!   * an `*.opf` spine+manifest describing every (X)HTML chapter file
//!   * one or more `*.xhtml` / `*.html` files — the actual chapter bodies
//!
//! We extract the spine order, read each referenced HTML file, strip tags,
//! and return a `Vec<Chapter>` in reading order. Chapters below a minimum
//! length (covers, nav, copyright pages) are skipped so the caller ends up
//! with the "real" content chapters only — Alice in Wonderland (12 chapters)
//! round-trips exactly as 12 non-trivial chapters.
//!
//! Intentionally avoids the `epub` crate: that crate's lifetime model
//! (archive held behind a `&mut`) collides with the rest of our async call
//! graph. A ~150 LOC zip+quick-xml walker is easier to reason about and
//! strictly sufficient for Project-Gutenberg-style EPUB 2/3 files.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;

/// One chapter ready to be persisted as a child `materials` row.
#[derive(Debug, Clone, Serialize)]
pub struct Chapter {
    /// 0-based index in the EPUB spine (after filtering empty/front-matter).
    pub index: i64,
    pub title: String,
    /// Plain-text content (tags stripped, entities decoded, paragraphs joined
    /// by `\n\n`). Feeds the frontend tokenizer directly.
    pub raw_text: String,
    /// Tiptap-compatible JSON (`doc → paragraph[]`). Serialised as a string so
    /// the IPC surface matches the existing `save_material` shape.
    pub tiptap_json: String,
    /// Best-effort word count — drives the chapter-picker unknown% badge and
    /// the existing `total_tokens` budget.
    pub word_count: i64,
}

/// Minimum `raw_text.len()` required to keep a chapter. Filters covers, nav
/// documents, and copyright pages that the OPF spine happily includes.
const MIN_CHAPTER_CHARS: usize = 200;

pub fn parse_epub(path: &Path) -> Result<Vec<Chapter>, String> {
    let file =
        std::fs::File::open(path).map_err(|e| format!("open epub {}: {e}", path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("read zip {}: {e}", path.display()))?;

    let opf_path = find_opf_path(&mut archive)?;
    let opf_xml = read_archive_string(&mut archive, &opf_path)?;
    let package = parse_package(&opf_xml)?;

    let base_dir = Path::new(&opf_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut chapters: Vec<Chapter> = Vec::with_capacity(package.spine.len());
    for idref in &package.spine {
        let Some(href) = package.manifest.get(idref) else {
            continue;
        };
        let full = if base_dir.is_empty() {
            href.clone()
        } else {
            format!("{base_dir}/{href}")
        };
        // Normalise `..` segments that Gutenberg sometimes slips into hrefs.
        let normalised = normalise_archive_path(&full);
        let html = match read_archive_string(&mut archive, &normalised) {
            Ok(s) => s,
            Err(_) => continue, // tolerate missing nav/cover references
        };
        let (title, paragraphs) = extract_chapter(&html);
        let raw_text = paragraphs.join("\n\n");
        if raw_text.len() < MIN_CHAPTER_CHARS {
            continue;
        }
        let word_count = count_words(&raw_text);
        let tiptap_json = build_tiptap_json(&paragraphs);
        let chapter_title = if title.trim().is_empty() {
            derive_title_from_text(&raw_text, chapters.len() + 1)
        } else {
            title
        };
        chapters.push(Chapter {
            index: chapters.len() as i64,
            title: chapter_title,
            raw_text,
            tiptap_json,
            word_count,
        });
    }

    Ok(chapters)
}

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------

fn read_archive_string(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<String, String> {
    let mut f = archive
        .by_name(name)
        .map_err(|e| format!("archive entry {name}: {e}"))?;
    let mut s = String::new();
    f.read_to_string(&mut s)
        .map_err(|e| format!("read entry {name}: {e}"))?;
    Ok(s)
}

fn find_opf_path(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<String, String> {
    let container = read_archive_string(archive, "META-INF/container.xml")?;
    let mut reader = Reader::from_str(&container);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("container.xml: {e}"))?
        {
            Event::Empty(e) | Event::Start(e) => {
                if e.local_name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"full-path" {
                            let v = attr
                                .unescape_value()
                                .map_err(|e| format!("full-path: {e}"))?;
                            return Ok(v.into_owned());
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    Err("container.xml has no rootfile/@full-path".into())
}

struct Package {
    /// manifest id → href (relative to the OPF file's directory).
    manifest: HashMap<String, String>,
    /// ordered list of manifest ids to read.
    spine: Vec<String>,
}

fn parse_package(opf: &str) -> Result<Package, String> {
    let mut manifest = HashMap::new();
    let mut spine = Vec::new();
    let mut reader = Reader::from_str(opf);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut in_spine = false;

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("package opf: {e}"))?
        {
            Event::Start(e) if e.local_name().as_ref() == b"spine" => {
                in_spine = true;
            }
            Event::End(e) if e.local_name().as_ref() == b"spine" => {
                in_spine = false;
            }
            Event::Empty(e) | Event::Start(e) => match e.local_name().as_ref() {
                b"item" => {
                    let mut id = None;
                    let mut href = None;
                    let mut media_type = String::new();
                    for attr in e.attributes().flatten() {
                        let val = attr
                            .unescape_value()
                            .map_err(|e| format!("attr: {e}"))?
                            .into_owned();
                        match attr.key.local_name().as_ref() {
                            b"id" => id = Some(val),
                            b"href" => href = Some(val),
                            b"media-type" => media_type = val,
                            _ => {}
                        }
                    }
                    if let (Some(id), Some(href)) = (id, href) {
                        // Only keep (x)html chapter entries.
                        if media_type.contains("xhtml") || media_type.contains("html") {
                            manifest.insert(id, href);
                        }
                    }
                }
                b"itemref" if in_spine => {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"idref" {
                            let v = attr.unescape_value().map_err(|e| format!("attr: {e}"))?;
                            spine.push(v.into_owned());
                        }
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if spine.is_empty() {
        return Err("package opf: empty spine".into());
    }
    Ok(Package { manifest, spine })
}

// ---------------------------------------------------------------------------
// HTML → paragraphs
// ---------------------------------------------------------------------------

/// Strip (X)HTML tags, decode common entities, return (title, paragraphs).
/// Paragraphs are whatever sits between `<p>`, `<h1..6>`, `<div>`, `<br>`
/// boundaries — good enough for linear prose (novels, articles).
fn extract_chapter(html: &str) -> (String, Vec<String>) {
    let mut reader = Reader::from_str(html);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = false;

    let mut title = String::new();
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_title_tag = false;
    let mut in_h1_or_header = false;
    let mut first_heading: Option<String> = None;
    let mut heading_buf = String::new();
    let mut skip_depth: u32 = 0; // script/style nesting

    fn flush(current: &mut String, paragraphs: &mut Vec<String>) {
        let s = collapse_ws(current);
        if !s.is_empty() {
            paragraphs.push(s);
        }
        current.clear();
    }

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"script" | b"style" => skip_depth += 1,
                    b"title" => in_title_tag = true,
                    b"h1" | b"h2" | b"h3" => {
                        in_h1_or_header = true;
                        heading_buf.clear();
                        flush(&mut current, &mut paragraphs);
                    }
                    b"p" | b"div" | b"section" | b"blockquote" | b"li" => {
                        flush(&mut current, &mut paragraphs);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                let n = name.as_ref();
                match n {
                    b"script" | b"style" => {
                        if skip_depth > 0 {
                            skip_depth -= 1;
                        }
                    }
                    b"title" => in_title_tag = false,
                    b"h1" | b"h2" | b"h3" => {
                        in_h1_or_header = false;
                        let heading = collapse_ws(&heading_buf);
                        if !heading.is_empty() {
                            if first_heading.is_none() {
                                first_heading = Some(heading.clone());
                            }
                            paragraphs.push(heading);
                        }
                        heading_buf.clear();
                    }
                    b"p" | b"div" | b"section" | b"blockquote" | b"li" => {
                        flush(&mut current, &mut paragraphs);
                    }
                    b"br" => current.push('\n'),
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == b"br" {
                    current.push('\n');
                }
            }
            Ok(Event::Text(e)) => {
                if skip_depth > 0 {
                    continue;
                }
                let decoded = e.unescape().map(|c| c.into_owned()).unwrap_or_default();
                if in_title_tag {
                    title.push_str(&decoded);
                } else if in_h1_or_header {
                    heading_buf.push_str(&decoded);
                } else {
                    current.push_str(&decoded);
                }
            }
            Ok(Event::CData(e)) => {
                if skip_depth == 0 {
                    if let Ok(s) = std::str::from_utf8(&e) {
                        current.push_str(s);
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break, // tolerate HTML quirks
            _ => {}
        }
        buf.clear();
    }
    flush(&mut current, &mut paragraphs);

    let final_title = if !title.trim().is_empty() {
        collapse_ws(&title)
    } else if let Some(h) = first_heading {
        h
    } else {
        String::new()
    };

    (final_title, paragraphs)
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = true; // trims leading whitespace
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out
}

fn count_words(s: &str) -> i64 {
    s.split_whitespace()
        .filter(|t| t.chars().any(|c| c.is_alphabetic()))
        .count() as i64
}

fn derive_title_from_text(raw: &str, fallback_index: usize) -> String {
    let first = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let trimmed = first.trim();
    if trimmed.is_empty() {
        return format!("Chapter {fallback_index}");
    }
    let clipped: String = trimmed.chars().take(80).collect();
    clipped
}

fn build_tiptap_json(paragraphs: &[String]) -> String {
    use serde_json::json;
    let content: Vec<_> = paragraphs
        .iter()
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            json!({
                "type": "paragraph",
                "content": [{ "type": "text", "text": p }],
            })
        })
        .collect();
    json!({ "type": "doc", "content": content }).to_string()
}

fn normalise_archive_path(p: &str) -> String {
    // Remove URL fragment (`chap1.xhtml#section`).
    let cleaned: String = match p.find('#') {
        Some(i) => p[..i].to_string(),
        None => p.to_string(),
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in cleaned.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

// ---------------------------------------------------------------------------
// Tests — synthetic EPUB in-memory, no external fixtures required.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn write_synthetic_epub(path: &Path, chapter_count: usize) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let store = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let deflate =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // mimetype must be the first, uncompressed entry per EPUB spec.
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

        // Build the OPF spine/manifest.
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
  <dc:title>Test Book</dc:title>
  <dc:identifier id="pub-id">urn:test:1</dc:identifier>
 </metadata>
 <manifest>{manifest}</manifest>
 <spine>{spine}</spine>
</package>"#
        );
        zip.start_file("OEBPS/content.opf", deflate).unwrap();
        zip.write_all(opf.as_bytes()).unwrap();

        // Each chapter: enough text to clear MIN_CHAPTER_CHARS + a heading.
        for i in 1..=chapter_count {
            let body = format!(
                r#"<?xml version="1.0"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter {i} Title</title></head>
<body>
 <h1>Chapter {i}</h1>
 <p>This is the body of chapter {i}. It contains several English sentences so that the tokenizer has something meaningful to chew on. Alice thought to herself, &ldquo;curiouser and curiouser&rdquo;.</p>
 <p>The {i}th chapter continues here with more substantive prose, padded so the minimum-length filter (200 chars) never drops a real chapter. Rabbits, teacups, and playing-card soldiers populate the scene.</p>
</body>
</html>"#
            );
            zip.start_file(format!("OEBPS/chap{i}.xhtml"), deflate)
                .unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn parses_twelve_chapter_synthetic_epub_within_budget() {
        let dir = tempfile::tempdir().unwrap();
        let epub_path = dir.path().join("alice.epub");
        write_synthetic_epub(&epub_path, 12);

        let start = std::time::Instant::now();
        let chapters = parse_epub(&epub_path).expect("parse_epub ok");
        let elapsed_ms = start.elapsed().as_millis();

        assert!(
            elapsed_ms < 3000,
            "parse_epub took {elapsed_ms} ms (budget 3000)"
        );
        assert_eq!(
            chapters.len(),
            12,
            "expected 12 chapters, got {}",
            chapters.len()
        );
        for (i, ch) in chapters.iter().enumerate() {
            assert_eq!(ch.index, i as i64);
            assert!(
                ch.raw_text.contains(&format!("chapter {}", i + 1))
                    || ch.raw_text.contains(&format!("Chapter {}", i + 1)),
                "chapter {} missing body text: {:?}",
                i + 1,
                ch.raw_text
            );
            assert!(ch.word_count > 10, "chapter {} word count too small", i + 1);
            // tiptap_json is a JSON doc with at least one paragraph.
            let v: serde_json::Value = serde_json::from_str(&ch.tiptap_json).unwrap();
            assert_eq!(v["type"], "doc");
        }
    }

    #[test]
    fn skips_front_matter_under_minimum() {
        let dir = tempfile::tempdir().unwrap();
        let epub_path = dir.path().join("mixed.epub");
        // 10 real chapters + 1 tiny cover-style spine item.
        {
            let file = std::fs::File::create(&epub_path).unwrap();
            let mut zip = ZipWriter::new(file);
            let store =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            let deflate =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

            zip.start_file("mimetype", store).unwrap();
            zip.write_all(b"application/epub+zip").unwrap();
            zip.start_file("META-INF/container.xml", deflate).unwrap();
            zip.write_all(
                br#"<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
 <rootfiles>
  <rootfile full-path="content.opf" media-type="application/oebps-package+xml"/>
 </rootfiles>
</container>"#,
            )
            .unwrap();
            let mut manifest = String::from(
                r#"<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>"#,
            );
            let mut spine = String::from(r#"<itemref idref="cover"/>"#);
            for i in 1..=10 {
                manifest.push_str(&format!(
                    r#"<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>"#
                ));
                spine.push_str(&format!(r#"<itemref idref="c{i}"/>"#));
            }
            let opf = format!(
                r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="x">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:identifier id="x">x</dc:identifier></metadata>
 <manifest>{manifest}</manifest>
 <spine>{spine}</spine>
</package>"#
            );
            zip.start_file("content.opf", deflate).unwrap();
            zip.write_all(opf.as_bytes()).unwrap();

            zip.start_file("cover.xhtml", deflate).unwrap();
            zip.write_all(b"<html><body><p>Cover.</p></body></html>")
                .unwrap();
            for i in 1..=10 {
                let body = format!(
                    r#"<html><body><h2>Real Chapter {i}</h2><p>The quick brown fox jumps over the lazy dog. This is a real chapter body with enough alphabetic characters to satisfy the minimum length filter baked into the parser.</p><p>Another paragraph extending the chapter so the tokenizer sees natural prose.</p></body></html>"#
                );
                zip.start_file(format!("c{i}.xhtml"), deflate).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }

        let chapters = parse_epub(&epub_path).unwrap();
        assert_eq!(
            chapters.len(),
            10,
            "front-matter cover under {MIN_CHAPTER_CHARS} chars must be filtered"
        );
    }

    #[test]
    fn strip_srt_style_markup_independent_of_epub() {
        // Sanity on collapse_ws / normalise_archive_path so regressions show up.
        assert_eq!(collapse_ws("  a   b\n\tc  "), "a b c");
        assert_eq!(
            normalise_archive_path("OEBPS/../chap1.xhtml#s"),
            "chap1.xhtml"
        );
        assert_eq!(normalise_archive_path("./a/b"), "a/b");
    }
}
