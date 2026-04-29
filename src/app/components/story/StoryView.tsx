'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Grid,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  theme,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  HistoryOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  deleteStory,
  generateMcqExplanation,
  generateStory,
  isTauri,
  listStoryHistory,
  loadStory,
  recentPracticeWordsIpc,
  regenerateStory,
  type RecentWordIpc,
  type StoryHistoryItemIpc,
  type StoryMaterialIpc,
} from '@/app/lib/ipc';
import { useWordStore } from '@/app/stores/wordStore';
import { registerWordUse } from '@/app/stores/usageStore';
import { lemmatize } from '@/app/lib/tokenizer';
import { WordLookupModal, normalizeLookupQuery } from '@/app/components/dictionary/WordLookupModal';

const { Title, Text, Paragraph } = Typography;

interface BlankState {
  index: number;
  picked: string | null;
  answered: boolean;
  correct: boolean;
  explanation: string | null;
  loadingExplanation: boolean;
}

type Phase = 'idle' | 'loading_seed' | 'ready' | 'error';

interface StoryLookup {
  lemma: string;
  surface: string;
}

interface StoryViewProps {
  onDrillLemma?: (lemma: string) => void;
}

/**
 * Story Review surface. Pulls a handful of recent low-level words from
 * `recent_practice_words(14, 5)`, sends them to the AI via `generate_story`
 * for a coherent paragraph with cloze blanks rendered as inline AntD Selects,
 * and fires `register_word_use(word_id, 'story_review')` on every answer
 * (correct OR wrong). Wrong answers also pull a known-words-only explanation
 * via `generate_mcq_explanation`.
 *
 * The story is persisted server-side as a `materials` row with
 * `source_kind='ai_story'` so it re-appears in the Library.
 */
