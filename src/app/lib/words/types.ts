export type WordState = 'known' | 'learning' | 'unknown';

export interface WordRecord {
  id: number;
  lemma: string;
  state: WordState;
  stateSource: string | null;
  freqRank: number | null;
  exposureCount: number;
  /**
   * Learning-loop counter; mirrors `words.usage_count` on the Rust side.
   * UI-facing "level" is derived as `Math.min(10, usageCount)`.
   */
  usageCount: number;
  // Backend now_ms() returns ms since epoch; keep the raw number and let the UI format.
  markedKnownAt: number | null;
  userNote: string | null;
  materialCount: number;
}

/**
 * Helper for the Level (0–10) column on the Words view. Centralised so the
 * derivation matches the Rust-side `MIN(10, usage_count)` exactly.
 */
export function levelFromUsage(usageCount: number): number {
  if (typeof usageCount !== 'number' || !Number.isFinite(usageCount) || usageCount <= 0) {
    return 0;
  }
  return Math.min(10, Math.floor(usageCount));
}

export interface ListWordsFilter {
  states?: Array<'known' | 'learning'>;
  sources?: string[];
  searchPrefix?: string;
}

export type WordSortKey = 'lemma' | 'markedKnownAt' | 'exposureCount' | 'freqRank';
