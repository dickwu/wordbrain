'use client';

import { App, Card, Space, Switch, Typography } from 'antd';
import { useSettingsStore } from '@/app/stores/settingsStore';

const { Title, Text } = Typography;

/** General app preferences. Currently holds the auto-update toggle; grow as
 * Phase 9+ preferences land. */
export function GeneralSettingsPanel() {
  const { message } = App.useApp();
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);

  return (
    <Card size="small">
      <Space orientation="vertical" style={{ width: '100%' }} size={12}>
        <Title level={5} style={{ margin: 0 }}>
          General
        </Title>
        <Space
          style={{ width: '100%', justifyContent: 'space-between', alignItems: 'flex-start' }}
        >
          <Space orientation="vertical" size={2}>
            <Text strong>Automatically check for updates</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              When enabled, WordBrain silently checks GitHub every 30 minutes for a new release.
              Manual checks (from the status bar) always work either way.
            </Text>
          </Space>
          <Switch
            checked={autoUpdateEnabled}
            onChange={async (v) => {
              try {
                await setAutoUpdate(v);
                message.success(v ? 'Auto-updates enabled' : 'Auto-updates paused');
              } catch (err) {
                message.error(`Could not save preference: ${err}`);
              }
            }}
          />
        </Space>
      </Space>
    </Card>
  );
}
