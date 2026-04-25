'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
  Tabs,
  Tag,
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
import { AiTab, OfflineTab, OnlineTab } from './LookupTabs';

const { Text, Title } = Typography;

const WORD_RE = /^[A-Za-z][A-Za-z'’-]*$/;

/** True when `value` is a single English word we should hand to the dictionary. */
export function isLookupCandidate(value: string | null | undefined): boolean {
  if (!value) return false;
  return WORD_RE.test(value.trim());
}

/** Normalize raw selection / clipboard text to a canonical lemma surface. Returns
 * an empty string when the input isn't a lookup-able single word. */
export function normalizeLookupQuery(value: string | null | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!WORD_RE.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

/** CSS selector for elements where double-click should NOT pop the dictionary —
 * native form fields, interactive controls, the Tiptap reader (which has its own
 * popover), and the dictionary modal itself (so we can't recursively trigger). */
const SKIP_DBLCLICK_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '.ProseMirror',
  '.ant-btn',
  '.ant-modal-content',
].join(', ');

interface DictionaryFloatProps {
  onOpenSettings: () => void;
}

export function DictionaryFloat({ onOpenSettings }: DictionaryFloatProps) {
  const [open, setOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState('');
  const [autoSearch, setAutoSearch] = useState(false);

  const openWith = (word: string) => {
    setInitialQuery(word);
    setAutoSearch(Boolean(word));
    setOpen(true);
  };

  // FloatButton: try the OS clipboard first (tauri-plugin-clipboard-manager),
  // fall back to the current selection. If we land on a single English word
  // we auto-fire the lookup so the user sees the explanation immediately.
  const openModal = async () => {
    let seed = window.getSelection?.()?.toString().trim() ?? '';
    if (!seed && isTauri()) {
      try {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
        seed = (await readText()) ?? '';
      } catch {
        // Clipboard refusal (permission / empty / non-text) is non-fatal —
        // open the modal with no seed.
      }
    }
    openWith(normalizeLookupQuery(seed));
  };

  // Global double-click → dictionary lookup. We use the capture phase so we
  // see events before per-component handlers, but bail out for any element
  // that owns its own click semantics (buttons, links, the Tiptap reader,
  // form fields, the modal itself).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onDblClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(SKIP_DBLCLICK_SELECTOR)) return;
      const selection = window.getSelection?.()?.toString();
      const word = normalizeLookupQuery(selection);
      if (!word) return;
      openWith(word);
    };
    document.addEventListener('dblclick', onDblClick, true);
    return () => document.removeEventListener('dblclick', onDblClick, true);
  }, []);

  return (
    <>
      <FloatButton
        icon={<BookOutlined />}
        tooltip="Dictionary (double-click any word)"
        onClick={() => {
          void openModal();
        }}
        style={{ right: 32, bottom: 32 }}
      />

      {open && (
        <DictionaryLookupModal
          visible={true}
          initialQuery={initialQuery}
          autoSearch={autoSearch}
          onClose={() => {
            setOpen(false);
            setAutoSearch(false);
          }}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );
}

interface DictionaryLookupModalProps {
  visible: boolean;
  initialQuery: string;
  /** When true and `initialQuery` is non-empty, fire `runLookup` once on mount. */
  autoSearch?: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

function DictionaryLookupModal({
  visible,
  initialQuery,
  autoSearch = false,
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
  const ranAutoRef = useRef(false);

  const dictionaryOptions = useMemo(
    () => [
      { value: 0, label: 'All dictionaries' },
      ...dictionaries.map((dict) => ({ value: dict.id, label: dict.name })),
    ],
    [dictionaries]
  );

  const activeEntry = result?.entries[activeEntryIndex] ?? null;
  // Trim once for the secondary tabs; they accept a lemma rather than a free
  // query, so an empty / non-word query simply renders an inert placeholder.
  const lemmaForTabs = normalizeLookupQuery(query);

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
    onOpenSettings();
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
          onOpenSettings={openSettings}
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
        <AiTab lemma={lemmaForTabs} contextSentence={lemmaForTabs} />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Enter a single English word for an AI gloss.
        </Text>
      ),
    },
  ];

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

          <Tabs size="small" defaultActiveKey="custom" items={tabItems} />
        </Space>
      )}
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
  onOpenSettings: () => void;
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
        <Button icon={<SettingOutlined />} onClick={onOpenSettings}>
          Settings
        </Button>
      </Empty>
    );
  }

  return (
    <div>
      {err && <Alert type="warning" showIcon message={err} style={{ marginBottom: 8 }} />}
      {loading && <Spin size="small" />}

      {result && !loading && result.entries.length === 0 && (
        <Empty description={`No entry for "${result.query}"`}>
          <Button icon={<SettingOutlined />} onClick={onOpenSettings}>
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
            border: '1px solid #f0f0f0',
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
                borderBottom: index === entries.length - 1 ? 0 : '1px solid #f0f0f0',
                padding: '10px 12px',
                textAlign: 'left',
                background: index === activeEntryIndex ? '#e6f4ff' : '#fff',
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
            border: '1px solid #f0f0f0',
            borderRadius: 6,
            background: '#fff',
          }}
        />
      </div>
    </div>
  );
}
