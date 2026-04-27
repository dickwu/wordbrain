'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Space, Tag, Typography } from 'antd';
import { CheckCircleTwoTone, DeleteOutlined } from '@ant-design/icons';

const { Paragraph, Text } = Typography;

export interface ProviderKeyDef {
  id: string;
  label: string;
  hint: string;
  placeholder: string;
}

export function ProviderKeyRows({
  providers,
  configured,
  busyProvider,
  onSave,
  onClear,
}: {
  providers: ProviderKeyDef[];
  configured: Set<string>;
  busyProvider: string | null;
  onSave: (provider: string, value: string) => Promise<void>;
  onClear: (provider: string) => Promise<void>;
}) {
  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={12}>
      {providers.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          configured={configured.has(provider.id)}
          busy={busyProvider === provider.id}
          onSave={(value) => onSave(provider.id, value)}
          onClear={() => onClear(provider.id)}
        />
      ))}
    </Space>
  );
}

function ProviderRow({
  provider,
  configured,
  busy,
  onSave,
  onClear,
}: {
  provider: ProviderKeyDef;
  configured: boolean;
  busy: boolean;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched && configured) setValue('');
  }, [configured, touched]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <Text strong>{provider.label}</Text>
        <span style={{ flex: 1 }} />
        {configured && (
          <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">
            configured
          </Tag>
        )}
      </div>
      <Paragraph type="secondary" style={{ fontSize: 11, marginBottom: 4 }}>
        {provider.hint}
      </Paragraph>
      <Space.Compact style={{ width: '100%' }}>
        <Input.Password
          size="small"
          placeholder={provider.placeholder}
          value={value}
          onChange={(e) => {
            setTouched(true);
            setValue(e.target.value);
          }}
          autoComplete="off"
        />
        <Button
          type="primary"
          size="small"
          loading={busy}
          disabled={!value}
          onClick={async () => {
            await onSave(value);
            setValue('');
            setTouched(false);
          }}
        >
          Save
        </Button>
        <Button
          size="small"
          icon={<DeleteOutlined />}
          disabled={!configured || busy}
          onClick={onClear}
        >
          Clear
        </Button>
      </Space.Compact>
    </div>
  );
}
