import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { lookupRemoteDictionary } from '@/app/lib/dict';
import { buildDictionaryFrameSrcDoc, WordLookupModal } from '../WordLookupModal';

// Comfortably longer than the modal's AUTO_SEARCH_DEBOUNCE_MS (450ms) so a
// negative assertion can be sure the debounced lookup would have fired by now.
const AUTO_SEARCH_SETTLE_MS = 700;

function renderModal(initialQuery = 'automatic', extraProps = {}) {
  return render(
    <ConfigProvider>
      <AntApp>
        <WordLookupModal visible initialQuery={initialQuery} onClose={() => {}} {...extraProps} />
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

describe('WordLookupModal auto-search', () => {
  beforeEach(() => {
    vi.mocked(isInSrs).mockResolvedValue(false);
    vi.mocked(lookupRemoteDictionary).mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('fires the lookup automatically a beat after the user types', async () => {
    renderModal('', { autoSearch: false });

    fireEvent.change(screen.getByPlaceholderText('Look up a word'), {
      target: { value: 'serendipity' },
    });

    await waitFor(
      () => expect(lookupRemoteDictionary).toHaveBeenCalledWith('serendipity', expect.anything()),
      { timeout: 2000 }
    );
    expect(lookupRemoteDictionary).toHaveBeenCalledTimes(1);
  });

  it('does not auto-search the initial query when autoSearch is off', async () => {
    renderModal('automatic');

    // Let the isInSrs effect settle, then give the debounce window time to (not) fire.
    await waitFor(() => expect(isInSrs).toHaveBeenCalledWith('automatic'));
    await new Promise((resolve) => setTimeout(resolve, AUTO_SEARCH_SETTLE_MS));

    expect(lookupRemoteDictionary).not.toHaveBeenCalled();
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
