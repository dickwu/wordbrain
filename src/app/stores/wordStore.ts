import { create } from 'zustand';
import { PHASE1_SEED } from '@/app/lib/seed/phase1-seed';
import {
  isTauri,
  markKnownIpc,
  markKnownNameIpc,
  unmarkKnownIpc,
  getAllKnownLemmas,
  getAllKnownNames,
} from '@/app/lib/ipc';
import { BUILTIN_KNOWN_NAMES, looksLikeNameToken, normalizeNameKey } from '@/app/lib/names';

interface WordState {
  known: Set<string>;
  knownNames: Set<string>;
  /** True once the DB-backed set has replaced the Phase-1 fallback seed. */
  hydrated: boolean;
  markKnown: (lemma: string) => void;
  markKnownName: (name: string) => void;
  unmark: (lemma: string) => void;
  bulkUnmark: (lemmas: string[]) => void;
  setState: (lemma: string, state: 'known' | 'learning' | 'unknown') => void;
  isKnown: (lemma: string) => boolean;
  isKnownName: (lemma: string, surface?: string) => boolean;
  hydrateFrom: (lemmas: Iterable<string>, names?: Iterable<string>) => void;
  /** Monotonic counter; bump on every mutation so Tiptap can rebuild decorations. */
  version: number;
}

// Fallback seed used only in the browser dev environment (no Tauri host).
// Once `hydrateFromDb()` runs in Tauri, this set is replaced wholesale.
const initialSeed = new Set<string>();
for (const w of PHASE1_SEED) initialSeed.add(w.toLowerCase());

const initialNameSeed = new Set<string>();
for (const n of BUILTIN_KNOWN_NAMES) initialNameSeed.add(n);

export const useWordStore = create<WordState>((set, get) => ({
  known: initialSeed,
  knownNames: initialNameSeed,
  hydrated: false,
  version: 0,
  markKnown: (lemma) => {
    const key = lemma.toLowerCase();
    // Optimistic update; fire-and-forget the IPC so the UI never blocks on it.
    set((s) => {
      if (s.known.has(key)) return s;
      const next = new Set(s.known);
      next.add(key);
      return { known: next, version: s.version + 1 };
    });
    if (isTauri()) {
      void markKnownIpc(key).catch((err) => {
        console.error('[wordbrain] mark_known IPC failed', err);
      });
    }
  },
  markKnownName: (name) => {
    const key = normalizeNameKey(name);
    if (!key) return;
    set((s) => {
      if (s.knownNames.has(key)) return s;
      const next = new Set(s.knownNames);
      next.add(key);
      return { knownNames: next, version: s.version + 1 };
    });
    if (isTauri()) {
      void markKnownNameIpc(key).catch((err) => {
        console.error('[wordbrain] mark_known_name IPC failed', err);
      });
    }
  },
  unmark: (lemma) => {
    const key = lemma.toLowerCase();
    set((s) => {
      if (!s.known.has(key)) return s;
      const next = new Set(s.known);
      next.delete(key);
      return { known: next, version: s.version + 1 };
    });
    if (isTauri()) {
      void unmarkKnownIpc(key).catch((err) => {
        console.error('[wordbrain] unmark_known IPC failed', err);
      });
    }
  },
  // Pure in-memory bulk removal. IPC is handled by the caller (mutation hook).
  bulkUnmark: (lemmas) => {
    const keys = lemmas.map((l) => l.toLowerCase());
    set((s) => {
      let changed = false;
      const next = new Set(s.known);
      for (const k of keys) {
        if (next.delete(k)) changed = true;
      }
      if (!changed) return s;
      return { known: next, version: s.version + 1 };
    });
  },
  // Pure in-memory state transition. IPC is handled by the caller (mutation hook).
  setState: (lemma, state) => {
    const key = lemma.toLowerCase();
    set((s) => {
      const has = s.known.has(key);
      if (state === 'known') {
        if (has) return s;
        const next = new Set(s.known);
        next.add(key);
        return { known: next, version: s.version + 1 };
      }
      // learning | unknown — remove from known set so the reader stops highlighting.
      if (!has) return s;
      const next = new Set(s.known);
      next.delete(key);
      return { known: next, version: s.version + 1 };
    });
  },
  isKnown: (lemma) => get().known.has(lemma.toLowerCase()),
  isKnownName: (lemma, surface) => {
    if (surface && !looksLikeNameToken(surface)) return false;
    return get().knownNames.has(normalizeNameKey(lemma));
  },
  hydrateFrom: (lemmas, names = BUILTIN_KNOWN_NAMES) => {
    const next = new Set<string>();
    for (const l of lemmas) next.add(l.toLowerCase());
    const nextNames = new Set<string>();
    for (const n of names) {
      const key = normalizeNameKey(n);
      if (key) nextNames.add(key);
    }
    set((s) => ({ known: next, knownNames: nextNames, hydrated: true, version: s.version + 1 }));
  },
}));

export function isLemmaKnown(lemma: string): boolean {
  return useWordStore.getState().known.has(lemma.toLowerCase());
}

export function isKnownNameToken(lemma: string, surface: string): boolean {
  return looksLikeNameToken(surface) && useWordStore.getState().isKnownName(lemma);
}

export function isReaderTokenKnown(lemma: string, surface: string): boolean {
  return isLemmaKnown(lemma) || isKnownNameToken(lemma, surface);
}

/**
 * Replace the in-memory known-set with whatever the DB currently holds.
 * Safe to call multiple times; each call is a full refresh.
 */
export async function hydrateFromDb(): Promise<number> {
  if (!isTauri()) {
    // Browser/dev — mark hydrated so consumers don't block.
    useWordStore.setState((s) => ({ hydrated: true, version: s.version + 1 }));
    return useWordStore.getState().known.size;
  }
  const [lemmas, names] = await Promise.all([getAllKnownLemmas(), getAllKnownNames()]);
  useWordStore.getState().hydrateFrom(lemmas, names);
  return lemmas.length;
}

export { looksLikeNameToken };
