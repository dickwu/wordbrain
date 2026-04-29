import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

vi.mock('@/app/lib/dict', () => ({
  listRemoteDictionaries: vi.fn(async () => []),
  lookupRemoteDictionary: vi.fn(),
}));

vi.mock('@/app/lib/ipc', () => ({
  isTauri: () => true,
  addToSrs: vi.fn(),
  isInSrs: vi.fn(),
  countDueSrs: vi.fn(async () => 0),
  getAllKnownLemmas: vi.fn(async () => []),
  getAllKnownNames: vi.fn(async () => []),
  markKnownIpc: vi.fn(async () => {}),
  markKnownNameIpc: vi.fn(async () => {}),
  unmarkKnownIpc: vi.fn(async () => {}),
}));

import { isInSrs } from '@/app/lib/ipc';
import { buildDictionaryFrameSrcDoc, WordLookupModal } from '../WordLookupModal';

function renderModal(initialQuery = 'automatic') {
  return render(
    <ConfigProvider>
      <AntApp>
        <WordLookupModal visible initialQuery={initialQuery} onClose={() => {}} />
      </AntApp>
    </ConfigProvider>
  );
}

describe('WordLookupModal SRS controls', () => {
  beforeEach(() => {
    vi.mocked(isInSrs).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows Add to SRS when the word is not scheduled', async () => {
    vi.mocked(isInSrs).mockResolvedValue(false);

    renderModal();

    await waitFor(() => expect(isInSrs).toHaveBeenCalledWith('automatic'));
    expect(await screen.findByRole('button', { name: /add to srs/i })).toBeDefined();
  });

  it('hides Add to SRS when the word is already scheduled', async () => {
    vi.mocked(isInSrs).mockResolvedValue(true);

    renderModal();

    await waitFor(() => expect(isInSrs).toHaveBeenCalledWith('automatic'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /add to srs/i })).toBeNull();
    });
  });
});

describe('buildDictionaryFrameSrcDoc', () => {
  it('injects a dictionary API base URL before linked resources', () => {
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="/static/dict.css"></head><body></body></html>';

    expect(buildDictionaryFrameSrcDoc(html, 'https://dict.example.test')).toContain(
      '<head><base href="https://dict.example.test/"><link'
    );
  });

  it('wraps fragments so relative resources do not resolve against the packaged app', () => {
    expect(
      buildDictionaryFrameSrcDoc('<img src="audio/speaker.svg">', 'https://dict.example.test/api')
    ).toBe(
      '<!doctype html><html><head><base href="https://dict.example.test/api/"></head><body><img src="audio/speaker.svg"></body></html>'
    );
  });

  it('keeps API-provided base tags intact', () => {
    const html =
      '<html><head><base href="https://cdn.example.test/"><link href="dict.css"></head></html>';

    expect(buildDictionaryFrameSrcDoc(html, 'https://dict.example.test')).toBe(html);
  });
});
