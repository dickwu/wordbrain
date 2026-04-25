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

const { Text, Paragraph } = Typography;

export const DEFAULT_AI_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  ollama: 'qwen2.5:3b',
};

export const MODEL_OPTIONS: Record<AiProvider, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'],
  ollama: ['qwen2.5:3b', 'llama3.1:8b', 'gemma2:2b'],
};

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
  if (err) return <Alert type="error" message={err} showIcon />;
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
      {err && <Alert type="warning" message={err} showIcon style={{ marginTop: 4 }} />}
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
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState<string>(DEFAULT_AI_MODEL.openai);
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
            setProvider(v);
            setModel(DEFAULT_AI_MODEL[v]);
          }}
          options={[
            { value: 'openai', label: 'OpenAI' },
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'ollama', label: 'Ollama' },
          ]}
        />
        <Select
          size="small"
          value={model}
          style={{ minWidth: 140 }}
          onChange={(v) => setModel(v)}
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
      {err && <Alert type="warning" message={err} showIcon style={{ marginTop: 4 }} />}
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
