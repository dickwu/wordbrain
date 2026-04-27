'use client';

import { useState } from 'react';
import { Popover, Button, Typography, Tag, Space, Tabs } from 'antd';
import { CheckOutlined, CloseOutlined, LinkOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp } from 'antd';
import type { WordHighlightClickPayload } from './WordHighlightExtension';
import { addToSrs, isTauri } from '@/app/lib/ipc';
import { refreshDueCount } from '@/app/stores/srsStore';
import { AiTab, OfflineTab, OnlineTab } from '@/app/components/dictionary/LookupTabs';

const { Text } = Typography;

interface WordCardPopoverProps {
  payload: WordHighlightClickPayload;
  onClose: () => void;
  onMarkKnown: () => void;
  /** Sentence containing the word — fed to lookup_ai for contextual gloss. */
  contextSentence?: string;
  /** Optional hook: if provided a "Related docs" button surfaces the drawer. */
  onDrillLemma?: () => void;
}

export function WordCardPopover({
  payload,
  onClose,
  onMarkKnown,
  contextSentence,
  onDrillLemma,
}: WordCardPopoverProps) {
  const { message } = AntApp.useApp();
  const [addingToSrs, setAddingToSrs] = useState(false);

  const handleAddToSrs = async () => {
    setAddingToSrs(true);
    try {
      if (!isTauri()) {
        message.info(`[dev] would schedule "${payload.lemma}" for SRS`);
      } else {
        const out = await addToSrs(payload.lemma);
        if (out.already_scheduled) {
          message.info(`"${payload.lemma}" is already in your review queue.`);
        } else {
          message.success(`Added "${payload.lemma}" to the review queue.`);
        }
        await refreshDueCount();
      }
    } catch (err) {
      message.error(`Failed to add to SRS: ${err}`);
    } finally {
      setAddingToSrs(false);
    }
  };

  const style: React.CSSProperties = {
    position: 'fixed',
    left: payload.rect.x,
    top: payload.rect.y,
    width: payload.rect.width,
    height: payload.rect.height,
    pointerEvents: 'none',
  };

  const content = (
    <div style={{ width: 360 }}>
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

      <Tabs
        size="small"
        defaultActiveKey="offline"
        items={[
          {
            key: 'offline',
            label: '离线',
            children: <OfflineTab lemma={payload.lemma} />,
          },
          {
            key: 'online',
            label: '在线',
            children: <OnlineTab lemma={payload.lemma} />,
          },
          {
            key: 'ai',
            label: '智能',
            children: (
              <AiTab lemma={payload.lemma} contextSentence={contextSentence ?? payload.surface} />
            ),
          },
        ]}
      />

      <Space style={{ marginTop: 8 }} wrap>
        <Button type="primary" size="small" icon={<CheckOutlined />} onClick={onMarkKnown}>
          Mark known
        </Button>
        <Button size="small" icon={<PlusOutlined />} loading={addingToSrs} onClick={handleAddToSrs}>
          Add to SRS
        </Button>
        {onDrillLemma && (
          <Button size="small" icon={<LinkOutlined />} onClick={onDrillLemma}>
            Related docs
          </Button>
        )}
        <Button size="small" icon={<CloseOutlined />} onClick={onClose}>
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
