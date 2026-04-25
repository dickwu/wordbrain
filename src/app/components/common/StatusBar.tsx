'use client';

import { Space, theme, Typography } from 'antd';
import { useWordStore } from '@/app/stores/wordStore';
import { UpdateChecker } from '@/app/components/common/UpdateChecker';

const { Text } = Typography;

/**
 * Persistent bottom bar shown on every view. Left group surfaces the updater
 * status + app version + known-word count; right group carries the bundle
 * identifier as a small ambient label for support / debugging.
 */
export function StatusBar() {
  const knownCount = useWordStore((s) => s.known.size);
  const { token } = theme.useToken();

  return (
    <div
      className="wb-status-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '4px 16px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgLayout,
        fontSize: 12,
        minHeight: 32,
      }}
    >
      <Space size="middle">
        <UpdateChecker />
        <Text type="secondary">{knownCount.toLocaleString()} known words</Text>
      </Space>
      <Text type="secondary" style={{ fontSize: 11 }}>
        com.lifefarmer.wordbrain
      </Text>
    </div>
  );
}
