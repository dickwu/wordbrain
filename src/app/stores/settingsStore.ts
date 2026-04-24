import { create } from 'zustand';
import { getSetting, setSetting, isTauri } from '@/app/lib/ipc';

const AUTO_UPDATE_KEY = 'phase9.auto_update_enabled';

interface SettingsState {
  /** True while the store is still reading persisted values from IPC. */
  loading: boolean;
  /** When true, UpdateChecker schedules the startup + 30-min silent checks.
   * Manual checks (clicking the status-bar version button) always work
   * regardless of this flag. */
  autoUpdateEnabled: boolean;
  setAutoUpdate: (v: boolean) => Promise<void>;
  /** Read the persisted values from SQLite via IPC. Safe to call multiple times. */
  hydrate: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  loading: true,
  autoUpdateEnabled: true,
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
  hydrate: async () => {
    if (!isTauri()) {
      set({ loading: false });
      return;
    }
    try {
      const raw = await getSetting(AUTO_UPDATE_KEY);
      if (raw === null || raw === undefined) {
        set({ loading: false });
        return;
      }
      const parsed = JSON.parse(raw);
      set({
        autoUpdateEnabled: typeof parsed === 'boolean' ? parsed : true,
        loading: false,
      });
    } catch (err) {
      console.warn('[wordbrain] settings hydrate skipped', err);
      set({ loading: false });
    }
  },
}));
