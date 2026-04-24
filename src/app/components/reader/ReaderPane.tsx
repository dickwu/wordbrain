'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { useEffect, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import {
  WordHighlightExtension,
  wordHighlightPluginKey,
  WORD_HIGHLIGHT_REBUILD,
  type WordHighlightClickPayload,
} from './WordHighlightExtension';
import { useWordStore, isLemmaKnown } from '@/app/stores/wordStore';
import { WordCardPopover } from './WordCardPopover';

interface ReaderPaneProps {
  initialContent?: string;
  placeholder?: string;
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
    lower.lastIndexOf('\n', idx),
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
}: ReaderPaneProps) {
  const { message } = AntApp.useApp();
  const [popover, setPopover] = useState<WordHighlightClickPayload | null>(null);
  const version = useWordStore((s) => s.version);
  const paintBudgetRef = useRef<number>(0);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
      WordHighlightExtension.configure({
        isKnown: isLemmaKnown,
        onClickUnknown: setPopover,
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

  return (
    <div style={{ position: 'relative' }}>
      <EditorContent
        editor={editor}
        style={{
          minHeight: 320,
          padding: 20,
          border: '1px solid rgba(0,0,0,0.12)',
          borderRadius: 8,
          background: '#fff',
          lineHeight: 1.7,
          fontSize: 15,
        }}
      />
      {popover && editor && (
        <WordCardPopover
          payload={popover}
          contextSentence={extractSentence(editor.getText(), popover.surface)}
          onClose={() => setPopover(null)}
          onMarkKnown={() => {
            useWordStore.getState().markKnown(popover.lemma);
            message.success(`Marked "${popover.surface}" as known`);
            setPopover(null);
          }}
        />
      )}
    </div>
  );
}
