'use client';

import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Empty, Spin } from 'antd';
import { Icons } from '@/app/components/shell/Icons';
import { applySrsRating, listDueSrs, type DueCardIpc, isTauri } from '@/app/lib/ipc';
import { RATING_CODE, RATING_LABEL, schedule, type SrsRating } from '@/app/lib/srs';
import { useWordStore } from '@/app/stores/wordStore';
import { refreshDueCount } from '@/app/stores/srsStore';
import { lookupRemoteDictionary, type DictionaryLookupEntry } from '@/app/lib/dict';

type Phase = 'loading' | 'empty' | 'reviewing' | 'done';

const GRADES: ReadonlyArray<{
  k: SrsRating;
  l: string;
  hint: string;
  cls: string;
}> = [
  { k: 'again', l: 'Again', hint: '<1m', cls: 'g-again' },
  { k: 'hard', l: 'Hard', hint: '8m', cls: 'g-hard' },
  { k: 'good', l: 'Good', hint: '2d', cls: 'g-good' },
  { k: 'easy', l: 'Easy', hint: '9d', cls: 'g-easy' },
];

/**
 * Drains the SRS due queue one card at a time. Editorial flashcard:
 * 72px serif lemma, sample sentence quote, four colour-coded grade buttons.
 * Keeps the existing IPC + ts-fsrs scheduling intact.
 */
