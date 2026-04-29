'use client';

import { useEffect, useState } from 'react';
import { Empty } from 'antd';
import { Icons } from '@/app/components/shell/Icons';
import {
  clearLookupHistoryPersisted,
  loadLookupHistoryPersisted,
  removeLookupHistoryWordPersisted,
  subscribeLookupHistory,
} from '@/app/lib/lookup-history';

interface SearchHistoryViewProps {
  onSearch: (word: string) => void;
}

/**
 * Dictionary lookup log — grouped (Today / Yesterday / Earlier) with the
 * editorial rule + serif word and a `mono` time hint per row. The actual
 * history is just an ordered array of recent strings (no timestamps), so we
 * bucket arbitrarily but consistently: first 5 → Today, next 2 → Yesterday,
 * remainder → Earlier. Mirrors the design's intent without inventing fake
 * timestamps.
 */
export function SearchHistoryView({ onSearch }: SearchHistoryViewProps) {
  const [history, setHistory] = useState<string[]>([]);
  const [filter, setFilter] = useState('');

  const refresh = () => {
    void loadLookupHistoryPersisted().then(setHistory);
  };

  useEffect(() => {
    refresh();
    return subscribeLookupHistory(refresh);
  }, []);

  const filtered = filter.trim()
    ? history.filter((w) => w.toLowerCase().includes(filter.toLowerCase().trim()))
    : history;

  const groups: ReadonlyArray<{ day: string; items: string[] }> = [
    { day: 'Today', items: filtered.slice(0, 5) },
    { day: 'Yesterday', items: filtered.slice(5, 7) },
    { day: 'Earlier', items: filtered.slice(7) },
  ];

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Dictionary log · {history.length} entries</div>
          <h1 className="page-title">
            Searches<em>.</em>
          </h1>
          <p className="page-sub">
            Every word you&rsquo;ve looked up, in order. Click to repeat the lookup.
          </p>
        </div>
        <div style={{ width: 280 }}>
          <input
            className="input"
            placeholder="Filter searches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {history.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No searched words yet." />
      ) : filtered.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing matches that filter." />
      ) : (
        groups.map((group, gi) =>
          group.items.length === 0 ? null : (
            <div key={gi} className="srch-group">
              <div className="srch-day">
                <span className="page-eyebrow" style={{ margin: 0 }}>
                  {group.day}
                </span>
                <span className="srch-rule" />
                <span className="small dim mono">{group.items.length}</span>
              </div>
              {group.items.map((word, i) => (
                <div
                  key={`${word}-${i}`}
                  className="srch-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onSearch(word)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSearch(word);
                  }}
                >
                  <div className="srch-time mono small dim">recent</div>
                  <div>
                    <span className="serif srch-word">{word}</span>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    aria-label={`Remove ${word}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeLookupHistoryWordPersisted(word).then(setHistory);
                    }}
                    style={{ padding: 4 }}
                  >
                    <Icons.X size={11} />
                  </button>
                  <Icons.ChevR size={12} />
                </div>
              ))}
            </div>
          )
        )
      )}

      {history.length > 0 && (
        <div className="row" style={{ marginTop: 24, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => {
              void clearLookupHistoryPersisted().then(() => setHistory([]));
            }}
            style={{ color: 'var(--outside-line)' }}
          >
            Clear history
          </button>
        </div>
      )}

      <style>{`
        .srch-group { margin-bottom: 32px; }
        .srch-day { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .srch-rule { flex: 1; height: 1px; background: var(--rule); }
        .srch-row {
          display: grid; grid-template-columns: 100px 1fr 28px 20px;
          gap: 16px; padding: 12px 14px; align-items: center;
          border-bottom: 1px solid var(--rule-soft); cursor: pointer;
        }
        .srch-row:hover { background: var(--paper-2); }
        .srch-word { font-size: 18px; font-weight: 500; color: var(--ink); letter-spacing: -0.01em; }
      `}</style>
    </div>
  );
}
