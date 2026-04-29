'use client';

import { useEffect, useState } from 'react';
import { ApiOutlined, CheckCircleTwoTone, CloseCircleTwoTone } from '@ant-design/icons';
import { Alert, App as AntApp, Button, Card, Input, Space, Switch, Tag, Typography } from 'antd';
import {
  getDictionaryApiConfig,
  saveDictionaryApiConfig,
  testDictionaryApiConfig,
} from '@/app/lib/dict';
import { isTauri } from '@/app/lib/ipc';

const { Paragraph, Text } = Typography;

export function DictionaryApiSettingsPanel() {
  const { message } = AntApp.useApp();
  const [enabled, setEnabled] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [ok, setOk] = useState<boolean | null>(null);

  const load = async () => {
    if (!isTauri()) return;
    try {
      const config = await getDictionaryApiConfig();
      setEnabled(config.enabled);
      setServerUrl(config.serverUrl);
      setHasApiKey(config.hasApiKey);
    } catch (err) {
      console.error('[wordbrain] load dictionary API config', err);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!isTauri()) {
      message.info('Dictionary API settings require the Tauri shell.');
      return false;
    }
    setSaving(true);
    setStatus(null);
    setOk(null);
    try {
      const config = await saveDictionaryApiConfig({
        enabled,
        serverUrl,
        apiKey: apiKey.trim() || undefined,
      });
      setEnabled(config.enabled);
      setServerUrl(config.serverUrl);
      setHasApiKey(config.hasApiKey);
      setApiKey('');
      message.success('Dictionary API saved');
      return true;
    } catch (err) {
      message.error(`Save dictionary API failed: ${err}`);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!isTauri()) return;
    setSaving(true);
    try {
      const config = await saveDictionaryApiConfig({ apiKey: '' });
      setHasApiKey(config.hasApiKey);
      setApiKey('');
      message.success('Dictionary API key cleared');
    } catch (err) {
      message.error(`Clear dictionary API key failed: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!isTauri()) {
      message.info('Dictionary API test requires the Tauri shell.');
      return;
    }
    setTesting(true);
    setStatus(null);
    setOk(null);
    try {
      const saved = await save();
      if (!saved) return;
      const result = await testDictionaryApiConfig();
      setOk(result.ok);
      setStatus(result.message);
    } catch (err) {
      setOk(false);
      setStatus(String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      size="small"
      title={
        <span>
          <ApiOutlined /> Dictionary API
        </span>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        Connect WordBrain to a private dictionary server. The API key is encrypted at rest and only
        read by the Rust backend.
      </Paragraph>
      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Dictionary API settings are disabled outside the Tauri shell."
          style={{ marginBottom: 12 }}
        />
      )}

      <Space orientation="vertical" size={10} style={{ width: '100%' }}>
        <Space align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space orientation="vertical" size={2}>
            <Text strong>Enable remote dictionaries</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Lookups use only the configured Dictionary API.
            </Text>
          </Space>
          <Switch checked={enabled} onChange={setEnabled} />
        </Space>

        <Input
          size="small"
          placeholder="http://server-ip-or-domain:8080"
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          onPressEnter={() => void save()}
        />
        <Input.Password
          size="small"
          placeholder={hasApiKey ? 'API key saved' : 'API key'}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
          onPressEnter={() => void save()}
        />

        <Space wrap>
          <Button size="small" type="primary" loading={saving} onClick={() => void save()}>
            Save
          </Button>
          <Button size="small" loading={testing} onClick={() => void test()}>
            Test
          </Button>
          <Button size="small" disabled={!hasApiKey} onClick={() => void clearKey()}>
            Clear key
          </Button>
          <Tag color={enabled ? 'processing' : 'default'}>{enabled ? 'enabled' : 'disabled'}</Tag>
          <Tag color={hasApiKey ? 'success' : 'warning'}>
            {hasApiKey ? 'key configured' : 'no key'}
          </Tag>
        </Space>

        {status && (
          <Space size={6}>
            {ok ? (
              <CheckCircleTwoTone twoToneColor="#52c41a" />
            ) : (
              <CloseCircleTwoTone twoToneColor="#ff4d4f" />
            )}
            <Text type={ok ? 'success' : 'danger'} style={{ fontSize: 12 }}>
              {status}
            </Text>
          </Space>
        )}
      </Space>
    </Card>
  );
}
