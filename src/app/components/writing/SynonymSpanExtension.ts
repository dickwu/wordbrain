import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export interface SynonymSpanClickPayload {
  lemma: string;
  bracket: string;
  from: number;
  to: number;
  rect: { x: number; y: number; width: number; height: number };
}

export interface SynonymSpanOptions {
  onClickSynonym?: (payload: SynonymSpanClickPayload) => void;
}

export const synonymSpanPluginKey = new PluginKey<DecorationSet>('synonymSpan');

const BRACKET_RE = /\[([a-zA-Z][a-zA-Z\-' ]*(?:,\s*[a-zA-Z][a-zA-Z\-' ]*)+)\]/g;

interface BracketHit {
  from: number;
  to: number;
  bracket: string;
  synonyms: string[];
}

function findBrackets(doc: ProseMirrorNode): BracketHit[] {
  const hits: BracketHit[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    BRACKET_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BRACKET_RE.exec(text)) !== null) {
      const inner = match[1] ?? '';
      const synonyms = inner
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (synonyms.length < 2) continue;
      hits.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        bracket: match[0],
        synonyms,
      });
    }
  });
  return hits;
}

function buildDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  for (const hit of findBrackets(doc)) {
    decorations.push(
      Decoration.inline(
        hit.from,
        hit.to,
        {
          class: 'wb-synonym-span',
          'data-bracket': hit.bracket,
          'data-synonyms': hit.synonyms.join('|'),
        },
        { bracket: hit.bracket, synonyms: hit.synonyms }
      )
    );
  }
  return DecorationSet.create(doc, decorations);
}

export const SynonymSpanExtension = Mark.create<SynonymSpanOptions>({
  name: 'synonymSpan',

  addOptions() {
    return {
      onClickSynonym: undefined,
    };
  },

  parseHTML() {
    return [{ tag: 'span.wb-synonym-span' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'wb-synonym-span' }), 0];
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<DecorationSet>({
        key: synonymSpanPluginKey,
        state: {
          init(_, { doc }) {
            return buildDecorations(doc);
          },
          apply(tr, old) {
            if (tr.docChanged) {
              return buildDecorations(tr.doc);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return synonymSpanPluginKey.getState(state) ?? null;
          },
          handleClick(view, _pos, event) {
            const target = event.target as HTMLElement | null;
            if (!target || !target.classList.contains('wb-synonym-span')) return false;
            if (!options.onClickSynonym) return false;
            const bracket = target.getAttribute('data-bracket') ?? target.textContent ?? '';
            const synonymsAttr = target.getAttribute('data-synonyms') ?? '';
            const synonyms = synonymsAttr.split('|').filter(Boolean);
            const rect = target.getBoundingClientRect();
            const offsetRatio = (event.clientX - rect.left) / Math.max(rect.width, 1);
            const clamped = Math.min(
              synonyms.length - 1,
              Math.max(0, Math.floor(offsetRatio * synonyms.length))
            );
            const lemma = synonyms[clamped] ?? synonyms[0] ?? '';
            const posAtDom = view.posAtDOM(target, 0);
            options.onClickSynonym({
              lemma,
              bracket,
              from: posAtDom,
              to: posAtDom + bracket.length,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
            return true;
          },
        },
      }),
    ];
  },
});

export { findBrackets as findSynonymBrackets };
