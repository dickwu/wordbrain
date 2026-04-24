export type WordState = 'known' | 'learning' | 'unknown';

export interface WordRecord {
  id: number;
  lemma: string;
  state: WordState;
  stateSource: string | null;
  freqRank: number | null;
  exposureCount: number;
  // Backend now_ms() returns ms since epoch; keep the raw number and let the UI format.
  markedKnownAt: number | null;
  userNote: string | null;
  materialCount: number;
}

export interface ListWordsFilter {
  states?: Array<'known' | 'learning'>;
  sources?: string[];
  searchPrefix?: string;
}

export type WordSortKey = 'lemma' | 'markedKnownAt' | 'exposureCount' | 'freqRank';
