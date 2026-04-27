'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import {
  Alert,
  App as AntApp,
  Button,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Tag,
  theme,
  Tooltip,
  Typography,
} from 'antd';
import {
  BookOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  deleteStory,
  isTauri,
  listMaterials,
  recommendNext,
  type MaterialSummary,
  type RecommendedMaterial,
} from '@/app/lib/ipc';
import { estimateReadingMinutes } from '@/app/lib/material-builder';

const { Title, Text } = Typography;

interface LibraryViewProps {
  /** Bumped whenever the caller wants the list refetched. */
  refreshKey?: number;
  /** Fired when a row is picked; parent typically loads it into the reader. */
  onOpen?: (m: MaterialSummary) => void;
}

export function LibraryView({ refreshKey = 0, onOpen }: LibraryViewProps) {
  const { message } = AntApp.useApp();
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [recs, setRecs] = useState<RecommendedMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const { token } = theme.useToken();

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setLoading(false);
      setError('Library requires the Tauri shell — run `bun run tauri dev`.');
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    Promise.all([listMaterials(), recommendNext(0.035, 5).catch(() => [] as RecommendedMaterial[])])
      .then(([mats, next]) => {
        if (cancelled) return;
        setMaterials(mats);
        setRecs(next);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const topPick = recs[0];
  const topPickRow = useMemo(
    () => (topPick ? materials.find((m) => m.id === topPick.id) : undefined),
    [materials, topPick]
  );

  const onDeleteAiStory = useCallback(
    async (m: MaterialSummary) => {
      setDeletingId(m.id);
      try {
        const deleted = await deleteStory(m.id);
        if (!deleted) {
          message.warning('That story is already gone.');
        } else {
          message.success('Story deleted.');
        }
        setMaterials((prev) => prev.filter((item) => item.id !== m.id));
        setRecs((prev) => prev.filter((item) => item.id !== m.id));
      } catch (err) {
        message.error(`delete_story failed: ${err}`);
      } finally {
        setDeletingId(null);
      }
    },
    [message]
  );

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return <Alert type="warning" message={error} showIcon style={{ marginBottom: 12 }} />;
  }

  if (materials.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No materials saved yet. Paste some text or open a file to seed the library."
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {topPick && topPickRow && (
        <Alert
          type="success"
          showIcon
          icon={<ThunderboltOutlined />}
          message={
            <span>
              Next up: <strong>{topPick.title}</strong> — unknown ratio{' '}
              <Tag color={inSweetSpot(topPick.unknown_ratio) ? 'green' : 'orange'}>
                {(topPick.unknown_ratio * 100).toFixed(1)}%
              </Tag>
            </span>
          }
          action={
            <Button size="small" type="primary" onClick={() => onOpen?.(topPickRow)}>
              Open
            </Button>
          }
        />
      )}

      <LibraryHeader total={materials.length} />

      <div
        style={{
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          background: token.colorBgContainer,
          overflow: 'hidden',
        }}
      >
        <Virtuoso
          style={{ height: 480 }}
          data={materials}
          itemContent={(_, m) => (
            <LibraryRow
              material={m}
              deleting={deletingId === m.id}
              onOpen={onOpen}
              onDeleteAiStory={onDeleteAiStory}
            />
          )}
          components={{ Footer: () => <div style={{ height: 12 }} /> }}
        />
      </div>
    </div>
  );
}

function LibraryHeader({ total }: { total: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <Title level={4} style={{ margin: 0 }}>
        Library
      </Title>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {total} saved material{total === 1 ? '' : 's'}
      </Text>
    </div>
  );
}

function LibraryRow({
  material: m,
  deleting,
  onOpen,
  onDeleteAiStory,
}: {
  material: MaterialSummary;
  deleting: boolean;
  onOpen?: (m: MaterialSummary) => void;
  onDeleteAiStory?: (m: MaterialSummary) => void;
}) {
  const { token } = theme.useToken();
  const ratio = m.unique_tokens > 0 ? m.unknown_count / m.unique_tokens : 0;
  const ratioPct = (ratio * 100).toFixed(1);
  const est = estimateReadingMinutes(m.total_tokens);
  const lastRead = m.read_at ? new Date(m.read_at).toLocaleString() : '—';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(m)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onOpen?.(m);
      }}
      style={{
        padding: '12px 16px',
        borderBottom: `1px solid ${token.colorSplit}`,
        display: 'grid',
        gridTemplateColumns: '1.8fr 0.6fr 0.9fr 1fr 0.8fr 40px',
        gap: 12,
        alignItems: 'center',
        cursor: 'pointer',
      }}
    >
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <Space size={6}>
          <BookOutlined />
          <Tooltip title={m.title}>
            <strong>{m.title}</strong>
          </Tooltip>
        </Space>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {m.unique_tokens.toLocaleString()} words
        </Text>
      </div>
      <div>
        <Tag color={inSweetSpot(ratio) ? 'green' : ratio > 0.1 ? 'red' : 'default'}>
          {ratioPct}%
        </Tag>
      </div>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {lastRead}
        </Text>
      </div>
      <div style={{ textAlign: 'right' }}>
        <Space size={4}>
          <ClockCircleOutlined style={{ fontSize: 12, color: token.colorTextSecondary }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            ~{est} min
          </Text>
        </Space>
      </div>
      <div style={{ textAlign: 'right' }}>
        {m.source_kind === 'ai_story' && (
          <Popconfirm
            title="Delete this story?"
            description="It will be removed from Story history and Library."
            okText="Delete"
            cancelText="Cancel"
            okType="danger"
            onConfirm={(e) => {
              e?.stopPropagation();
              onDeleteAiStory?.(m);
            }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Button
              type="text"
              danger
              size="small"
              icon={<DeleteOutlined />}
              aria-label={`Delete ${m.title}`}
              loading={deleting}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </Popconfirm>
        )}
      </div>
    </div>
  );
}

function inSweetSpot(ratio: number): boolean {
  return ratio >= 0.02 && ratio <= 0.05;
}
