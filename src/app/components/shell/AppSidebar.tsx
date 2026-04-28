'use client';

import { Tooltip } from 'antd';
import { Icons } from '@/app/components/shell/Icons';
import { useEffectiveTheme, useThemeStore } from '@/app/stores/themeStore';

export type ViewId =
  | 'library'
  | 'reader'
  | 'review'
  | 'story'
  | 'writing'
  | 'words'
  | 'network'
  | 'searches'
  | 'settings';

const NAV: Array<{
  id: ViewId;
  label: string;
  icon: keyof typeof Icons;
  badgeKey?: 'due' | 'storyUnread';
  group: 'Read' | 'Practice' | 'Vocabulary' | 'App';
}> = [
  { id: 'library', label: 'Library', icon: 'Library', group: 'Read' },
  { id: 'reader', label: 'Reader', icon: 'Reader', group: 'Read' },
  { id: 'review', label: 'Review', icon: 'Review', badgeKey: 'due', group: 'Practice' },
  { id: 'story', label: 'Story', icon: 'Story', badgeKey: 'storyUnread', group: 'Practice' },
  { id: 'writing', label: 'Writing', icon: 'Writing', group: 'Practice' },
  { id: 'words', label: 'Words', icon: 'Words', group: 'Vocabulary' },
  { id: 'network', label: 'Network', icon: 'Network', group: 'Vocabulary' },
  { id: 'searches', label: 'Searches', icon: 'History', group: 'Vocabulary' },
  { id: 'settings', label: 'Settings', icon: 'Settings', group: 'App' },
];

const GROUP_ORDER: Array<NonNullable<(typeof NAV)[number]['group']>> = [
  'Read',
  'Practice',
  'Vocabulary',
  'App',
];

interface SidebarProps {
  view: ViewId;
  onChange: (v: ViewId) => void;
  knownCount: number;
  dueCount: number;
  storyUnread: number;
  hydrated: boolean;
  appVersion: string;
  writingHint?: string | null;
}

export function AppSidebar({
  view,
  onChange,
  knownCount,
  dueCount,
  storyUnread,
  hydrated,
  appVersion,
  writingHint,
}: SidebarProps) {
  const effective = useEffectiveTheme();
  const toggleTheme = useThemeStore((s) => s.toggleMode);

  const badgeFor = (k?: 'due' | 'storyUnread') => {
    if (k === 'due') return dueCount;
    if (k === 'storyUnread') return storyUnread;
    return undefined;
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="mark">
          Word<em>brain</em>
        </div>
        <div className="ver">v{appVersion}</div>
        <div style={{ flex: 1 }} />
        <Tooltip title={`Switch to ${effective === 'dark' ? 'light' : 'dark'} theme`}>
          <button
            type="button"
            className="btn ghost sm"
            onClick={toggleTheme}
            aria-label="Toggle theme"
            style={{ padding: 4 }}
          >
            {effective === 'dark' ? <Icons.Sun size={14} /> : <Icons.Moon size={14} />}
          </button>
        </Tooltip>
      </div>

      {GROUP_ORDER.map((g) => {
        const items = NAV.filter((n) => n.group === g);
        if (items.length === 0) return null;
        return (
          <div key={g}>
            <div className="nav-section">{g}</div>
            {items.map((n) => {
              const Icon = Icons[n.icon];
              const badge = badgeFor(n.badgeKey);
              const node = (
                <button
                  key={n.id}
                  type="button"
                  className={'nav-item' + (view === n.id ? ' active' : '')}
                  onClick={() => onChange(n.id)}
                >
                  <Icon size={15} />
                  <span className="label">{n.label}</span>
                  {badge !== undefined && badge > 0 && <span className="badge">{badge}</span>}
                </button>
              );
              if (n.id === 'writing' && writingHint) {
                return (
                  <Tooltip key={n.id} placement="right" title={writingHint}>
                    <span style={{ display: 'block' }}>{node}</span>
                  </Tooltip>
                );
              }
              return node;
            })}
          </div>
        );
      })}

      <div className="stats">
        <button type="button" className="stat" onClick={() => onChange('words')}>
          <div className="num tabular">{knownCount.toLocaleString()}</div>
          <div className="lbl">Known</div>
        </button>
        <button type="button" className="stat" onClick={() => onChange('review')}>
          <div className="num tabular">{dueCount}</div>
          <div className="lbl">Due today</div>
        </button>
        {!hydrated && (
          <div
            className="small dim"
            style={{ gridColumn: '1 / -1', marginTop: -4, fontStyle: 'italic' }}
          >
            using Phase-1 fallback seed
          </div>
        )}
      </div>
    </aside>
  );
}
