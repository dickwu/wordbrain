import { create } from 'zustand';
import { getSetting, setSetting, isTauri } from '@/app/lib/ipc';

const AUTO_UPDATE_KEY = 'phase9.auto_update_enabled';
const HTTP_FALLBACK_KEY = 'learn_loop.http_fallback_enabled';

interface SettingsState {
  /** True while the store is still reading persisted values from IPC. */
  loading: boolean;
  /** When true, UpdateChecker schedules the startup + 30-min silent checks.
   * Manual checks (clicking the status-bar version button) always work
   * regardless of this flag. */
  autoUpdateEnabled: boolean;
  setAutoUpdate: (v: boolean) => Promise<void>;
  /** When true, AI calls fall back to the HTTP `lookup_ai` path after both
   * CLI channels (`claude -p`, `codex exec`) fail. Off by default — the
   * learning loop is meant to stay local-first. */
  httpFallbackEnabled: boolean;
  setHttpFallback: (v: boolean) => Promise<void>;
  /** Read the persisted values from SQLite via IPC. Safe to call multiple times. */
  hydrate: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  loading: true,
  autoUpdateEnabled: true,
  httpFallbackEnabled: false,
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
  hydrate: async () => {
    if (!isTauri()) {
      set({ loading: false });
      return;
    }
    try {
      const [autoRaw, httpRaw] = await Promise.all([
        getSetting(AUTO_UPDATE_KEY),
        getSetting(HTTP_FALLBACK_KEY),
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
      set(next);
    } catch (err) {
      console.warn('[wordbrain] settings hydrate skipped', err);
      set({ loading: false });
    }
  },
}));