export function StoryView({ onDrillLemma }: StoryViewProps = {}) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const known = useWordStore((s) => s.known);

  const [phase, setPhase] = useState<Phase>('loading_seed');
  const [seed, setSeed] = useState<RecentWordIpc[]>([]);
  const [story, setStory] = useState<StoryMaterialIpc | null>(null);
  const [blanks, setBlanks] = useState<BlankState[]>([]);
  const [history, setHistory] = useState<StoryHistoryItemIpc[]>([]);
  const [selectedWordIds, setSelectedWordIds] = useState<Set<number>>(() => new Set());
  const [seedError, setSeedError] = useState<string | null>(null);
  const [generatingNew, setGeneratingNew] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [loadingStoryId, setLoadingStoryId] = useState<number | null>(null);
  const [deletingStoryId, setDeletingStoryId] = useState<number | null>(null);
  const [lookup, setLookup] = useState<StoryLookup | null>(null);

  const applyStory = useCallback((result: StoryMaterialIpc) => {
    setStory(result);
    setBlanks(makeBlankState(result));
    setPhase('ready');
  }, []);

  const refreshHistory = useCallback(async () => {
    const rows = await listStoryHistory();
    setHistory(rows);
    return rows;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase('loading_seed');
      setSeedError(null);
      if (!isTauri()) {
        if (!cancelled) {
          setSeedError('Story Review requires the Tauri shell — run `bun run tauri dev`.');
          setPhase('error');
        }
        return;
      }
      try {
        const [rows, storyHistory] = await Promise.all([
          recentPracticeWordsIpc(14, 5),
          listStoryHistory(),
        ]);
        if (cancelled) return;
        setSeed(rows);
        setSelectedWordIds(new Set(rows.map((row) => row.id)));
        setHistory(storyHistory);
        setPhase('idle');
      } catch (err) {
        if (!cancelled) {
          setSeedError(`Story Review failed to load: ${err}`);
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onGenerate = useCallback(async () => {
    if (seed.length === 0) {
      message.warning('No recent words to weave into a story yet — read more first.');
      return;
    }
    if (selectedWordIds.size === 0) {
      message.warning('Select at least one word for the story.');
      return;
    }
    setGeneratingNew(true);
    try {
      const wordIds = seed.filter((s) => selectedWordIds.has(s.id)).map((s) => s.id);
      const result = await generateStory(wordIds);
      applyStory(result);
      await refreshHistory();
    } catch (err) {
      message.error(`generate_story failed: ${err}`);
      if (!story) setPhase('idle');
    } finally {
      setGeneratingNew(false);
    }
  }, [seed, selectedWordIds, message, story, applyStory, refreshHistory]);

  const onToggleWord = useCallback((wordId: number) => {
    setSelectedWordIds((prev) => {
      const next = new Set(prev);
      if (next.has(wordId)) {
        next.delete(wordId);
      } else {
        next.add(wordId);
      }
      return next;
    });
  }, []);

  const onShowGeneratePage = useCallback(() => {
    setSelectedWordIds(new Set(seed.map((s) => s.id)));
    setPhase('idle');
  }, [seed]);

  const onLoadHistory = useCallback(
    async (materialId: number) => {
      setLoadingStoryId(materialId);
      try {
        const result = await loadStory(materialId);
        if (result) {
          applyStory(result);
        } else {
          message.warning('That story is no longer available.');
          await refreshHistory();
        }
      } catch (err) {
        message.error(`load_story failed: ${err}`);
      } finally {
        setLoadingStoryId(null);
      }
    },
    [applyStory, message, refreshHistory]
  );

  const onDeleteHistory = useCallback(
    async (materialId: number) => {
      setDeletingStoryId(materialId);
      try {
        const deleted = await deleteStory(materialId);
        if (!deleted) {
          message.warning('That story is already gone.');
        } else {
          message.success('Story deleted.');
        }
        const rows = await refreshHistory();
        if (story?.material_id === materialId) {
          setStory(null);
          setBlanks([]);
          setPhase('idle');
        }
        if (!deleted && rows.length === 0) {
          setPhase('idle');
        }
      } catch (err) {
        message.error(`delete_story failed: ${err}`);
      } finally {
        setDeletingStoryId(null);
      }
    },
    [message, refreshHistory, story]
  );

  const onRegenerate = useCallback(async () => {
    if (!story) return;
    setRegenerating(true);
    try {
      const result = await regenerateStory(story.material_id);
      applyStory(result);
      await refreshHistory();
      message.success('Story regenerated and overwritten.');
    } catch (err) {
      message.error(`regenerate_story failed: ${err}`);
    } finally {
      setRegenerating(false);
    }
  }, [story, applyStory, refreshHistory, message]);

  /**
   * Commit one MCQ answer: fire +1 on the target word (regardless of
   * correctness — the spec is explicit about this), then for wrong answers
   * pull a known-words-only explanation in the background.
   */
  const onAnswer = useCallback(
    async (blankIdx: number, picked: string) => {
      if (!story) return;
      const blank = story.blanks[blankIdx];
      if (!blank) return;

      const correctText = blank.options[blank.correct_index] ?? '';
      const isCorrect = picked === correctText;

      setBlanks((prev) =>
        prev.map((b, i) =>
          i === blankIdx
            ? {
                ...b,
                picked,
                answered: true,
                correct: isCorrect,
                loadingExplanation: !isCorrect,
              }
            : b
        )
      );

      try {
        await registerWordUse(blank.target_word_id, 'story_review');
      } catch (err) {
        console.warn('[wordbrain] register_word_use failed', err);
      }

      if (!isCorrect) {
        try {
          const knownLemmas = Array.from(known);
          const explanation = await generateMcqExplanation(
            blank.target_word_id,
            picked,
            correctText,
            knownLemmas
          );
          setBlanks((prev) =>
            prev.map((b, i) =>
              i === blankIdx ? { ...b, explanation, loadingExplanation: false } : b
            )
          );
        } catch (err) {
          message.error(`generate_mcq_explanation failed: ${err}`);
          setBlanks((prev) =>
            prev.map((b, i) => (i === blankIdx ? { ...b, loadingExplanation: false } : b))
          );
        }
      }
    },
    [story, known, message]
  );

  const storySegments = useMemo(() => {
    if (!story) return [] as Array<{ kind: 'text' | 'blank'; value: string; blankIdx?: number }>;
    return splitOnPlaceholders(story.story_text);
  }, [story]);

  const openSelectedStoryWord = useCallback(() => {
    if (!story) return;
    const surface = window.getSelection?.()?.toString().trim() ?? '';
    const normalized = normalizeLookupQuery(surface);
    if (!normalized) return;
    setLookup({
      lemma: lemmatize(normalized),
      surface,
    });
  }, [story]);

  if (phase === 'loading_seed') {
    return (
      <ViewShell>
        <Spin />
      </ViewShell>
    );
  }

  if (phase === 'error') {
    return (
      <ViewShell>
        <Alert type="warning" message={seedError ?? 'Failed to load recent words'} showIcon />
      </ViewShell>
    );
  }

  if (phase === 'idle') {
    return (
      <ViewShell>
        <StoryLayout
          history={history}
          activeStoryId={story?.material_id ?? null}
          loadingStoryId={loadingStoryId}
          deletingStoryId={deletingStoryId}
          onLoadHistory={onLoadHistory}
          onDeleteHistory={onDeleteHistory}
        >
          <GenerateCard
            seed={seed}
            selectedWordIds={selectedWordIds}
            generating={generatingNew}
            onToggleWord={onToggleWord}
            onGenerate={onGenerate}
          />
        </StoryLayout>
      </ViewShell>
    );
  }

  if (!story) return null;
  return (
    <ViewShell>
      <StoryLayout
        history={history}
        activeStoryId={story.material_id}
        loadingStoryId={loadingStoryId}
        deletingStoryId={deletingStoryId}
        onLoadHistory={onLoadHistory}
        onDeleteHistory={onDeleteHistory}
      >
        <Card>
          <Paragraph
            className="wb-story-lookup-surface"
            onDoubleClick={openSelectedStoryWord}
            style={{ fontSize: 16, lineHeight: 1.8 }}
          >
            {storySegments.map((seg, i) => {
              if (seg.kind === 'text') {
                return <span key={`t-${i}`}>{seg.value}</span>;
              }
              const blankIdx = seg.blankIdx!;
              const blank = story.blanks[blankIdx];
              if (!blank) return null;
              const state = blanks[blankIdx];
              const isAnswered = state?.answered ?? false;
              return (
                <Select
                  key={`b-${i}`}
                  size="middle"
                  style={{ minWidth: 140, margin: '0 4px' }}
                  placeholder="choose..."
                  disabled={isAnswered}
                  value={state?.picked ?? undefined}
                  onChange={(v) => void onAnswer(blankIdx, v)}
                  options={blank.options.map((opt) => ({ value: opt, label: opt }))}
                  status={isAnswered ? (state?.correct ? 'warning' : 'error') : undefined}
                  suffixIcon={
                    isAnswered ? (
                      state?.correct ? (
                        <CheckCircleOutlined style={{ color: token.colorSuccess }} />
                      ) : (
                        <CloseCircleOutlined style={{ color: token.colorError }} />
                      )
                    ) : undefined
                  }
                />
              );
            })}
          </Paragraph>

          {blanks.some((b) => b.answered && !b.correct) && (
            <div style={{ marginTop: 16 }}>
              <Title level={5} style={{ marginBottom: 8 }}>
                Explanations
              </Title>
              {blanks.map((b, i) => {
                if (!b.answered || b.correct) return null;
                const blank = story.blanks[i];
                if (!blank) return null;
                return (
                  <Alert
                    key={`exp-${i}`}
                    type="info"
                    showIcon
                    style={{ marginBottom: 8 }}
                    message={
                      <span>
                        Blank #{i + 1} - correct answer was{' '}
                        <Text strong>{blank.options[blank.correct_index]}</Text>
                      </span>
                    }
                    description={
                      b.loadingExplanation ? (
                        <Spin size="small" />
                      ) : (
                        <Paragraph style={{ marginBottom: 0 }}>{b.explanation}</Paragraph>
                      )
                    }
                  />
                );
              })}
            </div>
          )}

          <Space style={{ marginTop: 16 }} wrap>
            <Button
              onClick={onShowGeneratePage}
              icon={<ThunderboltOutlined />}
              disabled={regenerating}
            >
              Generate new story
            </Button>
            <Button
              onClick={onRegenerate}
              icon={<ReloadOutlined />}
              loading={regenerating}
              disabled={generatingNew}
            >
              Regenerate and overwrite
            </Button>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Story saved to your Library as an AI Story.
            </Text>
          </Space>

          {lookup && (
            <WordLookupModal
              visible={true}
              initialQuery={lookup.lemma}
              surface={lookup.surface}
              autoSearch={true}
              onClose={() => setLookup(null)}
              onShowLinked={onDrillLemma}
            />
          )}
        </Card>
      </StoryLayout>
    </ViewShell>
  );
}

function GenerateCard({
  seed,
  selectedWordIds,
  generating,
  onToggleWord,
  onGenerate,
}: {
  seed: RecentWordIpc[];
  selectedWordIds: Set<number>;
  generating: boolean;
  onToggleWord: (wordId: number) => void;
  onGenerate: () => void;
}) {
  if (seed.length === 0) {
    return (
      <Card>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No recent low-level words to weave into a story yet. Read or import more text to populate this list."
        />
      </Card>
    );
  }

  return (
    <Card>
      <Paragraph>
        Generate a short story (~120-180 words) that practises{' '}
        <strong>{selectedWordIds.size}</strong> selected word{selectedWordIds.size === 1 ? '' : 's'}
        .
      </Paragraph>
      <Space size={[6, 6]} wrap style={{ marginBottom: 16 }}>
        {seed.map((w) => {
          const selected = selectedWordIds.has(w.id);
          return (
            <Tag
              key={w.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              color={selected ? 'blue' : 'default'}
              closable={selected}
              closeIcon={<CloseOutlined aria-label={`Remove ${w.lemma}`} />}
              onClose={(e) => {
                e.preventDefault();
                onToggleWord(w.id);
              }}
              onClick={() => onToggleWord(w.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggleWord(w.id);
                }
              }}
              style={{
                cursor: 'pointer',
                opacity: selected ? 1 : 0.58,
                textDecoration: selected ? 'none' : 'line-through',
                userSelect: 'none',
              }}
            >
              {w.lemma} <Text type="secondary">- lvl {w.level}</Text>
            </Tag>
          );
        })}
      </Space>
      <div>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={generating}
          onClick={onGenerate}
          disabled={selectedWordIds.size === 0}
        >
          {generating ? 'Composing story...' : 'Generate story'}
        </Button>
      </div>
    </Card>
  );
}

function StoryLayout({
  children,
  history,
  activeStoryId,
  loadingStoryId,
  deletingStoryId,
  onLoadHistory,
  onDeleteHistory,
}: {
  children: React.ReactNode;
  history: StoryHistoryItemIpc[];
  activeStoryId: number | null;
  loadingStoryId: number | null;
  deletingStoryId: number | null;
  onLoadHistory: (materialId: number) => void;
  onDeleteHistory: (materialId: number) => void;
}) {
  const screens = Grid.useBreakpoint();
  const stacked = !screens.lg;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: stacked ? '1fr' : 'minmax(0, 1fr) minmax(240px, 300px)',
        gap: 12,
        alignItems: 'start',
      }}
    >
      <div>{children}</div>
      <StoryHistoryPanel
        history={history}
        activeStoryId={activeStoryId}
        loadingStoryId={loadingStoryId}
        deletingStoryId={deletingStoryId}
        onLoadHistory={onLoadHistory}
        onDeleteHistory={onDeleteHistory}
      />
    </div>
  );
}

