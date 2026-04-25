'use client';

import { App, Card, Segmented, Space, Switch, Typography } from 'antd';
import { useSettingsStore } from '@/app/stores/settingsStore';
import { useThemeStore, type ThemeMode } from '@/app/stores/themeStore';

const { Title, Text } = Typography;

const THEME_OPTIONS: { label: string; value: ThemeMode }[] = [
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
  { label: 'System', value: 'system' },
];

/** General app preferences. Holds the appearance + auto-update toggles; grow
 * as Phase 9+ preferences land. */
export function GeneralSettingsPanel() {
  const { message } = App.useApp();
  const autoUpdateEnabled = useSettingsStore((s) => s.autoUpdateEnabled);
  const setAutoUpdate = useSettingsStore((s) => s.setAutoUpdate);
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);

  return (
    <Card size="small">
      <Space orientation="vertical" style={{ width: '100%' }} size={12}>
        <Title level={5} style={{ margin: 0 }}>
          General
        </Title>

        <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Space orientation="vertical" size={2}>
            <Text strong>Appearance</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Light, dark, or follow your operating system. The choice is remembered locally.
            </Text>
          </Space>
          <Segmented
            value={themeMode}
            onChange={(v) => setThemeMode(v as ThemeMode)}
            options={THEME_OPTIONS}
          />
        </Space>

        <Space style={{ width: '100%', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
