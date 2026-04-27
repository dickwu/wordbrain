'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, Empty, Space, Tag, Typography, theme } from 'antd';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  WordHighlightExtension,
  wordHighlightPluginKey,
  WORD_HIGHLIGHT_REBUILD,
  type WordHighlightClickPayload,
} from '@/app/components/reader/WordHighlightExtension';
import { useWordStore, isReaderTokenKnown } from '@/app/stores/wordStore';
import { lemmatize } from '@/app/lib/tokenizer';
import { WordLookupModal, normalizeLookupQuery } from '@/app/components/dictionary/WordLookupModal';
import {
  isTauri,
  recentPracticeWordsIpc,
  submitWriting,
  type RecentWordIpc,
  type WritingFeedbackIpc,
} from '@/app/lib/ipc';
import { useUsageStore } from '@/app/stores/usageStore';
import { SynonymSpanExtension } from './SynonymSpanExtension';
import { WritingFeedbackPanel } from './WritingFeedbackPanel';
import { diffWords } from './diff';

const { Title, Text } = Typography;

const WINDOW_DAYS_DEFAULT = 14;
const SIDEBAR_LIMIT = 50;

interface WritingViewProps {
  /** Optional override of the recent-words window (default 14d). */
  windowDays?: number;
}

export function WritingView({ windowDays = WINDOW_DAYS_DEFAULT }: WritingViewProps) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [recent, setRecent] = useState<RecentWordIpc[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<WritingFeedbackIpc | null>(null);
  const [wordLookup, setWordLookup] = useState<WordHighlightClickPayload | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const version = useWordStore((s) => s.version);

  const fetchRecent = useCallback(async () => {
    if (!isTauri()) {
      setRecent([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await recentPracticeWordsIpc(windowDays, SIDEBAR_LIMIT);
      setRecent(rows);
      setActiveIdx((idx) => (idx >= rows.length ? 0 : idx));
    } catch (err) {
      message.error(`Recent practice words failed: ${err}`);
    } finally {
      setLoading(false);
    }
  }, [windowDays, message]);

  useEffect(() => {
    void fetchRecent();
  }, [fetchRecent]);

  const activeWord = recent[activeIdx] ?? null;

  // Tiptap editor — same WordHighlight setup as ReaderPane so unknowns light
  // up live, plus our synonym span extension parses `[a, b, c]` brackets.
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: 'Write a sentence using the highlighted target word — submit when ready.',
      }),
      WordHighlightExtension.configure({
        isKnown: isReaderTokenKnown,
        onClickUnknown: (payload) => setWordLookup(payload),
      }),
      SynonymSpanExtension.configure({
        onClickSynonym: (payload) =>
          setWordLookup({
            lemma: payload.lemma,
            surface: payload.lemma,
            from: payload.from,
            to: payload.to,
            rect: payload.rect,
          }),
      }),
    ],
    content: '',
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'wb-reader-surface' },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Whenever active word IDENTITY changes, seed the editor with `"{word}: "`
  // and focus the cursor at the end so the user can type immediately. Keying
  // off `activeWord.id` keeps a `recent` refetch (which produces a new row
  // object with the same id) from clobbering an in-flight feedback panel.
  const activeWordId = activeWord?.id ?? null;
  const activeWordLemma = activeWord?.lemma ?? '';
  useEffect(() => {
    if (!editor || activeWordId === null) return;
    const seed = `${activeWordLemma}: `;
    editor.commands.setContent(seed, { emitUpdate: false });
    editor.commands.focus('end');
    setFeedback(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, activeWordId]);

  // Rebuild WordHighlight decorations whenever the known-set changes.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(editor.state.tr.setMeta(wordHighlightPluginKey, WORD_HIGHLIGHT_REBUILD));
  }, [editor, version]);

  const onSubmit = useCallback(async () => {
    if (!editor || !activeWord) return;
    const raw = editor.getText().trim();
    if (raw.length < 5) {
      message.warning('Write at least one full sentence first.');
      return;
    }
    if (!isTauri()) {
      // Browser-dev preview: fake a feedback object so the layout renders.
      const corrected = raw;
      setFeedback({
        material_id: -1,
        corrected_text: corrected,
        diff_spans: diffWords(raw, corrected).map((d) => ({
          from: 0,
          to: 0,
          kind: d.op,
          text: d.text,
        })),
        usage_verdict: 'ambiguous',
        usage_explanation: '(dev mode — Tauri shell required for AI grading)',
        synonym_spans: [],
        new_usage_count: activeWord.usageCount + 1,
      });
      return;
    }
    setSubmitting(true);
    try {
      const tiptapJson = editor.getJSON();
      const out = await submitWriting({
        target_word_id: activeWord.id,
        raw_text: raw,
        tiptap_json: JSON.stringify(tiptapJson),
      });
      setFeedback(out);
      // Mirror the new server-confirmed usage_count into the local store so
      // the WordsView Level chip + sidebar level chip update without a full
      // refetch round-trip.
      useUsageStore.getState().setUsage(activeWord.id, out.new_usage_count);
      // Refresh the sidebar so ordering + counts update + advance to the
      // next word in the queue.
      await fetchRecent();
      setActiveIdx((idx) => Math.min(idx + 1, Math.max(0, recent.length - 1)));
    } catch (err) {
      message.error(`Writing submit failed: ${err}`);
    } finally {
      setSubmitting(false);
    }
  }, [editor, activeWord, message, fetchRecent, recent.length]);

  const onAcceptRewrite = useCallback(() => {
    if (!editor || !feedback) return;
    editor.commands.setContent(feedback.corrected_text, { emitUpdate: true });
    editor.commands.focus('end');
    setFeedback(null);
  }, [editor, feedback]);

  const onKeepMine = useCallback(() => setFeedback(null), []);

  const openSelectedWord = () => {
    const surface = window.getSelection?.()?.toString().trim() ?? '';
    const normalized = normalizeLookupQuery(surface);
    if (!normalized) return;
    setWordLookup({
      lemma: lemmatize(normalized),
      surface,
      from: 0,
      to: 0,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    });
  };

  const sidebar = useMemo(
    () => (
      <div
        style={{
          width: 240,
          minWidth: 240,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          paddingRight: 12,
          overflowY: 'auto',
          maxHeight: '70vh',
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          Recent practice words ({recent.length})
        </Text>
        {recent.length === 0 && !loading ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No recent words in window"
            style={{ marginTop: 12 }}
          />
        ) : (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {recent.map((row, i) => (
              <SidebarRow
                key={row.id}
                row={row}
                active={i === activeIdx}
                onClick={() => setActiveIdx(i)}
              />
            ))}
          </div>
        )}
      </div>
    ),
    [recent, loading, activeIdx, token]
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <Title level={3} style={{ margin: 0 }}>
          Writing Train
        </Title>
        <Text type="secondary">
          Pick a recent word, write one sentence using it, get word-usage feedback.
        </Text>
      </div>

      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Running in browser dev — submit will short-circuit to a stubbed feedback panel."
        />
      )}

      <div style={{ display: 'flex', gap: 16 }}>
        {sidebar}

        <div style={{ flex: 1, minWidth: 0 }}>
          {activeWord ? (
            <>
              <Space size={8} style={{ marginBottom: 8 }}>
                <Text strong>Target:</Text>
                <Tag color="blue">{activeWord.lemma}</Tag>
                <Tag>level {activeWord.level}</Tag>
              </Space>
              <div style={{ position: 'relative' }} onDoubleClick={openSelectedWord}>
                <EditorContent
                  editor={editor}
                  style={{
                    minHeight: 220,
                    padding: 16,
                    border: `1px solid ${token.colorBorder}`,
                    borderRadius: 8,
                    background: token.colorBgContainer,
                    color: token.colorText,
                    lineHeight: 1.7,
                    fontSize: 15,
                  }}
                />
                {wordLookup && editor && (
                  <WordLookupModal
                    visible={true}
                    initialQuery={wordLookup.lemma}
                    surface={wordLookup.surface}
                    contextSentence={editor.getText()}
                    autoSearch={true}
                    onClose={() => setWordLookup(null)}
                  />
                )}
              </div>
              <Space style={{ marginTop: 12 }}>
                <Button
                  type="primary"
                  loading={submitting}
                  onClick={onSubmit}
                  disabled={!activeWord}
                >
                  Submit for grading
                </Button>
                <Button onClick={() => setActiveIdx((i) => Math.min(i + 1, recent.length - 1))}>
                  Next word
                </Button>
              </Space>
              {feedback && (
                <WritingFeedbackPanel
                  feedback={feedback}
                  onAcceptRewrite={onAcceptRewrite}
                  onKeepMine={onKeepMine}
                />
              )}
            </>
          ) : (
            <Empty description="No recent words yet — read more material to populate the practice queue." />
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarRow({
  row,
  active,
  onClick,
}: {
  row: RecentWordIpc;
  active: boolean;
  onClick: () => void;
}) {
  const { token } = theme.useToken();
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        background: active ? token.controlItemBgActive : 'transparent',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
        color: active ? token.colorPrimary : token.colorText,
      }}
    >
      <span style={{ fontWeight: active ? 600 : 400 }}>{row.lemma}</span>
      <Tag style={{ marginRight: 0 }}>lvl {row.level}</Tag>
    </div>
  );
}

export default WritingView;
