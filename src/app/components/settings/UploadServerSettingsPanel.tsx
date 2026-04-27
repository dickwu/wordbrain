'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Alert,
  Button,
  Card,
  Divider,
  Input,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { CloudUploadOutlined } from '@ant-design/icons';
import {
  getUploadServerConfig,
  saveUploadServerConfig,
  type UploadServerConfig,
  type UploadServerConfigInput,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;

const schemeOptions = [
  { label: 'https', value: 'https' },
  { label: 'http', value: 'http' },
];

export function UploadServerSettingsPanel() {
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [uploadEnabled, setUploadEnabled] = useState(false);
  const [endpointScheme, setEndpointScheme] = useState('https');
  const [endpointHost, setEndpointHost] = useState('');
  const [bucket, setBucket] = useState('');
  const [publicDomainScheme, setPublicDomainScheme] = useState('https');
  const [publicDomainHost, setPublicDomainHost] = useState('');
  const [prefix, setPrefix] = useState('wordbrain/resources');
  const [r2ConfigText, setR2ConfigText] = useState('');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [hasAccessKeyId, setHasAccessKeyId] = useState(false);
  const [hasSecretAccessKey, setHasSecretAccessKey] = useState(false);
  const [hasApiToken, setHasApiToken] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState('');

  useEffect(() => {
    void loadConfig();
  }, []);

  const applyConfig = (config: UploadServerConfig) => {
    setName(config.name || '');
    setAccountId(r2AccountIdFromEndpoint(config.endpointHost || ''));
    setEnabled(config.enabled);
    setUploadEnabled(config.uploadEnabled);
    setEndpointScheme(config.endpointScheme || 'https');
    setEndpointHost(config.endpointHost || '');
    setBucket(config.bucket || '');
    setPublicDomainScheme(config.publicDomainScheme || 'https');
    setPublicDomainHost(config.publicDomainHost || '');
    setPrefix(config.prefix || 'wordbrain/resources');
    setHasAccessKeyId(config.hasAccessKeyId);
    setHasSecretAccessKey(config.hasSecretAccessKey);
    setHasApiToken(config.hasApiToken);
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

  const r2ConfigData = useMemo(
    () =>
      JSON.stringify(
        {
          name,
          id: accountId || r2AccountIdFromEndpoint(endpointHost),
          token: credentialMarker(apiToken, hasApiToken),
          bucket,
          key: {
            accessKeyId: credentialMarker(accessKeyId, hasAccessKeyId),
            secretAccessKey: credentialMarker(secretAccessKey, hasSecretAccessKey),
          },
          enabled,
          uploadEnabled: enabled && uploadEnabled,
          endpoint: endpointHost ? `${endpointScheme}://${endpointHost}` : '',
          publicDomain: publicDomainHost ? `${publicDomainScheme}://${publicDomainHost}` : '',
          prefix,
        },
        null,
        2
      ),
    [
      accessKeyId,
      accountId,
      apiToken,
      bucket,
      enabled,
      endpointHost,
      endpointScheme,
      hasAccessKeyId,
      hasApiToken,
      hasSecretAccessKey,
      name,
      prefix,
      publicDomainHost,
      publicDomainScheme,
      secretAccessKey,
      uploadEnabled,
    ]
  );

  const loadConfig = async () => {
    if (!isTauri()) return;
    try {
      applyConfig(await getUploadServerConfig());
    } catch (err) {
      console.error('[wordbrain] load upload server config', err);
    }
  };

  const saveConfig = async () => {
    if (!isTauri()) return null;
    setSaving(true);
    try {
      const config = await saveUploadServerConfig({
        name,
        accountId: accountId.trim() || undefined,
        enabled,
        uploadEnabled: enabled && uploadEnabled,
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
      applyConfig(config);
      setAccessKeyId('');
      setSecretAccessKey('');
      setApiToken('');
      message.success('Upload server saved');
      return config;
    } catch (err) {
      message.error(`Save upload server failed: ${err}`);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const saveR2ConfigJson = async () => {
    if (!isTauri()) {
      message.info('Upload server settings require the Tauri shell.');
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

    setSaving(true);
    try {
      const config = await saveUploadServerConfig(parsed as UploadServerConfigInput);
      applyConfig(config);
      setAccessKeyId('');
      setSecretAccessKey('');
      setApiToken('');
      setR2ConfigText('');
      message.success('R2 upload server saved');
    } catch (err) {
      message.error(`Save R2 config failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <span>
          <CloudUploadOutlined /> Upload Server
        </span>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Configure the R2/S3-compatible file server WordBrain uses for uploaded resources.
      </Paragraph>
      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Upload server settings are disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}

      <Space orientation="vertical" size={10} style={{ width: '100%' }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space orientation="vertical" size={2}>
            <Text strong>Enable upload server</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Public resource URLs resolve through this domain.
            </Text>
          </Space>
          <Switch
            checked={enabled}
            onChange={(checked) => {
              setEnabled(checked);
              if (!checked) setUploadEnabled(false);
            }}
          />
        </Space>

        <Input
          size="small"
          placeholder="R2 config name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          size="small"
          placeholder="Cloudflare account ID"
          value={accountId}
          onChange={(e) => {
            const next = e.target.value.trim();
            setAccountId(next);
            setEndpointHost(next ? `${next}.r2.cloudflarestorage.com` : '');
          }}
        />

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
          loading={saving}
          disabled={!r2ConfigText.trim()}
          onClick={() => void saveR2ConfigJson()}
        >
          Save R2 JSON
        </Button>

        <Space orientation="vertical" size={4} style={{ width: '100%' }}>
          <Text strong>R2 config data</Text>
          <Input.TextArea
            size="small"
            value={r2ConfigData}
            readOnly
            autoSize={{ minRows: 8, maxRows: 14 }}
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            }}
          />
          <Text type="secondary" style={{ fontSize: 11 }}>
            Secrets are shown as saved or pending, not as raw values.
          </Text>
        </Space>

        {enabled && (
          <>
            <Divider style={{ margin: '4px 0' }} />
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
              <Space orientation="vertical" size={2}>
                <Text strong>Allow uploads</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Store new resources through the compatible object-storage endpoint.
                </Text>
              </Space>
              <Switch checked={uploadEnabled} onChange={setUploadEnabled} />
            </Space>

            {uploadEnabled && (
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
                    onChange={(e) => {
                      const next = e.target.value.trim();
                      setEndpointHost(next);
                      setAccountId(r2AccountIdFromEndpoint(next));
                    }}
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
                  autoComplete="off"
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
                  autoComplete="off"
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
                  autoComplete="off"
                />
              </Space>
            )}

            <Space style={{ justifyContent: 'space-between', width: '100%' }} wrap>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {credentialStatus || 'No saved upload credentials'}
              </Text>
            </Space>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={enabled && !publicDomainHost.trim()}
            onClick={() => void saveConfig()}
          >
            Save upload server
          </Button>
        </div>
      </Space>
    </Card>
  );
}

function r2AccountIdFromEndpoint(endpointHost: string) {
  const suffix = '.r2.cloudflarestorage.com';
  const host = endpointHost.trim();
  if (!host.endsWith(suffix)) return '';
  return host.slice(0, -suffix.length);
}

function credentialMarker(pendingValue: string, saved: boolean) {
  if (pendingValue.trim()) return '<pending>';
  if (saved) return '<saved>';
  return null;
}
