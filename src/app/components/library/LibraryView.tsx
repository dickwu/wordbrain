'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Alert, App as AntApp, Empty, Popconfirm, Spin } from 'antd';
import { Icons } from '@/app/components/shell/Icons';
import {
  deleteStory,
  isTauri,
  listMaterials,
  recommendNext,
  type MaterialSummary,
  type RecommendedMaterial,
} from '@/app/lib/ipc';
import { estimateReadingMinutes } from '@/app/lib/material-builder';

interface LibraryViewProps {
  /** Bumped whenever the caller wants the list refetched. */
  refreshKey?: number;
  /** Fired when a row is picked; parent typically loads it into the reader. */
  onOpen?: (m: MaterialSummary) => void;
}

type FilterKey = 'all' | 'sweet' | 'easy' | 'hard';
const FILTER_TABS: ReadonlyArray<[FilterKey, string]> = [
  ['all', 'All'],
  ['sweet', 'i+1 sweet spot'],
  ['easy', 'Comfortable'],
  ['hard', 'Stretch'],
];
type SortKey = 'recent' | 'unknown' | 'length' | 'title';

export function LibraryView({ refreshKey = 0, onOpen }: LibraryViewProps) {
  const { message } = AntApp.useApp();
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [recs, setRecs] = useState<RecommendedMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sort, setSort] = useState<SortKey>('recent');

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setLoading(false);
      setError('Library requires the Tauri shell — run `bun run tauri dev`.');
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    Promise.all([listMaterials(), recommendNext(0.035, 5).catch(() => [] as RecommendedMaterial[])])
      .then(([mats, next]) => {
        if (cancelled) return;
        setMaterials(mats);
        setRecs(next);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const topPick = recs[0];
  const topPickRow = useMemo(
    () => (topPick ? materials.find((m) => m.id === topPick.id) : undefined),
    [materials, topPick]
  );
  const sweetCount = useMemo(
    () => materials.filter((m) => inSweetSpot(unknownRatioOf(m))).length,
    [materials]
  );

  const rest = useMemo(
    () => (topPickRow ? materials.filter((m) => m.id !== topPickRow.id) : materials),
    [materials, topPickRow]
  );

  const filtered = useMemo(() => {
    const base = rest.filter((m) => {
      const r = unknownRatioOf(m);
      if (filter === 'sweet') return inSweetSpot(r);
      if (filter === 'easy') return r < 0.02;
      if (filter === 'hard') return r > 0.05;
      return true;
    });
    const sorted = [...base];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'unknown':
          return unknownRatioOf(b) - unknownRatioOf(a);
        case 'length':
          return b.total_tokens - a.total_tokens;
        case 'title':
          return a.title.localeCompare(b.title);
        case 'recent':
        default: {
          const ax = a.read_at ?? 0;
          const bx = b.read_at ?? 0;
          return bx - ax;
        }
      }
    });
    return sorted;
  }, [rest, filter, sort]);

  const onDeleteAiStory = useCallback(
    async (m: MaterialSummary) => {
      setDeletingId(m.id);
      try {
        const deleted = await deleteStory(m.id);
        if (!deleted) message.warning('That story is already gone.');
        else message.success('Story deleted.');
        setMaterials((prev) => prev.filter((item) => item.id !== m.id));
        setRecs((prev) => prev.filter((item) => item.id !== m.id));
      } catch (err) {
        message.error(`delete_story failed: ${err}`);
      } finally {
        setDeletingId(null);
      }
    },
    [message]
  );

  if (loading) {
    return (
      <div className="page wide" style={{ textAlign: 'center', padding: 80 }}>
        <Spin />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page wide">
        <Alert type="warning" message={error} showIcon style={{ marginBottom: 12 }} />
      </div>
    );
  }
  if (materials.length === 0) {
    return (
      <div className="page wide">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Your shelf</div>
            <h1 className="page-title">Library</h1>
            <p className="page-sub">Nothing here yet. Paste some text or open a file to seed it.</p>
          </div>
        </div>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No materials saved yet." />
      </div>
    );
  }

  return (
    <div className="page wide">
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Your shelf</div>
          <h1 className="page-title">Library</h1>
          <p className="page-sub">
            {materials.length} material{materials.length === 1 ? '' : 's'}
            {sweetCount > 0
              ? ` · ${sweetCount} sit${sweetCount === 1 ? 's' : ''} in the i+1 sweet spot today.`
              : '.'}
          </p>
        </div>
      </div>

      {topPick && topPickRow && (
        <RecommendCard
          material={topPickRow}
          ratio={topPick.unknown_ratio}
          onOpen={() => onOpen?.(topPickRow)}
        />
      )}

      <div className="lib-controls">
        <div className="row gap-4">
          {FILTER_TABS.map(([k, l]) => (
            <button
              key={k}
              type="button"
              className={'tab' + (filter === k ? ' active' : '')}
              onClick={() => setFilter(k)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="grow" />
        <div className="row gap-8">
          <span className="small dim">Sort by</span>
          <select
            className="input"
            style={{ width: 160, padding: '6px 10px' }}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="recent">Last opened</option>
            <option value="unknown">Unknown ratio</option>
            <option value="length">Length</option>
            <option value="title">Title</option>
          </select>
        </div>
      </div>

      <div className="lib-table">
        <div className="lib-row lib-head">
          <div>Title</div>
          <div>Unknown</div>
          <div>Length</div>
          <div>Last opened</div>
          <div />
        </div>
        <Virtuoso
          style={{ height: Math.min(640, Math.max(240, filtered.length * 64 + 16)) }}
          data={filtered}
          itemContent={(_, m) => (
            <LibraryRow
              material={m}
              deleting={deletingId === m.id}
              onOpen={onOpen}
              onDeleteAiStory={onDeleteAiStory}
            />
          )}
        />
      </div>

      <RecommendStyles />
    </div>
  );
}

function RecommendCard({
  material,
  ratio,
  onOpen,
}: {
  material: MaterialSummary;
  ratio: number;
  onOpen: () => void;
}) {
  const pct = (ratio * 100).toFixed(1);
  const sweet = inSweetSpot(ratio);
  const minutes = estimateReadingMinutes(material.total_tokens);
  return (
    <div className="lib-recommend">
      <div className="rec-eyebrow">
        <Icons.Bolt size={12} />
        <span>Krashen i+1 — next up</span>
      </div>
      <div className="rec-grid">
        <div>
          <h2 className="rec-title">{material.title}</h2>
          <div className="rec-source">{sourceLabel(material)}</div>
          <p className="serif rec-blurb">
            Hovering near the upper edge of what you already know — dense enough to teach, gentle
            enough to keep you turning pages.
          </p>
          <div className="row gap-12" style={{ marginTop: 18, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" onClick={onOpen}>
              <Icons.Reader size={13} /> Open reader
            </button>
            <span className={'chip ' + (sweet ? 'sweet' : 'outside')}>
              <span className="dot" /> {pct}% unknown ·{' '}
              {sweet ? 'in sweet spot' : 'outside sweet spot'}
            </span>
            <span className="chip">
              <Icons.Clock size={11} /> ~{minutes} min
            </span>
          </div>
        </div>
        <div className="rec-stats">
          <div>
            <div className="num serif tabular">{material.total_tokens.toLocaleString()}</div>
            <div className="lbl">tokens</div>
          </div>
          <div>
            <div className="num serif tabular">{material.unique_tokens.toLocaleString()}</div>
            <div className="lbl">unique</div>
          </div>
          <div>
            <div className="num serif tabular">
              {pct}
              <span className="dim small"> %</span>
            </div>
            <div className="lbl">unknown</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LibraryRow({
  material: m,
  deleting,
  onOpen,
  onDeleteAiStory,
}: {
  material: MaterialSummary;
  deleting: boolean;
  onOpen?: (m: MaterialSummary) => void;
  onDeleteAiStory?: (m: MaterialSummary) => void;
}) {
  const ratio = unknownRatioOf(m);
  const ratioPct = (ratio * 100).toFixed(1);
  const est = estimateReadingMinutes(m.total_tokens);
  const lastRead = m.read_at ? relativeTime(new Date(m.read_at)) : 'never';
  const sweet = inSweetSpot(ratio);

  return (
    <div
      className="lib-row"
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(m)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen?.(m);
      }}
    >
      <div style={{ overflow: 'hidden' }}>
        <div className="serif lib-title">{m.title}</div>
        <div className="small dim">{sourceLabel(m)}</div>
      </div>
      <div>
        <span className={'chip ' + (sweet ? 'sweet' : ratio > 0.05 ? 'outside' : '')}>
          <span className="dot" /> {ratioPct}%
        </span>
      </div>
      <div className="tabular small">
        <div>{m.total_tokens.toLocaleString()} tokens</div>
        <div className="dim">~{est} min</div>
      </div>
      <div className="small dim">{lastRead}</div>
      <div style={{ textAlign: 'right' }}>
        {m.source_kind === 'ai_story' ? (
          <Popconfirm
            title="Delete this story?"
            description="It will be removed from Story history and Library."
            okText="Delete"
            cancelText="Cancel"
            okType="danger"
            onConfirm={(e) => {
              e?.stopPropagation();
              onDeleteAiStory?.(m);
            }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Delete ${m.title}`}
              disabled={deleting}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              style={{ color: 'var(--outside-line)' }}
            >
              <Icons.X size={12} />
            </button>
          </Popconfirm>
        ) : (
          <Icons.ChevR size={14} />
        )}
      </div>
    </div>
  );
}

function unknownRatioOf(m: MaterialSummary): number {
  return m.unique_tokens > 0 ? m.unknown_count / m.unique_tokens : 0;
}

function inSweetSpot(ratio: number): boolean {
  return ratio >= 0.02 && ratio <= 0.05;
}

function sourceLabel(m: MaterialSummary): string {
  const kind = m.source_kind ? m.source_kind.replace(/_/g, ' ') : 'note';
  return `${kind} · ${m.unique_tokens.toLocaleString()} unique`;
}

function relativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const day = 86_400_000;
  if (ms < day) return 'today';
  if (ms < day * 2) return 'yesterday';
  if (ms < day * 14) return `${Math.floor(ms / day)} days ago`;
  if (ms < day * 60) return `${Math.floor(ms / (day * 7))} weeks ago`;
  return `${Math.floor(ms / (day * 30))} months ago`;
}

function RecommendStyles() {
  return (
    <style>{`
      .lib-recommend {
        background: linear-gradient(135deg, var(--accent-bg), var(--paper-2));
        border: 1px solid var(--rule);
        border-radius: var(--radius-lg);
        padding: 28px 32px;
        margin-bottom: 28px;
      }
      .rec-eyebrow {
        display: inline-flex; align-items: center; gap: 6px;
        font: 600 10px/1 var(--sans); letter-spacing: .18em;
        text-transform: uppercase; color: var(--accent); margin-bottom: 14px;
      }
      .rec-grid { display: grid; grid-template-columns: 1fr 280px; gap: 32px; align-items: start; }
      @media (max-width: 900px) { .rec-grid { grid-template-columns: 1fr; } }
      .rec-title { font-family: var(--serif); font-weight: 500; font-size: 36px; line-height: 1.05; margin: 0; letter-spacing: -0.02em; color: var(--ink); }
      .rec-source { font-family: var(--serif); font-style: italic; color: var(--ink-3); font-size: 14px; margin-top: 6px; }
      .rec-blurb { color: var(--ink-2); font-size: 16px; line-height: 1.55; margin: 16px 0 0; }
      .rec-stats {
        display: grid; grid-template-rows: 1fr 1fr 1fr; gap: 14px;
        padding: 16px 20px; background: var(--paper); border: 1px solid var(--rule); border-radius: var(--radius);
      }
      .rec-stats .num { font-size: 24px; line-height:1; letter-spacing:-0.01em; }
      .rec-stats .lbl { font-size: 10px; color: var(--ink-4); text-transform: uppercase; letter-spacing: .1em; margin-top: 4px; }
      .lib-controls { display: flex; align-items: center; gap: 16px; padding: 0 4px; margin-bottom: 12px; }
      .lib-table { border: 1px solid var(--rule); border-radius: var(--radius); overflow: hidden; background: var(--paper); }
      .lib-row {
        display: grid;
        grid-template-columns: 2.6fr 1fr 1fr 1fr 30px;
        gap: 18px;
        padding: 14px 20px;
        align-items: center;
        border-bottom: 1px solid var(--rule-soft);
        cursor: pointer;
        transition: background .1s;
      }
      .lib-row:last-child { border-bottom: 0; }
      .lib-row:hover:not(.lib-head) { background: var(--paper-2); }
      .lib-head { font: 600 10px/1 var(--sans); letter-spacing:.12em; text-transform: uppercase; color: var(--ink-4); cursor: default; background: var(--paper-2); }
      .lib-head:hover { background: var(--paper-2); }
      .lib-title { font-size: 17px; font-weight: 500; color: var(--ink); letter-spacing:-0.01em; }
    `}</style>
  );
}
