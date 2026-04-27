import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenize } from '@/app/lib/tokenizer';

interface FreqPayload {
  count: number;
  entries: Array<[string, number, number]>;
}

// The bundled asset lives under src-tauri/ (outside the TS root). Read it via
// fs so the vitest run exercises the exact file shipped to Tauri at build time.
const FREQ_PATH = resolve(__dirname, '../../../../../src-tauri/assets/subtlex_us_freq.json');

function buildKnownSet(cutoff: number): Set<string> {
  const payload = JSON.parse(readFileSync(FREQ_PATH, 'utf8')) as FreqPayload;
  const out = new Set<string>();
  for (const [lemma, rank] of payload.entries) {
    if (rank > cutoff) break;
    out.add(lemma.toLowerCase());
  }
  return out;
}

// Standard BBC-style news paragraph (headline + lede) with register-neutral
// vocabulary — the "typical news article" referenced by the wizard copy
// ("Typical news articles will show ≈4% unknown" at cutoff=3000). Proper
// nouns are avoided because they skew the ratio without reflecting real
// reading difficulty for a learner.
const BBC_PARAGRAPH = `
Rain causes travel delays across the country
Heavy rain has caused flooding in parts of the country, forcing many
drivers to change their plans on Monday. Emergency teams moved equipment
into the worst-hit towns overnight and a number of schools closed early
to let children travel home safely. Weather officials warned that more
rain could fall in the next two days and asked people to avoid journeys
that were not truly needed. A spokesperson said the situation was being
watched hour by hour and that help would reach anyone still stuck by the
end of the week.
`.trim();

describe('Phase 1.5 cutoff acceptance (AC6)', () => {
  it('bundles at least 60k ranked entries (AC1)', () => {
    const payload = JSON.parse(readFileSync(FREQ_PATH, 'utf8')) as FreqPayload;
    expect(payload.entries.length).toBeGreaterThanOrEqual(60_000);
    expect(payload.entries[0][0]).toBeTypeOf('string');
    expect(payload.entries[0][1]).toBe(1);
  });

  it('seeding top 3000 ranks → unknown ratio ≤ 10% on a BBC paragraph', () => {
    const known = buildKnownSet(3000);
    const tokens = tokenize(BBC_PARAGRAPH);
    expect(tokens.length).toBeGreaterThan(40);

    const unknowns = tokens.filter((t) => !known.has(t.lemma.toLowerCase()));
    const ratio = unknowns.length / tokens.length;
    if (ratio > 0.1) {
      // Surface the offending lemmas so future regressions are debuggable.
      const lemmas = [...new Set(unknowns.map((u) => u.lemma))].sort();
      throw new Error(
        `unknown ratio ${(ratio * 100).toFixed(1)}% > 10%; unknowns: ${JSON.stringify(lemmas)}`
      );
    }
    expect(ratio).toBeLessThanOrEqual(0.1);
  });

  it('seeding fewer words raises unknown ratio (sanity-check on the freq ordering)', () => {
    const narrow = buildKnownSet(300);
    const wide = buildKnownSet(3000);
    const tokens = tokenize(BBC_PARAGRAPH);
    const unknownsNarrow = tokens.filter((t) => !narrow.has(t.lemma.toLowerCase())).length;
    const unknownsWide = tokens.filter((t) => !wide.has(t.lemma.toLowerCase())).length;
    expect(unknownsNarrow).toBeGreaterThan(unknownsWide);
  });
});
