'use client';

import { useEffect, useState } from 'react';
import { App, Alert, Card, Space, Switch, Tag, Typography } from 'antd';
import { ThunderboltOutlined, CheckCircleTwoTone, CloseCircleTwoTone } from '@ant-design/icons';
import { aiProviderStatus, type ProviderStatusReport } from '@/app/lib/ai';
import { isTauri } from '@/app/lib/ipc';
import { useSettingsStore } from '@/app/stores/settingsStore';

const { Paragraph, Text } = Typography;

export function AiPanel() {
  const { message } = App.useApp();
  const [report, setReport] = useState<ProviderStatusReport | null>(null);
  const [loading, setLoading] = useState(true);

  const httpFallback = useSettingsStore((s) => s.httpFallbackEnabled);
  const setHttpFallback = useSettingsStore((s) => s.setHttpFallback);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) {
        setLoading(false);
        return;
      }
      try {
        const r = await aiProviderStatus();
        if (!cancelled) setReport(r);
      } catch (err) {
        console.error('[wordbrain] ai_provider_status', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      size="small"
      title={
        <span>
          <ThunderboltOutlined /> AI Providers (Story / Writing)
        </span>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Story Review and Writing Train call your local CLI tools. WordBrain tries{' '}
        <Text code>claude -p</Text> first, then falls back to <Text code>codex exec</Text>. No API
        key is required when these CLIs are signed in.
      </Paragraph>

      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Provider detection is disabled outside the Tauri shell."
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
            Detecting providers…
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
                ) and re-launch WordBrain. Until one is reachable, Story Review and Writing Train
                will surface an "AI unavailable" error.
              </span>
            }
          />
        )}
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
          <Text strong>Use HTTP fallback (opt-in)</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            When both CLI channels fail, fall back to the existing OpenAI / Anthropic / Ollama HTTP
            path. Off by default — flip on only if you accept the network round-trip.
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
