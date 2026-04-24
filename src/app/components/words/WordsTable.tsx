'use client';

import { Button, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { WordRecord } from '@/app/lib/words/types';
import { WordNoteCell } from './WordNoteCell';
import { WordStateCell } from './WordStateCell';

interface WordsTableProps {
  rows: WordRecord[];
  loading: boolean;
  selection: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  onUnmark: (lemma: string) => void;
  onStateChange: (lemma: string, state: 'known' | 'learning') => void;
  onNoteSave: (lemma: string, note: string | null) => Promise<void> | void;
}

function formatDate(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function WordsTable({
  rows,
  loading,
  selection,
  onSelectionChange,
  onUnmark,
  onStateChange,
  onNoteSave,
}: WordsTableProps) {
  const columns: ColumnsType<WordRecord> = [
    {
      title: 'Lemma',
      dataIndex: 'lemma',
      key: 'lemma',
      sorter: (a, b) => a.lemma.localeCompare(b.lemma),
      defaultSortOrder: 'ascend',
      width: 200,
    },
    {
      title: 'State',
      dataIndex: 'state',
      key: 'state',
      width: 130,
      render: (_: unknown, r: WordRecord) => <WordStateCell record={r} onChange={onStateChange} />,
    },
    {
      title: 'Source',
      dataIndex: 'stateSource',
      key: 'stateSource',
      width: 150,
      render: (v: string | null) => (v ? <Tag>{v}</Tag> : null),
    },
    {
      title: 'Added',
      dataIndex: 'markedKnownAt',
      key: 'markedKnownAt',
      width: 140,
      sorter: (a, b) => (a.markedKnownAt ?? 0) - (b.markedKnownAt ?? 0),
      render: (v: number | null) => formatDate(v),
    },
    {
      title: 'Exposures',
      dataIndex: 'exposureCount',
      key: 'exposureCount',
      width: 110,
      sorter: (a, b) => a.exposureCount - b.exposureCount,
    },
    {
      title: 'Note',
      dataIndex: 'userNote',
      key: 'userNote',
      render: (_: unknown, r: WordRecord) => <WordNoteCell record={r} onSave={onNoteSave} />,
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      render: (_: unknown, r: WordRecord) => (
        <Button size="small" danger onClick={() => onUnmark(r.lemma)}>
          Unmark
        </Button>
      ),
    },
  ];

  return (
    <Table<WordRecord>
      virtual
      rowKey="lemma"
      size="middle"
      dataSource={rows}
      columns={columns}
      loading={loading}
      rowSelection={{
        selectedRowKeys: Array.from(selection),
        onChange: (keys) => onSelectionChange(new Set(keys as string[])),
        preserveSelectedRowKeys: true,
      }}
      scroll={{ y: '60vh', x: 'max-content' }}
      pagination={false}
    />
  );
}
