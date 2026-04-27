import type { AiProvider } from '@/app/lib/dict';

export const DEFAULT_AI_PROVIDER: AiProvider = 'openai';

export const DEFAULT_AI_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  ollama: 'qwen2.5:3b',
};

export const MODEL_OPTIONS: Record<AiProvider, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'],
  ollama: ['qwen2.5:3b', 'llama3.1:8b', 'gemma2:2b'],
};

export const AI_PROVIDER_OPTIONS: Array<{ value: AiProvider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'ollama', label: 'Ollama' },
];

export function isAiProvider(value: unknown): value is AiProvider {
  return value === 'openai' || value === 'anthropic' || value === 'ollama';
}

export function normalizeAiModel(provider: AiProvider, model: unknown): string {
  if (typeof model === 'string' && model.trim()) {
    return model.trim();
  }
  return DEFAULT_AI_MODEL[provider];
}

export function normalizeAiModels(value: unknown): Record<AiProvider, string> {
  const source =
    value && typeof value === 'object' ? (value as Partial<Record<AiProvider, unknown>>) : {};
  return {
    openai: normalizeAiModel('openai', source.openai),
    anthropic: normalizeAiModel('anthropic', source.anthropic),
    ollama: normalizeAiModel('ollama', source.ollama),
  };
}
