'use client';

import { useEffect, useState } from 'react';
import { App, Alert, Button, Card, Divider, Select, Space, Switch, Tag, Typography } from 'antd';
import {
  ThunderboltOutlined,
  CheckCircleTwoTone,
  CloseCircleTwoTone,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  aiProviderStatus,
  codexAuthStatus,
  importOpenAiKeyFromCodexAuth,
  listCodexModelsFromAuth,
  type CodexAuthStatus,
  type CodexModelInfo,
  type ProviderStatusReport,
} from '@/app/lib/ai';
import { listConfiguredProviders, saveApiKey } from '@/app/lib/dict';
import type { AiProvider } from '@/app/lib/dict';
import { AI_PROVIDER_OPTIONS, MODEL_OPTIONS } from '@/app/lib/ai-models';
import { isTauri } from '@/app/lib/ipc';
import { useSettingsStore } from '@/app/stores/settingsStore';
import { ProviderKeyRows, type ProviderKeyDef } from './ProviderKeyRows';

const { Paragraph, Text } = Typography;

const AI_KEY_PROVIDERS: ProviderKeyDef[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'API key (sk-...) for the optional HTTP fallback.',
    placeholder: 'sk-...',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'API key (sk-ant-...) for the optional HTTP fallback.',
    placeholder: 'sk-ant-...',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    hint: 'Runs on 127.0.0.1:11434. Save any marker value to show it as configured.',
    placeholder: 'local: ok',
  },
];

