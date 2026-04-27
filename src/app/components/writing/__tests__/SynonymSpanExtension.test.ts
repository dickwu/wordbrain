import { describe, expect, it } from 'vitest';
import { Schema, DOMParser as PMParser } from '@tiptap/pm/model';
import { findSynonymBrackets } from '../SynonymSpanExtension';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'text*',
      toDOM: () => ['p', 0],
    },
    text: {},
  },
});

function docFromText(text: string) {
  const dom = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = text;
  dom.appendChild(p);
  return PMParser.fromSchema(schema).parse(dom);
}

describe('findSynonymBrackets', () => {
  it('finds a single bracket span with at least two synonyms', () => {
    const doc = docFromText('She is trepidation [fear, dread, worry] about the test.');
    const hits = findSynonymBrackets(doc);
    expect(hits).toHaveLength(1);
    expect(hits[0].synonyms).toEqual(['fear', 'dread', 'worry']);
    expect(hits[0].bracket).toBe('[fear, dread, worry]');
  });

  it('skips brackets with only one item', () => {
    const doc = docFromText('Just one [word] here.');
    expect(findSynonymBrackets(doc)).toHaveLength(0);
  });

  it('skips brackets with non-letter content', () => {
    const doc = docFromText('Numbers [1, 2, 3] and pipes [|, |].');
    expect(findSynonymBrackets(doc)).toHaveLength(0);
  });

  it('finds multiple brackets in one paragraph', () => {
    const doc = docFromText('First [a, b] and second [c, d, e] here.');
    const hits = findSynonymBrackets(doc);
    expect(hits).toHaveLength(2);
    expect(hits[0].synonyms).toEqual(['a', 'b']);
    expect(hits[1].synonyms).toEqual(['c', 'd', 'e']);
  });
});
