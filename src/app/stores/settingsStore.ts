import { create } from 'zustand';
import { getSetting, setSetting, isTauri } from '@/app/lib/ipc';
import {
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROVIDER,
  isAiProvider,
  normalizeAiModel,
  normalizeAiModels,
} from '@/app/lib/ai-models';
import type { AiProvider } from '@/app/lib/dict';

const AUTO_UPDATE_KEY = 'phase9.auto_update_enabled';
const HTTP_FALLBACK_KEY = 'learn_loop.http_fallback_enabled';
const AI_PROVIDER_KEY = 'ai.default_provider';
const AI_MODELS_KEY = 'ai.default_models';

interface SettingsState {
  /** True while the store is still reading persisted values from IPC. */
  loading: boolean;
  /** When true, UpdateChecker schedules the startup + 30-min silent checks.
   * Manual checks (clicking the status-bar version button) always work
   * regardless of this flag. */
  autoUpdateEnabled: boolean;
  setAutoUpdate: (v: boolean) => Promise<void>;
  /** When true, AI calls fall back to the configured HTTP provider after both
   * CLI channels (`claude -p`, `codex exec`) fail. Off by default — the
   * learning loop is meant to stay local-first. */
  httpFallbackEnabled: boolean;
  setHttpFallback: (v: boolean) => Promise<void>;
  aiProvider: AiProvider;
  aiModels: Record<AiProvider, string>;
  setAiProvider: (provider: AiProvider) => Promise<void>;
  setAiModel: (provider: AiProvider, model: string) => Promise<void>;
  /** Read the persisted values from SQLite via IPC. Safe to call multiple times. */
  hydrate: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  loading: true,
  autoUpdateEnabled: true,
  httpFallbackEnabled: false,
  aiProvider: DEFAULT_AI_PROVIDER,
  aiModels: DEFAULT_AI_MODEL,
  setAutoUpdate: async (v) => {
    set({ autoUpdateEnabled: v });
    if (isTauri()) {
      try {
        await setSetting(AUTO_UPDATE_KEY, v);
      } catch (err) {
        console.error('[wordbrain] persist auto-update setting failed', err);
      }
    }
  },
  setHttpFallback: async (v) => {
    set({ httpFallbackEnabled: v });
    if (isTauri()) {
      try {
        await setSetting(HTTP_FALLBACK_KEY, v);
      } catch (err) {
        console.error('[wordbrain] persist http-fallback setting failed', err);
      }
    }
  },
  setAiProvider: async (provider) => {
    set({ aiProvider: provider });
    if (isTauri()) {
      try {
        await setSetting(AI_PROVIDER_KEY, provider);
      } catch (err) {
        console.error('[wordbrain] persist AI provider setting failed', err);
      }
    }
  },
  setAiModel: async (provider, model) => {
    const next = {
      ...get().aiModels,
      [provider]: normalizeAiModel(provider, model),
    };
    set({ aiModels: next });
    if (isTauri()) {
      try {
        await setSetting(AI_MODELS_KEY, next);
      } catch (err) {
        console.error('[wordbrain] persist AI model setting failed', err);
      }
    }
  },
  hydrate: async () => {
    if (!isTauri()) {
      set({ loading: false });
      return;
    }
    try {
      const [autoRaw, httpRaw, providerRaw, modelsRaw] = await Promise.all([
        getSetting(AUTO_UPDATE_KEY),
        getSetting(HTTP_FALLBACK_KEY),
        getSetting(AI_PROVIDER_KEY),
        getSetting(AI_MODELS_KEY),
      ]);
      const next: Partial<SettingsState> = { loading: false };
      if (autoRaw !== null && autoRaw !== undefined) {
        const parsed = JSON.parse(autoRaw);
        if (typeof parsed === 'boolean') next.autoUpdateEnabled = parsed;
      }
      if (httpRaw !== null && httpRaw !== undefined) {
        const parsed = JSON.parse(httpRaw);
        if (typeof parsed === 'boolean') next.httpFallbackEnabled = parsed;
      }
      if (providerRaw !== null && providerRaw !== undefined) {
        const parsed = JSON.parse(providerRaw);
        if (isAiProvider(parsed)) next.aiProvider = parsed;
      }
      if (modelsRaw !== null && modelsRaw !== undefined) {
        next.aiModels = normalizeAiModels(JSON.parse(modelsRaw));
      }
      set(next);
    } catch (err) {
      console.warn('[wordbrain] settings hydrate skipped', err);
      set({ loading: false });
    }
  },
}));
