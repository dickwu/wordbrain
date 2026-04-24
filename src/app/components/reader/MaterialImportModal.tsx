'use client';

import { useState } from 'react';
import { Modal, Input, Typography } from 'antd';

const { TextArea } = Input;
const { Paragraph } = Typography;

interface MaterialImportModalProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (raw: string) => void;
}

export function MaterialImportModal({ open, onCancel, onSubmit }: MaterialImportModalProps) {
  const [raw, setRaw] = useState('');

  return (
    <Modal
      open={open}
      title="Paste English reading material"
      width={720}
      okText="Load into reader"
      cancelText="Cancel"
      onCancel={() => {
        setRaw('');
        onCancel();
      }}
      onOk={() => {
        onSubmit(raw);
        setRaw('');
      }}
      okButtonProps={{ disabled: raw.trim().length === 0 }}
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Paste an article, a few paragraphs, or a chapter excerpt. Tokenisation + highlight happen
        instantly against your known-word list.
      </Paragraph>
      <TextArea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="Paste text here (≥ 100 characters recommended for a meaningful preview)"
        autoSize={{ minRows: 10, maxRows: 20 }}
      />
    </Modal>
  );
}
