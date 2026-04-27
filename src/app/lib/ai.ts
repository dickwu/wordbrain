// Frontend bindings for the AI provider chain (src-tauri/src/ai/*).
// Pure passthroughs — no caching, no normalization. Mirrors the
// `#[derive(Serialize)]` shapes in `ai/chain.rs`.
import { invoke } from '@tauri-apps/api/core';

export interface ProviderStatus {
  channel: 'claude-p' | 'codex-cli' | string;
  binary: string;
  available: boolean;
  resolved_path: string | null;
}

export interface ProviderStatusReport {
  providers: ProviderStatus[];
  any_available: boolean;
}

export interface CodexAuthStatus {
  authFileFound: boolean;
  authPath: string | null;
  hasApiKey: boolean;
  hasOauthToken: boolean;
}

export interface CodexAuthImportResult {
  imported: boolean;
  status: CodexAuthStatus;
  message: string;
}

export interface CodexModelInfo {
  id: string;
  label: string;
  description: string | null;
  supportedInApi: boolean;
  visibility: string | null;
}

export interface CodexModelListResult {
  models: CodexModelInfo[];
  source: string;
}

export async function aiProviderStatus(): Promise<ProviderStatusReport> {
  return invoke<ProviderStatusReport>('ai_provider_status');
}

export async function codexAuthStatus(): Promise<CodexAuthStatus> {
  return invoke<CodexAuthStatus>('codex_auth_status');
}

export async function importOpenAiKeyFromCodexAuth(): Promise<CodexAuthImportResult> {
  return invoke<CodexAuthImportResult>('import_openai_key_from_codex_auth');
}

export async function listCodexModelsFromAuth(): Promise<CodexModelListResult> {
  return invoke<CodexModelListResult>('list_codex_models_from_auth');
}
