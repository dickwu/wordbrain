'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Empty,
  FloatButton,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  theme,
  Typography,
} from 'antd';
import { BookOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import {
  listCustomDictionaries,
  lookupCustomDictionary,
  type CustomDictionary,
  type CustomDictionaryLookupEntry,
  type CustomDictionaryLookupResult,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Text, Title } = Typography;

interface DictionaryFloatProps {
  onOpenSettings: () => void;
}

export function DictionaryFloat({ onOpenSettings }: DictionaryFloatProps) {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState('');

  const openModal = () => {
    const selection = window.getSelection?.()?.toString().trim();
    const firstWord = selection?.match(/[A-Za-z][A-Za-z'’-]*/)?.[0];
    setInitialQuery(firstWord?.toLowerCase() ?? '');
    setOpen(true);
  };

  return (
    <>
      <FloatButton
        icon={<BookOutlined />}
        tooltip="Dictionary"
        onClick={openModal}
        style={{ right: 32, bottom: 32 }}
      />

      {open && (
        <DictionaryLookupModal
          visible={true}
          initialQuery={initialQuery}
          onClose={() => setOpen(false)}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );
}

interface DictionaryLookupModalProps {
  visible: boolean;
  initialQuery: string;
  onClose: () => void;
  onOpenSettings: () => void;
}

function DictionaryLookupModal({
  visible,
  initialQuery,
  onClose,
  onOpenSettings,
}: DictionaryLookupModalProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selectedDictionaryId, setSelectedDictionaryId] = useState<number | null>(null);
  const [dictionaries, setDictionaries] = useState<CustomDictionary[]>([]);
  const [result, setResult] = useState<CustomDictionaryLookupResult | null>(null);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingDictionaries, setLoadingDictionaries] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dictionaryOptions = useMemo(
    () => [
      { value: 0, label: 'All dictionaries' },
      ...dictionaries.map((dict) => ({ value: dict.id, label: dict.name })),
    ],
    [dictionaries]
  );

  const activeEntry = result?.entries[activeEntryIndex] ?? null;

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    setLoadingDictionaries(true);
    listCustomDictionaries()
      .then((items) => {
        if (!cancelled) setDictionaries(items);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingDictionaries(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runLookup = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setErr(null);
    try {
      const next = await lookupCustomDictionary(trimmed, {
        dictionaryId: selectedDictionaryId,
        limit: 4,
      });
      setResult(next);
      setActiveEntryIndex(0);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  const openSettings = () => {
    onClose();
    onOpenSettings();
  };

  return (
    <Modal
      title="Dictionary"
      open={visible}
      onCancel={onClose}
      footer={null}
      width="min(1040px, calc(100vw - 32px))"
      styles={{ body: { paddingTop: 12 } }}
    >
      {!isTauri() ? (
        <Alert type="info" showIcon message="Dictionary lookup requires the Tauri shell." />
      ) : loadingDictionaries ? (
        <Spin size="small" />
      ) : dictionaries.length === 0 ? (
        <Empty description="No dictionaries imported">
          <Button icon={<SettingOutlined />} onClick={openSettings}>
            Settings
          </Button>
        </Empty>
      ) : (
        <Space orientation="vertical" style={{ width: '100%' }} size={12}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
              gap: 8,
            }}
          >
            <Select
              size="small"
              value={selectedDictionaryId ?? 0}
              style={{ width: '100%' }}
              options={dictionaryOptions}
              onChange={(value) => setSelectedDictionaryId(value === 0 ? null : value)}
            />
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onPressEnter={runLookup}
                placeholder="Look up a word"
                autoFocus
              />
              <Button
                type="primary"
                icon={<SearchOutlined />}
                loading={loading}
                disabled={!query.trim()}
                onClick={runLookup}
              >
                Search
              </Button>
            </Space.Compact>
          </div>

          {err && <Alert type="warning" showIcon message={err} />}
          {loading && <Spin size="small" />}

          {result && !loading && result.entries.length === 0 && (
            <Empty description={`No entry for "${result.query}"`}>
              <Button icon={<SettingOutlined />} onClick={openSettings}>
                Settings
              </Button>
            </Empty>
          )}

          {result && !loading && activeEntry && (
            <DictionaryPage
              entries={result.entries}
              activeEntry={activeEntry}
              activeEntryIndex={activeEntryIndex}
              elapsedMs={result.elapsed_ms}
              onEntryChange={setActiveEntryIndex}
            />
          )}
        </Space>
      )}
    </Modal>
  );
}

function DictionaryPage({
  entries,
  activeEntry,
  activeEntryIndex,
  elapsedMs,
  onEntryChange,
}: {
  entries: CustomDictionaryLookupEntry[];
  activeEntry: CustomDictionaryLookupEntry;
  activeEntryIndex: number;
  elapsedMs: number;
  onEntryChange: (index: number) => void;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        minHeight: 520,
      }}
    >
      {entries.length > 1 && (
        <div
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 6,
            flex: '0 1 220px',
            overflow: 'hidden',
          }}
        >
          {entries.map((entry, index) => (
            <button
              key={`${entry.dictionary_id}-${entry.headword}-${index}`}
              type="button"
              onClick={() => onEntryChange(index)}
              style={{
                width: '100%',
                border: 0,
                borderBottom:
                  index === entries.length - 1 ? 0 : `1px solid ${token.colorBorderSecondary}`,
                padding: '10px 12px',
                textAlign: 'left',
                background:
                  index === activeEntryIndex ? token.controlItemBgActive : token.colorBgContainer,
                color: token.colorText,
                cursor: 'pointer',
              }}
            >
              <Text strong>{entry.headword}</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {entry.dictionary_name}
              </Text>
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: '1 1 420px', minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <Space size={6} wrap>
            <Title level={5} style={{ margin: 0 }}>
              {activeEntry.headword}
            </Title>
            <Tag color="blue">{activeEntry.dictionary_name}</Tag>
            {activeEntry.resolved_from && <Tag color="gold">from {activeEntry.resolved_from}</Tag>}
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {entries.length} result{entries.length === 1 ? '' : 's'} · {elapsedMs} ms
          </Text>
        </div>

        <iframe
          title={`${activeEntry.dictionary_name}: ${activeEntry.headword}`}
          srcDoc={activeEntry.definition_page_html || activeEntry.definition_html}
          sandbox=""
          style={{
            width: '100%',
            height: 'min(64vh, 640px)',
            minHeight: 500,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 6,
            background: token.colorBgContainer,
          }}
        />
      </div>
    </div>
  );
}
