import { splitWords, type RawToken } from './normalize';
import { lemmatize } from './lemmatizer';

export interface Token extends RawToken {
  /** Normalised base form for dictionary / known-set lookup. */
  lemma: string;
}

export function tokenize(raw: string): Token[] {
  return splitWords(raw).map((t) => ({
    ...t,
    lemma: lemmatize(t.surface),
  }));
}

export { splitWords } from './normalize';
export { lemmatize } from './lemmatizer';
export type { RawToken };
