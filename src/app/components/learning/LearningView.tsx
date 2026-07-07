'use client';

// Learning hub — the whole-loop cockpit and default landing view.
//
// One screen covers the full remember-words process:
//   meet (reader/import) → capture (lookup + SRS) → review (FSRS) →
//   apply (story/writing practice) → mastery (known funnel).
// Every number is a door: due cards start a review, the funnel opens the
// Words table, practice words open their full profile drawer, and the
// recommended next read drops straight into the Reader.

import { useCallback, useEffect, useState } from 'react';
import { Spin, Tooltip } from 'antd';
import type { ViewId } from '@/app/components/shell/AppSidebar';
import {
  isTauri,
  learningStats,
  recommendNext,
  recentPracticeWordsIpc,
  type LearningStatsIpc,
  type RecentWordIpc,
  type RecommendedMaterial,
} from '@/app/lib/ipc';

const ACTIVITY_DAYS = 14;
const PRACTICE_WINDOW_DAYS = 14;
const PRACTICE_LIMIT = 12;

export interface FunnelSegment {
  key: 'unknown' | 'learning' | 'known';
  count: number;
  /** Percentage width 0–100 across the tracked vocabulary. */
  pct: number;
}

/** Pure funnel math, exported for unit tests. */
export function funnelSegments(stats: {
  unknown_count: number;
  learning_count: number;
  known_count: number;
}): FunnelSegment[] {
  const total = Math.max(1, stats.unknown_count + stats.learning_count + stats.known_count);
  return [
    { key: 'unknown', count: stats.unknown_count, pct: (stats.unknown_count / total) * 100 },
    { key: 'learning', count: stats.learning_count, pct: (stats.learning_count / total) * 100 },
    { key: 'known', count: stats.known_count, pct: (stats.known_count / total) * 100 },
  ];
}

interface LearningViewProps {
  onNavigate: (view: ViewId) => void;
  /** Open a saved material in the Reader. */
  onOpenMaterial: (materialId: number) => void;
  /** Open the full word-profile drawer for a lemma. */
  onDrillLemma: (lemma: string) => void;
}

type Phase = 'loading' | 'ready' | 'browser' | 'error';

