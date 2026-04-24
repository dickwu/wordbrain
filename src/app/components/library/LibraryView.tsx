'use client';

import { useEffect, useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Alert, Button, Empty, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { BookOutlined, ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
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
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [recs, setRecs] = useState<RecommendedMaterial[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          border: '1px solid rgba(0,0,0,0.06)',
          borderRadius: 8,
          background: '#fff',
          overflow: 'hidden',
        }}
      >
        <Virtuoso
          style={{ height: 480 }}
          data={materials}
          itemContent={(_, m) => <LibraryRow material={m} onOpen={onOpen} />}
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
  onOpen,
}: {
  material: MaterialSummary;
  onOpen?: (m: MaterialSummary) => void;
}) {
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
        borderBottom: '1px solid rgba(0,0,0,0.04)',
        display: 'grid',
        gridTemplateColumns: '1.8fr 0.6fr 0.9fr 1fr 0.8fr',
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
          <ClockCircleOutlined style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            ~{est} min
          </Text>
        </Space>
      </div>
    </div>
  );
}

function inSweetSpot(ratio: number): boolean {
  return ratio >= 0.02 && ratio <= 0.05;
}
