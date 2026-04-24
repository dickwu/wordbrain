import { invoke } from '@tauri-apps/api/core';
import type { ListWordsFilter, WordRecord, WordState } from './types';

export async function listWords(filter: ListWordsFilter): Promise<WordRecord[]> {
  return invoke<WordRecord[]>('list_words', { filter });
}

export async function bulkUnmarkWords(lemmas: string[]): Promise<number> {
  return invoke<number>('bulk_unmark_known', { lemmas });
}

export async function setWordState(
  lemma: string,
  state: Extract<WordState, 'known' | 'learning'>
): Promise<void> {
  return invoke<void>('set_word_state', { lemma, state });
}

export async function setUserNote(lemma: string, note: string | null): Promise<void> {
  return invoke<void>('set_user_note', { lemma, note });
}
