'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  theme,
  Typography,
} from 'antd';
import {
  CheckOutlined,
  LinkOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  listCustomDictionaries,
  lookupCustomDictionary,
  type CustomDictionary,
  type CustomDictionaryLookupEntry,
  type CustomDictionaryLookupResult,
} from '@/app/lib/dict';
import { addToSrs, isTauri } from '@/app/lib/ipc';
import {
  isLookupCandidate,
  normalizeLookupQuery,
  recordLookupHistory,
} from '@/app/lib/lookup-history';
import { refreshDueCount } from '@/app/stores/srsStore';
import { looksLikeNameToken, useWordStore } from '@/app/stores/wordStore';
import { AiTab, OfflineTab, OnlineTab } from './LookupTabs';

const { Text, Title } = Typography;

export { isLookupCandidate, normalizeLookupQuery };

interface WordLookupModalProps {
  visible: boolean;
  initialQuery: string;
  /** Original surface form when it differs from the lookup key. */
  surface?: string;
  /** Sentence containing the word — fed to lookup_ai for contextual gloss. */
  contextSentence?: string;
  /** When true and `initialQuery` is non-empty, fire `runLookup` once on mount. */
  autoSearch?: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onShowLinked?: (lemma: string) => void;
}

export function WordLookupModal({
  visible,
  initialQuery,
  surface,
  contextSentence,
  autoSearch = false,
  onClose,
  onOpenSettings,
  onShowLinked,
}: WordLookupModalProps) {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState(initialQuery);
  const [selectedDictionaryId, setSelectedDictionaryId] = useState<number | null>(null);
  const [dictionaries, setDictionaries] = useState<CustomDictionary[]>([]);
  const [result, setResult] = useState<CustomDictionaryLookupResult | null>(null);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingDictionaries, setLoadingDictionaries] = useState(false);
  const [addingToSrs, setAddingToSrs] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ranAutoRef = useRef(false);

  const dictionaryOptions = useMemo(
    () => [
      { value: 0, label: 'All dictionaries' },
      ...dictionaries.map((dict) => ({ value: dict.id, label: dict.name })),
    ],
    [dictionaries]
  );

  const activeEntry = result?.entries[activeEntryIndex] ?? null;
  const lemmaForTabs = normalizeLookupQuery(query);
  const actionLemma = lemmaForTabs || normalizeLookupQuery(initialQuery);
  const surfaceLabel = surface?.trim() || query.trim() || actionLemma;
  const canIgnoreName = Boolean(actionLemma && surfaceLabel && looksLikeNameToken(surfaceLabel));

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

  const runLookup = async (overrideQuery?: string) => {
    const trimmed = (overrideQuery ?? query).trim();
    if (!trimmed) return;
    recordLookupHistory(trimmed);
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

  // Auto-fire the custom-dictionary lookup once the dictionaries list is
  // loaded, when caller asked for it (double-click / clipboard path). Guarded
  // so we never refire if the user later edits the query.
  useEffect(() => {
    if (!autoSearch || ranAutoRef.current) return;
    if (loadingDictionaries) return;
    if (!query.trim()) return;
    ranAutoRef.current = true;
    void runLookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSearch, loadingDictionaries, query]);

  const openSettings = () => {
    onClose();
    onOpenSettings?.();
  };

  const markKnown = () => {
    if (!actionLemma) return;
    useWordStore.getState().markKnown(actionLemma);
    message.success(`Marked "${surfaceLabel || actionLemma}" as known`);
    onClose();
  };

  const markName = () => {
    if (!actionLemma) return;
    useWordStore.getState().markKnownName(actionLemma);
    message.success(`Ignored name "${surfaceLabel || actionLemma}"`);
    onClose();
  };

  const handleAddToSrs = async () => {
    if (!actionLemma) return;
    setAddingToSrs(true);
    try {
      if (!isTauri()) {
        message.info(`[dev] would schedule "${actionLemma}" for SRS`);
      } else {
        const out = await addToSrs(actionLemma);
        if (out.already_scheduled) {
          message.info(`"${actionLemma}" is already in your review queue.`);
        } else {
          message.success(`Added "${actionLemma}" to the review queue.`);
        }
        await refreshDueCount();
      }
    } catch (e) {
      message.error(`Failed to add to SRS: ${e}`);
    } finally {
      setAddingToSrs(false);
    }
  };

  const showLinked = () => {
    if (!actionLemma || !onShowLinked) return;
    onShowLinked(actionLemma);
    onClose();
  };

  const tabItems = [
    {
      key: 'custom',
      label: '词典',
      children: (
        <CustomDictionaryPane
          loadingDictionaries={loadingDictionaries}
          dictionaries={dictionaries}
          loading={loading}
          result={result}
          activeEntry={activeEntry}
          activeEntryIndex={activeEntryIndex}
          err={err}
          onEntryChange={setActiveEntryIndex}
          onOpenSettings={onOpenSettings ? openSettings : undefined}
        />
      ),
    },
    {
      key: 'offline',
      label: '离线',
      children: lemmaForTabs ? (
        <OfflineTab lemma={lemmaForTabs} />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Enter a single English word to look it up offline.
        </Text>
      ),
    },
    {
      key: 'online',
      label: '在线',
      children: lemmaForTabs ? (
        <OnlineTab lemma={lemmaForTabs} />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Enter a single English word to call Youdao / DeepL.
        </Text>
      ),
    },
    {
      key: 'ai',
      label: '智能',
      children: lemmaForTabs ? (
        <AiTab lemma={lemmaForTabs} contextSentence={contextSentence ?? lemmaForTabs} />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Enter a single English word for an AI gloss.
        </Text>
      ),
    },
  ];

  return (
    <Modal
      title={
        <Space size={8} wrap>
          <span>Dictionary</span>
          {actionLemma && <Tag color="blue">{actionLemma}</Tag>}
          {surfaceLabel && surfaceLabel.toLowerCase() !== actionLemma && (
            <Tag color="default">seen as {surfaceLabel}</Tag>
          )}
        </Space>
      }
      open={visible}
      onCancel={onClose}
      footer={null}
      width="min(1040px, calc(100vw - 32px))"
      styles={{ body: { paddingTop: 12 } }}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size={12}>
        {!isTauri() && (
          <Alert
            type="info"
            showIcon
            message="Dictionary lookup is running in browser preview; live dictionary providers require the Tauri shell."
          />
        )}

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
              onPressEnter={() => void runLookup()}
              placeholder="Look up a word"
              autoFocus
            />
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={loading}
              disabled={!query.trim()}
              onClick={() => void runLookup()}
            >
              Search
            </Button>
          </Space.Compact>
        </div>

        <Space wrap>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            disabled={!actionLemma}
            onClick={markKnown}
          >
            Mark known
          </Button>
          {canIgnoreName && (
            <Button icon={<UserOutlined />} onClick={markName}>
              Ignore name
            </Button>
          )}
          <Button
            icon={<PlusOutlined />}
            loading={addingToSrs}
            disabled={!actionLemma}
            onClick={handleAddToSrs}
          >
            Add to SRS
          </Button>
          {onShowLinked && (
            <Button icon={<LinkOutlined />} disabled={!actionLemma} onClick={showLinked}>
              Linked docs
            </Button>
          )}
        </Space>

        <Tabs size="small" defaultActiveKey="custom" items={tabItems} />
      </Space>
    </Modal>
  );
}

