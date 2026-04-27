'use client';

import { useEffect, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Space,
  Tag,
  theme,
  Typography,
} from 'antd';
import {
  BookOutlined,
  CheckCircleTwoTone,
  CloudUploadOutlined,
  FolderOpenOutlined,
  ImportOutlined,
} from '@ant-design/icons';
import {
  importCustomDictionary,
  listCustomDictionaries,
  uploadDictionaryResources,
  type CustomDictionary,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;

export function DictionarySettingsPanel() {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [path, setPath] = useState('');
  const [cssPath, setCssPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadingResources, setUploadingResources] = useState(false);
  const [dictionaries, setDictionaries] = useState<CustomDictionary[]>([]);

  const refresh = async () => {
    if (!isTauri()) return;
    try {
      setDictionaries(await listCustomDictionaries());
    } catch (err) {
      console.error('[wordbrain] load custom dictionaries', err);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const uploadAllResources = async () => {
    if (!isTauri()) {
      message.info('Resource upload requires the Tauri shell.');
      return;
    }
    if (dictionaries.length === 0) return;

    setUploadingResources(true);
    try {
      const result = await uploadDictionaryResources({ force: true });
      await refresh();
      const totalResources = result.pageAssetCount + result.archiveResourceCount;
      if (result.failedCount > 0) {
        message.warning(
          `Uploaded ${result.uploadedCount.toLocaleString()} of ${totalResources.toLocaleString()} resources, ${result.failedCount.toLocaleString()} failed`
        );
      } else {
        message.success(
          `Uploaded ${result.uploadedCount.toLocaleString()} of ${totalResources.toLocaleString()} resources (${formatBytes(result.uploadedBytes)})`
        );
      }
    } catch (err) {
      message.error(`Upload resources failed: ${err}`);
    } finally {
      setUploadingResources(false);
    }
  };

  const pickDictionary = async () => {
    if (!isTauri()) {
      message.info('Dictionary import requires the Tauri shell.');
      return;
    }
    const selected = await openDialog({
      title: 'Choose dictionary folder or .mdx file',
      directory: true,
      multiple: false,
      recursive: true,
      fileAccessMode: 'scoped',
    });
    if (typeof selected === 'string') {
      setPath(selected);
    }
  };

  const pickCssFile = async () => {
    if (!isTauri()) {
      message.info('CSS import requires the Tauri shell.');
      return;
    }
    const selected = await openDialog({
      title: 'Choose dictionary CSS file',
      multiple: false,
      filters: [{ name: 'CSS', extensions: ['css'] }],
      fileAccessMode: 'scoped',
    });
    if (typeof selected === 'string') {
      setCssPath(selected);
    }
  };

  const importDictionary = async () => {
    const trimmed = path.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const dict = await importCustomDictionary(trimmed, {
        cssPath: cssPath.trim() || null,
      });
      message.success(`Imported ${dict.name}`);
      setPath('');
      setCssPath('');
      await refresh();
    } catch (err) {
      message.error(`Dictionary import failed: ${err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={
        <span>
          <BookOutlined /> Dictionaries
        </span>
      }
      size="small"
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Import an MDict dictionary folder or a single .mdx file into WordBrain's local database. Add
        a CSS file when the stylesheet lives outside the dictionary folder.
      </Paragraph>
      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Running in browser dev — dictionary import is disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}
      <Space.Compact style={{ width: '100%' }}>
        <Input
          size="small"
          placeholder="Path to dictionary folder or .mdx"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onPressEnter={importDictionary}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={pickDictionary}>
          Pick
        </Button>
        <Button
          type="primary"
          size="small"
          icon={<ImportOutlined />}
          loading={busy}
          disabled={!path.trim()}
          onClick={importDictionary}
        >
          Import
        </Button>
      </Space.Compact>
      <Space.Compact style={{ width: '100%', marginTop: 8 }}>
        <Input
          size="small"
          placeholder="Optional CSS file path"
          value={cssPath}
          onChange={(e) => setCssPath(e.target.value)}
          onPressEnter={importDictionary}
        />
        <Button size="small" icon={<FolderOpenOutlined />} onClick={pickCssFile}>
          Pick CSS
        </Button>
      </Space.Compact>

      <Divider style={{ margin: '14px 0 10px' }} />
      <Space orientation="vertical" size={8} style={{ width: '100%' }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }} wrap>
          <Space size={8}>
            <CloudUploadOutlined />
            <Text strong>Resource uploads</Text>
          </Space>
          <Button
            size="small"
            icon={<CloudUploadOutlined />}
            loading={uploadingResources}
            disabled={dictionaries.length === 0}
            onClick={() => void uploadAllResources()}
          >
            Upload all
          </Button>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Uses the shared Upload Server settings above for public URLs and R2-compatible uploads.
        </Text>
      </Space>

      <div style={{ marginTop: 12 }}>
        {dictionaries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No dictionaries imported" />
        ) : (
          <div
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            {dictionaries.map((dict, index) => (
              <div
                key={dict.id}
                style={{
                  padding: '8px 12px',
                  borderBottom:
                    index === dictionaries.length - 1
                      ? 0
                      : `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Space size={6} wrap>
                  <Text strong>{dict.name}</Text>
                  <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">
                    {dict.entry_count.toLocaleString()} entries
                  </Tag>
                  <Tag color={dict.storage_kind === 'database' ? 'blue' : 'orange'}>
                    {dict.storage_kind === 'database' ? 'local database' : 'external file'}
                  </Tag>
                </Space>
                <div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {dictionaryStorageSummary(dict)}
                  </Text>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function dictionaryStorageSummary(dict: CustomDictionary) {
  if (dict.storage_kind !== 'database') {
    return `${dict.mdx_path} · re-import to store it in the local database`;
  }
  return [
    `${formatBytes(dict.mdx_size)} stored`,
    `${dict.asset_count} page ${plural(dict.asset_count, 'asset')}`,
    dict.resource_archive_count
      ? `${dict.resource_archive_count} resource ${plural(dict.resource_archive_count, 'library')}`
      : null,
    dict.cloud_file_count
      ? `${dict.cloud_file_count} cloud ${plural(dict.cloud_file_count, 'file')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function plural(count: number, noun: string) {
  return count === 1 ? noun : `${noun}s`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
