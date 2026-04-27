'use client';

import { useEffect, useState } from 'react';
import { Button, Empty, List, Space, Tag, theme, Typography } from 'antd';
import { CloseOutlined, DeleteOutlined, HistoryOutlined, SearchOutlined } from '@ant-design/icons';
import {
  clearLookupHistory,
  loadLookupHistory,
  removeLookupHistoryWord,
  subscribeLookupHistory,
} from '@/app/lib/lookup-history';

const { Title, Text } = Typography;

interface SearchHistoryViewProps {
  onSearch: (word: string) => void;
}

export function SearchHistoryView({ onSearch }: SearchHistoryViewProps) {
  const [history, setHistory] = useState<string[]>([]);
  const { token } = theme.useToken();

  const refresh = () => setHistory(loadLookupHistory());

  useEffect(() => {
    refresh();
    return subscribeLookupHistory(refresh);
  }, []);

  const removeWord = (word: string) => {
    setHistory(removeLookupHistoryWord(word));
  };

  const clearAll = () => {
    clearLookupHistory();
    setHistory([]);
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <HistoryOutlined /> Search History
          </Title>
          <Text type="secondary">
            {history.length} searched word{history.length === 1 ? '' : 's'}
          </Text>
        </div>
        {history.length > 0 && (
          <Button danger icon={<DeleteOutlined />} onClick={clearAll}>
            Clear
          </Button>
        )}
      </div>

      {history.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No searched words yet." />
      ) : (
        <div
          style={{
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
            background: token.colorBgContainer,
            overflow: 'hidden',
          }}
        >
          <List
            dataSource={history}
            renderItem={(word, index) => (
              <List.Item
                actions={[
                  <Button
                    key="search"
                    type="text"
                    icon={<SearchOutlined />}
                    onClick={() => onSearch(word)}
                    aria-label={`Search ${word}`}
                    title={`Search ${word}`}
                  />,
                  <Button
                    key="remove"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => removeWord(word)}
                    aria-label={`Remove ${word}`}
                    title={`Remove ${word}`}
                  />,
                ]}
                style={{
                  paddingInline: 16,
                  borderBottom: index === history.length - 1 ? 0 : `1px solid ${token.colorSplit}`,
                }}
              >
                <button
                  type="button"
                  onClick={() => onSearch(word)}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: token.colorText,
                    cursor: 'pointer',
                    minWidth: 0,
                    padding: 0,
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  <Space size={8}>
                    <Text strong>{word}</Text>
                    <Tag style={{ marginInlineEnd: 0 }}>recent</Tag>
                  </Space>
                </button>
              </List.Item>
            )}
          />
        </div>
      )}
    </div>
  );
}
