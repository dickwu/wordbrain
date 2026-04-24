// Thin wrapper around ts-fsrs that makes the scheduling step testable with
// an injected clock. Pure — no Tauri / DOM dependencies — so the
// auto-promotion logic is trivial to unit-test in vitest.

import {
  createEmptyCard,
  fsrs as buildFsrs,
  Rating,
  type Card,
  type FSRS,
  type Grade,
} from 'ts-fsrs';

export type SrsRating = 'again' | 'hard' | 'good' | 'easy';

/** Integer codes the Rust `srs_review_log.rating` column stores. */
export const RATING_CODE: Record<SrsRating, number> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4,
};

export const RATING_LABEL: Record<SrsRating, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
};

const RATING_ENUM: Record<SrsRating, Grade> = {
  again: Rating.Again as Grade,
  hard: Rating.Hard as Grade,
  good: Rating.Good as Grade,
  easy: Rating.Easy as Grade,
};

/**
 * Card snapshot returned by the Rust `list_due_srs` IPC. `last_review` /
 * `due` are millisecond-epoch integers; `stability` / `difficulty` are
 * floats; everything else is an integer. Matches the Serialize shape of
 * `db::srs::DueCard`.
 */
export interface PersistedCard {
  word_id: number;
  lemma: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  last_review: number | null;
  due: number;
}

/** Subset of ts-fsrs `Card` that Rust persists. */
export interface SchedulingUpdate {
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  /** Epoch-ms of the next due time. */
  due: number;
}

/**
 * Inflate a persisted row into a ts-fsrs `Card`.
 *
 * A freshly-added card (reps=0 in Rust, stability=0 by the add_to_srs
 * defaults) is rehydrated via `createEmptyCard()` so ts-fsrs runs its
 * init-stability branch — it rejects any `stability < S_MIN` on the
 * review path. Only cards that have already been reviewed carry their
 * persisted FSRS memory state forward.
 */
export function cardFromPersisted(row: PersistedCard): Card {
  if (row.reps === 0) {
    // Rehydrate a fresh-from-Rust card. ts-fsrs's createEmptyCard() produces
    // state=New + stability=0 which the scheduler will initialise on first
    // review — our persisted stability/difficulty are the add_to_srs
    // placeholders (0 / 5), not meaningful memory state yet.
    const fresh = createEmptyCard();
    fresh.due = new Date(row.due);
    return fresh;
  }
  const base = createEmptyCard();
  return {
    ...base,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    last_review: row.last_review ? new Date(row.last_review) : undefined,
    due: new Date(row.due),
  };
}

/** Flatten a ts-fsrs `Card` back into the serialisable update payload. */
export function updateFromCard(card: Card): SchedulingUpdate {
  return {
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: Math.round(card.elapsed_days),
    scheduled_days: Math.round(card.scheduled_days),
    due: card.due.getTime(),
  };
}

let _scheduler: FSRS | null = null;
function scheduler(): FSRS {
  if (!_scheduler) _scheduler = buildFsrs({ enable_fuzz: false });
  return _scheduler;
}

/**
 * Apply a rating to a persisted card snapshot at `nowMs` and return the
 * update payload Rust should write back. Pure — `nowMs` is injected so
 * integration tests can advance a fake clock.
 */
export function schedule(
  persisted: PersistedCard,
  rating: SrsRating,
  nowMs: number
): SchedulingUpdate {
  const card = cardFromPersisted(persisted);
  const now = new Date(nowMs);
  const result = scheduler().next(card, now, RATING_ENUM[rating]);
  return updateFromCard(result.card);
}
