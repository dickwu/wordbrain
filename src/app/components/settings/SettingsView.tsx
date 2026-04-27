'use client';

import { Space, Typography } from 'antd';
import { AiPanel } from '@/app/components/settings/AiPanel';
import { ApiKeysPanel } from '@/app/components/settings/ApiKeysPanel';
import { DictionarySettingsPanel } from '@/app/components/settings/DictionarySettingsPanel';
import { GeneralSettingsPanel } from '@/app/components/settings/GeneralSettingsPanel';
import { UploadServerSettingsPanel } from '@/app/components/settings/UploadServerSettingsPanel';

const { Title, Text } = Typography;

export function SettingsView() {
  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>
          Settings
        </Title>
        <Text type="secondary">Local preferences, upload server, dictionaries, and AI.</Text>
      </div>

      <Space orientation="vertical" style={{ width: '100%' }} size={14}>
        <GeneralSettingsPanel />
        <UploadServerSettingsPanel />
        <DictionarySettingsPanel />
        <AiPanel />
        <ApiKeysPanel />
      </Space>
    </>
  );
}