function StoryHistoryPanel({
  history,
  activeStoryId,
  loadingStoryId,
  deletingStoryId,
  onLoadHistory,
  onDeleteHistory,
}: {
  history: StoryHistoryItemIpc[];
  activeStoryId: number | null;
  loadingStoryId: number | null;
  deletingStoryId: number | null;
  onLoadHistory: (materialId: number) => void;
  onDeleteHistory: (materialId: number) => void;
}) {
  const { token } = theme.useToken();

  return (
    <aside
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        background: token.colorBgContainer,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: `1px solid ${token.colorSplit}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Space size={6}>
          <HistoryOutlined />
          <Text strong>History</Text>
        </Space>
        <Tag>{history.length}</Tag>
      </div>

      {history.length === 0 ? (
        <div style={{ padding: 12 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No generated stories yet." />
        </div>
      ) : (
        <div role="list" style={{ maxHeight: 520, overflow: 'auto' }}>
          {history.map((item) => {
            const active = item.material_id === activeStoryId;
            const loading = item.material_id === loadingStoryId;
            const deleting = item.material_id === deletingStoryId;
            return (
              <div
                key={item.material_id}
                role="listitem"
                style={{
                  borderBottom: `1px solid ${token.colorSplit}`,
                  borderLeft: active ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                  background: active ? token.colorFillSecondary : token.colorBgContainer,
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 32px',
                  alignItems: 'stretch',
                }}
              >
                <button
                  type="button"
                  onClick={() => onLoadHistory(item.material_id)}
                  disabled={loading || deleting}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: token.colorText,
                    cursor: loading || deleting ? 'wait' : 'pointer',
                    padding: '10px 12px',
                    textAlign: 'left',
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                    }}
                  >
                    <Text strong ellipsis style={{ maxWidth: 190 }}>
                      {item.title}
                    </Text>
                    {loading ? <Spin size="small" /> : <Tag>{item.blank_count}</Tag>}
                  </div>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                    {new Date(item.created_at).toLocaleString()}
                  </Text>
                </button>
                <div
                  style={{
                    padding: '8px 8px 8px 0',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Popconfirm
                    title="Delete this story?"
                    description="It will be removed from Story history and Library."
                    okText="Delete"
                    cancelText="Cancel"
                    okType="danger"
                    onConfirm={() => onDeleteHistory(item.material_id)}
                  >
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label={`Delete ${item.title}`}
                      loading={deleting}
                    />
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function ViewShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="page wide">
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Generated · cloze practice</div>
          <h1 className="page-title">
            Story<em>.</em>
          </h1>
          <p className="page-sub">
            Short pieces written around the words you&rsquo;re learning. Pick blanks, get a verdict
            and an AI explanation when you&rsquo;re wrong.
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Split a story body on `{{N}}` placeholders into alternating text and blank
 * segments. `N` is 1-based in the story text but exposed as 0-based blankIdx
 * so it matches the `story.blanks` array directly.
 */
function splitOnPlaceholders(
  text: string
): Array<{ kind: 'text' | 'blank'; value: string; blankIdx?: number }> {
  const out: Array<{ kind: 'text' | 'blank'; value: string; blankIdx?: number }> = [];
  const re = /\{\{(\d+)\}\}/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) {
      out.push({ kind: 'text', value: text.slice(lastEnd, m.index) });
    }
    const oneBased = parseInt(m[1] ?? '0', 10);
    out.push({ kind: 'blank', value: m[0], blankIdx: Math.max(0, oneBased - 1) });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < text.length) {
    out.push({ kind: 'text', value: text.slice(lastEnd) });
  }
  return out;
}

function makeBlankState(story: StoryMaterialIpc): BlankState[] {
  return story.blanks.map((b) => ({
    index: b.index,
    picked: null,
    answered: false,
    correct: false,
    explanation: null,
    loadingExplanation: false,
  }));
}
