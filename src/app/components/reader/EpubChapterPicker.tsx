'use client';

import { useEffect, useMemo, useState } from 'react';
import { List, Button, Drawer, Progress, Space, Tag, Typography } from 'antd';
import { BookOutlined, ReadOutlined } from '@ant-design/icons';
import { isLemmaKnown, useWordStore } from '@/app/stores/wordStore';
import { tokenize } from '@/app/lib/tokenizer';
import type { EpubChapter, MaterialSummary } from '@/app/lib/ipc';

const { Text } = Typography;

interface EpubChapterPickerProps {
  open: boolean;
  /** Book-level title shown in the drawer header. */
  bookTitle: string;
  /** In-memory chapters freshly parsed from an EPUB drop. */
  chapters?: EpubChapter[] | null;
  /** Previously-saved chapters read back from SQLite. */
  savedChapters?: MaterialSummary[] | null;
  /** Bumped when the caller wants unknown% re-computed (e.g. after marking
   * new words known in another view). */
  version?: number;
  onClose: () => void;
  /** Fired when the user clicks a chapter; receives the 0-based chapter index
   * into whichever list (`chapters` or `savedChapters`) is active. */
  onOpenChapter: (index: number) => void;
}

/**
 * Side drawer that lists every chapter in an EPUB with a per-chapter
 * unknown% badge. Unknown% is computed client-side against the in-memory
 * known-word set so badges update immediately when words are marked known
 * elsewhere in the UI.
 */
export function EpubChapterPicker({
  open,
  bookTitle,
  chapters,
  savedChapters,
  version = 0,
  onClose,
  onOpenChapter,
}: EpubChapterPickerProps) {
  // Subscribe to known-set mutations so we re-compute unknown% when the
  // user marks a word known elsewhere.
  const knownVersion = useWordStore((s) => s.version);

  const rows = useMemo<PickerRow[]>(() => {
    if (chapters && chapters.length > 0) {
      return chapters.map((ch) => ({
        key: `ch-${ch.index}`,
        title: ch.title,
        subtitle: `Chapter ${ch.index + 1}`,
        wordCount: ch.word_count,
        unknownRatio: chapterUnknownRatio(ch.raw_text),
      }));
    }
    if (savedChapters && savedChapters.length > 0) {
      return savedChapters.map((m, i) => ({
        key: `m-${m.id}`,
        title: m.title,
        subtitle:
          m.chapter_index !== null ? `Chapter ${m.chapter_index + 1}` : `Chapter ${i + 1}`,
        wordCount: m.total_tokens,
        unknownRatio: m.unique_tokens > 0 ? m.unknown_count / m.unique_tokens : 0,
      }));
    }
    return [];
    // `knownVersion` and `version` intentionally in deps: re-derive unknown%
    // whenever the caller bumps version or the known-set changes.
  }, [chapters, savedChapters, knownVersion, version]);

  return (
    <Drawer
      title={
        <Space>
          <BookOutlined />
          <strong>{bookTitle}</strong>
        </Space>
      }
      placement="left"
      width={420}
      open={open}
      onClose={onClose}
    >
      <ChapterList rows={rows} onOpenChapter={onOpenChapter} />
      {rows.length === 0 && <Text type="secondary">No chapters available.</Text>}
    </Drawer>
  );
}

interface PickerRow {
  key: string;
  title: string;
  subtitle: string;
  wordCount: number;
  unknownRatio: number;
}

function ChapterList({
  rows,
  onOpenChapter,
}: {
  rows: PickerRow[];
  onOpenChapter: (index: number) => void;
}) {
  return (
    <List
      itemLayout="horizontal"
      dataSource={rows}
      renderItem={(row, index) => {
        const pct = Math.round(row.unknownRatio * 1000) / 10; // one decimal
        const colour =
          row.unknownRatio <= 0.05 ? 'green' : row.unknownRatio >= 0.12 ? 'red' : 'orange';
        return (
          <List.Item
            data-testid="epub-chapter-row"
            onClick={() => onOpenChapter(index)}
            style={{ cursor: 'pointer', padding: '10px 0' }}
            actions={[
              <Button key="open" size="small" icon={<ReadOutlined />}>
                Open
              </Button>,
            ]}
          >
            <List.Item.Meta
              title={
                <Space>
                  <Tag color={colour}>{pct}% unknown</Tag>
                  <strong>{row.title}</strong>
                </Space>
              }
              description={
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {row.subtitle} · {row.wordCount.toLocaleString()} words
                  </Text>
                  <Progress
                    percent={Math.max(0, Math.min(100, pct))}
                    size="small"
                    showInfo={false}
                    strokeColor={
                      colour === 'green' ? '#22c55e' : colour === 'red' ? '#ef4444' : '#f59e0b'
                    }
                    style={{ marginTop: 6 }}
                  />
                </div>
              }
            />
          </List.Item>
        );
      }}
    />
  );
}

/**
 * Compute `unknown_unique / total_unique` against the in-memory known set.
 * Runs synchronously on the raw chapter text — fine for Gutenberg-scale
 * chapters (~5k tokens) and keeps the picker reactive.
 */
export function chapterUnknownRatio(raw: string): number {
  const toks = tokenize(raw);
  const seen = new Set<string>();
  let unknown = 0;
  for (const t of toks) {
    if (!t.lemma) continue;
    if (seen.has(t.lemma)) continue;
    seen.add(t.lemma);
    if (!isLemmaKnown(t.lemma)) unknown += 1;
  }
  if (seen.size === 0) return 0;
  return unknown / seen.size;
}

/** Minimal hook: re-run an expensive picker computation whenever the caller
 * bumps `deps`. Kept exported so page.tsx can force a refresh after saving
 * freshly-imported chapters to the DB. */
export function useChapterPickerRefresh() {
  const [n, setN] = useState(0);
  return { version: n, bump: () => setN((v) => v + 1) };
}
