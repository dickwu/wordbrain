'use client';

import { useState } from 'react';
import { Input, Typography } from 'antd';
import type { WordRecord } from '@/app/lib/words/types';

const { Text } = Typography;

interface WordNoteCellProps {
  record: WordRecord;
  onSave: (lemma: string, note: string | null) => Promise<void> | void;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function WordNoteCell({ record, onSave }: WordNoteCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.userNote ?? '');

  const commit = () => {
    const trimmed = draft.trim();
    const current = record.userNote ?? '';
    if (trimmed !== current) {
      void onSave(record.lemma, trimmed.length === 0 ? null : trimmed);
    }
    setEditing(false);
  };

  const cancel = () => {
    setDraft(record.userNote ?? '');
    setEditing(false);
  };

  if (!editing) {
    return (
      <Text
        type="secondary"
        style={{ cursor: 'pointer' }}
        onClick={() => {
          setDraft(record.userNote ?? '');
          setEditing(true);
        }}
      >
        {truncate(record.userNote ?? '—', 40)}
      </Text>
    );
  }

  return (
    <Input.TextArea
      autoSize={{ minRows: 1, maxRows: 4 }}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}
