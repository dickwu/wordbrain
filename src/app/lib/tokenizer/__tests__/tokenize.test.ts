import { describe, expect, test } from 'vitest';
import { tokenize, splitWords, lemmatize } from '../index';

describe('splitWords', () => {
  test('empty string yields no tokens', () => {
    expect(splitWords('')).toEqual([]);
  });

  test('punctuation-only input yields no tokens', () => {
    expect(splitWords('!?!? ... ;')).toEqual([]);
  });

  test('skips pure numerics, keeps words', () => {
    const parts = splitWords('I have 5 apples');
    expect(parts.map((p) => p.surface)).toEqual(['I', 'have', 'apples']);
  });

  test('keeps contraction as single token (straight apostrophe)', () => {
    const parts = splitWords("don't go");
    expect(parts.map((p) => p.surface)).toEqual(["don't", 'go']);
  });

  test('keeps contraction as single token (curly apostrophe)', () => {
    const parts = splitWords('they’re here');
    expect(parts[0].surface).toBe('they’re');
    expect(parts[1].surface).toBe('here');
  });

  test('splits hyphenated compound into parts', () => {
    const parts = splitWords('co-operate now');
    expect(parts.map((p) => p.surface)).toEqual(['co', 'operate', 'now']);
  });

  test('preserves original case in surface, lowercases lowered', () => {
    const parts = splitWords('Hello WORLD');
    expect(parts[0].surface).toBe('Hello');
    expect(parts[0].lowered).toBe('hello');
    expect(parts[1].surface).toBe('WORLD');
    expect(parts[1].lowered).toBe('world');
  });

  test('offsets are absolute into the raw string', () => {
    const raw = '  hello there ';
    const parts = splitWords(raw);
    expect(raw.slice(parts[0].start, parts[0].end)).toBe('hello');
    expect(raw.slice(parts[1].start, parts[1].end)).toBe('there');
  });

  test('unicode letters (accented) kept in one run', () => {
    const parts = splitWords('café naïve');
    expect(parts.map((p) => p.surface)).toEqual(['café', 'naïve']);
  });
});

describe('lemmatize', () => {
  test('verb inflections → base form', () => {
    expect(lemmatize('running')).toBe('run');
    expect(lemmatize('ran')).toBe('run');
    expect(lemmatize('went')).toBe('go');
  });

  test('noun plurals → singular', () => {
    expect(lemmatize('mice')).toBe('mouse');
    expect(lemmatize('apples')).toBe('apple');
  });

  test('adjective comparatives → positive', () => {
    expect(lemmatize('happier')).toBe('happy');
  });

  test('unchanged for words already in base form', () => {
    expect(lemmatize('cat')).toBe('cat');
  });

  test('lowercases its input', () => {
    expect(lemmatize('RUNNING')).toBe('run');
  });

  test('strips possessive clitic so "bank\'s" → "bank"', () => {
    expect(lemmatize("bank's")).toBe('bank');
    expect(lemmatize('bank’s')).toBe('bank');
    expect(lemmatize("Alice's")).toBe('alice');
  });

  test('leaves non-possessive contractions alone', () => {
    // n't is a different clitic from 's; "don't" and "can't" remain intact.
    expect(lemmatize("don't")).toBe("don't");
    expect(lemmatize("can't")).toBe("can't");
  });
});

describe('tokenize', () => {
  test('attaches lemma to every surface form', () => {
    const tokens = tokenize('The mice were running.');
    const byLemma = tokens.map((t) => `${t.surface}:${t.lemma}`);
    expect(byLemma).toEqual(['The:the', 'mice:mouse', 'were:be', 'running:run']);
  });

  test('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  test('offsets are preserved through lemmatisation', () => {
    const raw = 'Mice run fast.';
    const tokens = tokenize(raw);
    expect(raw.slice(tokens[0].start, tokens[0].end)).toBe('Mice');
    expect(tokens[0].lemma).toBe('mouse');
  });
});
