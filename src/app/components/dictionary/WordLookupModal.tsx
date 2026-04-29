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
  Tag,
  theme,
  Typography,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckOutlined,
  LinkOutlined,
  PlusOutlined,
  SearchOutlined,
  SettingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  listRemoteDictionaries,
  lookupRemoteDictionary,
  type DictionaryLookupEntry,
  type DictionaryLookupResult,
  type RemoteDictionary,
} from '@/app/lib/dict';
import { addToSrs, isInSrs, isTauri } from '@/app/lib/ipc';
import {
  isLookupCandidate,
  normalizeLookupQuery,
  recordLookupHistoryPersisted,
} from '@/app/lib/lookup-history';
import { refreshDueCount } from '@/app/stores/srsStore';
import { looksLikeNameToken, useWordStore } from '@/app/stores/wordStore';

const { Text, Title } = Typography;

export { isLookupCandidate, normalizeLookupQuery };

export function buildDictionaryFrameSrcDoc(
  sourceHtml: string,
  assetBaseUrl?: string | null
): string {
  const html = sourceHtml.trim();
  const normalizedBaseUrl = normalizeDictionaryAssetBaseUrl(assetBaseUrl);
  if (!html || !normalizedBaseUrl || /<base(?:\s|>|\/)/i.test(html)) {
    return html;
  }

  const baseTag = `<base href="${escapeHtmlAttribute(normalizedBaseUrl)}">`;
  const headOpenEnd = findOpeningTagEnd(html, 'head');
  if (headOpenEnd !== -1) {
    return `${html.slice(0, headOpenEnd)}${baseTag}${html.slice(headOpenEnd)}`;
  }

  const htmlOpenEnd = findOpeningTagEnd(html, 'html');
  if (htmlOpenEnd !== -1) {
    return `${html.slice(0, htmlOpenEnd)}<head>${baseTag}</head>${html.slice(htmlOpenEnd)}`;
  }

  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? '<!doctype html>';
  const body = doctype === '<!doctype html>' ? html : html.slice(doctype.length);
  return `${doctype}<html><head>${baseTag}</head><body>${body}</body></html>`;
}

interface WordLookupModalProps {
  visible: boolean;
  initialQuery: string;
  /** Original surface form when it differs from the lookup key. */
  surface?: string;
  /** When true and `initialQuery` is non-empty, fire `runLookup` once on mount. */
  autoSearch?: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
  onShowLinked?: (lemma: string) => void;
}

interface LookupSnapshot {
  query: string;
  selectedDictionarySlug: string | null;
  result: DictionaryLookupResult;
  activeEntryIndex: number;
}

interface DictionaryNavigateMessage {
  type: 'dictionary-api:navigate';
  query: string;
  dictionarySlug?: string;
}

