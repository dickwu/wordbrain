// Thin wrapper around dictionary-related IPC commands. Dictionary lookup flows
// use the private Dictionary API.

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@/app/lib/ipc';

export interface DictionaryLookupEntry {
  dictionary_id: number;
  dictionary_name: string;
  headword: string;
  definition_html: string;
  definition_page_html: string;
  definition_text: string;
  asset_base_url: string;
  resolved_from: string | null;
}

export interface DictionaryLookupResult {
  query: string;
  entries: DictionaryLookupEntry[];
  elapsed_ms: number;
}

export interface DictionaryApiConfig {
  enabled: boolean;
  serverUrl: string;
  hasApiKey: boolean;
}

export interface DictionaryApiConfigInput {
  enabled?: boolean;
  serverUrl?: string;
  apiKey?: string;
}

export interface DictionaryApiStatus {
  ok: boolean;
  dictionaryCount: number;
  message: string;
}

export interface RemoteDictionary {
  slug: string;
  name: string;
  indexUid: string;
  entryCount: number;
  updatedAtMs: number;
}

const DEFAULT_DICTIONARY_API_CONFIG: DictionaryApiConfig = {
  enabled: false,
  serverUrl: '',
  hasApiKey: false,
};

export async function getDictionaryApiConfig(): Promise<DictionaryApiConfig> {
  if (!isTauri()) return DEFAULT_DICTIONARY_API_CONFIG;
  return invoke<DictionaryApiConfig>('get_dictionary_api_config');
}

export async function saveDictionaryApiConfig(
  config: DictionaryApiConfigInput
): Promise<DictionaryApiConfig> {
  if (!isTauri()) {
    throw new Error('dictionary API config requires Tauri runtime');
  }
  return invoke<DictionaryApiConfig>('save_dictionary_api_config', { config });
}

export async function testDictionaryApiConfig(): Promise<DictionaryApiStatus> {
  if (!isTauri()) {
    throw new Error('dictionary API config requires Tauri runtime');
  }
  return invoke<DictionaryApiStatus>('test_dictionary_api_config');
}

export async function listRemoteDictionaries(): Promise<RemoteDictionary[]> {
  if (!isTauri()) return [];
  return invoke<RemoteDictionary[]>('list_remote_dictionaries');
}

export async function lookupRemoteDictionary(
  query: string,
  opts?: { dictionarySlug?: string | null; limit?: number }
): Promise<DictionaryLookupResult> {
  if (!isTauri()) {
    return { query, entries: [], elapsed_ms: 0 };
  }
  return invoke<DictionaryLookupResult>('lookup_remote_dictionary', {
    query,
    dictionarySlug: opts?.dictionarySlug ?? null,
    limit: opts?.limit ?? null,
  });
}

export type AiProvider = 'openai' | 'anthropic' | 'ollama';

export async function saveApiKey(provider: string, value: string): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('save_api_key', { provider, value });
}

export async function listConfiguredProviders(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>('list_configured_providers');
}
