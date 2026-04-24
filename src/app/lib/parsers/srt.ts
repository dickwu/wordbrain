/**
 * SRT subtitle parser — strips timestamps and block numbers, retains line breaks.
 *
 * SRT format (per block, blocks separated by a blank line):
 *   <block-number>
 *   HH:MM:SS,mmm --> HH:MM:SS,mmm [X1:… X2:… Y1:… Y2:…]
 *   <text line 1>
 *   <text line 2>
 *   (blank line)
 *
 * We deliberately do NOT drop every numeric-only line — SRT content can
 * legitimately read "I have 5 apples". A block number is only skipped when
 * the next non-empty line parses as a timestamp (the SRT spec's invariant).
 *
 * The parser is pure (no I/O), deterministic, and round-trips line breaks so
 * the tokenizer downstream sees natural sentence boundaries.
 */

const TIMESTAMP_LINE = /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;
const BLOCK_NUMBER = /^\d+$/;
const INLINE_TAGS = /<\/?[a-zA-Z][^>]*>/g;
const BRACE_TAGS = /\{[^}]*\}/g;

export function stripSrt(raw: string): string {
  const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Strip BOM if present.
  const text = normalised.charCodeAt(0) === 0xfeff ? normalised.slice(1) : normalised;
  const lines = text.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (TIMESTAMP_LINE.test(trimmed)) continue;

    if (BLOCK_NUMBER.test(trimmed) && isNextNonEmptyTimestamp(lines, i + 1)) {
      continue;
    }

    // Strip common subtitle cue markup (<i>, <b>, <font color=…>, {\an8}, etc.)
    const cleaned = line.replace(INLINE_TAGS, '').replace(BRACE_TAGS, '');
    out.push(cleaned);
  }

  // Collapse runs of blank lines to at most one blank, trim the tails.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function isNextNonEmptyTimestamp(lines: string[], from: number): boolean {
  for (let j = from; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t === '') continue;
    return TIMESTAMP_LINE.test(t);
  }
  return false;
}

/** Quick check used by the importer to route `.srt` files through [`stripSrt`]. */
export function looksLikeSrt(raw: string): boolean {
  return /^\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/m.test(
    raw.slice(0, 4096)
  );
}
