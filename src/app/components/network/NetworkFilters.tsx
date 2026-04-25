'use client';

/**
 * Phase-6 NetworkFilters — toggles for the word-network view.
 *
 * Three filter dimensions:
 *  1. State — show any subset of {known, learning, unknown}.
 *  2. Material subset — restrict nodes to lemmas attached to ≥1 of the chosen
 *     materials (empty set ⇒ no material restriction, show everything).
 *  3. Min co-occurrence degree — hide strays that only link to a single
 *     partner; useful for pruning noise when the library is sparse.
 *
 * All filtering is done client-side on the already-fetched payload so flipping
 * a toggle re-lays out instantly without a round-trip.
 */

import { Checkbox, InputNumber, Select, Space, Tag, theme, Typography } from 'antd';
import type { MaterialSummary } from '@/app/lib/ipc';

const { Text } = Typography;

export interface NetworkFilterValue {
  /** Which word states pass. Empty set means "show none" (useful guardrail
   * when a user unchecks everything — the graph is empty until they re-enable
   * something). */
  states: Set<'known' | 'learning' | 'unknown'>;
  /** Restrict to words attached to at least one of these material ids.
   * Empty array ⇒ no material restriction. */
  materialIds: number[];
  /** Hide nodes with degree < this value. */
  minDegree: number;
}

export const DEFAULT_FILTER: NetworkFilterValue = {
  states: new Set(['known', 'learning', 'unknown']),
  materialIds: [],
  minDegree: 0,
};

export function NetworkFilters({
  value,
  onChange,
  materials,
  visibleNodeCount,
  totalNodeCount,
}: {
  value: NetworkFilterValue;
  onChange: (next: NetworkFilterValue) => void;
  materials: MaterialSummary[];
  visibleNodeCount: number;
  totalNodeCount: number;
}) {
  const { token } = theme.useToken();
  const toggleState = (s: 'known' | 'learning' | 'unknown', on: boolean) => {
    const next = new Set(value.states);
    if (on) next.add(s);
    else next.delete(s);
    onChange({ ...value, states: next });
  };

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 12px',
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        background: token.colorBgContainer,
      }}
    >
      <Space size={10} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>
          State
        </Text>
        <Checkbox
          checked={value.states.has('known')}
          onChange={(e) => toggleState('known', e.target.checked)}
        >
          <Tag color="green" style={{ marginInlineEnd: 0 }}>
            known
          </Tag>
        </Checkbox>
        <Checkbox
          checked={value.states.has('learning')}
          onChange={(e) => toggleState('learning', e.target.checked)}
        >
          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
            learning
          </Tag>
        </Checkbox>
        <Checkbox
          checked={value.states.has('unknown')}
          onChange={(e) => toggleState('unknown', e.target.checked)}
        >
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
            unknown
          </Tag>
        </Checkbox>
      </Space>

      <Space size={8} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>
          Min co-occurrence
        </Text>
        <InputNumber
          size="small"
          min={0}
          max={50}
          value={value.minDegree}
          onChange={(n) => onChange({ ...value, minDegree: Number(n ?? 0) })}
          style={{ width: 70 }}
        />
      </Space>

      <Space size={8} align="center" style={{ flex: 1, minWidth: 220 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Material subset
        </Text>
        <Select
          mode="multiple"
          size="small"
          allowClear
          placeholder="(every material)"
          style={{ minWidth: 200, flex: 1 }}
          value={value.materialIds}
          onChange={(ids) => onChange({ ...value, materialIds: ids })}
          options={materials
            .filter((m) => m.source_kind !== 'epub') // book rows are redundant with their chapters
            .map((m) => ({ value: m.id, label: m.title }))}
          maxTagCount={2}
          maxTagTextLength={16}
        />
      </Space>

      <Text type="secondary" style={{ fontSize: 12 }}>
        {visibleNodeCount.toLocaleString()} / {totalNodeCount.toLocaleString()} nodes
      </Text>
    </div>
  );
}

/** Apply the current filter to a node list. Returns the surviving subset so
 * the caller can also prune the edges (an edge with a dangling endpoint is
 * dropped). */
export function filterNodes<
  N extends { state: string; degree: number; id: number; material_ids: number[] },
>(nodes: N[], filter: NetworkFilterValue): N[] {
  const materialFilterActive = filter.materialIds.length > 0;
  const materialSet = new Set(filter.materialIds);
  return nodes.filter((n) => {
    if (!filter.states.has(n.state as 'known' | 'learning' | 'unknown')) return false;
    if (n.degree < filter.minDegree) return false;
    if (materialFilterActive) {
      const hit = n.material_ids.some((id) => materialSet.has(id));
      if (!hit) return false;
    }
    return true;
  });
}
