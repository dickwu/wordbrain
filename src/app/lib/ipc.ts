// Thin wrapper around `@tauri-apps/api/core.invoke`. All WordBrain IPC goes
// through here so commands are typed and mockable in unit tests.
import { invoke } from '@tauri-apps/api/core';

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function seedKnownFromFrequency(cutoff: number): Promise<number> {
  return invoke<number>('seed_known_from_frequency', { cutoff });
}

export async function getAllKnownLemmas(): Promise<string[]> {
  return invoke<string[]>('get_all_known_lemmas');
}

export async function markKnownIpc(lemma: string, source = 'manual'): Promise<void> {
  return invoke<void>('mark_known', { lemma, source });
}

export async function unmarkKnownIpc(lemma: string): Promise<void> {
  return invoke<void>('unmark_known', { lemma });
}

export async function frequencyPreview(cutoff: number): Promise<Array<[number, string]>> {
  return invoke<Array<[number, string]>>('frequency_preview', { cutoff });
}

export async function getSetting(key: string): Promise<string | null> {
  const raw = await invoke<string | null>('get_setting', { key });
  return raw ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  return invoke<void>('set_setting', { key, value: JSON.stringify(value) });
}
