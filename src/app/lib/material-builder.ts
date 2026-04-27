/**
 * Convert a chunk of raw text into a `SaveMaterialInput` ready to hand to the
 * `save_material` Tauri command. Tokenisation + lemmatisation live on the
 * frontend (wink-lemmatizer) so the Rust side never owns English NLP state.
 *
 * The bipartite-edge format collapses repeat surface forms that share a lemma
 * into a single `TokenEdge` with the correct `occurrence_count`, the earliest
 * `first_position`, and the sentence preview around that first occurrence.
 */

import { tokenize } from '@/app/lib/tokenizer';
import type { SaveMaterialInput, TokenEdgeInput } from '@/app/lib/ipc';
import { isKnownNameToken } from '@/app/stores/wordStore';

const PREVIEW_MAX = 160;

/** Sentence surrounding a char offset. Same crude chunker as ReaderPane. */
function previewAround(raw: string, offset: number): string {
  const lower = raw; // no case folding — previews are user-facing
  const stops = ['.', '?', '!', '\n'];
  let start = 0;
  let end = raw.length;
  for (const s of stops) {
    const b = lower.lastIndexOf(s, offset - 1);
    if (b > start) start = b + 1;
    const a = lower.indexOf(s, offset);
    if (a >= 0 && a < end) end = a + 1;
  }
  const slice = raw.slice(start, end).trim();
  if (slice.length <= PREVIEW_MAX) return slice;
  // Always keep the word itself in the window.
  const local = raw.slice(offset, offset + 80).trim();
  return local || slice.slice(0, PREVIEW_MAX) + '…';
}

export interface BuildMaterialInputArgs {
  title: string;
  raw: string;
  sourceKind?: SaveMaterialInput['source_kind'];
  originPath?: string | null;
  tiptapJson?: unknown;
}

export function buildMaterialInput({
  title,
  raw,
  sourceKind = 'paste',
  originPath = null,
  tiptapJson,
}: BuildMaterialInputArgs): SaveMaterialInput {
  const tokens = tokenize(raw);
  const byLemma = new Map<string, TokenEdgeInput>();
  for (const t of tokens) {
    if (!t.lemma) continue;
    if (isKnownNameToken(t.lemma, t.surface)) continue;
    const existing = byLemma.get(t.lemma);
    if (existing) {
      existing.occurrence_count += 1;
      if (t.start < existing.first_position) {
        existing.first_position = t.start;
        existing.sentence_preview = previewAround(raw, t.start);
      }
    } else {
      byLemma.set(t.lemma, {
        lemma: t.lemma,
        occurrence_count: 1,
        first_position: t.start,
        sentence_preview: previewAround(raw, t.start),
      });
    }
  }

  // Fallback tiptap JSON for paste flow: a single paragraph wrapping the raw
  // text. Callers that already have an editor hand us its JSON directly.
  const fallbackJson = {
    type: 'doc',
    content: [{ type: 'paragraph', content: raw ? [{ type: 'text', text: raw }] : [] }],
  };

  return {
    title: title.trim() || deriveTitle(raw),
    source_kind: sourceKind,
    origin_path: originPath,
    tiptap_json: JSON.stringify(tiptapJson ?? fallbackJson),
    raw_text: raw,
    total_tokens: tokens.length,
    unique_tokens: byLemma.size,
    tokens: Array.from(byLemma.values()),
  };
}

/** Trim a doc down to a short descriptive title when the user didn't provide one. */
export function deriveTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const clipped = firstLine.trim().slice(0, 80);
  return clipped.length ? clipped : 'Untitled material';
}

/** Crude ~200 wpm estimate for the library row. */
export function estimateReadingMinutes(totalTokens: number): number {
  return Math.max(1, Math.round(totalTokens / 200));
}
