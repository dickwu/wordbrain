export interface RawToken {
  /** Exact text as it appeared in input (preserving case, curly apostrophes, etc.) */
  surface: string;
  /** Lowercased copy used as dictionary-lookup key. */
  lowered: string;
  /** Inclusive character offset into the raw input. */
  start: number;
  /** Exclusive character offset into the raw input. */
  end: number;
}

// Match a contiguous sequence of Unicode letters, allowing straight ' and
// curly ' inside the run (so "don't" and "they're" stay as single tokens).
// Hyphens are NOT included on purpose — "co-operate" should tokenise into
// two lookup units so dictionaries that only have "cooperate" or "operate"
// still resolve the learner's unknown-word question.
const WORD_RE = /\p{L}(?:['’]?\p{L})*/gu;

export function splitWords(raw: string): RawToken[] {
  if (!raw) return [];
  const out: RawToken[] = [];
  for (const match of raw.matchAll(WORD_RE)) {
    const surface = match[0];
    const start = match.index ?? 0;
    out.push({
      surface,
      lowered: surface.toLowerCase(),
      start,
      end: start + surface.length,
    });
  }
  return out;
}
