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

export interface CustomDictionary {
  id: number;
  name: string;
  source_path: string;
  mdx_path: string;
  entry_count: number;
  imported_at: number;
  updated_at: number;
  storage_kind: 'database' | 'external';
  mdx_size: number;
  asset_count: number;
  resource_archive_count: number;
  resource_archive_size: number;
  cloud_file_count: number;
  cloud_file_size: number;
}

export interface CustomDictionaryLookupEntry {
  dictionary_id: number;
  dictionary_name: string;
  headword: string;
  definition_html: string;
  definition_page_html: string;
  definition_text: string;
  resolved_from: string | null;
}

export interface CustomDictionaryLookupResult {
  query: string;
  entries: CustomDictionaryLookupEntry[];
  elapsed_ms: number;
}

export interface UploadServerConfig {
  name: string;
  enabled: boolean;
  uploadEnabled: boolean;
  endpointScheme: string;
  endpointHost: string;
  bucket: string;
  publicDomainScheme: string;
  publicDomainHost: string;
  prefix: string;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasApiToken: boolean;
}

export interface UploadServerConfigInput {
  name?: string;
  id?: string;
  accountId?: string;
  enabled?: boolean;
  uploadEnabled?: boolean;
  endpointScheme?: string;
  endpointHost?: string;
  bucket?: string;
  publicDomainScheme?: string;
  publicDomainHost?: string;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  apiToken?: string;
  token?: string;
  key?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    apiToken?: string;
    token?: string;
  };
}

export type DictionaryCloudConfig = UploadServerConfig;
export type DictionaryCloudConfigInput = UploadServerConfigInput;

export interface DictionaryResourceUploadResult {
  dictionaryCount: number;
  pageAssetCount: number;
  archiveResourceCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  uploadedBytes: number;
  firstError: string | null;
}

export async function lookupOffline(lemma: string): Promise<OfflineLookupResult> {
  if (!isTauri()) {
    return { entry: null, elapsed_ms: 0 };
  }
  return invoke<OfflineLookupResult>('lookup_offline', { lemma });
}

export async function importCustomDictionary(
  path: string,
  opts?: { cssPath?: string | null }
): Promise<CustomDictionary> {
  if (!isTauri()) {
    throw new Error('dictionary import requires Tauri runtime');
  }
  return invoke<CustomDictionary>('import_custom_dictionary', {
    path,
    cssPath: opts?.cssPath?.trim() || null,
  });
}

export async function listCustomDictionaries(): Promise<CustomDictionary[]> {
  if (!isTauri()) return [];
  return invoke<CustomDictionary[]>('list_custom_dictionaries');
}

export async function lookupCustomDictionary(
  query: string,
  opts?: { dictionaryId?: number | null; limit?: number }
): Promise<CustomDictionaryLookupResult> {
  if (!isTauri()) {
    return { query, entries: [], elapsed_ms: 0 };
  }
  return invoke<CustomDictionaryLookupResult>('lookup_custom_dictionary', {
    query,
    dictionaryId: opts?.dictionaryId ?? null,
    limit: opts?.limit ?? null,
  });
}

const DEFAULT_UPLOAD_SERVER_CONFIG: UploadServerConfig = {
  name: '',
  enabled: false,
  uploadEnabled: false,
  endpointScheme: 'https',
  endpointHost: '',
  bucket: '',
  publicDomainScheme: 'https',
  publicDomainHost: '',
  prefix: 'wordbrain/resources',
  hasAccessKeyId: false,
  hasSecretAccessKey: false,
  hasApiToken: false,
};

export async function getUploadServerConfig(): Promise<UploadServerConfig> {
  if (!isTauri()) {
    return DEFAULT_UPLOAD_SERVER_CONFIG;
  }
  return invoke<UploadServerConfig>('get_upload_server_config');
}

export async function saveUploadServerConfig(
  config: UploadServerConfigInput
): Promise<UploadServerConfig> {
  if (!isTauri()) {
    throw new Error('upload server config requires Tauri runtime');
  }
  return invoke<UploadServerConfig>('save_upload_server_config', { config });
}

export const getDictionaryCloudConfig = getUploadServerConfig;
export const saveDictionaryCloudConfig = saveUploadServerConfig;

export async function uploadDictionaryResources(opts?: {
  dictionaryId?: number | null;
  force?: boolean;
}): Promise<DictionaryResourceUploadResult> {
  if (!isTauri()) {
    throw new Error('dictionary resource upload requires Tauri runtime');
  }
  return invoke<DictionaryResourceUploadResult>('upload_dictionary_resources', {
    dictionaryId: opts?.dictionaryId ?? null,
    force: opts?.force ?? false,
  });
}

export type OnlineProvider = 'youdao' | 'deepl';

export async function lookupOnline(
  lemma: string,
  provider: OnlineProvider
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
  model: string
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
