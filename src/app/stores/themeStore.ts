import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** User-selectable theme preference. `system` follows `prefers-color-scheme`. */
export type ThemeMode = 'light' | 'dark' | 'system';
/** What actually paints — `system` is resolved against the OS preference. */
export type EffectiveTheme = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  systemPrefersDark: boolean;
  setMode: (mode: ThemeMode) => void;
  /** Flip between light and dark from whatever is currently visible. If the
   * user is on `system`, this pins them to the opposite of the resolved
   * theme — which is what they almost certainly want from a one-click toggle. */
  toggleMode: () => void;
  /** Internal: pumped by the prefers-color-scheme listener. */
  _setSystemPrefersDark: (v: boolean) => void;
}

function detectSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      systemPrefersDark: detectSystemPrefersDark(),
      setMode: (mode) => set({ mode }),
      toggleMode: () => {
        const eff = effectiveTheme(get());
        set({ mode: eff === 'dark' ? 'light' : 'dark' });
      },
      _setSystemPrefersDark: (v) => set({ systemPrefersDark: v }),
    }),
    {
      name: 'theme-storage',
      version: 1,
      // Only the user's choice is persisted; the OS-preference flag is
      // re-detected on every load.
      partialize: (s) => ({ mode: s.mode }) as Partial<ThemeState> as ThemeState,
      // v0 stored `theme: 'light' | 'dark'` directly. Promote it to `mode`
      // so users keep their preference across the upgrade.
      migrate: (persisted, version) => {
        if (version < 1) {
          const t = (persisted as { theme?: string } | undefined)?.theme;
          const mode: ThemeMode = t === 'light' || t === 'dark' ? t : 'system';
          return { mode } as Partial<ThemeState> as ThemeState;
        }
        return persisted as ThemeState;
      },
    }
  )
);

export function effectiveTheme(s: { mode: ThemeMode; systemPrefersDark: boolean }): EffectiveTheme {
  if (s.mode === 'system') return s.systemPrefersDark ? 'dark' : 'light';
  return s.mode;
}

/** Convenience hook — subscribe to whatever should actually paint. */
export function useEffectiveTheme(): EffectiveTheme {
  return useThemeStore(effectiveTheme);
}

/** Subscribe to OS prefers-color-scheme so `system` mode stays live as the
 * user toggles their OS appearance. Returns a teardown; safe in non-browser
 * environments (returns a no-op). */
export function startSystemThemeListener(): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const update = (e?: MediaQueryListEvent) => {
    useThemeStore.getState()._setSystemPrefersDark(e ? e.matches : mq.matches);
  };
  update();
  mq.addEventListener('change', update);
  return () => mq.removeEventListener('change', update);
}
