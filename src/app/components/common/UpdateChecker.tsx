'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Badge, Button, Tooltip } from 'antd';
import { CloudDownloadOutlined } from '@ant-design/icons';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isTauri } from '@/app/lib/ipc';
import { useSettingsStore } from '@/app/stores/settingsStore';

const AUTO_CHECK_DELAY_MS = 3_000;
const AUTO_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

export function UpdateChecker() {
  const [appVersion, setAppVersion] = useState<string>('');
  const [checking, setChecking] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled);
  const { message, modal } = App.useApp();
  const promptedVersionRef = useRef<string | null>(null);

  const promptUpdate = useCallback(
    (update: Update) => {
      if (promptedVersionRef.current === update.version) return;
      promptedVersionRef.current = update.version;
      setHasUpdate(true);
      modal.confirm({
        title: `Update available: v${update.version}`,
        content: update.body || 'A new version of WordBrain is available. Update now?',
        okText: 'Update & Restart',
        cancelText: 'Later',
        onOk: async () => {
          message.loading({ content: 'Downloading update…', key: 'wb-update', duration: 0 });
          try {
            await update.downloadAndInstall();
            message.success({ content: 'Update installed. Restarting…', key: 'wb-update' });
            await relaunch();
          } catch (err) {
            message.error({ content: `Update failed: ${err}`, key: 'wb-update' });
          }
        },
        onCancel: () => {
          // Allow the same version to prompt again on the next manual click.
          promptedVersionRef.current = null;
        },
      });
    },
    [message, modal]
  );

  const runCheck = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!isTauri()) {
        if (!silent) message.info('Updates only available in the packaged app.');
        return;
      }
      setChecking(true);
      try {
        const update = await check();
        if (update) {
          promptUpdate(update);
        } else {
          setHasUpdate(false);
          if (!silent) message.success("You're on the latest version.");
        }
      } catch (err) {
        if (!silent) message.error(`Update check failed: ${err}`);
      } finally {
        setChecking(false);
      }
    },
    [message, promptUpdate]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) return;
      try {
        const v = await getVersion();
        if (!cancelled) setAppVersion(v);
      } catch {
        // tauri-apps/api throws outside Tauri; leave appVersion empty.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Silent auto-checks, gated on the user's preference. Manual clicks ignore this.
  useEffect(() => {
    if (!isTauri()) return;
    if (!autoUpdateEnabled) return;
    const startup = window.setTimeout(() => {
      void runCheck({ silent: true });
    }, AUTO_CHECK_DELAY_MS);
    const interval = window.setInterval(() => {
      void runCheck({ silent: true });
    }, AUTO_CHECK_INTERVAL_MS);
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(interval);
    };
  }, [autoUpdateEnabled, runCheck]);

  return (
    <Tooltip title="Check for updates">
      <Badge dot={hasUpdate} offset={[-4, 2]}>
        <Button
          type="text"
          size="small"
          icon={<CloudDownloadOutlined spin={checking} />}
          onClick={() => void runCheck()}
          loading={checking}
        >
          {appVersion ? `v${appVersion}` : null}
        </Button>
      </Badge>
    </Tooltip>
  );
}
