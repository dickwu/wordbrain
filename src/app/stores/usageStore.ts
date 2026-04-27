// Mirrors the server-side `words.usage_count` for the words/word the renderer
// has touched recently, so the Words view + sidebar level chips can render
// with one O(1) lookup instead of waiting on a refetch.
//
// The store is intentionally lazy — entries are inserted only after a
// `register_word_use` round-trip completes (so we always store the
// authoritative server value, not an optimistic guess) and after fetches that
// already include the counter (e.g. `listWords`, `recentPracticeWords`).
//
// Companion to `wordStore.ts` (in-memory known-set). They are kept separate
// because the known-set is keyed by lemma string while usage counters are
// keyed by `word_id` — different cardinalities and different invalidation
// triggers.

import { create } from 'zustand';
import { isTauri, registerWordUseIpc, type UsageSurface } from '@/app/lib/ipc';
import { levelFromUsage } from '@/app/lib/words/types';

interface UsageState {
  /** word_id → server-confirmed usage_count */
  byId: Map<number, number>;
  /** Bumped on every mutation so consumers can subscribe for invalidations. */
  version: number;
  setUsage: (wordId: number, usageCount: number) => void;
  setMany: (entries: Iterable<[number, number]>) => void;
  getUsage: (wordId: number) => number | undefined;
  getLevel: (wordId: number) => number;
  reset: () => void;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  byId: new Map(),
  version: 0,
  setUsage: (wordId, usageCount) => {
    set((s) => {
      const prev = s.byId.get(wordId);
      if (prev === usageCount) return s;
      const next = new Map(s.byId);
      next.set(wordId, usageCount);
      return { byId: next, version: s.version + 1 };
    });
  },
  setMany: (entries) => {
    set((s) => {
      const next = new Map(s.byId);
      let changed = false;
      for (const [id, count] of entries) {
        if (next.get(id) !== count) {
          next.set(id, count);
          changed = true;
        }
      }
      if (!changed) return s;
      return { byId: next, version: s.version + 1 };
    });
  },
  getUsage: (wordId) => get().byId.get(wordId),
  getLevel: (wordId) => levelFromUsage(get().byId.get(wordId) ?? 0),
  reset: () => set({ byId: new Map(), version: 0 }),
}));

/**
 * Fire `register_word_use` and atomically reflect the new server value into
 * the usage store. Returns the post-increment counter; throws on IPC failure
 * so callers can surface the error themselves (we deliberately do NOT
 * fall back to optimistic +1 — counter accuracy beats latency here).
 */
export async function registerWordUse(wordId: number, surface: UsageSurface): Promise<number> {
  if (!isTauri()) {
    // Browser dev — bump the local mirror so the UI still updates without
    // a real DB round-trip.
    const next = (useUsageStore.getState().byId.get(wordId) ?? 0) + 1;
    useUsageStore.getState().setUsage(wordId, next);
    return next;
  }
  const next = await registerWordUseIpc(wordId, surface);
  useUsageStore.getState().setUsage(wordId, next);
  return next;
}
