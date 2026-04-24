// Sanity checks on the ts-fsrs wrapper: stability + due both strictly
// advance across three successful reps, and an Again rating rewinds the
// card to a short due interval. Complements the Rust-side AC4 test which
// owns the persistence + graduation path.

import { describe, expect, it } from 'vitest';
import { schedule, RATING_CODE, type PersistedCard } from '../srs';

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyCard(): PersistedCard {
  return {
    word_id: 1,
    lemma: 'ephemeral',
    stability: 0,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: 0,
    lapses: 0,
    last_review: null,
    due: 0,
  };
}

describe('srs.schedule', () => {
  it('pushes due forward and raises stability across three Good ratings', () => {
    const t0 = 1_700_000_000_000;
    let card = emptyCard();
    let now = t0;

    const updates: number[] = [];
    let lastStability = 0;
    for (let i = 0; i < 3; i++) {
      const u = schedule(card, 'good', now);
      expect(u.due).toBeGreaterThan(now);
      expect(u.stability).toBeGreaterThanOrEqual(lastStability);
      updates.push(u.due - now);

      lastStability = u.stability;
      now = u.due; // fast-forward to the next due boundary
      card = {
        ...card,
        stability: u.stability,
        difficulty: u.difficulty,
        elapsed_days: u.elapsed_days,
        scheduled_days: u.scheduled_days,
        reps: card.reps + 1,
        last_review: now,
        due: u.due,
      };
    }

    // Intervals monotonically increasing (FSRS expands intervals on success).
    expect(updates[1]).toBeGreaterThanOrEqual(updates[0]);
    expect(updates[2]).toBeGreaterThanOrEqual(updates[1]);
  });

  it('Again rating shortens the interval vs a Good rating', () => {
    const t0 = 1_700_000_000_000;
    const card = emptyCard();
    const good = schedule(card, 'good', t0);
    const again = schedule(card, 'again', t0);
    expect(again.due - t0).toBeLessThan(good.due - t0);
    // Rating codes are wire-level integers the Rust side expects.
    expect(RATING_CODE.again).toBe(1);
    expect(RATING_CODE.good).toBe(3);
  });

  it('produces integer day counts (Rust schema stores INTEGER)', () => {
    const t0 = 1_700_000_000_000;
    const u = schedule(emptyCard(), 'easy', t0);
    expect(Number.isInteger(u.elapsed_days)).toBe(true);
    expect(Number.isInteger(u.scheduled_days)).toBe(true);
    // Easy should at minimum schedule a day out.
    expect(u.due).toBeGreaterThanOrEqual(t0 + DAY_MS);
  });
});
