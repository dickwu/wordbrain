import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';
import { WordsTable } from '../WordsTable';
import { levelFromUsage, type WordRecord } from '@/app/lib/words/types';

function rec(overrides: Partial<WordRecord>): WordRecord {
  return {
    id: 1,
    lemma: 'alpha',
    state: 'learning',
    stateSource: 'manual',
    freqRank: 100,
    exposureCount: 0,
    usageCount: 0,
    markedKnownAt: null,
    userNote: null,
    materialCount: 0,
    ...overrides,
  };
}

function renderTable(rows: WordRecord[]) {
  return render(
    <ConfigProvider>
      <AntApp>
        <WordsTable
          rows={rows}
          loading={false}
          selection={new Set()}
          onSelectionChange={() => {}}
          onUnmark={() => {}}
          onStateChange={() => {}}
          onNoteSave={() => {}}
        />
      </AntApp>
    </ConfigProvider>
  );
}

describe('levelFromUsage', () => {
  it('caps at 10', () => {
    expect(levelFromUsage(25)).toBe(10);
    expect(levelFromUsage(10)).toBe(10);
    expect(levelFromUsage(11)).toBe(10);
  });
  it('floors negatives + non-finite to 0', () => {
    expect(levelFromUsage(-1)).toBe(0);
    expect(levelFromUsage(NaN)).toBe(0);
    expect(levelFromUsage(Infinity)).toBe(0);
  });
  it('passes through 0..9 unchanged', () => {
    for (let i = 0; i < 10; i++) expect(levelFromUsage(i)).toBe(i);
  });
});

describe('WordsTable Level column', () => {
  it('renders a Level header', () => {
    renderTable([rec({ usageCount: 3 })]);
    expect(screen.getByText('Level')).toBeDefined();
  });

  it('renders MIN(10, usageCount) in the Level cell', () => {
    renderTable([
      rec({ id: 1, lemma: 'alpha', usageCount: 0 }),
      rec({ id: 2, lemma: 'bravo', usageCount: 7 }),
      rec({ id: 3, lemma: 'charlie', usageCount: 25 }),
    ]);
    // AntD Tag renders the level number as visible text, with aria-label
    // e.g. "level 7" — assert the chip values exist for each row.
    expect(screen.getByLabelText('level 0')).toBeDefined();
    expect(screen.getByLabelText('level 7')).toBeDefined();
    expect(screen.getByLabelText('level 10')).toBeDefined();
  });
});
