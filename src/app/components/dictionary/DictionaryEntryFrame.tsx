'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { theme } from 'antd';
import type { DictionaryLookupEntry } from '@/app/lib/dict';

/**
 * Wraps a dictionary entry's HTML so the renderer iframe resolves the
 * dictionary's own stylesheet + asset URLs against the API server. Without a
 * `<base href>`, relative links (CSS, images, audio) would resolve against the
 * packaged Tauri app and 404, leaving the entry unstyled.
 */
export function buildDictionaryFrameSrcDoc(
  sourceHtml: string,
  assetBaseUrl?: string | null
): string {
  const html = sourceHtml.trim();
  const normalizedBaseUrl = normalizeDictionaryAssetBaseUrl(assetBaseUrl);
  if (!html || !normalizedBaseUrl || /<base(?:\s|>|\/)/i.test(html)) {
    return html;
  }

  const baseTag = `<base href="${escapeHtmlAttribute(normalizedBaseUrl)}">`;
  const headOpenEnd = findOpeningTagEnd(html, 'head');
  if (headOpenEnd !== -1) {
    return `${html.slice(0, headOpenEnd)}${baseTag}${html.slice(headOpenEnd)}`;
  }

  const htmlOpenEnd = findOpeningTagEnd(html, 'html');
  if (htmlOpenEnd !== -1) {
    return `${html.slice(0, htmlOpenEnd)}<head>${baseTag}</head>${html.slice(htmlOpenEnd)}`;
  }

  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '<!doctype html>';
  const body = doctype === '<!doctype html>' ? html : html.slice(doctype.length);
  return `${doctype}<html><head>${baseTag}</head><body>${body}</body></html>`;
}

interface DictionaryNavigateMessage {
  type: 'dictionary-api:navigate';
  query: string;
  dictionarySlug?: string;
}

interface DictionaryEntryFrameProps {
  entry: DictionaryLookupEntry;
  /**
   * When provided, in-page cross-reference links (postMessage from the
   * sandboxed dictionary HTML) navigate to the referenced entry. Omit on
   * read-only surfaces such as the SRS review flashcard.
   */
  onNavigateEntry?: (query: string, dictionarySlug?: string) => void;
  /** CSS height for the iframe. Defaults to the modal's tall reading height. */
  height?: CSSProperties['height'];
  /** CSS min-height for the iframe. */
  minHeight?: CSSProperties['minHeight'];
}

/**
 * Renders a single dictionary entry inside a sandboxed iframe so the
 * dictionary's full stylesheet + assets load exactly as published. Shared by
 * the dictionary modal and the SRS review card so both surfaces render the
 * entry identically.
 */
export function DictionaryEntryFrame({
  entry,
  onNavigateEntry,
  height = 'min(64vh, 640px)',
  minHeight = 500,
}: DictionaryEntryFrameProps) {
  const { token } = theme.useToken();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const html = entry.definition_page_html || entry.definition_html;
  const frameSrcDoc = buildDictionaryFrameSrcDoc(html, entry.asset_base_url);

  useEffect(() => {
    if (!onNavigateEntry) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isDictionaryNavigateMessage(event.data)) return;
      onNavigateEntry(event.data.query, event.data.dictionarySlug);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onNavigateEntry]);

  // No publishable HTML (rare): fall back to plain text rather than a blank frame.
  if (!html.trim()) {
    return (
      <div
        style={{
          whiteSpace: 'pre-wrap',
          color: token.colorText,
          fontSize: 15,
          lineHeight: 1.5,
        }}
      >
        {entry.definition_text || entry.headword}
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      title={`${entry.dictionary_name}: ${entry.headword}`}
      srcDoc={frameSrcDoc}
      sandbox="allow-scripts"
      allow="autoplay"
      style={{
        width: '100%',
        height,
        minHeight,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 6,
        background: token.colorBgContainer,
      }}
    />
  );
}

function isDictionaryNavigateMessage(value: unknown): value is DictionaryNavigateMessage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    data.type === 'dictionary-api:navigate' &&
    typeof data.query === 'string' &&
    data.query.trim().length > 0 &&
    (data.dictionarySlug === undefined || typeof data.dictionarySlug === 'string')
  );
}

function normalizeDictionaryAssetBaseUrl(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return '';
  }
}

function findOpeningTagEnd(html: string, tagName: string): number {
  const match = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'i').exec(html);
  return match ? match.index + match[0].length : -1;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
