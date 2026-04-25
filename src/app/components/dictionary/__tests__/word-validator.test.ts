import { describe, expect, it } from 'vitest';
import { isLookupCandidate, normalizeLookupQuery } from '../DictionaryFloat';

describe('isLookupCandidate', () => {
  it('accepts a single English word', () => {
    expect(isLookupCandidate('apple')).toBe(true);
    expect(isLookupCandidate('Apple')).toBe(true);
    expect(isLookupCandidate('serendipity')).toBe(true);
  });

  it('accepts apostrophes and hyphens inside the word', () => {
    expect(isLookupCandidate("Don't")).toBe(true);
    expect(isLookupCandidate('mother-in-law')).toBe(true);
    expect(isLookupCandidate('it’s')).toBe(true);
  });

  it('rejects empty / null / multi-word / non-word input', () => {
    expect(isLookupCandidate('')).toBe(false);
    expect(isLookupCandidate(null)).toBe(false);
    expect(isLookupCandidate(undefined)).toBe(false);
    expect(isLookupCandidate('   ')).toBe(false);
    expect(isLookupCandidate('123')).toBe(false);
    expect(isLookupCandidate('apple pie')).toBe(false);
    expect(isLookupCandidate('apple.')).toBe(false);
    expect(isLookupCandidate('中文')).toBe(false);
    expect(isLookupCandidate('hello, world')).toBe(false);
  });

  it("doesn't accept words starting with apostrophe or hyphen", () => {
    expect(isLookupCandidate("'apple")).toBe(false);
    expect(isLookupCandidate('-apple')).toBe(false);
  });
});

describe('normalizeLookupQuery', () => {
  it('lowercases and trims valid words', () => {
    expect(normalizeLookupQuery('  Apple  ')).toBe('apple');
    expect(normalizeLookupQuery('Mother-In-Law')).toBe('mother-in-law');
  });

  it('returns empty string for invalid input', () => {
    expect(normalizeLookupQuery('apple pie')).toBe('');
    expect(normalizeLookupQuery('')).toBe('');
    expect(normalizeLookupQuery(null)).toBe('');
    expect(normalizeLookupQuery('apple.')).toBe('');
  });
});