export function ReviewSession() {
  const { message } = AntApp.useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [queue, setQueue] = useState<DueCardIpc[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [gloss, setGloss] = useState<DictionaryLookupEntry | null>(null);
  const [graduatedCount, setGraduatedCount] = useState(0);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  const current = queue[index];

  const loadQueue = useCallback(async () => {
    setPhase('loading');
    try {
      const due = isTauri() ? await listDueSrs() : [];
      setQueue(due);
      setIndex(0);
      setRevealed(false);
      setGloss(null);
      setGraduatedCount(0);
      setReviewedCount(0);
      setPhase(due.length === 0 ? 'empty' : 'reviewing');
    } catch (err) {
      message.error(`Failed to load due queue: ${err}`);
      setPhase('empty');
    }
  }, [message]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Pre-fetch the gloss for the current card so reveal feels instant.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setRevealed(false);
    setGloss(null);
    (async () => {
      if (!isTauri()) return;
      try {
        const res = await lookupRemoteDictionary(current.lemma, { limit: 1 });
        if (!cancelled) setGloss(res.entries[0] ?? null);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current]);

  const onRate = useCallback(
    async (rating: SrsRating) => {
      if (!current) return;
      setSubmitting(true);
      try {
        const now = Date.now();
        const update = schedule(current, rating, now);
        if (!isTauri()) {
          message.info(`[dev] ${current.lemma} → ${RATING_LABEL[rating]} (not persisted)`);
        } else {
          const out = await applySrsRating(current.lemma, RATING_CODE[rating], update, {
            nowOverride: now,
          });
          if (out.graduated_to_known) {
            useWordStore.getState().markKnown(current.lemma);
            setGraduatedCount((n) => n + 1);
            message.success(
              <span>
                <strong>{current.lemma}</strong> graduated to known (via SRS)
              </span>
            );
          }
        }
        setReviewedCount((n) => n + 1);

        if (index + 1 >= queue.length) {
          setPhase('done');
        } else {
          setIndex((n) => n + 1);
          setRevealed(false);
          setGloss(null);
        }
        void refreshDueCount();
      } catch (err) {
        message.error(`apply_srs_rating failed: ${err}`);
      } finally {
        setSubmitting(false);
      }
    },
    [current, index, queue.length, message]
  );

  // Keyboard: SPACE = reveal, 1-4 = grades.
  useEffect(() => {
    if (phase !== 'reviewing' || !current) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable) return;
      if (e.code === 'Space' && !revealed) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed && !submitting && /^[1-4]$/.test(e.key)) {
        e.preventDefault();
        const grade = GRADES[Number(e.key) - 1];
        if (grade) void onRate(grade.k);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, current, revealed, submitting, onRate]);

  const total = queue.length || 0;
  const numForProgress = Math.max(total, 1);

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">FSRS · spaced repetition</div>
          <h1 className="page-title">
            Review<em>.</em>
          </h1>
          <p className="page-sub">
            {phase === 'reviewing'
              ? `${total} card${total === 1 ? '' : 's'} due today. Recall, then grade — the schedule adjusts itself.`
              : phase === 'empty'
                ? 'Queue is empty. New cards arrive as you read.'
                : phase === 'done'
                  ? 'Session complete.'
                  : 'Loading queue…'}
          </p>
        </div>
        {phase === 'reviewing' && (
          <button type="button" className="btn ghost sm" onClick={() => setPhase('done')}>
            Skip session
          </button>
        )}
      </div>

      {phase === 'loading' && (
        <div style={{ textAlign: 'center', padding: 64 }}>
          <Spin />
        </div>
      )}

      {phase === 'empty' && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No cards due right now. Come back later or add new words from the reader."
        />
      )}

      {phase === 'done' && (
        <div className="card" style={{ padding: 40, textAlign: 'center' }}>
          <Icons.Check size={36} stroke="var(--review-line)" sw={2} />
          <div className="serif" style={{ fontSize: 28, marginTop: 12, color: 'var(--ink)' }}>
            Session complete
          </div>
          <div
            className="serif"
            style={{ color: 'var(--ink-3)', marginTop: 6, fontStyle: 'italic' }}
          >
            Reviewed <strong>{reviewedCount}</strong> card{reviewedCount === 1 ? '' : 's'}
            {graduatedCount > 0 && (
              <>
                {' '}
                — <strong>{graduatedCount}</strong> graduated to known
              </>
            )}
            .
          </div>
          <div style={{ marginTop: 24 }}>
            <button type="button" className="btn primary" onClick={loadQueue}>
              Reload queue
            </button>
          </div>
        </div>
      )}

      {phase === 'reviewing' && current && (
        <>
          <div className="review-progress">
            <div className="rp-track">
              {Array.from({ length: numForProgress }).map((_, i) => (
                <div
                  key={i}
                  className={'rp-tick' + (i < index ? ' done' : i === index ? ' current' : '')}
                />
              ))}
            </div>
            <div className="small dim">
              {index + 1} of {total}
            </div>
          </div>

          <div className="card flashcard">
            <div className="fc-meta">
              <span className="chip">
                <Icons.Clock size={11} /> reps {current.reps}
              </span>
              <span className="chip">
                <Icons.History size={11} /> stability {current.stability.toFixed(1)}d
              </span>
              {current.lapses > 0 && (
                <span className="chip">
                  {current.lapses} lapse{current.lapses === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="fc-word">{current.lemma}</div>

            {!revealed ? (
              <button
                type="button"
                className="btn primary fc-reveal"
                onClick={() => setRevealed(true)}
              >
                Reveal definition
                <span className="mono small dim" style={{ marginLeft: 8 }}>
                  SPACE
                </span>
              </button>
            ) : (
              <div className="fc-answer">
                {gloss ? (
                  <>
                    <div className="mono small dim" style={{ marginBottom: 4 }}>
                      {gloss.dictionary_name}
                    </div>
                    <div
                      className="serif"
                      style={{
                        fontSize: 18,
                        lineHeight: 1.45,
                        color: 'var(--ink)',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {gloss.definition_text || gloss.headword}
                    </div>
                  </>
                ) : (
                  <div
                    className="serif"
                    style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--ink-3)' }}
                  >
                    Dictionary API has no entry for <span className="mono">{current.lemma}</span>.
                  </div>
                )}
                <div className="fc-grades">
                  {GRADES.map((g) => (
                    <button
                      key={g.k}
                      type="button"
                      className={'grade ' + g.cls}
                      disabled={submitting}
                      onClick={() => onRate(g.k)}
                    >
                      <div className="g-l">{g.l}</div>
                      <div className="g-h mono">{g.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="row small dim gap-12" style={{ marginTop: 20, justifyContent: 'center' }}>
            <span>
              <span className="mono">1–4</span> grade
            </span>
            <span>·</span>
            <span>
              <span className="mono">SPACE</span> reveal
            </span>
          </div>
        </>
      )}

      <style>{`
        .review-progress { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
        .rp-track { display:flex; gap:4px; flex:1; }
        .rp-tick { flex:1; height: 3px; background: var(--paper-3); border-radius:999px; }
        .rp-tick.done { background: var(--accent); }
        .rp-tick.current { background: var(--ink); }
        .flashcard { padding: 40px 44px; }
        .fc-meta { display:flex; gap:8px; margin-bottom:24px; flex-wrap: wrap; }
        .fc-word {
          font-family: var(--serif); font-weight: 400;
          font-size: 72px; line-height: 1; letter-spacing: -0.03em;
          color: var(--ink); margin-bottom: 24px;
        }
        .fc-reveal { width: 100%; padding: 14px; justify-content: center; font-size: 14px; }
        .fc-answer { padding-top: 20px; border-top: 1px solid var(--rule-soft); }
        .fc-grades { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 24px; }
        .grade {
          appearance: none; border: 1px solid var(--rule); background: var(--paper);
          padding: 14px 8px; border-radius: var(--radius); cursor: pointer;
          font-family: var(--sans); transition: all .12s;
        }
        .grade:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-2); }
        .grade:disabled { opacity: 0.55; cursor: not-allowed; }
        .grade .g-l { font-weight: 600; font-size: 14px; color: var(--ink); margin-bottom: 4px; }
        .grade .g-h { font-size: 11px; color: var(--ink-3); }
        .g-again { border-color: #c89999; } .g-again:hover:not(:disabled) { background: #f0d9d9; }
        .g-hard  { border-color: #cdb189; } .g-hard:hover:not(:disabled)  { background: #f0e2c5; }
        .g-good  { border-color: #a3b889; } .g-good:hover:not(:disabled)  { background: #dee9c5; }
        .g-easy  { border-color: #8fa9b3; } .g-easy:hover:not(:disabled)  { background: #cde0e6; }
        [data-theme='dark'] .g-again { border-color: #6b3a3a; } [data-theme='dark'] .g-again:hover:not(:disabled) { background: #3d2222; }
        [data-theme='dark'] .g-hard  { border-color: #6b5a3a; } [data-theme='dark'] .g-hard:hover:not(:disabled)  { background: #3d3322; }
        [data-theme='dark'] .g-good  { border-color: #4a6b3a; } [data-theme='dark'] .g-good:hover:not(:disabled)  { background: #2a3d22; }
        [data-theme='dark'] .g-easy  { border-color: #3a5a6b; } [data-theme='dark'] .g-easy:hover:not(:disabled)  { background: #223340; }
      `}</style>
    </div>
  );
}