export function LearningView({ onNavigate, onOpenMaterial, onDrillLemma }: LearningViewProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [stats, setStats] = useState<LearningStatsIpc | null>(null);
  const [nextReads, setNextReads] = useState<RecommendedMaterial[]>([]);
  const [practice, setPractice] = useState<RecentWordIpc[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isTauri()) {
      setPhase('browser');
      return;
    }
    setPhase('loading');
    try {
      const [s, recs, words] = await Promise.all([
        learningStats(ACTIVITY_DAYS),
        recommendNext(0.035, 3).catch(() => [] as RecommendedMaterial[]),
        recentPracticeWordsIpc(PRACTICE_WINDOW_DAYS, PRACTICE_LIMIT).catch(
          () => [] as RecentWordIpc[]
        ),
      ]);
      setStats(s);
      setNextReads(recs);
      setPractice(words);
      setPhase('ready');
    } catch (e) {
      setErr(String(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Whole loop · meet → review → use → own</div>
          <h1 className="page-title">
            Learning<em>.</em>
          </h1>
          <p className="page-sub">
            Everything in flight, one glance. Click any number to jump into that part of the loop;
            click any word for its full trail.
          </p>
        </div>
        {phase === 'ready' && (
          <button type="button" className="btn ghost sm" onClick={() => void load()}>
            Refresh
          </button>
        )}
      </div>

      {phase === 'loading' && (
        <div style={{ textAlign: 'center', padding: 64 }}>
          <Spin />
        </div>
      )}

      {phase === 'browser' && (
        <div className="card" style={{ padding: 24 }}>
          <p className="serif" style={{ fontStyle: 'italic', color: 'var(--ink-3)' }}>
            The Learning hub reads your local database — run the desktop shell (
            <span className="mono">bun run tauri:dev</span>) to see it live.
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div className="card" style={{ padding: 24 }}>
          <p style={{ color: 'var(--ink-3)' }}>Failed to load learning stats: {err}</p>
          <button type="button" className="btn primary sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {phase === 'ready' && stats && (
        <>
          {/* Today row — the four levers of the day. */}
          <div className="lv-grid4">
            <StatCard
              label="Due now"
              value={stats.due_now}
              hint={`${stats.scheduled_total} scheduled`}
              accent={stats.due_now > 0}
              action={stats.due_now > 0 ? 'Start review' : 'Review queue'}
              onClick={() => onNavigate('review')}
            />
            <StatCard
              label="In learning"
              value={stats.learning_count}
              hint="words in flight"
              action="Open words"
              onClick={() => onNavigate('words')}
            />
            <StatCard
              label="New this week"
              value={stats.new_words_last_7d}
              hint="words first met"
              action="Read more"
              onClick={() => onNavigate('library')}
            />
            <div className="card lv-stat">
              <div className="lv-stat-label">Reviews today</div>
              <div className="lv-stat-value serif">{stats.reviews_today}</div>
              <ActivityStrip days={stats.reviews_by_day} />
            </div>
          </div>

          {/* Vocabulary funnel. */}
          <div className="card" style={{ padding: '18px 20px', marginTop: 14 }}>
            <div className="lv-row-between">
              <div className="lv-section-title">Vocabulary funnel</div>
              <div className="small dim">
                {(stats.unknown_count + stats.learning_count + stats.known_count).toLocaleString()}{' '}
                words tracked
              </div>
            </div>
            <FunnelBar stats={stats} />
            <div className="lv-chips" style={{ marginTop: 10 }}>
              {funnelSegments(stats).map((seg) => (
                <button
                  key={seg.key}
                  type="button"
                  className="chip lv-chip-btn"
                  onClick={() => onNavigate('words')}
                >
                  <span className={`lv-swatch lv-${seg.key}`} />
                  {seg.key} · {seg.count.toLocaleString()}
                </button>
              ))}
              {stats.known_by_source.map((s) => (
                <span key={s.source} className="chip dim">
                  {sourceLabel(s.source)} {s.count.toLocaleString()}
                </span>
              ))}
            </div>
          </div>

          {/* Continue: next read + practice pool. */}
          <div className="lv-grid2" style={{ marginTop: 14 }}>
            <div className="card" style={{ padding: '18px 20px' }}>
              <div className="lv-section-title">Next read · i+1 sweet spot</div>
              {nextReads.length === 0 ? (
                <div className="small dim" style={{ marginTop: 8 }}>
                  Nothing unread in the library.{' '}
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onNavigate('library')}
                  >
                    Import material
                  </button>
                </div>
              ) : (
                nextReads.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="lv-read-row"
                    onClick={() => onOpenMaterial(r.id)}
                  >
                    <span className="lv-read-title">{r.title}</span>
                    <span className="mono small dim">
                      {(r.unknown_ratio * 100).toFixed(1)}% new · {r.total_tokens.toLocaleString()}{' '}
                      words
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="card" style={{ padding: '18px 20px' }}>
              <div className="lv-row-between">
                <div className="lv-section-title">Practice pool · lowest level first</div>
                <div className="row gap-12">
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onNavigate('story')}
                  >
                    Story
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => onNavigate('writing')}
                  >
                    Writing
                  </button>
                </div>
              </div>
              {practice.length === 0 ? (
                <div className="small dim" style={{ marginTop: 8 }}>
                  No recent words to drill — new words appear here after you read or look them up.
                </div>
              ) : (
                <div className="lv-chips" style={{ marginTop: 10 }}>
                  {practice.map((w) => (
                    <Tooltip key={w.id} title={`level ${w.level} · click for full trail`}>
                      <button
                        type="button"
                        className="chip lv-chip-btn"
                        onClick={() => onDrillLemma(w.lemma)}
                      >
                        {w.lemma}
                        <span className="lv-lvl">{w.level}</span>
                      </button>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Trail totals. */}
          <div className="lv-chips" style={{ marginTop: 14 }}>
            <span className="chip dim">{stats.documents_total} documents</span>
            <button type="button" className="chip lv-chip-btn" onClick={() => onNavigate('story')}>
              {stats.stories_total} stories
            </button>
            <button
              type="button"
              className="chip lv-chip-btn"
              onClick={() => onNavigate('writing')}
            >
              {stats.writing_total} writing submissions
            </button>
            <button
              type="button"
              className="chip lv-chip-btn"
              onClick={() => onNavigate('searches')}
            >
              {stats.lookups_total} dictionary lookups
            </button>
          </div>
        </>
      )}

      <style>{`
        .lv-grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        .lv-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 900px) {
          .lv-grid4 { grid-template-columns: repeat(2, 1fr); }
          .lv-grid2 { grid-template-columns: 1fr; }
        }
        .lv-stat { padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; }
        .lv-stat-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
        .lv-stat-value { font-size: 40px; line-height: 1; color: var(--ink); }
        .lv-stat-hint { font-size: 12px; color: var(--ink-3); }
        .lv-stat-action { margin-top: auto; align-self: flex-start; }
        .lv-section-title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
        .lv-row-between { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
        .lv-funnel { display: flex; height: 14px; border-radius: 999px; overflow: hidden; margin-top: 12px; background: var(--paper-3); }
        .lv-funnel-seg { height: 100%; min-width: 2px; }
        .lv-unknown { background: color-mix(in srgb, var(--accent) 28%, var(--paper-3)); }
        .lv-learning { background: color-mix(in srgb, var(--accent) 62%, var(--paper-3)); }
        .lv-known { background: var(--accent); }
        .lv-swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; }
        .lv-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        .lv-chip-btn { cursor: pointer; border: 1px solid var(--rule); background: var(--paper); }
        .lv-chip-btn:hover { border-color: var(--accent); }
        .lv-lvl {
          margin-left: 6px; font-size: 10px; font-family: var(--mono, monospace);
          background: var(--paper-3); border-radius: 999px; padding: 0 5px;
        }
        .lv-strip { display: flex; align-items: flex-end; gap: 2px; height: 28px; margin-top: 6px; }
        .lv-strip-bar { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 2px; opacity: 0.85; }
        .lv-strip-bar.empty { background: var(--paper-3); }
        .lv-read-row {
          display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
          width: 100%; text-align: left; padding: 10px 0; cursor: pointer;
          background: none; border: none; border-bottom: 1px solid var(--rule-soft);
        }
        .lv-read-row:last-child { border-bottom: none; }
        .lv-read-row:hover .lv-read-title { color: var(--accent); }
        .lv-read-title { font-weight: 600; font-size: 14px; color: var(--ink); }
      `}</style>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  action,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  action: string;
  accent?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="card lv-stat">
      <div className="lv-stat-label">{label}</div>
      <div className="lv-stat-value serif">{value.toLocaleString()}</div>
      <div className="lv-stat-hint">{hint}</div>
      <button
        type="button"
        className={`btn ${accent ? 'primary' : 'ghost'} sm lv-stat-action`}
        onClick={onClick}
      >
        {action}
      </button>
    </div>
  );
}

function FunnelBar({ stats }: { stats: LearningStatsIpc }) {
  return (
    <div className="lv-funnel">
      {funnelSegments(stats).map((seg) => (
        <Tooltip key={seg.key} title={`${seg.key}: ${seg.count.toLocaleString()}`}>
          <div className={`lv-funnel-seg lv-${seg.key}`} style={{ width: `${seg.pct}%` }} />
        </Tooltip>
      ))}
    </div>
  );
}

function ActivityStrip({ days }: { days: LearningStatsIpc['reviews_by_day'] }) {
  const max = Math.max(1, ...days.map((d) => d.reviews));
  return (
    <div className="lv-strip">
      {days.map((d) => (
        <Tooltip
          key={d.day_start_ms}
          title={`${new Date(d.day_start_ms).toLocaleDateString()} · ${d.reviews} review${d.reviews === 1 ? '' : 's'}`}
        >
          <div
            className={`lv-strip-bar${d.reviews === 0 ? 'empty' : ''}`}
            style={{ height: `${Math.max(7, (d.reviews / max) * 100)}%` }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'seed_freq':
      return 'seeded';
    case 'auto_exposure':
      return 'via reading';
    case 'srs':
      return 'via review';
    case 'manual':
      return 'marked';
    default:
      return source;
  }
}
