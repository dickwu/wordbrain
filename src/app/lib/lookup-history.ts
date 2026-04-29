import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/app/lib/ipc';

const WORD_RE = /^[A-Za-z][A-Za-z'’-]*$/;
const LOOKUP_HISTORY_STORAGE_KEY = 'wordbrain.dictionary.lookupHistory.v1';
const LOOKUP_HISTORY_LIMIT = 20;
const LOOKUP_HISTORY_EVENT = 'wordbrain:lookup-history-changed';

export interface LookupHistoryEntry {
  lemma: string;
  lookupCount: number;
  firstLookedUpAt: number;
  lastLookedUpAt: number;
}

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

export async function loadLookupHistoryPersisted(): Promise<string[]> {
  if (!isTauri()) return loadLookupHistory();
  try {
    const rows = await invoke<LookupHistoryEntry[]>('list_lookup_history', {
      limit: LOOKUP_HISTORY_LIMIT,
    });
    if (rows.length > 0) {
      const history = rows.map((row) => row.lemma);
      saveLookupHistory(history, { notify: false });
      return history;
    }
  } catch (err) {
    console.warn('[wordbrain] list_lookup_history failed', err);
  }
  return loadLookupHistory();
}

export function recordLookupHistory(rawQuery: string): string[] {
  const next = mergeLookupHistory(loadLookupHistory(), rawQuery);
  saveLookupHistory(next);
  return next;
}

export async function recordLookupHistoryPersisted(rawQuery: string): Promise<string[]> {
  const next = recordLookupHistory(rawQuery);
  const query = normalizeLookupQuery(rawQuery);
  if (!query || !isTauri()) return next;
  try {
    await invoke<void>('record_lookup_history', { lemma: query });
    dispatchLookupHistoryChanged();
  } catch (err) {
    console.warn('[wordbrain] record_lookup_history failed', err);
  }
  return next;
}

export function removeLookupHistoryWord(word: string): string[] {
  const normalized = normalizeLookupQuery(word);
  const next = loadLookupHistory().filter((item) => item !== normalized);
  saveLookupHistory(next);
  return next;
}

export async function removeLookupHistoryWordPersisted(word: string): Promise<string[]> {
  const next = removeLookupHistoryWord(word);
  const normalized = normalizeLookupQuery(word);
  if (!normalized || !isTauri()) return next;
  try {
    await invoke<void>('remove_lookup_history_word', { lemma: normalized });
    dispatchLookupHistoryChanged();
  } catch (err) {
    console.warn('[wordbrain] remove_lookup_history_word failed', err);
  }
  return next;
}

export function clearLookupHistory(): void {
  saveLookupHistory([]);
}

export async function clearLookupHistoryPersisted(): Promise<void> {
  clearLookupHistory();
  if (!isTauri()) return;
  try {
    await invoke<void>('clear_lookup_history');
    dispatchLookupHistoryChanged();
  } catch (err) {
    console.warn('[wordbrain] clear_lookup_history failed', err);
  }
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

function saveLookupHistory(history: string[], opts: { notify?: boolean } = {}) {
  const storage = getLookupHistoryStorage();
  if (!storage) return;
  try {
    storage.setItem(
      LOOKUP_HISTORY_STORAGE_KEY,
      JSON.stringify(sanitizeLookupHistory(history).slice(0, LOOKUP_HISTORY_LIMIT))
    );
    if (opts.notify !== false) {
      dispatchLookupHistoryChanged();
    }
  } catch {
    // Storage can be disabled in hardened webviews; lookup itself should still work.
  }
}

function dispatchLookupHistoryChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(LOOKUP_HISTORY_EVENT));
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
