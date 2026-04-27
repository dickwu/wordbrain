'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp, Button, Card, Empty, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { applySrsRating, listDueSrs, type DueCardIpc, isTauri } from '@/app/lib/ipc';
import { RATING_CODE, RATING_LABEL, schedule, type SrsRating } from '@/app/lib/srs';
import { useWordStore } from '@/app/stores/wordStore';
import { refreshDueCount } from '@/app/stores/srsStore';
import { lookupOffline, type OfflineEntry } from '@/app/lib/dict';

const { Title, Text, Paragraph } = Typography;

type Phase = 'loading' | 'empty' | 'reviewing' | 'done';

/**
 * Drains the SRS due queue one card at a time:
 *   1. Show the lemma, hide the gloss.
 *   2. User clicks [Reveal] → ECDICT gloss is revealed.
 *   3. User clicks Again/Hard/Good/Easy → ts-fsrs computes the next
 *      stability/difficulty/due, we persist via `apply_srs_rating`, and
 *      auto-graduation is handled server-side.
 */
export function ReviewSession() {
  const { message } = AntApp.useApp();
  const [phase, setPhase] = useState<Phase>('loading');
  const [queue, setQueue] = useState<DueCardIpc[]>([]);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [gloss, setGloss] = useState<OfflineEntry | null>(null);
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

  // Pre-fetch the gloss for the current card in the background so clicking
  // "Reveal" feels instant. ECDICT is local + ~1ms so this is cheap.
  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setRevealed(false);
    setGloss(null);
    (async () => {
      if (!isTauri()) return;
      try {
        const res = await lookupOffline(current.lemma);
        if (!cancelled) setGloss(res.entry);
      } catch {
        // Non-fatal — user can still rate without the gloss.
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
            // Mirror into the in-memory known-set so the reader highlight
            // updates immediately if the user pops back to it.
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

        // Advance the queue. If we ran out of cards, go to the done state.
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

  const content = useMemo(() => {
    if (phase === 'loading') return <Spin />;
    if (phase === 'empty') {
      return (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>No cards due right now. Come back later or add new words from the reader.</span>
          }
        />
      );
    }
    if (phase === 'done') {
      return (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <CheckCircleOutlined style={{ fontSize: 48, color: '#22c55e' }} />
          <Title level={4} style={{ marginTop: 12 }}>
            Session complete
          </Title>
          <Paragraph type="secondary">
            Reviewed <strong>{reviewedCount}</strong> card{reviewedCount === 1 ? '' : 's'}
            {graduatedCount > 0 && (
              <>
                {' '}
                — <strong>{graduatedCount}</strong> graduated to known
              </>
            )}
            .
          </Paragraph>
          <Button type="primary" onClick={loadQueue}>
            Reload queue
          </Button>
        </div>
      );
    }
    if (!current) return null;

    return (
      <Card
        size="small"
        title={
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Card {index + 1} / {queue.length}
            </Text>
            <Tag color="blue">reps {current.reps}</Tag>
            <Tag color="gold">stability {current.stability.toFixed(1)}</Tag>
            {current.lapses > 0 && <Tag color="volcano">lapses {current.lapses}</Tag>}
          </Space>
        }
      >
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <Title level={2} style={{ margin: 0 }}>
            {current.lemma}
          </Title>
          {!revealed ? (
            <Paragraph type="secondary" style={{ marginTop: 24 }}>
              <Button type="default" onClick={() => setRevealed(true)}>
                Reveal gloss
              </Button>
            </Paragraph>
          ) : (
            <div style={{ marginTop: 16, minHeight: 56 }}>
              {gloss ? (
                <>
                  {gloss.pos && <Tag color="purple">{gloss.pos}</Tag>}
                  {gloss.ipa && <Text type="secondary">/{gloss.ipa}/</Text>}
                  <Paragraph style={{ fontSize: 15, marginTop: 8, whiteSpace: 'pre-wrap' }}>
                    {gloss.definitions_zh || gloss.definitions_en || '(no gloss)'}
                  </Paragraph>
                </>
              ) : (
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  ECDICT has no entry for <Text code>{current.lemma}</Text>.
                </Paragraph>
              )}
            </div>
          )}
        </div>
        <Space wrap style={{ justifyContent: 'center', display: 'flex' }}>
          {(['again', 'hard', 'good', 'easy'] as SrsRating[]).map((r) => (
            <Button
              key={r}
              type={r === 'good' ? 'primary' : 'default'}
              danger={r === 'again'}
              loading={submitting}
              disabled={!revealed}
              onClick={() => onRate(r)}
            >
              {RATING_LABEL[r]}
            </Button>
          ))}
        </Space>
        {!revealed && (
          <Paragraph type="secondary" style={{ fontSize: 11, textAlign: 'center', marginTop: 8 }}>
            Reveal the gloss before rating.
          </Paragraph>
        )}
      </Card>
    );
  }, [
    phase,
    current,
    index,
    queue.length,
    revealed,
    gloss,
    submitting,
    reviewedCount,
    graduatedCount,
    loadQueue,
    onRate,
  ]);

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <ThunderboltOutlined /> Review
          </Title>
          <Text type="secondary">FSRS-scheduled flashcards for words you've added.</Text>
        </div>
      </div>
      {content}
    </div>
  );
}
