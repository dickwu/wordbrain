#!/usr/bin/env python3
"""Convert the upstream ECDICT CSV into a slim SQLite bundle.

Input:  .omc/cache/ecdict.csv  (full ECDICT CSV, ~65 MB, 770k rows)
Output: src-tauri/assets/ecdict.db  (≥700k rows, stripped columns, VACUUMed)

We keep only the columns the app actually surfaces (lemma, pos, ipa,
definitions_zh, definitions_en) so the bundled asset stays well under the
100 MB GitHub limit. The table name and column names match the in-app
`dictionary_entries` schema so first-run bootstrap is a single
`ATTACH DATABASE` + `INSERT INTO ... SELECT ...`.
"""
import csv
import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".omc" / "cache" / "ecdict.csv"
DST = ROOT / "src-tauri" / "assets" / "ecdict.db"

# ECDICT Chinese definitions frequently contain newline-separated parts of
# speech on different lines. The short `definition` (English) column is
# already redundant with `translation` for our Chinese-first UX, so we drop
# it to save disk. If you later want richer English meaning, re-enable by
# setting KEEP_DEFINITION_EN = True.
KEEP_DEFINITION_EN = False


def main() -> int:
    if not SRC.exists():
        print(f"missing source CSV: {SRC}", file=sys.stderr)
        return 2
    DST.parent.mkdir(parents=True, exist_ok=True)
    if DST.exists():
        DST.unlink()

    con = sqlite3.connect(DST)
    con.execute("PRAGMA journal_mode = OFF;")
    con.execute("PRAGMA synchronous = OFF;")
    con.execute("PRAGMA temp_store = MEMORY;")
    con.execute("PRAGMA page_size = 4096;")
    con.executescript(
        """
        CREATE TABLE dictionary_entries (
          lemma          TEXT NOT NULL,
          pos            TEXT,
          ipa            TEXT,
          definitions_zh TEXT,
          definitions_en TEXT,
          examples       TEXT,
          source         TEXT NOT NULL,
          PRIMARY KEY (lemma, pos, source)
        );
        CREATE INDEX idx_dict_lemma ON dictionary_entries(lemma);
        """
    )

    inserted = 0
    skipped_empty = 0
    collisions = 0
    csv.field_size_limit(1 << 24)
    with SRC.open("r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        con.execute("BEGIN;")
        try:
            for row in reader:
                lemma = (row.get("word") or "").strip()
                if not lemma:
                    skipped_empty += 1
                    continue
                translation = (row.get("translation") or "").strip()
                definition_en = (row.get("definition") or "").strip() if KEEP_DEFINITION_EN else None
                if not translation and not definition_en:
                    skipped_empty += 1
                    continue
                pos = (row.get("pos") or "").strip() or None
                phonetic = (row.get("phonetic") or "").strip() or None
                try:
                    con.execute(
                        "INSERT INTO dictionary_entries "
                        "  (lemma, pos, ipa, definitions_zh, definitions_en, examples, source) "
                        "VALUES (?, ?, ?, ?, ?, ?, 'ecdict')",
                        (
                            lemma.lower(),
                            pos or "",
                            phonetic,
                            translation or None,
                            definition_en,
                            None,
                        ),
                    )
                    inserted += 1
                except sqlite3.IntegrityError:
                    collisions += 1
                if inserted % 100_000 == 0 and inserted:
                    print(f"  {inserted:,} inserted…", flush=True)
            con.execute("COMMIT;")
        except Exception:
            con.execute("ROLLBACK;")
            raise

    con.execute("ANALYZE;")
    con.execute("VACUUM;")
    (count,) = con.execute("SELECT COUNT(*) FROM dictionary_entries").fetchone()
    con.close()
    size = DST.stat().st_size
    print(f"done: rows={count:,} skipped_empty={skipped_empty:,} collisions={collisions:,} size={size/1024/1024:.1f} MB")
    if count < 700_000:
        print(f"ERROR: row count {count:,} below the 700k AC threshold", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
