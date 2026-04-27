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

export async function aiProviderStatus(): Promise<ProviderStatusReport> {
  return invoke<ProviderStatusReport>('ai_provider_status');
}
