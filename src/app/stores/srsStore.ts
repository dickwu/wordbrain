// Keeps a running count of SRS cards whose `due <= now()` so the sidebar
// badge can render without every consumer polling independently. Any caller
// that mutates srs_schedule (add_to_srs, apply_srs_rating) should call
// `refreshDueCount()` afterwards so the badge updates immediately.

import { create } from 'zustand';
import { countDueSrs, isTauri } from '@/app/lib/ipc';

interface SrsState {
  dueCount: number;
  /** bumped on every mutation so consumers can subscribe for invalidations */
  version: number;
  setDueCount: (n: number) => void;
  bumpVersion: () => void;
}

export const useSrsStore = create<SrsState>((set) => ({
  dueCount: 0,
  version: 0,
  setDueCount: (n) => set({ dueCount: n }),
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
}));

/** Fetch the live due-count from Rust and stash it in the store. */
export async function refreshDueCount(): Promise<number> {
  if (!isTauri()) {
    useSrsStore.getState().setDueCount(0);
    return 0;
  }
  try {
    const n = await countDueSrs();
    useSrsStore.getState().setDueCount(n);
    useSrsStore.getState().bumpVersion();
    return n;
  } catch (err) {
    console.warn('[wordbrain] count_due_srs failed', err);
    return useSrsStore.getState().dueCount;
  }
}
