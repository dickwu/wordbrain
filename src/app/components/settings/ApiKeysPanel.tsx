'use client';

import { useEffect, useState } from 'react';
import {
  Card,
  Form,
  Input,
  Button,
  Space,
  Tag,
  Typography,
  Alert,
  App as AntApp,
} from 'antd';
import { KeyOutlined, DeleteOutlined, CheckCircleTwoTone } from '@ant-design/icons';
import {
  saveApiKey,
  hasApiKey,
  listConfiguredProviders,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;

interface ProviderDef {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
  secure?: boolean;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'youdao',
    label: '有道 (Youdao)',
    hint: 'Format: APP_KEY:APP_SECRET (free tier at ai.youdao.com)',
    placeholder: 'xxxxxxxx:xxxxxxxxxxxxxxxxxxxxxxxx',
    secure: true,
  },
  {
    id: 'deepl',
    label: 'DeepL',
    hint: 'Auth key from deepl.com. Free-tier keys end in ":fx".',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx',
    secure: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Your own API key (sk-…) used for contextual AI gloss.',
    placeholder: 'sk-…',
    secure: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'API key (sk-ant-…) for Claude-powered gloss.',
    placeholder: 'sk-ant-…',
    secure: true,
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    hint: 'Runs on 127.0.0.1:11434 — no key needed. Toggle to mark as "ready".',
    placeholder: 'local: ok',
    secure: false,
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
    <Card title={<span><KeyOutlined /> BYOK — API Keys</span>} size="small">
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Keys are encrypted at rest via tauri-plugin-stronghold and never leave
        the Rust backend after saving. Clear the slot by saving an empty
        value.
      </Paragraph>
      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Running in browser dev — key storage is disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {PROVIDERS.map((p) => (
          <ProviderRow
            key={p.id}
            provider={p}
            configured={configured.has(p.id)}
            busy={busy === p.id}
            onSave={(value) => onSave(p.id, value)}
            onClear={() => onClear(p.id)}
          />
        ))}
      </Space>
    </Card>
  );
}

function ProviderRow({
  provider,
  configured,
  busy,
  onSave,
  onClear,
}: {
  provider: ProviderDef;
  configured: boolean;
  busy: boolean;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    // Clear the input whenever it successfully saves.
    if (!touched && configured) setValue('');
  }, [configured, touched]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <Text strong>{provider.label}</Text>
        <span style={{ flex: 1 }} />
        {configured && (
          <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">
            configured
          </Tag>
        )}
      </div>
      <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 4 }}>
        {provider.hint}
      </Paragraph>
      <Space.Compact style={{ width: '100%' }}>
        <Input.Password
          size="small"
          placeholder={provider.placeholder}
          value={value}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
          autoComplete="off"
        />
        <Button
          type="primary"
          size="small"
          loading={busy}
          disabled={!value}
          onClick={async () => {
            await onSave(value);
            setValue('');
            setTouched(false);
          }}
        >
          Save
        </Button>
        <Button
          size="small"
          icon={<DeleteOutlined />}
          disabled={!configured || busy}
          onClick={onClear}
        >
          Clear
        </Button>
      </Space.Compact>
    </div>
  );
}
