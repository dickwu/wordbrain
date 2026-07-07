'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Drawer, Empty, List, Spin, Tag, Typography } from 'antd';
import {
  addToSrs,
  isTauri,
  wordProfile,
  type MaterialForWord,
  type WordProfileIpc,
} from '@/app/lib/ipc';
import { setWordState as setWordStateIpc } from '@/app/lib/words/api';
import { useWordStore } from '@/app/stores/wordStore';
import { refreshDueCount } from '@/app/stores/srsStore';
import { refreshLearningCount } from '@/app/stores/learningStore';

const { Text, Paragraph } = Typography;

const DOC_KINDS = new Set(['paste', 'file', 'url', 'epub', 'epub_chapter']);

/** True for reading materials (vs AI stories / writing submissions). */
export function isDocumentKind(kind: string): boolean {
  return DOC_KINDS.has(kind);
}

/** Group a word's materials into the three learning-trail buckets. */
export function splitMaterials(materials: MaterialForWord[]): {
  docs: MaterialForWord[];
  stories: MaterialForWord[];
  writing: MaterialForWord[];
} {
  return {
    docs: materials.filter((m) => isDocumentKind(m.source_kind)),
    stories: materials.filter((m) => m.source_kind === 'ai_story'),
    writing: materials.filter((m) => m.source_kind === 'writing_submission'),
  };
}

/** Compact relative time: "just now", "5m ago", "3d ago", "in 2d". */
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 60_000
      ? ['just now', 'just now']
      : abs < 3_600_000
        ? [`${Math.round(abs / 60_000)}m ago`, `in ${Math.round(abs / 60_000)}m`]
        : abs < 86_400_000
          ? [`${Math.round(abs / 3_600_000)}h ago`, `in ${Math.round(abs / 3_600_000)}h`]
          : [`${Math.round(abs / 86_400_000)}d ago`, `in ${Math.round(abs / 86_400_000)}d`];
  return diff <= 0 ? unit[0] : unit[1];
}

const RATING_META: Record<number, { label: string; color: string }> = {
  1: { label: 'Again', color: '#b46a6a' },
  2: { label: 'Hard', color: '#b48f5a' },
  3: { label: 'Good', color: '#7a9a5a' },
  4: { label: 'Easy', color: '#5a8a9a' },
};

const STATE_TAG: Record<string, { color: string; label: string }> = {
  known: { color: 'green', label: 'known' },
  learning: { color: 'gold', label: 'learning' },
  unknown: { color: 'default', label: 'unknown' },
};

interface WordProfileDrawerProps {
  /** Lemma to profile; when null the drawer is closed. */
  lemma: string | null;
  onClose: () => void;
  /** Open a material; the caller routes by `source_kind` (doc → Reader, story → Story). */
  onOpenMaterial?: (m: MaterialForWord) => void;
  /** Open the dictionary lookup modal for this lemma. */
  onLookup?: (lemma: string) => void;
}

/**
 * The "recall everything" surface: one drawer aggregating a word's entire
 * learning trail — state + level, SRS memory curve and review history,
 * dictionary lookups, and every place the word was encountered or practised
 * (documents, AI stories, writing submissions). Reachable from Reader,
 * Review, Words, Story, Network and Search surfaces.
 */
