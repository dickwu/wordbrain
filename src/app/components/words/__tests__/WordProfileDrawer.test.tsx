import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { formatRelative, isDocumentKind, splitMaterials } from '../WordProfileDrawer';
import type { MaterialForWord } from '@/app/lib/ipc';

function mat(overrides: Partial<MaterialForWord>): MaterialForWord {
  return {
    material_id: 1,
    title: 'Doc',
    source_kind: 'paste',
    created_at: Date.now(),
    read_at: null,
    occurrence_count: 1,
    first_position: 0,
    sentence_preview: 'A sentence.',
    ...overrides,
  };
}

const PROFILE_FIXTURE = {
  word_id: 7,
  lemma: 'serendipity',
  state: 'learning',
  state_source: 'srs',
  freq_rank: 12345,
  exposure_count: 4,
  usage_count: 2,
  level: 2,
  first_seen_at: Date.now() - 3 * 86_400_000,
  marked_known_at: null,
  user_note: 'lucky accident',
  srs: {
    stability: 2.5,
    difficulty: 5.1,
    scheduled_days: 2,
    reps: 3,
    lapses: 1,
    last_review: Date.now() - 86_400_000,
    due: Date.now() + 86_400_000,
  },
  recent_reviews: [
    { rating: 3, reviewed_at: Date.now() - 86_400_000, prev_stability: 1.2, new_stability: 2.5 },
    {
      rating: 1,
      reviewed_at: Date.now() - 2 * 86_400_000,
      prev_stability: 2.0,
      new_stability: 1.2,
    },
  ],
  lookup: {
    lookup_count: 5,
    first_looked_up_at: Date.now() - 4 * 86_400_000,
    last_looked_up_at: Date.now() - 3_600_000,
  },
  story_uses: 2,
  writing_uses: 1,
  materials: [
    mat({ material_id: 11, title: 'Reef Essay', source_kind: 'paste' }),
    mat({ material_id: 12, title: 'Night Story', source_kind: 'ai_story' }),
    mat({ material_id: 13, title: 'My sentence', source_kind: 'writing_submission' }),
  ],
};

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'word_profile') return PROFILE_FIXTURE;
    throw new Error(`unexpected cmd ${cmd}`);
  });
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

async function renderDrawer() {
  const { WordProfileDrawer } = await import('../WordProfileDrawer');
  const onOpenMaterial = vi.fn<(m: MaterialForWord) => void>();
  const onLookup = vi.fn<(l: string) => void>();
  const utils = render(
    <ConfigProvider>
      <AntApp>
        <WordProfileDrawer
          lemma="serendipity"
          onClose={() => {}}
          onOpenMaterial={onOpenMaterial}
          onLookup={onLookup}
        />
      </AntApp>
    </ConfigProvider>
  );
  await waitFor(() => expect(screen.getByText('Memory')).toBeDefined());
  return { ...utils, onOpenMaterial, onLookup };
}

describe('splitMaterials', () => {
  it('buckets docs, stories and writing submissions', () => {
    const groups = splitMaterials([
      mat({ source_kind: 'paste' }),
      mat({ source_kind: 'epub_chapter' }),
      mat({ source_kind: 'ai_story' }),
      mat({ source_kind: 'writing_submission' }),
    ]);
    expect(groups.docs).toHaveLength(2);
    expect(groups.stories).toHaveLength(1);
    expect(groups.writing).toHaveLength(1);
  });

  it('treats every reader kind as a document', () => {
    for (const kind of ['paste', 'file', 'url', 'epub', 'epub_chapter']) {
      expect(isDocumentKind(kind)).toBe(true);
    }
    expect(isDocumentKind('ai_story')).toBe(false);
    expect(isDocumentKind('writing_submission')).toBe(false);
  });
});

describe('formatRelative', () => {
  const now = 100 * 86_400_000;
  it('renders past and future compactly', () => {
    expect(formatRelative(now - 30_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatRelative(now + 2 * 86_400_000, now)).toBe('in 2d');
  });
});

describe('WordProfileDrawer', () => {
  it('renders the full learning trail for a word', async () => {
    await renderDrawer();
    // Header + note.
    expect(screen.getByText('serendipity')).toBeDefined();
    expect(screen.getByText('learning')).toBeDefined();
    expect(screen.getByText('“lucky accident”')).toBeDefined();
    // Memory section with review history.
    expect(screen.getByText('reps 3')).toBeDefined();
    expect(screen.getByText('Good')).toBeDefined();
    expect(screen.getByText('Again')).toBeDefined();
    // Encounters + practice trail.
    expect(screen.getByText(/Where you met it · 1/)).toBeDefined();
    expect(screen.getByText('Reef Essay')).toBeDefined();
    expect(screen.getByText(/Practice trail · 2/)).toBeDefined();
    expect(screen.getByText('Night Story')).toBeDefined();
    // Trail footer.
    expect(screen.getByText(/looked up 5×/)).toBeDefined();
    expect(screen.getByText('story uses 2')).toBeDefined();
  });

  it('routes material clicks with their source kind', async () => {
    const { onOpenMaterial } = await renderDrawer();
    fireEvent.click(screen.getByText('Night Story'));
    expect(onOpenMaterial).toHaveBeenCalledTimes(1);
    expect(onOpenMaterial.mock.calls[0][0].source_kind).toBe('ai_story');
    expect(onOpenMaterial.mock.calls[0][0].material_id).toBe(12);
  });

  it('opens the dictionary from the actions row', async () => {
    const { onLookup } = await renderDrawer();
    fireEvent.click(screen.getByText('Dictionary'));
    expect(onLookup).toHaveBeenCalledWith('serendipity');
  });
});
