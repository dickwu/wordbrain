'use client';

import { useState } from 'react';
import { App as AntApp, Button, Input, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';

interface AddWordInputProps {
  onAdd: (lemma: string) => Promise<void> | void;
}

const LEMMA_RE = /^[a-z][a-z'-]*$/;

export function AddWordInput({ onAdd }: AddWordInputProps) {
  const { message } = AntApp.useApp();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const lemma = value.trim().toLowerCase();
    if (!lemma || !LEMMA_RE.test(lemma)) {
      message.warning('Enter a valid lowercase word (letters, apostrophes, hyphens)');
      return;
    }
    setBusy(true);
    try {
      await onAdd(lemma);
      setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space.Compact>
      <Input
        placeholder="Add a word"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={submit}
        style={{ width: 180 }}
      />
      <Button type="primary" icon={<PlusOutlined />} loading={busy} onClick={submit}>
        Add
      </Button>
    </Space.Compact>
  );
}
