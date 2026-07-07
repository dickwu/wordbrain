import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { funnelSegments } from '../LearningView';

const STATS_FIXTURE = {
  unknown_count: 40,
  learning_count: 10,
  known_count: 50,
  known_by_source: [{ source: 'seed_freq', count: 45 }],
  due_now: 3,
  scheduled_total: 12,
  reviews_by_day: Array.from({ length: 14 }, (_, i) => ({
    day_start_ms: i * 86_400_000,
    reviews: i === 13 ? 5 : 0,
  })),
  reviews_today: 5,
  new_words_last_7d: 7,
  lookups_total: 21,
  documents_total: 4,
  stories_total: 2,
  writing_total: 1,
};

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'learning_stats') return STATS_FIXTURE;
    if (cmd === 'recommend_next') {
      return [
        {
          id: 9,
          title: 'The Reef Essay',
          total_tokens: 900,
          unique_tokens: 300,
          unknown_count: 11,
          unknown_ratio: 0.036,
          score: 0.001,
          created_at: 0,
        },
      ];
    }
    if (cmd === 'recent_practice_words') {
      return [
        { id: 1, lemma: 'alpha', usageCount: 0, level: 0, firstSeenAt: 0, state: 'learning' },
        { id: 2, lemma: 'bravo', usageCount: 2, level: 2, firstSeenAt: 0, state: 'learning' },
      ];
    }
    throw new Error(`unexpected cmd ${cmd}`);
  });
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

async function renderHub(overrides?: {
  onNavigate?: (v: string) => void;
  onOpenMaterial?: (id: number) => void;
  onDrillLemma?: (l: string) => void;
}) {
  const { LearningView } = await import('../LearningView');
  const onNavigate = overrides?.onNavigate ?? vi.fn();
  const onOpenMaterial = overrides?.onOpenMaterial ?? vi.fn();
  const onDrillLemma = overrides?.onDrillLemma ?? vi.fn();
  const utils = render(
    <ConfigProvider>
      <AntApp>
        <LearningView
          onNavigate={onNavigate as never}
          onOpenMaterial={onOpenMaterial}
          onDrillLemma={onDrillLemma}
        />
      </AntApp>
    </ConfigProvider>
  );
  await waitFor(() => expect(screen.getByText('Due now')).toBeDefined());
  return { ...utils, onNavigate, onOpenMaterial, onDrillLemma };
}

describe('funnelSegments', () => {
  it('splits counts into percentages that sum to 100', () => {
    const segs = funnelSegments({ unknown_count: 40, learning_count: 10, known_count: 50 });
    expect(segs.map((s) => s.key)).toEqual(['unknown', 'learning', 'known']);
    expect(segs.map((s) => s.pct)).toEqual([40, 10, 50]);
    expect(segs.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(100);
  });

  it('handles an empty vocabulary without dividing by zero', () => {
    const segs = funnelSegments({ unknown_count: 0, learning_count: 0, known_count: 0 });
    expect(segs.every((s) => s.pct === 0)).toBe(true);
  });
});

describe('LearningView hub', () => {
  it('renders today stats, funnel counts and trail totals from learning_stats', async () => {
    await renderHub();
    expect(screen.getByText('3')).toBeDefined(); // due now
    expect(screen.getByText('12 scheduled')).toBeDefined();
    expect(screen.getByText(/unknown · 40/)).toBeDefined();
    expect(screen.getByText(/learning · 10/)).toBeDefined();
    expect(screen.getByText(/known · 50/)).toBeDefined();
    expect(screen.getByText('100 words tracked')).toBeDefined();
    expect(screen.getByText('21 dictionary lookups')).toBeDefined();
  });

  it('starts a review from the due card', async () => {
    const { onNavigate } = await renderHub();
    fireEvent.click(screen.getByText('Start review'));
    expect(onNavigate).toHaveBeenCalledWith('review');
  });

  it('opens the recommended next read in the reader', async () => {
    const { onOpenMaterial } = await renderHub();
    fireEvent.click(screen.getByText('The Reef Essay'));
    expect(onOpenMaterial).toHaveBeenCalledWith(9);
  });

  it('drills a practice word into its profile', async () => {
    const { onDrillLemma } = await renderHub();
    fireEvent.click(screen.getByText('alpha'));
    expect(onDrillLemma).toHaveBeenCalledWith('alpha');
  });
});
