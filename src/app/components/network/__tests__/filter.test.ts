import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, filterNodes, type NetworkFilterValue } from '../NetworkFilters';

// A minimal node shape matching what filterNodes actually reads.
function node(
  id: number,
  state: 'known' | 'learning' | 'unknown',
  degree: number,
  material_ids: number[] = []
) {
  return { id, state, degree, material_ids };
}

describe('filterNodes', () => {
  it('keeps everything under the default filter', () => {
    const nodes = [node(1, 'known', 3), node(2, 'learning', 1), node(3, 'unknown', 0)];
    expect(filterNodes(nodes, DEFAULT_FILTER)).toHaveLength(3);
  });

  it('drops nodes whose state is deselected', () => {
    const nodes = [node(1, 'known', 3), node(2, 'learning', 1), node(3, 'unknown', 0)];
    const f: NetworkFilterValue = {
      ...DEFAULT_FILTER,
      states: new Set(['unknown']),
    };
    const kept = filterNodes(nodes, f);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).toBe(3);
  });

  it('enforces the min-degree floor', () => {
    const nodes = [node(1, 'known', 5), node(2, 'known', 2), node(3, 'known', 0)];
    const f: NetworkFilterValue = { ...DEFAULT_FILTER, minDegree: 3 };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual([1]);
  });

  it('restricts to the chosen material subset', () => {
    const nodes = [
      node(1, 'known', 5, [100, 200]),
      node(2, 'known', 5, [300]),
      node(3, 'known', 5, []), // never in any material
    ];
    const f: NetworkFilterValue = { ...DEFAULT_FILTER, materialIds: [200] };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual([1]);
  });

  it('empty material list means "no restriction"', () => {
    const nodes = [node(1, 'known', 5, [100]), node(2, 'known', 5, [])];
    const f: NetworkFilterValue = { ...DEFAULT_FILTER, materialIds: [] };
    expect(filterNodes(nodes, f)).toHaveLength(2);
  });

  it('combining state + material + degree is an AND filter', () => {
    const nodes = [
      node(1, 'known', 5, [1]),
      node(2, 'learning', 5, [1]),
      node(3, 'known', 0, [1]),
      node(4, 'known', 5, [2]),
    ];
    const f: NetworkFilterValue = {
      states: new Set(['known']),
      minDegree: 3,
      materialIds: [1],
    };
    expect(filterNodes(nodes, f).map((n) => n.id)).toEqual([1]);
  });
});