export function WordLookupModal({
  visible,
  initialQuery,
  surface,
  autoSearch = false,
  onClose,
  onOpenSettings,
  onShowLinked,
}: WordLookupModalProps) {
  const { message } = AntApp.useApp();
  const [query, setQuery] = useState(initialQuery);
  const [selectedDictionarySlug, setSelectedDictionarySlug] = useState<string | null>(null);
  const [dictionaries, setDictionaries] = useState<RemoteDictionary[]>([]);
  const [result, setResult] = useState<DictionaryLookupResult | null>(null);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  const [entryHistory, setEntryHistory] = useState<LookupSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingDictionaries, setLoadingDictionaries] = useState(false);
  const [addingToSrs, setAddingToSrs] = useState(false);
  const [srsStatus, setSrsStatus] = useState<{ lemma: string; inSrs: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ranAutoRef = useRef(false);

  const dictionaryOptions = useMemo(
    () => [
      { value: 'all', label: 'All API dictionaries' },
      ...dictionaries.map((dict) => ({
        value: dict.slug,
        label: dict.name,
      })),
    ],
    [dictionaries]
  );

  const activeEntry = result?.entries[activeEntryIndex] ?? null;
  const lookupLemma = normalizeLookupQuery(query);
  const actionLemma = lookupLemma || normalizeLookupQuery(initialQuery);
  const surfaceLabel = surface?.trim() || query.trim() || actionLemma;
  const canIgnoreName = Boolean(actionLemma && surfaceLabel && looksLikeNameToken(surfaceLabel));
  const srsStatusMatchesAction = srsStatus?.lemma === actionLemma;
  const actionLemmaInSrs = Boolean(srsStatusMatchesAction && srsStatus?.inSrs);
  const showAddToSrs =
    Boolean(actionLemma) && (!isTauri() || (srsStatusMatchesAction && !actionLemmaInSrs));

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    setLoadingDictionaries(true);
    listRemoteDictionaries()
      .then((items) => {
        if (!cancelled) {
          setDictionaries(items);
        }
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

  useEffect(() => {
    if (!visible || !actionLemma) {
      setSrsStatus(null);
      return;
    }
    if (!isTauri()) {
      setSrsStatus({ lemma: actionLemma, inSrs: false });
      return;
    }

    let cancelled = false;
    setSrsStatus(null);
    isInSrs(actionLemma)
      .then((inSrs) => {
        if (!cancelled) setSrsStatus({ lemma: actionLemma, inSrs });
      })
      .catch((e) => {
        console.warn('[wordbrain] is_in_srs failed', e);
        if (!cancelled) setSrsStatus({ lemma: actionLemma, inSrs: false });
      });
    return () => {
      cancelled = true;
    };
  }, [visible, actionLemma]);

  const runLookup = async (
    overrideQuery?: string,
    opts?: { dictionarySlug?: string | null; pushHistory?: boolean }
  ) => {
    const trimmed = (overrideQuery ?? query).trim();
    if (!trimmed) return;
    await recordLookupHistoryPersisted(trimmed);
    const dictionarySlug =
      opts && Object.prototype.hasOwnProperty.call(opts, 'dictionarySlug')
        ? (opts.dictionarySlug ?? null)
        : selectedDictionarySlug;
    if (opts?.pushHistory && result) {
      setEntryHistory((items) =>
        [
          ...items,
          {
            query,
            selectedDictionarySlug,
            result,
            activeEntryIndex,
          },
        ].slice(-20)
      );
    }
    setQuery(trimmed);
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'dictionarySlug')) {
      setSelectedDictionarySlug(dictionarySlug);
    }
    setLoading(true);
    setErr(null);
    try {
      const limit = 4;
      const next = await lookupRemoteDictionary(trimmed, {
        dictionarySlug,
        limit,
      });
      setResult(next);
      setActiveEntryIndex(0);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Auto-fire the API dictionary lookup once the dictionaries list is
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
        setSrsStatus({ lemma: actionLemma, inSrs: true });
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

  const navigateLinkedEntry = (nextQuery: string, dictionarySlug?: string) => {
    const trimmed = nextQuery.trim();
    if (!trimmed) return;
    void runLookup(trimmed, {
      dictionarySlug: dictionarySlug || selectedDictionarySlug,
      pushHistory: true,
    });
  };

  const goBack = () => {
    const previous = entryHistory[entryHistory.length - 1];
    if (!previous) return;
    setEntryHistory((items) => items.slice(0, -1));
    setQuery(previous.query);
    setSelectedDictionarySlug(previous.selectedDictionarySlug);
    setResult(previous.result);
    setActiveEntryIndex(previous.activeEntryIndex);
    setErr(null);
  };

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
            message="Dictionary lookup is running in browser preview; the Dictionary API requires the Tauri shell."
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
            value={selectedDictionarySlug ?? 'all'}
            style={{ width: '100%' }}
            options={dictionaryOptions}
            onChange={(value) => setSelectedDictionarySlug(value === 'all' ? null : value)}
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
          {entryHistory.length > 0 && (
            <Button icon={<ArrowLeftOutlined />} onClick={goBack}>
              Back
            </Button>
          )}
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
          {showAddToSrs && (
            <Button
              icon={<PlusOutlined />}
              loading={addingToSrs}
              disabled={!actionLemma}
              onClick={handleAddToSrs}
            >
              Add to SRS
            </Button>
          )}
          {onShowLinked && (
            <Button icon={<LinkOutlined />} disabled={!actionLemma} onClick={showLinked}>
              Linked docs
            </Button>
          )}
        </Space>

        <DictionaryApiPane
          loadingDictionaries={loadingDictionaries}
          dictionaries={dictionaries}
          loading={loading}
          result={result}
          activeEntry={activeEntry}
          activeEntryIndex={activeEntryIndex}
          err={err}
          onEntryChange={setActiveEntryIndex}
          onNavigateEntry={navigateLinkedEntry}
          onOpenSettings={onOpenSettings ? openSettings : undefined}
        />
      </Space>
    </Modal>
  );
}

interface DictionaryApiPaneProps {
  loadingDictionaries: boolean;
  dictionaries: RemoteDictionary[];
  loading: boolean;
  result: DictionaryLookupResult | null;
  activeEntry: DictionaryLookupEntry | null;
  activeEntryIndex: number;
  err: string | null;
  onEntryChange: (index: number) => void;
  onNavigateEntry: (query: string, dictionarySlug?: string) => void;
  onOpenSettings?: () => void;
}

function DictionaryApiPane({
  loadingDictionaries,
  dictionaries,
  loading,
  result,
  activeEntry,
  activeEntryIndex,
  err,
  onEntryChange,
  onNavigateEntry,
  onOpenSettings,
}: DictionaryApiPaneProps) {
  if (loadingDictionaries) return <Spin size="small" />;
  if (dictionaries.length === 0) {
    return (
      <Empty description="No API dictionaries configured">
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
          onNavigateEntry={onNavigateEntry}
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
  onNavigateEntry,
}: {
  entries: DictionaryLookupEntry[];
  activeEntry: DictionaryLookupEntry;
  activeEntryIndex: number;
  elapsedMs: number;
  onEntryChange: (index: number) => void;
  onNavigateEntry: (query: string, dictionarySlug?: string) => void;
}) {
  const { token } = theme.useToken();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const frameSrcDoc = buildDictionaryFrameSrcDoc(
    activeEntry.definition_page_html || activeEntry.definition_html,
    activeEntry.asset_base_url
  );

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (!isDictionaryNavigateMessage(event.data)) return;
      onNavigateEntry(event.data.query, event.data.dictionarySlug);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [onNavigateEntry]);

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
          ref={iframeRef}
          title={`${activeEntry.dictionary_name}: ${activeEntry.headword}`}
          srcDoc={frameSrcDoc}
          sandbox="allow-scripts"
          allow="autoplay"
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

function isDictionaryNavigateMessage(value: unknown): value is DictionaryNavigateMessage {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    data.type === 'dictionary-api:navigate' &&
    typeof data.query === 'string' &&
    data.query.trim().length > 0 &&
    (data.dictionarySlug === undefined || typeof data.dictionarySlug === 'string')
  );
}

function normalizeDictionaryAssetBaseUrl(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return '';
  }
}

function findOpeningTagEnd(html: string, tagName: string): number {
  const match = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'i').exec(html);
  return match ? match.index + match[0].length : -1;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
