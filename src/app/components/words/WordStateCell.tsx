'use client';

import { Select, Tag } from 'antd';
import type { WordRecord } from '@/app/lib/words/types';

interface WordStateCellProps {
  record: WordRecord;
  onChange: (lemma: string, state: 'known' | 'learning') => void;
}

const options = [
  { value: 'known', label: 'Known' },
  { value: 'learning', label: 'Learning' },
];

export function WordStateCell({ record, onChange }: WordStateCellProps) {
  if (record.state === 'unknown') {
    return <Tag>unknown</Tag>;
  }
  return (
    <Select
      value={record.state}
      options={options}
      onChange={(v) => onChange(record.lemma, v)}
      size="small"
      style={{ width: 110 }}
    />
  );
}
