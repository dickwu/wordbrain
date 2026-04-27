import { beforeEach, describe, expect, it } from 'vitest';
import { buildMaterialInput } from '@/app/lib/material-builder';
import { isKnownNameToken, isReaderTokenKnown, useWordStore } from '@/app/stores/wordStore';

describe('known-name filtering', () => {
  beforeEach(() => {
    useWordStore.setState({
      known: new Set<string>(),
      knownNames: new Set<string>(['mia', 'will']),
      hydrated: true,
      version: 0,
    });
  });

  it('treats known names as reader-known only when capitalized like names', () => {
    expect(isKnownNameToken('mia', 'Mia')).toBe(true);
    expect(isReaderTokenKnown('mia', 'Mia')).toBe(true);
    expect(isKnownNameToken('will', 'will')).toBe(false);
  });

  it('excludes known names from material vocabulary edges', () => {
    const input = buildMaterialInput({
      title: 'attic',
      raw: "When Mia found a dusty wooden box in her grandmother's attic",
    });

    expect(input.total_tokens).toBe(11);
    expect(input.unique_tokens).toBe(10);
    expect(input.tokens.some((t) => t.lemma === 'mia')).toBe(false);
  });
});
