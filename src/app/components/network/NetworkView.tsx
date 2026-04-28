'use client';

/**
 * Phase-6 NetworkView — the "Network" surface rendered by the top-level page.
 *
 * Fetches `build_network(500)`, renders the graph, hosts the filter bar, and
 * coordinates the ClusterDrillDown drawer. Filtering is client-side — we
 * prune the node list and drop edges with dangling endpoints before handing
 * them to cytoscape, so a filter flip re-lays out without a round-trip.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, Empty, Spin, theme } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  buildNetwork,
  isTauri,
  listMaterials,
  type MaterialSummary,
  type NetworkPayload,
} from '@/app/lib/ipc';
import { WordNetworkGraph } from './WordNetworkGraph';
import { ClusterDrillDown } from './ClusterDrillDown';
import {
  DEFAULT_FILTER,
  NetworkFilters,
  filterNodes,
  type NetworkFilterValue,
} from './NetworkFilters';
import { useEffectiveTheme } from '@/app/stores/themeStore';

export interface NetworkViewProps {
  /** Bumped whenever callers want the graph refetched (e.g. after a new
   * material was imported). */
  refreshKey?: number;
  /** Jump to a material in the reader. */
  onOpenMaterial?: (materialId: number) => void;
}

export function NetworkView({ refreshKey = 0, onOpenMaterial }: NetworkViewProps) {
  const [payload, setPayload] = useState<NetworkPayload | null>(null);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<NetworkFilterValue>(DEFAULT_FILTER);
  const [activeLemma, setActiveLemma] = useState<string | null>(null);
  const [layoutMs, setLayoutMs] = useState<number | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const { token } = theme.useToken();
  const effectiveTheme = useEffectiveTheme();

  useEffect(() => {
    let cancelled = false;
    if (!isTauri()) {
      setLoading(false);
      setError('Network view requires the Tauri shell — run `bun run tauri dev`.');
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    Promise.all([buildNetwork(500), listMaterials().catch(() => [] as MaterialSummary[])])
      .then(([net, mats]) => {
        if (cancelled) return;
        setPayload(net);
        setMaterials(mats);
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
  }, [refreshKey, reloadTick]);

  // Apply the filter. We recompute a Set of surviving ids so edges with a
  // pruned endpoint can be dropped in one pass.
  const { visibleNodes, visibleEdges } = useMemo(() => {
    if (!payload) return { visibleNodes: [], visibleEdges: [] };
    const kept = filterNodes(payload.nodes, filter);
    const keptIds = new Set(kept.map((n) => n.id));
    const edges = payload.edges.filter((e) => keptIds.has(e.source) && keptIds.has(e.target));
    return { visibleNodes: kept, visibleEdges: edges };
  }, [payload, filter]);

  if (loading) {
    return (
      <div className="page wide" style={{ padding: 80, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page wide">
        <Alert type="warning" message={error} showIcon />
      </div>
    );
  }

  if (!payload || payload.nodes.length === 0) {
    return (
      <div className="page wide">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Bipartite graph · word ↔ material</div>
            <h1 className="page-title">
              Network<em>.</em>
            </h1>
            <p className="page-sub">Density grows as your vocabulary does.</p>
          </div>
        </div>
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No co-occurring words yet. Import a few materials and come back."
        />
      </div>
    );
  }

  return (
    <div
      className="page wide"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}
    >
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Bipartite graph · word ↔ material</div>
          <h1 className="page-title">
            Network<em>.</em>
          </h1>
          <p className="page-sub">
            Showing <strong>{payload.nodes.length}</strong> of{' '}
            {payload.total_words.toLocaleString()} words · {payload.edges.length} co-occurrence
            edges
            {layoutMs !== null && (
              <>
                {' '}
                · fcose layout in{' '}
                <span className="mono small" style={{ color: 'var(--ink-2)' }}>
                  {layoutMs.toFixed(0)} ms
                </span>
              </>
            )}
            .
          </p>
        </div>
        <button type="button" className="btn sm" onClick={() => setReloadTick((t) => t + 1)}>
          <ReloadOutlined /> Refresh
        </button>
      </div>

      <NetworkFilters
        value={filter}
        onChange={setFilter}
        materials={materials}
        visibleNodeCount={visibleNodes.length}
        totalNodeCount={payload.nodes.length}
      />

      <div
        style={{
          flex: 1,
          minHeight: 520,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: 8,
          background: token.colorBgContainer,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {visibleNodes.length === 0 ? (
          <div style={{ padding: 24 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No nodes match the current filter."
            />
          </div>
        ) : (
          <WordNetworkGraph
            nodes={visibleNodes}
            edges={visibleEdges}
            selectedLemma={activeLemma}
            onPickLemma={setActiveLemma}
            onLayoutStop={(ms) => setLayoutMs(ms)}
            effectiveTheme={effectiveTheme}
            style={{ width: '100%', height: '100%', minHeight: 520 }}
          />
        )}
      </div>

      <ClusterDrillDown
        lemma={activeLemma}
        onClose={() => setActiveLemma(null)}
        onOpenMaterial={onOpenMaterial}
        onPickLemma={(lemma) => setActiveLemma(lemma)}
      />
    </div>
  );
}
