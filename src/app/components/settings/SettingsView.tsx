'use client';

import { Space } from 'antd';
import { AiPanel } from '@/app/components/settings/AiPanel';
import { ApiKeysPanel } from '@/app/components/settings/ApiKeysPanel';
import { DictionarySettingsPanel } from '@/app/components/settings/DictionarySettingsPanel';
import { GeneralSettingsPanel } from '@/app/components/settings/GeneralSettingsPanel';
import { UploadServerSettingsPanel } from '@/app/components/settings/UploadServerSettingsPanel';

/**
 * Settings — editorial header on top, then the existing AntD panels stacked.
 * Each panel keeps its own form state; the wrapper just supplies the page
 * chrome so it lives inside the new shell.
 */
export function SettingsView() {
  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Preferences</div>
          <h1 className="page-title">
            Settings<em>.</em>
          </h1>
          <p className="page-sub">
            Sensible defaults. Change only what you need — your SQLite file lives on this machine.
          </p>
        </div>
      </div>

      <Space orientation="vertical" style={{ width: '100%' }} size={14}>
        <GeneralSettingsPanel />
        <UploadServerSettingsPanel />
        <DictionarySettingsPanel />
        <AiPanel />
        <ApiKeysPanel />
      </Space>
    </div>
  );
}
