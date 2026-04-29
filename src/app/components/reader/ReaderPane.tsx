'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef, useState } from 'react';
import {
  WordHighlightExtension,
  wordHighlightPluginKey,
  WORD_HIGHLIGHT_REBUILD,
  type WordHighlightClickPayload,
} from './WordHighlightExtension';
import { useWordStore, isReaderTokenKnown } from '@/app/stores/wordStore';
import { lemmatize } from '@/app/lib/tokenizer';
import { WordLookupModal, normalizeLookupQuery } from '@/app/components/dictionary/WordLookupModal';

interface ReaderPaneProps {
  initialContent?: string;
  placeholder?: string;
  /** Optional hook: called when the word card's "Related docs" button is clicked. */
  onDrillLemma?: (lemma: string) => void;
}

export function ReaderPane({
  initialContent = '',
  placeholder = 'Paste or type English text here — unknown words will be highlighted as you go.',
  onDrillLemma,
}: ReaderPaneProps) {
  const [lookup, setLookup] = useState<WordHighlightClickPayload | null>(null);
  const version = useWordStore((s) => s.version);
  const paintBudgetRef = useRef<number>(0);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      WordHighlightExtension.configure({
        isKnown: isReaderTokenKnown,
        onClickUnknown: setLookup,
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'wb-reader-surface',
      },
    },
  });

  // Rebuild decorations whenever the known-set changes (mark-known mutations bump version).
  useEffect(() => {
    if (!editor) return;
    const start = performance.now();
    editor.view.dispatch(editor.state.tr.setMeta(wordHighlightPluginKey, WORD_HIGHLIGHT_REBUILD));
    paintBudgetRef.current = performance.now() - start;
  }, [editor, version]);

  // Log the initial paint time for the AC performance check.
  useEffect(() => {
    if (!editor) return;
    const t = performance.now();
    const handler = () => {
      const elapsed = performance.now() - t;
      paintBudgetRef.current = elapsed;
      if (elapsed > 500) {
        console.warn(`[wordbrain] highlight paint took ${elapsed.toFixed(1)} ms (budget 500 ms)`);
      }
    };
    editor.on('update', handler);
    return () => {
      editor.off('update', handler);
    };
  }, [editor]);

  const openSelectedWord = () => {
    const surface = window.getSelection?.()?.toString().trim() ?? '';
    const normalized = normalizeLookupQuery(surface);
    if (!normalized) return;
    setLookup({
      lemma: lemmatize(normalized),
      surface,
      from: 0,
      to: 0,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
  };

  return (
    <div className="wb-reader-shell" onDoubleClick={openSelectedWord}>
      <EditorContent editor={editor} className="wb-reader-prose" />
      {lookup && editor && (
        <WordLookupModal
          visible={true}
          initialQuery={lookup.lemma}
          surface={lookup.surface}
          autoSearch={true}
          onClose={() => setLookup(null)}
          onShowLinked={onDrillLemma}
        />
      )}
      <style>{`
        .wb-reader-shell { position: relative; }
        .wb-reader-prose .ProseMirror,
        .wb-reader-prose .wb-reader-surface {
          font-family: var(--serif);
          font-size: 19px;
          line-height: 1.65;
          color: var(--ink);
          min-height: 360px;
          padding: 8px 0;
          outline: none;
          text-wrap: pretty;
          hanging-punctuation: first last;
        }
        .wb-reader-prose .ProseMirror p { margin: 0 0 1.2em; }
        .wb-reader-prose .ProseMirror p.is-editor-empty:first-child::before {
          color: var(--ink-4);
          font-style: italic;
          content: attr(data-placeholder);
          float: left;
          height: 0;
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}
