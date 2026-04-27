'use client';

import { useEffect, useState } from 'react';
import { FloatButton } from 'antd';
import { BookOutlined } from '@ant-design/icons';
import { isTauri } from '@/app/lib/ipc';
import { normalizeLookupQuery } from '@/app/lib/lookup-history';
import { WordLookupModal } from './WordLookupModal';

export {
  isLookupCandidate,
  mergeLookupHistory,
  normalizeLookupQuery,
} from '@/app/lib/lookup-history';

/** CSS selector for elements where double-click should NOT pop the global dictionary —
 * native form fields, interactive controls, reader/editor surfaces that provide
 * their own contextual lookup, and the dictionary modal itself. */
const SKIP_DBLCLICK_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '.ProseMirror',
  '.wb-story-lookup-surface',
  '.ant-btn',
  '.ant-modal-content',
].join(', ');

interface DictionaryFloatProps {
  onOpenSettings: () => void;
  onShowLinked?: (lemma: string) => void;
}

export function DictionaryFloat({ onOpenSettings, onShowLinked }: DictionaryFloatProps) {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState('');
  const [contextSentence, setContextSentence] = useState('');
  const [autoSearch, setAutoSearch] = useState(false);

  const openWith = (rawWord: string, context?: string) => {
    const word = normalizeLookupQuery(rawWord);
    setInitialQuery(word);
    setContextSentence(context?.trim() || word);
    setAutoSearch(Boolean(word));
    setOpen(true);
  };

  // FloatButton: try the OS clipboard first (tauri-plugin-clipboard-manager),
  // fall back to the current selection. If we land on a single English word
  // we auto-fire the lookup so the user sees the explanation immediately.
  const openModal = async () => {
    let seed = window.getSelection?.()?.toString().trim() ?? '';
    if (!seed && isTauri()) {
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
        seed = (await readText()) ?? '';
      } catch {
        // Clipboard refusal (permission / empty / non-text) is non-fatal.
      }
    }
    openWith(seed);
  };

  // Global double-click -> dictionary lookup. We use the capture phase so we
  // see plain-page word selections early, while letting reader/story/editor
  // surfaces provide richer contextual lookup themselves.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onDblClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(SKIP_DBLCLICK_SELECTOR)) return;
      const selection = window.getSelection?.()?.toString();
      const word = normalizeLookupQuery(selection);
      if (!word) return;
      openWith(word, selection ?? word);
    };
    document.addEventListener('dblclick', onDblClick, true);
    return () => document.removeEventListener('dblclick', onDblClick, true);
  }, []);

  return (
    <>
      <FloatButton
        icon={<BookOutlined />}
        tooltip="Dictionary (double-click any word)"
        onClick={() => {
          void openModal();
        }}
        style={{ right: 32, bottom: 32 }}
      />

      {open && (
        <WordLookupModal
          visible={true}
          initialQuery={initialQuery}
          contextSentence={contextSentence || initialQuery}
          autoSearch={autoSearch}
          onClose={() => {
            setOpen(false);
            setAutoSearch(false);
          }}
          onOpenSettings={onOpenSettings}
          onShowLinked={onShowLinked}
        />
      )}
    </>
  );
}
