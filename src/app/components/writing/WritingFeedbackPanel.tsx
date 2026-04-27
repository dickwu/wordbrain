'use client';

import { Button, Space, Tag, Typography } from 'antd';
import type { WritingFeedbackIpc, WritingUsageVerdict } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;

interface WritingFeedbackPanelProps {
  feedback: WritingFeedbackIpc;
  onAcceptRewrite: () => void;
  onKeepMine: () => void;
}

export function WritingFeedbackPanel({
  feedback,
  onAcceptRewrite,
  onKeepMine,
}: WritingFeedbackPanelProps) {
  return (
    <div style={{ marginTop: 16 }}>
      <Space size={8} style={{ marginBottom: 8 }}>
        <VerdictBadge verdict={feedback.usage_verdict} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          Usage feedback for the target word
        </Text>
      </Space>

      <div
        style={{
          padding: 12,
          background: 'var(--ant-color-fill-tertiary, rgba(0,0,0,0.04))',
          borderRadius: 8,
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
        }}
      >
        {feedback.diff_spans.length === 0 ? (
          <span>{feedback.corrected_text}</span>
        ) : (
          feedback.diff_spans.map((span, i) => (
            <span key={i} className={spanClass(span.kind)}>
              {span.text}
            </span>
          ))
        )}
      </div>

      {feedback.usage_explanation && feedback.usage_verdict !== 'correct' && (
        <Paragraph style={{ marginTop: 8, fontSize: 13 }}>
          <Text strong>Why:</Text> {feedback.usage_explanation}
        </Paragraph>
      )}

      <Space style={{ marginTop: 12 }}>
        <Button type="primary" onClick={onAcceptRewrite}>
          Accept rewrite
        </Button>
        <Button onClick={onKeepMine}>Keep mine</Button>
      </Space>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict: WritingUsageVerdict }) {
  if (verdict === 'correct') return <Tag color="green">Correct usage</Tag>;
  if (verdict === 'incorrect') return <Tag color="red">Incorrect usage</Tag>;
  return <Tag color="orange">Ambiguous</Tag>;
}

function spanClass(kind: 'insert' | 'delete' | 'equal'): string {
  if (kind === 'insert') return 'wb-diff-insert';
  if (kind === 'delete') return 'wb-diff-delete';
  return '';
}
