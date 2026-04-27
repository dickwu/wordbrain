'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
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
  FileTextOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  generateMcqExplanation,
  generateStory,
  isTauri,
  recentPracticeWordsIpc,
  type RecentWordIpc,
  type StoryMaterialIpc,
} from '@/app/lib/ipc';
import { useWordStore } from '@/app/stores/wordStore';
import { registerWordUse } from '@/app/stores/usageStore';

const { Title, Text, Paragraph } = Typography;

interface BlankState {
  index: number;
  picked: string | null;
  answered: boolean;
  correct: boolean;
  explanation: string | null;
  loadingExplanation: boolean;
}

type Phase = 'idle' | 'loading_seed' | 'generating' | 'ready' | 'error';

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
export function StoryView() {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const known = useWordStore((s) => s.known);

  const [phase, setPhase] = useState<Phase>('loading_seed');
  const [seed, setSeed] = useState<RecentWordIpc[]>([]);
  const [story, setStory] = useState<StoryMaterialIpc | null>(null);
  const [blanks, setBlanks] = useState<BlankState[]>([]);
  const [seedError, setSeedError] = useState<string | null>(null);

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
        const rows = await recentPracticeWordsIpc(14, 5);
        if (cancelled) return;
        setSeed(rows);
        setPhase('idle');
      } catch (err) {
        if (!cancelled) {
          setSeedError(`recent_practice_words failed: ${err}`);
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
    setPhase('generating');
    try {
      const wordIds = seed.map((s) => s.id);
      const result = await generateStory(wordIds);
      setStory(result);
      setBlanks(
        result.blanks.map((b) => ({
          index: b.index,
          picked: null,
          answered: false,
          correct: false,
          explanation: null,
          loadingExplanation: false,
        }))
      );
      setPhase('ready');
    } catch (err) {
      message.error(`generate_story failed: ${err}`);
      setPhase('idle');
    }
  }, [seed, message]);

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

  if (phase === 'idle' || phase === 'generating') {
    return (
      <ViewShell>
        <Card>
          {seed.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No recent low-level words to weave into a story yet. Read or import more text to populate this list."
            />
          ) : (
            <>
              <Paragraph>
                Generate a short story (~120-180 words) that practises{' '}
                <strong>{seed.length}</strong> recent word{seed.length === 1 ? '' : 's'}.
              </Paragraph>
              <Space size={[6, 6]} wrap style={{ marginBottom: 16 }}>
                {seed.map((w) => (
                  <Tag key={w.id} color="blue">
                    {w.lemma} <Text type="secondary">- lvl {w.level}</Text>
                  </Tag>
                ))}
              </Space>
              <div>
                <Button
                  type="primary"
                  icon={<ThunderboltOutlined />}
                  loading={phase === 'generating'}
                  onClick={onGenerate}
                >
                  {phase === 'generating' ? 'Composing story...' : 'Generate story'}
                </Button>
              </div>
            </>
          )}
        </Card>
      </ViewShell>
    );
  }

  if (!story) return null;
  return (
    <ViewShell>
      <Card>
        <Paragraph style={{ fontSize: 16, lineHeight: 1.8 }}>
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

        <Space style={{ marginTop: 16 }}>
          <Button onClick={onGenerate} icon={<ThunderboltOutlined />}>
            Generate another story
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Story saved to your Library as an AI Story.
          </Text>
        </Space>
      </Card>
    </ViewShell>
  );
}

function ViewShell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <FileTextOutlined /> Story Review
          </Title>
          <Text type="secondary">
            AI-composed cloze stories that re-use your recent low-level words.
          </Text>
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
