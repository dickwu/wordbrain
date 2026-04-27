'use client';

import type { WordHighlightClickPayload } from './WordHighlightExtension';
import { WordLookupModal } from '@/app/components/dictionary/WordLookupModal';

interface WordCardPopoverProps {
  payload: WordHighlightClickPayload;
  onClose: () => void;
  onMarkKnown?: () => void;
  onMarkName?: () => void;
  /** Sentence containing the word — fed to lookup_ai for contextual gloss. */
  contextSentence?: string;
  /** Optional hook: if provided a "Related docs" button surfaces the drawer. */
  onDrillLemma?: () => void;
}

/**
 * Back-compat wrapper for older reader/writing imports. New surfaces should use
 * `WordLookupModal` directly so all lookup actions stay in one place.
 */
export function WordCardPopover({
  payload,
  onClose,
  contextSentence,
  onDrillLemma,
}: WordCardPopoverProps) {
  return (
    <WordLookupModal
      visible={true}
      initialQuery={payload.lemma}
      surface={payload.surface}
      contextSentence={contextSentence ?? payload.surface}
      autoSearch={true}
      onClose={onClose}
      onShowLinked={onDrillLemma ? () => onDrillLemma() : undefined}
    />
  );
}
