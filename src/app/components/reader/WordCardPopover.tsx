'use client';

import { useEffect, useState } from 'react';
import { Popover, Button, Typography, Tag, Space, Tabs, Spin, Select, Alert } from 'antd';
import { CheckOutlined, CloseOutlined, LinkOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { WordHighlightClickPayload } from './WordHighlightExtension';
import {
  lookupOffline,
  lookupOnline,
  lookupAi,
  type OfflineEntry,
  type OnlineLookupResult,
  type AiLookupResult,
  type OnlineProvider,
  type AiProvider,
} from '@/app/lib/dict';

const { Text, Paragraph } = Typography;

interface WordCardPopoverProps {
  payload: WordHighlightClickPayload;
  onClose: () => void;
  onMarkKnown: () => void;
  /** Sentence containing the word — fed to lookup_ai for contextual gloss. */
  contextSentence?: string;
  /** Optional hook: if provided a "Related docs" button surfaces the drawer. */
  onDrillLemma?: () => void;
}

export function WordCardPopover({
  payload,
  onClose,
  onMarkKnown,
  contextSentence,
  onDrillLemma,
}: WordCardPopoverProps) {
  const style: React.CSSProperties = {
    position: 'fixed',
    left: payload.rect.x,
    top: payload.rect.y,
    width: payload.rect.width,
    height: payload.rect.height,
    pointerEvents: 'none',
  };

  const content = (
    <div style={{ width: 360 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <Text strong style={{ fontSize: 18 }}>
          {payload.lemma}
        </Text>
        {payload.surface.toLowerCase() !== payload.lemma && (
          <Tag color="blue" style={{ fontSize: 11 }}>
            seen as {payload.surface}
          </Tag>
        )}
      </div>

      <Tabs
        size="small"
        defaultActiveKey="offline"
        items={[
          {
            key: 'offline',
            label: '离线',
            children: <OfflineTab lemma={payload.lemma} />,
          },
          {
            key: 'online',
            label: '在线',
            children: <OnlineTab lemma={payload.lemma} />,
          },
          {
            key: 'ai',
            label: '智能',
            children: (
              <AiTab lemma={payload.lemma} contextSentence={contextSentence ?? payload.surface} />
            ),
          },
        ]}
      />

      <Space style={{ marginTop: 8 }}>
        <Button type="primary" size="small" icon={<CheckOutlined />} onClick={onMarkKnown}>
          Mark known
        </Button>
        {onDrillLemma && (
          <Button size="small" icon={<LinkOutlined />} onClick={onDrillLemma}>
            Related docs
          </Button>
        )}
        <Button size="small" icon={<CloseOutlined />} onClick={onClose}>
          Close
        </Button>
      </Space>
    </div>
  );

  return (
    <div style={style}>
      <Popover
        content={content}
        open
        placement="bottom"
        trigger={[]}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <div style={{ width: '100%', height: '100%' }} />
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab bodies — each triggers its fetch lazily on mount so offline is free,
// online costs a round-trip only when the user clicks "在线", and AI only
// when they click "智能".
// ---------------------------------------------------------------------------

function OfflineTab({ lemma }: { lemma: string }) {
  const [loading, setLoading] = useState(true);
  const [entry, setEntry] = useState<OfflineEntry | null>(null);
  const [elapsed, setElapsed] = useState<number>(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

function OnlineTab({ lemma }: { lemma: string }) {
  const [provider, setProvider] = useState<OnlineProvider>('youdao');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<OnlineLookupResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const fetchNow = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await lookupOnline(lemma, provider);
      setResult(r);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch on first mount so the tab starts loading as soon as the user
  // clicks on it. If keys are missing the call surfaces an error.
  useEffect(() => {
    fetchNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

function AiTab({ lemma, contextSentence }: { lemma: string; contextSentence: string }) {
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

const DEFAULT_AI_MODEL: Record<AiProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-6',
  ollama: 'qwen2.5:3b',
};

const MODEL_OPTIONS: Record<AiProvider, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'],
  ollama: ['qwen2.5:3b', 'llama3.1:8b', 'gemma2:2b'],
};

function CacheBadge({
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
      {cached ? '✓ cache' : `⟳ live`} {elapsed} ms
    </Tag>
  );
}
