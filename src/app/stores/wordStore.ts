import { create } from 'zustand';
import { PHASE1_SEED } from '@/app/lib/seed/phase1-seed';

interface WordState {
  known: Set<string>;
  markKnown: (lemma: string) => void;
  unmark: (lemma: string) => void;
  isKnown: (lemma: string) => boolean;
  hydrateFrom: (lemmas: Iterable<string>) => void;
  /** Monotonic counter; bump on every mutation so Tiptap can rebuild decorations. */
  version: number;
}

const initialSeed = new Set<string>();
for (const w of PHASE1_SEED) initialSeed.add(w.toLowerCase());

export const useWordStore = create<WordState>((set, get) => ({
  known: initialSeed,
  version: 0,
  markKnown: (lemma) =>
    set((s) => {
      const next = new Set(s.known);
      next.add(lemma.toLowerCase());
      return { known: next, version: s.version + 1 };
    }),
  unmark: (lemma) =>
    set((s) => {
      const next = new Set(s.known);
      next.delete(lemma.toLowerCase());
      return { known: next, version: s.version + 1 };
    }),
  isKnown: (lemma) => get().known.has(lemma.toLowerCase()),
  hydrateFrom: (lemmas) => {
    const next = new Set<string>();
    for (const l of lemmas) next.add(l.toLowerCase());
    set((s) => ({ known: next, version: s.version + 1 }));
  },
}));

export function isLemmaKnown(lemma: string): boolean {
  return useWordStore.getState().known.has(lemma.toLowerCase());
}
