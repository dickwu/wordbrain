'use client';

import { useEffect, useState } from 'react';
import { Card, Typography, Alert, App as AntApp } from 'antd';
import { KeyOutlined } from '@ant-design/icons';
import { saveApiKey, listConfiguredProviders } from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';
import { ProviderKeyRows, type ProviderKeyDef } from './ProviderKeyRows';

const { Paragraph } = Typography;

const ONLINE_DICTIONARY_PROVIDERS: ProviderKeyDef[] = [
  {
    id: 'youdao',
    label: '有道 (Youdao)',
    hint: 'Format: APP_KEY:APP_SECRET (free tier at ai.youdao.com)',
    placeholder: 'xxxxxxxx:xxxxxxxxxxxxxxxxxxxxxxxx',
  },
  {
    id: 'deepl',
    label: 'DeepL',
    hint: 'Auth key from deepl.com. Free-tier keys end in ":fx".',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx',
  },
];

export function ApiKeysPanel() {
  const { message } = AntApp.useApp();
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      const list = await listConfiguredProviders();
      setConfigured(new Set(list));
    } catch (err) {
      console.error('[wordbrain] load configured providers', err);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onSave = async (provider: string, value: string) => {
    setBusy(provider);
    try {
      await saveApiKey(provider, value);
      message.success(`${provider} key saved`);
      await refresh();
    } catch (err) {
      message.error(`Save failed: ${err}`);
    } finally {
      setBusy(null);
    }
  };

  const onClear = async (provider: string) => {
    setBusy(provider);
    try {
      await saveApiKey(provider, '');
      message.success(`${provider} key cleared`);
      await refresh();
    } catch (err) {
      message.error(`Clear failed: ${err}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={
        <span>
          <KeyOutlined /> Online Dictionary Keys
        </span>
      }
      size="small"
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Youdao and DeepL keys are encrypted at rest and only read by the Rust backend.
      </Paragraph>
      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Running in browser dev — key storage is disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}
      <ProviderKeyRows
        providers={ONLINE_DICTIONARY_PROVIDERS}
        configured={configured}
        busyProvider={busy}
        onSave={onSave}
        onClear={onClear}
      />
    </Card>
  );
}
