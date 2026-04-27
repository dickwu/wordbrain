import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { tokenize } from '@/app/lib/tokenizer';

export interface WordHighlightClickPayload {
  lemma: string;
  surface: string;
  from: number;
  to: number;
  /** Client-space coordinates of the clicked span, useful for popover anchors. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface WordHighlightOptions {
  isKnown: (lemma: string, surface: string) => boolean;
  onClickUnknown?: (payload: WordHighlightClickPayload) => void;
}

export const wordHighlightPluginKey = new PluginKey<DecorationSet>('wordHighlight');

/** Rebuild-signal: dispatch `tr.setMeta(wordHighlightPluginKey, REBUILD)` after marking known. */
export const WORD_HIGHLIGHT_REBUILD = 'rebuild';

function buildDecorations(
  doc: ProseMirrorNode,
  isKnown: (lemma: string, surface: string) => boolean
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const tokens = tokenize(node.text);
    for (const t of tokens) {
      if (isKnown(t.lemma, t.surface)) continue; // paint only unknowns for perf
      const from = pos + t.start;
      const to = pos + t.end;
      decorations.push(
        Decoration.inline(
          from,
          to,
          { class: 'wb-word wb-word--unknown', 'data-lemma': t.lemma, 'data-surface': t.surface },
          { lemma: t.lemma, surface: t.surface }
        )
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WordHighlightExtension = Extension.create<WordHighlightOptions>({
  name: 'wordHighlight',

  addOptions() {
    return {
      isKnown: () => false,
      onClickUnknown: undefined,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin<DecorationSet>({
        key: wordHighlightPluginKey,
        state: {
          init(_, { doc }) {
            return buildDecorations(doc, options.isKnown);
          },
          apply(tr, old) {
            if (tr.docChanged || tr.getMeta(wordHighlightPluginKey) === WORD_HIGHLIGHT_REBUILD) {
              return buildDecorations(tr.doc, options.isKnown);
            }
            return old.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return wordHighlightPluginKey.getState(state) ?? null;
          },
          handleClick(view, _pos, event) {
            const target = event.target as HTMLElement | null;
            if (!target || !target.classList.contains('wb-word--unknown')) return false;
            const lemma = target.getAttribute('data-lemma');
            const surface = target.getAttribute('data-surface');
            if (!lemma || !surface) return false;
            if (!options.onClickUnknown) return false;
            const rect = target.getBoundingClientRect();
            const posAtDom = view.posAtDOM(target, 0);
            options.onClickUnknown({
              lemma,
              surface,
              from: posAtDom,
              to: posAtDom + surface.length,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            });
            return true;
          },
        },
      }),
    ];
  },
});
