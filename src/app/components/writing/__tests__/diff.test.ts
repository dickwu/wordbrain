import { describe, expect, it } from 'vitest';
import { diffWords } from '../diff';

describe('diffWords', () => {
  it('returns a single equal span when both strings match', () => {
    const out = diffWords('hello world', 'hello world');
    expect(out).toEqual([{ op: 'equal', text: 'hello world' }]);
  });

  it('marks insertions and deletions for a small word swap', () => {
    const out = diffWords('I am happy today.', 'I am very happy today.');
    const inserts = out.filter((d) => d.op === 'insert').map((d) => d.text);
    expect(inserts.join('').includes('very')).toBe(true);
  });

  it('does not lose any source characters', () => {
    const out = diffWords('alpha bravo charlie', 'alpha delta charlie');
    const reconstructed = out
      .filter((d) => d.op !== 'insert')
      .map((d) => d.text)
      .join('');
    expect(reconstructed).toBe('alpha bravo charlie');
    const corrected = out
      .filter((d) => d.op !== 'delete')
      .map((d) => d.text)
      .join('');
    expect(corrected).toBe('alpha delta charlie');
  });
});
