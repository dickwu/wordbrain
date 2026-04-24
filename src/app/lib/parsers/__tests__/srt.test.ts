import { describe, expect, test } from 'vitest';
import { stripSrt, looksLikeSrt } from '../srt';

const SAMPLE = `1
00:00:01,000 --> 00:00:04,000
Hello, world.
This is the first subtitle.

2
00:00:05,500 --> 00:00:08,200
A second block follows.

3
00:00:09,000 --> 00:00:12,000
I have 5 apples and 2 oranges.
`;

describe('stripSrt', () => {
  test('drops block numbers and timestamp lines', () => {
    const out = stripSrt(SAMPLE);
    expect(out).not.toMatch(/-->/);
    expect(out).not.toMatch(/^\d+$/m);
    expect(out).toContain('Hello, world.');
    expect(out).toContain('A second block follows.');
  });

  test('keeps content line breaks between blocks', () => {
    const out = stripSrt(SAMPLE);
    // Content from block 1 and block 2 should be separated by at least one \n.
    const block1 = out.indexOf('This is the first subtitle.');
    const block2 = out.indexOf('A second block follows.');
    expect(block1).toBeGreaterThan(-1);
    expect(block2).toBeGreaterThan(block1);
    expect(out.slice(block1, block2)).toContain('\n');
  });

  test('preserves numerics inside content ("I have 5 apples")', () => {
    const out = stripSrt(SAMPLE);
    expect(out).toContain('I have 5 apples and 2 oranges.');
  });

  test('handles Windows CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const out = stripSrt(crlf);
    expect(out).toContain('Hello, world.');
    expect(out).not.toMatch(/\r/);
  });

  test('accepts dot-millisecond variant (00:00:01.000)', () => {
    const dotted = `1
00:00:01.000 --> 00:00:04.000
Dotted variant.
`;
    const out = stripSrt(dotted);
    expect(out).toBe('Dotted variant.');
  });

  test('strips <i>, <b>, and {\\an8} cue markup', () => {
    const tagged = `1
00:00:01,000 --> 00:00:02,000
<i>italic</i> <b>bold</b> {\\an8}top-aligned
`;
    const out = stripSrt(tagged);
    expect(out).toBe('italic bold top-aligned');
  });

  test('is deterministic (idempotent on already-stripped text)', () => {
    const once = stripSrt(SAMPLE);
    const twice = stripSrt(once);
    expect(once).toBe(twice);
  });

  test('empty input yields empty string', () => {
    expect(stripSrt('')).toBe('');
  });

  test('does NOT drop numeric-looking lines that are not block numbers', () => {
    const contentOnly = `The year is 2024.\nAnd the count is 42.`;
    expect(stripSrt(contentOnly)).toBe(contentOnly);
  });

  test('strips BOM at start of file', () => {
    const withBom = '﻿' + SAMPLE;
    const out = stripSrt(withBom);
    expect(out.startsWith('Hello')).toBe(true);
  });
});

describe('looksLikeSrt', () => {
  test('detects SRT by timestamp line', () => {
    expect(looksLikeSrt(SAMPLE)).toBe(true);
  });

  test('returns false for plain markdown', () => {
    expect(looksLikeSrt('# Title\n\nSome paragraph.')).toBe(false);
  });
});
