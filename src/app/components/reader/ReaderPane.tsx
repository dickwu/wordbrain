'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef, useState } from 'react';
import { theme } from 'antd';
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

/** Crude sentence chunker: grabs the period/question/exclamation-bounded slice
 * that contains the given surface form. Good enough to feed lookup_ai. */
function extractSentence(text: string, surface: string): string {
  const lower = text.toLowerCase();
  const needle = surface.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) return surface;
  const before = Math.max(
    lower.lastIndexOf('.', idx),
    lower.lastIndexOf('?', idx),
    lower.lastIndexOf('!', idx),
    lower.lastIndexOf('\n', idx)
  );
  const afterCandidates = [
    lower.indexOf('.', idx + needle.length),
    lower.indexOf('?', idx + needle.length),
    lower.indexOf('!', idx + needle.length),
    lower.indexOf('\n', idx + needle.length),
  ].filter((n) => n > -1);
  const after = afterCandidates.length ? Math.min(...afterCandidates) : text.length - 1;
  return text.slice(before + 1, after + 1).trim();
}

export function ReaderPane({
  initialContent = '',
  placeholder = 'Paste or type English text here — unknown words will be highlighted as you go.',
  onDrillLemma,
}: ReaderPaneProps) {
  const { token } = theme.useToken();
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
    <div style={{ position: 'relative' }} onDoubleClick={openSelectedWord}>
      <EditorContent
        editor={editor}
        style={{
          minHeight: 320,
          padding: 20,
          border: `1px solid ${token.colorBorder}`,
          borderRadius: 8,
          background: token.colorBgContainer,
          color: token.colorText,
          lineHeight: 1.7,
          fontSize: 15,
        }}
      />
      {lookup && editor && (
        <WordLookupModal
          visible={true}
          initialQuery={lookup.lemma}
          surface={lookup.surface}
          contextSentence={extractSentence(editor.getText(), lookup.surface)}
          autoSearch={true}
          onClose={() => setLookup(null)}
          onShowLinked={onDrillLemma}
        />
      )}
    </div>
  );
}