export function AiPanel() {
  const { message } = App.useApp();
  const [report, setReport] = useState<ProviderStatusReport | null>(null);
  const [codexAuth, setCodexAuth] = useState<CodexAuthStatus | null>(null);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexModels, setCodexModels] = useState<CodexModelInfo[]>([]);
  const [modelsSource, setModelsSource] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const httpFallback = useSettingsStore((s) => s.httpFallbackEnabled);
  const setHttpFallback = useSettingsStore((s) => s.setHttpFallback);
  const aiProvider = useSettingsStore((s) => s.aiProvider);
  const aiModel = useSettingsStore((s) => s.aiModels[s.aiProvider]);
  const setAiProvider = useSettingsStore((s) => s.setAiProvider);
  const setAiModel = useSettingsStore((s) => s.setAiModel);
  const canUseCodexAuth = Boolean(codexAuth?.authFileFound);

  const refreshKeys = async () => {
    if (!isTauri()) return;
    try {
      setConfigured(new Set(await listConfiguredProviders()));
    } catch (err) {
      console.error('[wordbrain] load configured AI providers', err);
    }
  };

  const refreshCodexAuth = async () => {
    if (!isTauri()) return;
    try {
      setCodexAuth(await codexAuthStatus());
    } catch (err) {
      console.error('[wordbrain] codex_auth_status', err);
    }
  };

  const refreshCodexModels = async () => {
    if (!isTauri()) return;
    setModelsBusy(true);
    setModelsError(null);
    try {
      const result = await listCodexModelsFromAuth();
      setCodexModels(result.models);
      setModelsSource(result.source);
      if (result.models.length === 0) {
        setModelsError('Codex model API returned no models.');
      }
    } catch (err) {
      setCodexModels([]);
      setModelsSource(null);
      setModelsError(String(err));
    } finally {
      setModelsBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) {
        setLoading(false);
        return;
      }
      try {
        const [providerReport, authReport, configuredProviders] = await Promise.all([
          aiProviderStatus(),
          codexAuthStatus(),
          listConfiguredProviders(),
        ]);
        if (!cancelled) {
          setReport(providerReport);
          setCodexAuth(authReport);
          setConfigured(new Set(configuredProviders));
        }
        if (!cancelled && (authReport.hasApiKey || authReport.hasOauthToken)) {
          void refreshCodexModels();
        }
      } catch (err) {
        console.error('[wordbrain] ai settings hydrate', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (aiProvider !== 'openai' || codexModels.length === 0) return;
    if (codexModels.some((model) => model.id === aiModel)) return;
    const nextModel = codexModels.find((model) => model.supportedInApi) ?? codexModels[0];
    if (nextModel) void setAiModel('openai', nextModel.id);
  }, [aiProvider, aiModel, codexModels, setAiModel]);

  const onSaveKey = async (provider: string, value: string) => {
    setKeyBusy(provider);
    try {
      await saveApiKey(provider, value);
      message.success(`${provider} key saved`);
      await refreshKeys();
    } catch (err) {
      message.error(`Save failed: ${err}`);
    } finally {
      setKeyBusy(null);
    }
  };

  const onClearKey = async (provider: string) => {
    setKeyBusy(provider);
    try {
      await saveApiKey(provider, '');
      message.success(`${provider} key cleared`);
      await refreshKeys();
    } catch (err) {
      message.error(`Clear failed: ${err}`);
    } finally {
      setKeyBusy(null);
    }
  };

  const importCodexKey = async () => {
    setCodexBusy(true);
    try {
      const result = await importOpenAiKeyFromCodexAuth();
      setCodexAuth(result.status);
      if (result.imported) {
        message.success(result.message);
        await refreshKeys();
      } else if (result.status.hasOauthToken) {
        message.success(result.message);
      } else {
        message.info(result.message);
      }
      if (result.status.hasApiKey || result.status.hasOauthToken) {
        await refreshCodexModels();
      }
    } catch (err) {
      message.error(`Codex auth import failed: ${err}`);
    } finally {
      setCodexBusy(false);
      await refreshCodexAuth();
    }
  };

  const openAiModelOptions =
    aiProvider === 'openai' && codexModels.length > 0
      ? codexModels.map((model) => ({
          value: model.id,
          label: model.label === model.id ? model.id : `${model.label} (${model.id})`,
          disabled: !model.supportedInApi,
        }))
      : (MODEL_OPTIONS[aiProvider] ?? []).map((model) => ({
          value: model,
          label: model,
        }));

  return (
    <Card
      size="small"
      title={
        <span>
          <ThunderboltOutlined /> AI
        </span>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Story Review and Writing Train use local CLI providers first. API keys power the optional
        HTTP fallback.
      </Paragraph>

      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="AI provider detection is disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}

      <Space orientation="vertical" style={{ width: '100%' }} size={8}>
        {(report?.providers ?? []).map((p) => (
          <div key={p.channel} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {p.available ? (
              <CheckCircleTwoTone twoToneColor="#52c41a" />
            ) : (
              <CloseCircleTwoTone twoToneColor="#ff4d4f" />
            )}
            <Text strong>{p.channel}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {p.available ? (p.resolved_path ?? p.binary) : `binary \`${p.binary}\` not on PATH`}
            </Text>
            {p.available && (
              <Tag color="success" style={{ marginLeft: 'auto' }}>
                ready
              </Tag>
            )}
          </div>
        ))}
        {loading && isTauri() && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Detecting providers...
          </Text>
        )}
        {report && !report.any_available && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message="No CLI provider detected"
            description={
              <span>
                Install <Text code>claude</Text> (
                <a
                  href="https://docs.claude.com/en/docs/claude-code/setup"
                  target="_blank"
                  rel="noreferrer"
                >
                  setup
                </a>
                ) or <Text code>codex</Text> (
                <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
                  setup
                </a>
                ) and re-launch WordBrain.
              </span>
            }
          />
        )}
      </Space>

      <Divider style={{ margin: '14px 0 12px' }} />
      <Space orientation="vertical" size={12} style={{ width: '100%' }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
          <Space orientation="vertical" size={2}>
            <Text strong>Codex auth</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {codexAuthSummary(codexAuth)}
            </Text>
          </Space>
          <Button
            size="small"
            loading={codexBusy}
            disabled={!canUseCodexAuth}
            onClick={() => void importCodexKey()}
          >
            {codexAuth?.hasApiKey ? 'Use Codex OpenAI key' : 'Use Codex CLI token'}
          </Button>
        </Space>
        <Space size={6} wrap>
          <Tag color={codexAuth?.authFileFound ? 'success' : 'default'}>
            {codexAuth?.authFileFound ? 'auth file found' : 'auth file missing'}
          </Tag>
          <Tag color={codexAuth?.hasOauthToken ? 'success' : 'default'}>
            {codexAuth?.hasOauthToken ? 'CLI token found' : 'no CLI token'}
          </Tag>
          <Tag color={codexAuth?.hasApiKey ? 'success' : 'default'}>
            {codexAuth?.hasApiKey ? 'Codex API key found' : 'no Codex API key'}
          </Tag>
          <Tag color={configured.has('openai') ? 'success' : 'warning'}>
            {configured.has('openai') ? 'OpenAI key configured' : 'OpenAI key not configured'}
          </Tag>
        </Space>

        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
          <Space orientation="vertical" size={2}>
            <Text strong>Default API model</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Used by the optional HTTP fallback path.
            </Text>
          </Space>
          <Space.Compact>
            <Select
              size="small"
              value={aiProvider}
              options={AI_PROVIDER_OPTIONS}
              onChange={(value) => void setAiProvider(value as AiProvider)}
              style={{ width: 120 }}
            />
            <Select
              size="small"
              value={aiModel}
              loading={aiProvider === 'openai' && modelsBusy}
              options={openAiModelOptions}
              onChange={(value) => void setAiModel(aiProvider, value)}
              style={{ minWidth: 190 }}
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              title="Reload Codex models"
              aria-label="Reload Codex models"
              loading={modelsBusy}
              disabled={!canUseCodexAuth}
              onClick={() => void refreshCodexModels()}
            />
          </Space.Compact>
        </Space>
        <Space size={6} wrap>
          <Tag color={codexModels.length > 0 ? 'success' : 'default'}>
            {codexModels.length > 0
              ? `${codexModels.length} Codex models loaded`
              : 'Codex models not loaded'}
          </Tag>
          {modelsSource && <Tag color="processing">{modelsSource}</Tag>}
          {modelsError && <Tag color="warning">{modelsError}</Tag>}
        </Space>

        <ProviderKeyRows
          providers={AI_KEY_PROVIDERS}
          configured={configured}
          busyProvider={keyBusy}
          onSave={onSaveKey}
          onClear={onClearKey}
        />
      </Space>

      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: '1px solid var(--ant-color-border-secondary, #f0f0f0)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <Space orientation="vertical" size={2} style={{ flex: 1 }}>
          <Text strong>Use HTTP fallback</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            When both CLI channels fail, fall back to the configured OpenAI / Anthropic / Ollama
            HTTP path.
          </Text>
        </Space>
        <Switch
          checked={httpFallback}
          onChange={async (v) => {
            try {
              await setHttpFallback(v);
              message.success(v ? 'HTTP fallback enabled' : 'HTTP fallback off');
            } catch (err) {
              message.error(`Could not save preference: ${err}`);
            }
          }}
        />
      </div>
    </Card>
  );
}

function codexAuthSummary(status: CodexAuthStatus | null) {
  if (!status) return 'Checking ~/.codex/auth.json...';
  if (!status.authFileFound) return '~/.codex/auth.json not found.';
  if (status.hasApiKey) return 'OpenAI API key found in Codex auth.';
  if (status.hasOauthToken) return 'Codex CLI token found; the local codex CLI can use it.';
  return 'Codex auth file found, but no usable token was detected.';
}
