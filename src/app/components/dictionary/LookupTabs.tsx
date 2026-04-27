'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Select, Spin, Tag, Typography } from 'antd';
import { ThunderboltOutlined } from '@ant-design/icons';
import {
  lookupAi,
  lookupOffline,
  lookupOnline,
  type AiLookupResult,
  type AiProvider,
  type OfflineEntry,
  type OnlineLookupResult,
  type OnlineProvider,
} from '@/app/lib/dict';
import { AI_PROVIDER_OPTIONS, MODEL_OPTIONS } from '@/app/lib/ai-models';
import { useSettingsStore } from '@/app/stores/settingsStore';

const { Text, Paragraph } = Typography;

export function CacheBadge({
  label,
  elapsed,
  cached,
}: {
  label: string;
  elapsed: number;
  cached: boolean;
}) {
  return (
    <Tag
      color={cached ? 'green' : 'orange'}
      style={{ fontSize: 11, marginLeft: 6 }}
      title={cached ? 'served from local cache' : 'fresh fetch'}
    >
      {cached ? '✓ cache' : `⟳ live`} {elapsed} ms · {label}
    </Tag>
  );
}

export function OfflineTab({ lemma }: { lemma: string }) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<OfflineEntry | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEntry(null);
    setErr(null);
    (async () => {
      try {
        const res = await lookupOffline(lemma);
        if (cancelled) return;
        setEntry(res.entry);
        setElapsed(res.elapsed_ms);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lemma]);

  if (loading) return <Spin size="small" />;
  if (err) return <Alert type="error" title={err} showIcon />;
  if (!entry)
    return (
      <Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        ECDICT has no entry for <Text code>{lemma}</Text>.
      </Paragraph>
    );
  return (
    <div>
      <div style={{ marginBottom: 4 }}>
        {entry.pos && <Tag color="purple">{entry.pos}</Tag>}
        {entry.ipa && <Text type="secondary">/{entry.ipa}/</Text>}
        <CacheBadge label="bundled" elapsed={elapsed} cached={true} />
      </div>
      {entry.definitions_zh && (
        <Paragraph style={{ fontSize: 13, marginBottom: 4, whiteSpace: 'pre-wrap' }}>
          {entry.definitions_zh}
        </Paragraph>
      )}
      {entry.definitions_en && (
        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          {entry.definitions_en}
        </Paragraph>
      )}
    </div>
  );
}

export function OnlineTab({ lemma }: { lemma: string }) {
  const [provider, setProvider] = useState<OnlineProvider>('youdao');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnlineLookupResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setResult(null);
    (async () => {
      try {
        const r = await lookupOnline(lemma, provider);
        if (!cancelled) setResult(r);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lemma, provider]);

  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        <Select
          size="small"
          value={provider}
          style={{ width: 110 }}
          onChange={(v) => setProvider(v)}
          options={[
            { value: 'youdao', label: '有道' },
            { value: 'deepl', label: 'DeepL' },
          ]}
        />
      </div>
      {loading && <Spin size="small" />}
      {err && <Alert type="warning" title={err} showIcon style={{ marginTop: 4 }} />}
      {result && !loading && (
        <div>
          <div style={{ marginBottom: 4 }}>
            <Tag color="blue">{result.provider}</Tag>
            <CacheBadge
              label={result.provider}
              elapsed={result.elapsed_ms}
              cached={result.cached}
            />
          </div>
          <Paragraph style={{ fontSize: 13, marginBottom: 4, whiteSpace: 'pre-wrap' }}>
            {result.translation_zh || <Text type="secondary">(empty response)</Text>}
          </Paragraph>
          {result.example && (
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              例：{result.example}
            </Paragraph>
          )}
        </div>
      )}
    </div>
  );
}

export function AiTab({ lemma, contextSentence }: { lemma: string; contextSentence: string }) {
  const provider = useSettingsStore((s) => s.aiProvider);
  const model = useSettingsStore((s) => s.aiModels[s.aiProvider]);
  const setAiProvider = useSettingsStore((s) => s.setAiProvider);
  const setAiModel = useSettingsStore((s) => s.setAiModel);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AiLookupResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const runLookup = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await lookupAi(lemma, contextSentence, provider, model);
      setResult(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <Select
          size="small"
          value={provider}
          style={{ width: 100 }}
          onChange={(v) => {
            void setAiProvider(v as AiProvider);
          }}
          options={AI_PROVIDER_OPTIONS}
        />
        <Select
          size="small"
          value={model}
          style={{ minWidth: 140 }}
          onChange={(v) => void setAiModel(provider, v)}
          options={(MODEL_OPTIONS[provider] ?? []).map((m) => ({ value: m, label: m }))}
        />
        <Button
          size="small"
          type="primary"
          icon={<ThunderboltOutlined />}
          onClick={runLookup}
          loading={loading}
        >
          Ask
        </Button>
      </div>
      <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 6 }}>
        Uses this sentence as context (sha1-hashed for cache key).
      </Paragraph>
      {err && <Alert type="warning" title={err} showIcon style={{ marginTop: 4 }} />}
      {result && !loading && (
        <div>
          <div style={{ marginBottom: 4 }}>
            <Tag color="gold">
              {result.provider}/{result.model}
            </Tag>
            <CacheBadge label="ai" elapsed={result.elapsed_ms} cached={result.cached} />
          </div>
          <Paragraph style={{ fontSize: 13, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            {result.translation_zh}
          </Paragraph>
        </div>
      )}
    </div>
  );
}