interface CustomDictionaryPaneProps {
  loadingDictionaries: boolean;
  dictionaries: CustomDictionary[];
  loading: boolean;
  result: CustomDictionaryLookupResult | null;
  activeEntry: CustomDictionaryLookupEntry | null;
  activeEntryIndex: number;
  err: string | null;
  onEntryChange: (index: number) => void;
  onOpenSettings?: () => void;
}

function CustomDictionaryPane({
  loadingDictionaries,
  dictionaries,
  loading,
  result,
  activeEntry,
  activeEntryIndex,
  err,
  onEntryChange,
  onOpenSettings,
}: CustomDictionaryPaneProps) {
  if (loadingDictionaries) return <Spin size="small" />;
  if (dictionaries.length === 0) {
    return (
      <Empty description="No dictionaries imported">
        {onOpenSettings && (
          <Button icon={<SettingOutlined />} onClick={onOpenSettings}>
            Settings
          </Button>
        )}
      </Empty>
    );
  }

  return (
    <div>
      {err && <Alert type="warning" showIcon title={err} style={{ marginBottom: 8 }} />}
      {loading && <Spin size="small" />}

      {result && !loading && result.entries.length === 0 && (
        <Empty description={`No entry for "${result.query}"`}>
          {onOpenSettings && (
            <Button icon={<SettingOutlined />} onClick={onOpenSettings}>
              Settings
            </Button>
          )}
        </Empty>
      )}

      {result && !loading && activeEntry && (
        <DictionaryPage
          entries={result.entries}
          activeEntry={activeEntry}
          activeEntryIndex={activeEntryIndex}
          elapsedMs={result.elapsed_ms}
          onEntryChange={onEntryChange}
        />
      )}
    </div>
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
