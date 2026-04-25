'use client';

/**
 * Phase-6 ClusterDrillDown — side panel that shows a word's 1-hop + 2-hop
 * neighbours and the sentences where they co-occur with the anchor.
 *
 * Opened when the user clicks a node in `WordNetworkGraph`.
 */

import { useEffect, useRef, useState } from 'react';
import { Alert, Divider, Drawer, Empty, Spin, Tag, theme, Typography } from 'antd';
import { clusterForWord, isTauri, type ClusterNeighbour, type ClusterPayload } from '@/app/lib/ipc';

const { Text, Paragraph } = Typography;

interface ClusterDrillDownProps {
  /** Anchor lemma. When null the drawer is closed. */
  lemma: string | null;
  onClose: () => void;
  /** Optional jump target for "open the material where these co-occur". */
  onOpenMaterial?: (materialId: number) => void;
  /** Fired when a neighbour row is clicked — lets the caller move the
   * graph selection to the clicked lemma. */
  onPickLemma?: (lemma: string) => void;
}

export function ClusterDrillDown({
  lemma,
  onClose,
  onOpenMaterial,
  onPickLemma,
}: ClusterDrillDownProps) {
  const [cluster, setCluster] = useState<ClusterPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchIdRef = useRef(0);

  useEffect(() => {
    if (!lemma) {
      setCluster(null);
      setErr(null);
      setLoading(false);
      return;
    }
    if (!isTauri()) {
      setErr('Cluster drill-down requires the Tauri shell.');
      setCluster(null);
      setLoading(false);
      return;
    }
    const id = ++fetchIdRef.current;
    setLoading(true);
    setErr(null);
    clusterForWord(lemma, 20)
      .then((payload) => {
        if (id !== fetchIdRef.current) return;
        setCluster(payload);
        setLoading(false);
      })
      .catch((e) => {
        if (id !== fetchIdRef.current) return;
        setErr(String(e));
        setLoading(false);
      });
  }, [lemma]);

  const hop1 = cluster?.neighbours.filter((n) => n.hop === 1) ?? [];
  const hop2 = cluster?.neighbours.filter((n) => n.hop === 2) ?? [];

  return (
    <Drawer
      open={Boolean(lemma)}
      onClose={onClose}
      placement="right"
      size={560}
      title={
        lemma ? (
          <span>
            Cluster around <strong>{lemma}</strong>
            {cluster && (
              <Tag color={stateColor(cluster.anchor_state)} style={{ marginLeft: 8 }}>
                {cluster.anchor_state}
              </Tag>
            )}
          </span>
        ) : (
          'Cluster'
        )
      }
    >
      {err && <Alert type="warning" showIcon message={err} />}
      {loading && !err && (
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Spin />
        </div>
      )}

      {!loading && !err && cluster && cluster.neighbours.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`No co-occurring words for “${cluster.anchor}” yet.`}
        />
      )}

      {!loading && !err && cluster && cluster.neighbours.length > 0 && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Exposure count: {cluster.anchor_exposure_count} · {hop1.length} direct neighbour
            {hop1.length === 1 ? '' : 's'}, {hop2.length} 2-hop
          </Text>

          <Divider style={{ margin: '12px 0' }} titlePlacement="left">
            1-hop · shares ≥1 material with {cluster.anchor}
          </Divider>
          {hop1.map((n) => (
            <NeighbourBlock
              key={`h1-${n.lemma}`}
              n={n}
              onOpenMaterial={onOpenMaterial}
              onPickLemma={onPickLemma}
            />
          ))}

          {hop2.length > 0 && (
            <>
              <Divider style={{ margin: '16px 0 8px' }} titlePlacement="left">
                2-hop · reachable via a shared neighbour
              </Divider>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {hop2.map((n) => (
                  <Tag
                    key={`h2-${n.lemma}`}
                    color={stateColor(n.state)}
                    style={{ cursor: onPickLemma ? 'pointer' : 'default' }}
                    onClick={() => onPickLemma?.(n.lemma)}
                  >
                    {n.lemma}
                  </Tag>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}

function NeighbourBlock({
  n,
  onOpenMaterial,
  onPickLemma,
}: {
  n: ClusterNeighbour;
  onOpenMaterial?: (materialId: number) => void;
  onPickLemma?: (lemma: string) => void;
}) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        padding: 10,
        borderRadius: 6,
        border: `1px solid ${token.colorBorderSecondary}`,
        marginBottom: 8,
        background: token.colorFillTertiary,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onPickLemma?.(n.lemma)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && onPickLemma) onPickLemma(n.lemma);
        }}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          cursor: onPickLemma ? 'pointer' : 'default',
        }}
      >
        <Text strong>{n.lemma}</Text>
        <Tag color={stateColor(n.state)}>{n.state}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>
          exposure {n.exposure_count}
        </Text>
      </div>

      {n.shared_materials.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {n.shared_materials.map((m) => (
            <div key={m.material_id} style={{ marginTop: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <Text
                  style={{
                    fontSize: 12,
                    color: onOpenMaterial ? token.colorPrimary : token.colorText,
                    cursor: onOpenMaterial ? 'pointer' : 'default',
                  }}
                  onClick={() => onOpenMaterial?.(m.material_id)}
                >
                  {m.title}
                </Text>
              </div>
              {m.sentence_preview && (
                <Paragraph
                  type="secondary"
                  style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}
                >
                  “{m.sentence_preview}”
                </Paragraph>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function stateColor(state: string): string {
  switch (state) {
    case 'known':
      return 'green';
    case 'learning':
      return 'orange';
    case 'unknown':
      return 'blue';
    default:
      return 'default';
  }
}
