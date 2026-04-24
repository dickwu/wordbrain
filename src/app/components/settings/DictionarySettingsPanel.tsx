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
  Select,
  Space,
  Switch,
  Tag,
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
  getDictionaryCloudConfig,
  importCustomDictionary,
  listCustomDictionaries,
  saveDictionaryCloudConfig,
  uploadDictionaryResources,
  type CustomDictionary,
  type DictionaryCloudConfig,
  type DictionaryCloudConfigInput,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;
const schemeOptions = [
  { label: 'https', value: 'https' },
  { label: 'http', value: 'http' },
];

export function DictionarySettingsPanel() {
  const { message } = AntApp.useApp();
  const [path, setPath] = useState('');
  const [cssPath, setCssPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingCloud, setSavingCloud] = useState(false);
  const [uploadingResources, setUploadingResources] = useState(false);
  const [dictionaries, setDictionaries] = useState<CustomDictionary[]>([]);
  const [cloudEnabled, setCloudEnabled] = useState(false);
  const [cloudUploadEnabled, setCloudUploadEnabled] = useState(false);
  const [endpointScheme, setEndpointScheme] = useState('https');
  const [endpointHost, setEndpointHost] = useState('');
  const [bucket, setBucket] = useState('');
  const [publicDomainScheme, setPublicDomainScheme] = useState('https');
  const [publicDomainHost, setPublicDomainHost] = useState('');
  const [prefix, setPrefix] = useState('wordbrain/dictionaries');
  const [r2ConfigText, setR2ConfigText] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [credentialStatus, setCredentialStatus] = useState('');

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
    void loadCloudConfig();
  }, []);

  const applyCloudConfig = (config: DictionaryCloudConfig) => {
    setCloudEnabled(config.enabled);
    setCloudUploadEnabled(config.uploadEnabled);
    setEndpointScheme(config.endpointScheme || 'https');
    setEndpointHost(config.endpointHost || '');
    setBucket(config.bucket || '');
    setPublicDomainScheme(config.publicDomainScheme || 'https');
    setPublicDomainHost(config.publicDomainHost || '');
    setPrefix(config.prefix || 'wordbrain/dictionaries');
    setCredentialStatus(
      [
        config.hasAccessKeyId ? 'access key saved' : null,
        config.hasSecretAccessKey ? 'secret saved' : null,
        config.hasApiToken ? 'API token saved' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    );
  };

  const loadCloudConfig = async () => {
    if (!isTauri()) return;
    try {
      applyCloudConfig(await getDictionaryCloudConfig());
    } catch (err) {
      console.error('[wordbrain] load dictionary cloud config', err);
    }
  };

  const saveCloudConfig = async (opts?: { silent?: boolean }) => {
    if (!isTauri()) return null;
    setSavingCloud(true);
    try {
      const config = await saveDictionaryCloudConfig({
        enabled: cloudEnabled,
        uploadEnabled: cloudEnabled && cloudUploadEnabled,
        endpointScheme,
        endpointHost,
        bucket,
        publicDomainScheme,
        publicDomainHost,
        prefix,
        accessKeyId: accessKeyId.trim() || undefined,
        secretAccessKey: secretAccessKey.trim() || undefined,
        apiToken: apiToken.trim() || undefined,
      });
      applyCloudConfig(config);
      setAccessKeyId('');
      setSecretAccessKey('');
      setApiToken('');
      if (!opts?.silent) {
        message.success('Dictionary resource settings saved');
      }
      return config;
    } catch (err) {
      if (!opts?.silent) {
        message.error(`Save resource settings failed: ${err}`);
      }
      throw err;
    } finally {
      setSavingCloud(false);
    }
  };

  const saveR2ConfigJson = async () => {
    if (!isTauri()) {
      message.info('Resource settings require the Tauri shell.');
      return;
    }
    const raw = r2ConfigText.trim();
    if (!raw) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      message.error('R2 config JSON is invalid');
      return;
    }

    setSavingCloud(true);
    try {
      const config = await saveDictionaryCloudConfig(parsed as DictionaryCloudConfigInput);
      applyCloudConfig(config);
      setAccessKeyId('');
      setSecretAccessKey('');
      setApiToken('');
      setR2ConfigText('');
      message.success('R2 resource settings saved');
    } catch (err) {
      message.error(`Save R2 config failed: ${err}`);
    } finally {
      setSavingCloud(false);
    }
  };

  const uploadAllResources = async () => {
    if (!isTauri()) {
      message.info('Resource upload requires the Tauri shell.');
      return;
    }
    if (dictionaries.length === 0) return;

    setUploadingResources(true);
    try {
      const raw = r2ConfigText.trim();
      if (raw) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          message.error('R2 config JSON is invalid');
          return;
        }
        const config = await saveDictionaryCloudConfig(parsed as DictionaryCloudConfigInput);
        applyCloudConfig(config);
        setR2ConfigText('');
      } else if (cloudEnabled) {
        await saveCloudConfig({ silent: true });
      }

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
      if (cloudEnabled) {
        await saveCloudConfig({ silent: true });
      }
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
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space size={8}>
            <CloudUploadOutlined />
            <Text strong>Resource files</Text>
          </Space>
          <Switch
            size="small"
            checked={cloudEnabled}
            onChange={(checked) => {
              setCloudEnabled(checked);
              if (!checked) setCloudUploadEnabled(false);
            }}
          />
        </Space>
        <Input.TextArea
          size="small"
          placeholder="Paste R2 config JSON"
          value={r2ConfigText}
          onChange={(e) => setR2ConfigText(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 5 }}
        />
        <Button
          size="small"
          icon={<CloudUploadOutlined />}
          loading={savingCloud}
          disabled={!r2ConfigText.trim()}
          onClick={() => void saveR2ConfigJson()}
        >
          Save R2 JSON
        </Button>
        {cloudEnabled && (
          <>
            <Space.Compact style={{ width: '100%' }}>
              <Select
                size="small"
                value={publicDomainScheme}
                options={schemeOptions}
                onChange={setPublicDomainScheme}
                style={{ width: 88 }}
              />
              <Input
                size="small"
                placeholder="Public file server domain"
                value={publicDomainHost}
                onChange={(e) => setPublicDomainHost(e.target.value)}
              />
            </Space.Compact>
            <Input
              size="small"
              placeholder="Object prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
            <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Upload mirror
              </Text>
              <Switch size="small" checked={cloudUploadEnabled} onChange={setCloudUploadEnabled} />
            </Space>
            {cloudUploadEnabled && (
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                <Space.Compact style={{ width: '100%' }}>
                  <Select
                    size="small"
                    value={endpointScheme}
                    options={schemeOptions}
                    onChange={setEndpointScheme}
                    style={{ width: 88 }}
                  />
                  <Input
                    size="small"
                    placeholder="R2-compatible endpoint hostname"
                    value={endpointHost}
                    onChange={(e) => setEndpointHost(e.target.value)}
                  />
                </Space.Compact>
                <Input
                  size="small"
                  placeholder="Bucket"
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                />
                <Input.Password
                  size="small"
                  placeholder={
                    credentialStatus.includes('access key')
                      ? 'Access key ID saved'
                      : 'Access key ID'
                  }
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                />
                <Input.Password
                  size="small"
                  placeholder={
                    credentialStatus.includes('secret saved')
                      ? 'Secret access key saved'
                      : 'Secret access key'
                  }
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                />
                <Input.Password
                  size="small"
                  placeholder={
                    credentialStatus.includes('API token')
                      ? 'Cloudflare API token saved'
                      : 'Cloudflare API token'
                  }
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                />
              </Space>
            )}
            <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {credentialStatus || 'No saved upload credentials'}
              </Text>
              <Button
                size="small"
                loading={savingCloud}
                disabled={!publicDomainHost.trim()}
                onClick={() => void saveCloudConfig()}
              >
                Save resources
              </Button>
              <Button
                size="small"
                icon={<CloudUploadOutlined />}
                loading={uploadingResources}
                disabled={dictionaries.length === 0 || savingCloud}
                onClick={() => void uploadAllResources()}
              >
                Upload all
              </Button>
            </Space>
          </>
        )}
      </Space>

      <div style={{ marginTop: 12 }}>
        {dictionaries.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No dictionaries imported" />
        ) : (
          <div style={{ border: '1px solid #f0f0f0', borderRadius: 6, overflow: 'hidden' }}>
            {dictionaries.map((dict, index) => (
              <div
                key={dict.id}
                style={{
                  padding: '8px 12px',
                  borderBottom: index === dictionaries.length - 1 ? 0 : '1px solid #f0f0f0',
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
