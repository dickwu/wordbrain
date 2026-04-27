import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

// Mock the IPC bindings BEFORE importing the panel so the module sees the mock.
vi.mock('@/app/lib/ai', () => ({
  aiProviderStatus: vi.fn(),
}));

vi.mock('@/app/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/app/lib/ipc')>('@/app/lib/ipc');
  return {
    ...actual,
    isTauri: () => true,
    getSetting: vi.fn(async () => null),
    setSetting: vi.fn(),
  };
});

import { AiPanel } from '../AiPanel';
import { aiProviderStatus } from '@/app/lib/ai';

function renderPanel() {
  return render(
    <ConfigProvider>
      <AntApp>
        <AiPanel />
      </AntApp>
    </ConfigProvider>
  );
}

describe('AiPanel', () => {
  beforeEach(() => {
    vi.mocked(aiProviderStatus).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders ✅ rows for each available provider', async () => {
    vi.mocked(aiProviderStatus).mockResolvedValue({
      providers: [
        {
          channel: 'claude-p',
          binary: 'claude',
          available: true,
          resolved_path: '/usr/local/bin/claude',
        },
        {
          channel: 'codex-cli',
          binary: 'codex',
          available: true,
          resolved_path: '/opt/homebrew/bin/codex',
        },
      ],
      any_available: true,
    });

    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('claude-p')).toBeDefined();
      expect(screen.getByText('codex-cli')).toBeDefined();
      // both rows should expose the resolved path the backend reported.
      expect(screen.getByText('/usr/local/bin/claude')).toBeDefined();
      expect(screen.getByText('/opt/homebrew/bin/codex')).toBeDefined();
      // ready chips appear once per available provider
      expect(screen.getAllByText('ready').length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders ❌ + install hint when neither provider resolves', async () => {
    vi.mocked(aiProviderStatus).mockResolvedValue({
      providers: [
        { channel: 'claude-p', binary: 'claude', available: false, resolved_path: null },
        { channel: 'codex-cli', binary: 'codex', available: false, resolved_path: null },
      ],
      any_available: false,
    });

    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/binary `claude` not on PATH/i)).toBeDefined();
      expect(screen.getByText(/binary `codex` not on PATH/i)).toBeDefined();
      expect(screen.getByText('No CLI provider detected')).toBeDefined();
    });
  });

  it('shows the HTTP-fallback toggle (off by default)', async () => {
    vi.mocked(aiProviderStatus).mockResolvedValue({
      providers: [
        { channel: 'claude-p', binary: 'claude', available: true, resolved_path: '/x' },
        { channel: 'codex-cli', binary: 'codex', available: false, resolved_path: null },
      ],
      any_available: true,
    });

    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Use HTTP fallback/i)).toBeDefined();
    });
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });
});
