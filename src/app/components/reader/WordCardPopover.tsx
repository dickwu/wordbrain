'use client';

import { Popover, Button, Typography, Tag, Space } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import type { WordHighlightClickPayload } from './WordHighlightExtension';

const { Text, Paragraph } = Typography;

interface WordCardPopoverProps {
  payload: WordHighlightClickPayload;
  onClose: () => void;
  onMarkKnown: () => void;
}

export function WordCardPopover({ payload, onClose, onMarkKnown }: WordCardPopoverProps) {
  // Anchor a zero-size div at the decoration's client rect so AntD Popover can
  // position itself against it without us having to pass a trigger element.
  const style: React.CSSProperties = {
    position: 'fixed',
    left: payload.rect.x,
    top: payload.rect.y,
    width: payload.rect.width,
    height: payload.rect.height,
    pointerEvents: 'none',
  };

  const content = (
    <div style={{ maxWidth: 320 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <Text strong style={{ fontSize: 18 }}>
          {payload.lemma}
        </Text>
        {payload.surface.toLowerCase() !== payload.lemma && (
          <Tag color="blue" style={{ fontSize: 11 }}>
            seen as {payload.surface}
          </Tag>
        )}
      </div>
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10 }}>
        Dictionary lookup lands in Phase 2 (ECDICT offline · Youdao/DeepL online · AI on-demand).
      </Paragraph>
      <Space>
        <Button type="primary" icon={<CheckOutlined />} onClick={onMarkKnown}>
          Mark known
        </Button>
        <Button icon={<CloseOutlined />} onClick={onClose}>
          Close
        </Button>
      </Space>
    </div>
  );

  return (
    <div style={style}>
      <Popover
        content={content}
        open
        placement="bottom"
        trigger={[]}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <div style={{ width: '100%', height: '100%' }} />
      </Popover>
    </div>
  );
}
