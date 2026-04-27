const WORD_RE = /^[A-Za-z][A-Za-z'’-]*$/;
const LOOKUP_HISTORY_STORAGE_KEY = 'wordbrain.dictionary.lookupHistory.v1';
const LOOKUP_HISTORY_LIMIT = 20;
const LOOKUP_HISTORY_EVENT = 'wordbrain:lookup-history-changed';

/** True when `value` is a single English word we should hand to the dictionary. */
export function isLookupCandidate(value: string | null | undefined): boolean {
  if (!value) return false;
  return WORD_RE.test(value.trim());
}

/** Normalize raw selection / clipboard text to a canonical lemma surface. Returns
 * an empty string when the input isn't a lookup-able single word. */
export function normalizeLookupQuery(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!WORD_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

export function mergeLookupHistory(
  history: string[],
  rawQuery: string,
  limit = LOOKUP_HISTORY_LIMIT
): string[] {
  const query = normalizeLookupQuery(rawQuery);
  if (!query) return sanitizeLookupHistory(history, limit);
  return sanitizeLookupHistory([query, ...history], limit);
}

export function loadLookupHistory(): string[] {
  const storage = getLookupHistoryStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOOKUP_HISTORY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? sanitizeLookupHistory(parsed) : [];
  } catch {
    return [];
  }
}

export function recordLookupHistory(rawQuery: string): string[] {
  const next = mergeLookupHistory(loadLookupHistory(), rawQuery);
  saveLookupHistory(next);
  return next;
}

export function removeLookupHistoryWord(word: string): string[] {
  const normalized = normalizeLookupQuery(word);
  const next = loadLookupHistory().filter((item) => item !== normalized);
  saveLookupHistory(next);
  return next;
}

export function clearLookupHistory(): void {
  saveLookupHistory([]);
}

export function subscribeLookupHistory(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(LOOKUP_HISTORY_EVENT, callback);
  return () => window.removeEventListener(LOOKUP_HISTORY_EVENT, callback);
}

function sanitizeLookupHistory(items: unknown[], limit = LOOKUP_HISTORY_LIMIT): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const normalized = normalizeLookupQuery(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

function saveLookupHistory(history: string[]) {
  const storage = getLookupHistoryStorage();
  if (!storage) return;
  try {
    storage.setItem(
      LOOKUP_HISTORY_STORAGE_KEY,
      JSON.stringify(sanitizeLookupHistory(history).slice(0, LOOKUP_HISTORY_LIMIT))
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(LOOKUP_HISTORY_EVENT));
    }
  } catch {
    // Storage can be disabled in hardened webviews; lookup itself should still work.
  }
}

function getLookupHistoryStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
