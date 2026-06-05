import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import type { DictionaryLookupEntry } from '@/app/lib/dict';
import { DictionaryEntryFrame } from '../DictionaryEntryFrame';

function makeEntry(overrides: Partial<DictionaryLookupEntry> = {}): DictionaryLookupEntry {
  return {
    dictionary_id: 1,
    dictionary_name: 'Demo Dict',
    headword: 'serendipity',
    definition_html: '<p>a happy accident</p>',
    definition_page_html:
      '<!doctype html><html><head><link rel="stylesheet" href="/static/dict.css"></head><body><p>a happy accident</p></body></html>',
    definition_text: 'a happy accident',
    asset_base_url: 'https://dict.example.test',
    resolved_from: null,
    ...overrides,
  };
}

function renderFrame(entry: DictionaryLookupEntry) {
  return render(
    <ConfigProvider>
      <DictionaryEntryFrame entry={entry} />
    </ConfigProvider>
  );
}

describe('DictionaryEntryFrame', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the full dictionary page HTML in a sandboxed iframe', () => {
    renderFrame(makeEntry());

    const iframe = screen.getByTitle('Demo Dict: serendipity') as HTMLIFrameElement;
    const srcDoc = iframe.getAttribute('srcdoc') ?? '';

    // The full page (with its stylesheet) is loaded — not just plain text.
    expect(srcDoc).toContain('<link rel="stylesheet" href="/static/dict.css">');
    // A <base href> is injected so the dictionary's relative CSS/assets resolve
    // against the API server instead of the packaged app.
    expect(srcDoc).toContain('<base href="https://dict.example.test/">');
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('falls back to plain text when the entry has no HTML', () => {
    renderFrame(
      makeEntry({
        definition_html: '',
        definition_page_html: '',
        definition_text: 'a happy accident',
      })
    );

    expect(screen.queryByTitle('Demo Dict: serendipity')).toBeNull();
    expect(screen.getByText('a happy accident')).toBeDefined();
  });
});
