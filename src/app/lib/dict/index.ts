// Thin wrapper around the Phase-2 dictionary IPC commands. The orchestrator
// keeps the three tiers (offline → online → AI) exposed as independent fetch
// functions so the UI can render them in parallel tabs rather than resolving
// them serially.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/app/lib/ipc';

export interface OfflineEntry {
  lemma: string;
  pos: string | null;
  ipa: string | null;
  definitions_zh: string | null;
  definitions_en: string | null;
  source: string;
}

export interface OfflineLookupResult {
  entry: OfflineEntry | null;
  elapsed_ms: number;
}

export interface OnlineLookupResult {
  lemma: string;
  provider: string;
  translation_zh: string;
  example: string | null;
  cached: boolean;
  elapsed_ms: number;
}

export interface AiLookupResult {
  lemma: string;
  provider: string;
  model: string;
  context_hash: string;
  translation_zh: string;
  cached: boolean;
  elapsed_ms: number;
}

export async function lookupOffline(lemma: string): Promise<OfflineLookupResult> {
  if (!isTauri()) {
    return { entry: null, elapsed_ms: 0 };
  }
  return invoke<OfflineLookupResult>('lookup_offline', { lemma });
}

export type OnlineProvider = 'youdao' | 'deepl';

export async function lookupOnline(
  lemma: string,
  provider: OnlineProvider,
): Promise<OnlineLookupResult> {
  if (!isTauri()) {
    throw new Error('online lookup requires Tauri runtime');
  }
  return invoke<OnlineLookupResult>('lookup_online', { lemma, provider });
}

export type AiProvider = 'openai' | 'anthropic' | 'ollama';

export async function lookupAi(
  lemma: string,
  contextSentence: string,
  provider: AiProvider,
  model: string,
): Promise<AiLookupResult> {
  if (!isTauri()) {
    throw new Error('ai lookup requires Tauri runtime');
  }
  return invoke<AiLookupResult>('lookup_ai', {
    lemma,
    contextSentence,
    provider,
    model,
  });
}

export async function saveApiKey(provider: string, value: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('save_api_key', { provider, value });
}

export async function hasApiKey(provider: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('has_api_key', { provider });
}

export async function listConfiguredProviders(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('list_configured_providers');
}