export function WordProfileDrawer({
  lemma,
  onClose,
  onOpenMaterial,
  onLookup,
}: WordProfileDrawerProps) {
  const { message } = AntApp.useApp();
  const [profile, setProfile] = useState<WordProfileIpc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const loadIdRef = useRef(0);

  const reload = useCallback(async (target: string) => {
    const id = ++loadIdRef.current;
    setLoading(true);
    try {
      const p = await wordProfile(target);
      if (id !== loadIdRef.current) return;
      setProfile(p);
      setErr(null);
    } catch (e) {
      if (id !== loadIdRef.current) return;
      setErr(String(e));
      setProfile(null);
    } finally {
      if (id === loadIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!lemma) {
      setProfile(null);
      setErr(null);
      return;
    }
    if (!isTauri()) {
      setErr('Word profile requires the Tauri shell.');
      setProfile(null);
      return;
    }
    void reload(lemma);
  }, [lemma, reload]);

  const onAddToSrs = useCallback(async () => {
    if (!lemma) return;
    setMutating(true);
    try {
      const out = await addToSrs(lemma);
      message.success(
        out.already_scheduled ? (
          <span>
            <strong>{lemma}</strong> is already in the review queue
          </span>
        ) : (
          <span>
            <strong>{lemma}</strong> added to the review queue
          </span>
        )
      );
      useWordStore.getState().setState(lemma, 'learning');
      void refreshDueCount();
      void refreshLearningCount();
      await reload(lemma);
    } catch (e) {
      message.error(`add_to_srs failed: ${e}`);
    } finally {
      setMutating(false);
    }
  }, [lemma, message, reload]);

  const onSetState = useCallback(
    async (state: 'known' | 'learning') => {
      if (!lemma) return;
      setMutating(true);
      try {
        await setWordStateIpc(lemma, state);
        useWordStore.getState().setState(lemma, state);
        void refreshLearningCount();
        message.success(
          <span>
            <strong>{lemma}</strong> → {state}
          </span>
        );
        await reload(lemma);
      } catch (e) {
        message.error(`set_word_state failed: ${e}`);
      } finally {
        setMutating(false);
      }
    },
    [lemma, message, reload]
  );

  const groups = profile ? splitMaterials(profile.materials) : null;
  const stateTag = profile ? (STATE_TAG[profile.state] ?? STATE_TAG.unknown) : null;

  return (
    <Drawer
      title={lemma ? `Word profile · ${lemma}` : 'Word profile'}
      open={Boolean(lemma)}
      onClose={onClose}
      size={560}
      placement="right"
    >
      {err && <Text type="danger">{err}</Text>}
      {loading && !profile && !err && (
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin />
        </div>
      )}

      {!loading && !err && lemma && !profile && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              WordBrain has not tracked <strong>{lemma}</strong> yet. Read it somewhere, look it up,
              or add it to the review queue to start its trail.
            </span>
          }
        >
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            {onLookup && (
              <button type="button" className="btn ghost sm" onClick={() => onLookup(lemma)}>
                Look up
              </button>
            )}
            <button
              type="button"
              className="btn primary sm"
              disabled={mutating}
              onClick={onAddToSrs}
            >
              Add to review queue
            </button>
          </div>
        </Empty>
      )}

      {profile && (
        <div className="wpd">
          {/* Header: state, level, provenance. */}
          <div className="wpd-head">
            <div className="wpd-lemma serif">{profile.lemma}</div>
            <div className="wpd-chips">
              {stateTag && <Tag color={stateTag.color}>{stateTag.label}</Tag>}
              <span className="chip">lvl {profile.level}</span>
              {profile.freq_rank !== null && (
                <span className="chip">freq #{profile.freq_rank.toLocaleString()}</span>
              )}
              {profile.first_seen_at !== null && (
                <span className="chip">first met {formatRelative(profile.first_seen_at)}</span>
              )}
            </div>
            {profile.user_note && (
              <Paragraph type="secondary" style={{ fontSize: 13, margin: '8px 0 0' }}>
                “{profile.user_note}”
              </Paragraph>
            )}
          </div>

          <div className="wpd-actions">
            {onLookup && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => onLookup(profile.lemma)}
              >
                Dictionary
              </button>
            )}
            {!profile.srs && profile.state !== 'known' && (
              <button
                type="button"
                className="btn primary sm"
                disabled={mutating}
                onClick={onAddToSrs}
              >
                Add to review queue
              </button>
            )}
            {profile.state !== 'known' && (
              <button
                type="button"
                className="btn ghost sm"
                disabled={mutating}
                onClick={() => onSetState('known')}
              >
                Mark known
              </button>
            )}
            {profile.state === 'known' && (
              <button
                type="button"
                className="btn ghost sm"
                disabled={mutating}
                onClick={() => onSetState('learning')}
              >
                Back to learning
              </button>
            )}
          </div>

          {/* Memory: live FSRS schedule + recent reviews. */}
          <SectionTitle>Memory</SectionTitle>
          {profile.srs ? (
            <>
              <div className="wpd-chips">
                <span className="chip">due {formatRelative(profile.srs.due)}</span>
                <span className="chip">stability {profile.srs.stability.toFixed(1)}d</span>
                <span className="chip">reps {profile.srs.reps}</span>
                {profile.srs.lapses > 0 && (
                  <span className="chip">{profile.srs.lapses} lapses</span>
                )}
              </div>
              {profile.recent_reviews.length > 0 && (
                <div className="wpd-timeline">
                  {profile.recent_reviews.map((r, i) => {
                    const meta = RATING_META[r.rating] ?? { label: `#${r.rating}`, color: '#999' };
                    return (
                      <div key={i} className="wpd-review-row">
                        <span className="wpd-dot" style={{ background: meta.color }} />
                        <span className="wpd-review-label" style={{ color: meta.color }}>
                          {meta.label}
                        </span>
                        <span className="small dim">{formatRelative(r.reviewed_at)}</span>
                        {r.new_stability !== null && (
                          <span className="mono small dim">
                            {(r.prev_stability ?? 0).toFixed(1)}d → {r.new_stability.toFixed(1)}d
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <Text type="secondary" style={{ fontSize: 13 }}>
              Not in the review queue{profile.state === 'known' ? ' — already known.' : ' yet.'}
            </Text>
          )}

          {/* Encounters: documents where the word was met. */}
          <SectionTitle>Where you met it · {groups!.docs.length}</SectionTitle>
          {groups!.docs.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 13 }}>
              No saved document mentions “{profile.lemma}” yet.
            </Text>
          ) : (
            <List
              size="small"
              dataSource={groups!.docs}
              renderItem={(m) => (
                <MaterialRow key={m.material_id} m={m} onOpen={onOpenMaterial} clickable />
              )}
            />
          )}

          {/* Practice trail: AI stories + writing submissions. */}
          {(groups!.stories.length > 0 ||
            groups!.writing.length > 0 ||
            profile.story_uses > 0 ||
            profile.writing_uses > 0) && (
            <>
              <SectionTitle>
                Practice trail · {groups!.stories.length + groups!.writing.length}
              </SectionTitle>
              {groups!.stories.length > 0 && (
                <List
                  size="small"
                  dataSource={groups!.stories}
                  renderItem={(m) => (
                    <MaterialRow
                      key={m.material_id}
                      m={m}
                      onOpen={onOpenMaterial}
                      clickable
                      tag="story"
                    />
                  )}
                />
              )}
              {groups!.writing.length > 0 && (
                <List
                  size="small"
                  dataSource={groups!.writing}
                  renderItem={(m) => (
                    <MaterialRow key={m.material_id} m={m} tag="writing" clickable={false} />
                  )}
                />
              )}
            </>
          )}

          {/* Trail stats footer. */}
          <SectionTitle>Trail</SectionTitle>
          <div className="wpd-chips">
            <span className="chip">seen in {profile.materials.length} materials</span>
            <span className="chip">{profile.exposure_count} exposures</span>
            {profile.lookup ? (
              <span className="chip">
                looked up {profile.lookup.lookup_count}× · last{' '}
                {formatRelative(profile.lookup.last_looked_up_at)}
              </span>
            ) : (
              <span className="chip">never looked up</span>
            )}
            <span className="chip">story uses {profile.story_uses}</span>
            <span className="chip">writing uses {profile.writing_uses}</span>
          </div>
        </div>
      )}

      <style>{`
        .wpd { display: flex; flex-direction: column; gap: 6px; }
        .wpd-lemma { font-size: 40px; line-height: 1.1; letter-spacing: -0.02em; }
        .wpd-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 8px; }
        .wpd-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
        .wpd-section {
          margin: 18px 0 6px; font-size: 11px; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--ink-3, #888);
        }
        .wpd-timeline { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
        .wpd-review-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
        .wpd-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; }
        .wpd-review-label { width: 44px; font-weight: 600; font-size: 12px; }
      `}</style>
    </Drawer>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="wpd-section">{children}</div>;
}

function MaterialRow({
  m,
  onOpen,
  clickable,
  tag,
}: {
  m: MaterialForWord;
  onOpen?: (m: MaterialForWord) => void;
  clickable: boolean;
  tag?: string;
}) {
  const openable = clickable && Boolean(onOpen);
  return (
    <List.Item
      onClick={openable ? () => onOpen!(m) : undefined}
      style={{ cursor: openable ? 'pointer' : 'default', alignItems: 'flex-start' }}
    >
      <List.Item.Meta
        title={
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13 }}>
              {m.title}
            </Text>
            {tag && <Tag color={tag === 'story' ? 'purple' : 'cyan'}>{tag}</Tag>}
            <Tag color="blue">{m.occurrence_count}×</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelative(m.created_at)}
            </Text>
          </div>
        }
        description={
          m.sentence_preview ? (
            <Paragraph type="secondary" style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>
              “{m.sentence_preview}”
            </Paragraph>
          ) : null
        }
      />
    </List.Item>
  );
}
