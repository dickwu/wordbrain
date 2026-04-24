import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @tauri-apps/api/core so we can drive get_setting / set_setting from tests.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Force isTauri() → true by planting the runtime marker on window before ipc.ts
// captures it. The flag is a simple presence check so any value works.
beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

describe('settingsStore', () => {
  it('defaults autoUpdateEnabled to true before hydrate resolves', async () => {
    const mod = await import('../settingsStore');
    const state = mod.useSettingsStore.getState();
    expect(state.autoUpdateEnabled).toBe(true);
    expect(state.loading).toBe(true);
  });

  it('hydrate() reads get_setting via IPC and updates the store', async () => {
    invokeMock.mockImplementation(async (cmd: string, args: { key: string }) => {
      if (cmd === 'get_setting' && args.key === 'phase9.auto_update_enabled') {
        return JSON.stringify(false);
      }
      return null;
    });

    const mod = await import('../settingsStore');
    await mod.useSettingsStore.getState().hydrate();

    expect(invokeMock).toHaveBeenCalledWith('get_setting', {
      key: 'phase9.auto_update_enabled',
    });
    expect(mod.useSettingsStore.getState().autoUpdateEnabled).toBe(false);
    expect(mod.useSettingsStore.getState().loading).toBe(false);
  });

  it('setAutoUpdate(v) writes the new value through set_setting', async () => {
    invokeMock.mockResolvedValue(null);

    const mod = await import('../settingsStore');
    await mod.useSettingsStore.getState().setAutoUpdate(false);

    expect(mod.useSettingsStore.getState().autoUpdateEnabled).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('set_setting', {
      key: 'phase9.auto_update_enabled',
      value: JSON.stringify(false),
    });
  });

  it('hydrate() treats a missing key (null) as the default (true)', async () => {
    invokeMock.mockResolvedValue(null);

    const mod = await import('../settingsStore');
    // Force the store into the "off" state first so we can see hydrate leave it
    // alone when the persisted value is absent.
    mod.useSettingsStore.setState({ autoUpdateEnabled: true, loading: true });
    await mod.useSettingsStore.getState().hydrate();

    expect(mod.useSettingsStore.getState().autoUpdateEnabled).toBe(true);
    expect(mod.useSettingsStore.getState().loading).toBe(false);
  });
});
