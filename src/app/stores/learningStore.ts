// Tracks the count of `state='learning'` words so the sidebar can render
// a third stat alongside `Known` and `Due today`. Mirrors `srsStore`'s
// pattern: a single owning store, polled from page.tsx, refreshed on the
// same 30 s tick as `refreshDueCount`.
//
// Saturday's wordStore audit will introduce a `learning: Set<string>` for
// reader highlighting. This store stays as the dedicated count source so
// the polling tick has one stable import; the Set keeps highlight latency
// at O(1) without pulling rows on every keystroke.

import { create } from 'zustand';
import { isTauri } from '@/app/lib/ipc';
import { listWords } from '@/app/lib/words/api';

interface LearningState {
  learningCount: number;
  /** bumped on every mutation so consumers can subscribe for invalidations */
  version: number;
  setLearningCount: (n: number) => void;
  bumpVersion: () => void;
}

export const useLearningStore = create<LearningState>((set) => ({
  learningCount: 0,
  version: 0,
  setLearningCount: (n) => set({ learningCount: n }),
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
}));

/** Fetch the current learning-state row count and stash it in the store. */
export async function refreshLearningCount(): Promise<number> {
  if (!isTauri()) {
    useLearningStore.getState().setLearningCount(0);
    return 0;
  }
  try {
    const rows = await listWords({ states: ['learning'] });
    const n = rows.length;
    useLearningStore.getState().setLearningCount(n);
    useLearningStore.getState().bumpVersion();
    return n;
  } catch (err) {
    console.warn('[wordbrain] list_words(learning) for count failed', err);
    return useLearningStore.getState().learningCount;
  }
}
