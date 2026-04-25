'use client';

/**
 * Phase-6 word-network visualisation (§Phase 6 of `.omc/plans/wordbrain-v1.md`).
 *
 * Renders up to 500 lemma nodes with `fcose` (force-directed compound) layout.
 * Node colour encodes `state` (known/learning/unknown), node size is
 * `log(exposure_count + 1)`, edge opacity tracks `log(weight + 1)`. Clicking a
 * node emits `onPickLemma`, which the page turns into a ClusterDrillDown panel.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import CytoscapeComponent from 'react-cytoscapejs';
import type { NetworkEdge, NetworkNode } from '@/app/lib/ipc';
import type { EffectiveTheme } from '@/app/stores/themeStore';

// Register the fcose layout exactly once. The dedupe guard stops us from
// registering twice in React-Strict-Mode dev (dev-only double render).
let registered = false;
function ensureRegistered() {
  if (registered) return;
  // cytoscape.use throws if called twice with the same ext name; swallow for
  // HMR-safety.
  try {
    cytoscape.use(fcose);
  } catch {
    /* already registered in a previous HMR cycle */
  }
  registered = true;
}

export interface WordNetworkGraphProps {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Active lemma to highlight (ring) — e.g. the anchor of the drill-down. */
  selectedLemma?: string | null;
  onPickLemma?: (lemma: string) => void;
  /** Captured to fulfil AC2 (<2 s to render). Fires on layout `stop`. */
  onLayoutStop?: (elapsedMs: number) => void;
  /** Light/dark theme — drives label and edge colors so the graph stays
   * readable on either canvas. Defaults to light. */
  effectiveTheme?: EffectiveTheme;
  style?: React.CSSProperties;
}

const STATE_COLOR: Record<string, string> = {
  known: '#22c55e',
  learning: '#f59e0b',
  unknown: '#4f46e5',
};

export function WordNetworkGraph({
  nodes,
  edges,
  selectedLemma,
  onPickLemma,
  onLayoutStop,
  effectiveTheme = 'light',
  style,
}: WordNetworkGraphProps) {
  ensureRegistered();
  const cyRef = useRef<Core | null>(null);
  const [, setLayoutTick] = useState(0);

  // Stylesheet depends on theme so labels and edges remain legible against the
  // app's canvas. Recomputed (and reapplied below) only when the theme flips.
  const stylesheet = useMemo<cytoscape.StylesheetJsonBlock[]>(
    () => buildStylesheet(effectiveTheme),
    [effectiveTheme]
  );

  // Build cytoscape element list. `data.size` is pre-computed so the
  // stylesheet can map-by-data rather than re-evaluating an expression per
  // frame.
  const elements = useMemo<ElementDefinition[]>(() => {
    const nodeEls: ElementDefinition[] = nodes.map((n) => ({
      group: 'nodes',
      data: {
        id: `n${n.id}`,
        lemma: n.lemma,
        state: n.state,
        exposure: n.exposure_count,
        size: nodeSize(n.exposure_count),
        degree: n.degree,
        color: STATE_COLOR[n.state] ?? STATE_COLOR.unknown,
      },
    }));
    const edgeEls: ElementDefinition[] = edges.map((e) => ({
      group: 'edges',
      data: {
        id: `e${e.source}_${e.target}`,
        source: `n${e.source}`,
        target: `n${e.target}`,
        weight: e.weight,
        opacity: edgeOpacity(e.weight),
      },
    }));
    return [...nodeEls, ...edgeEls];
  }, [nodes, edges]);

  // Wire click → onPickLemma. Keep one listener across rerenders.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !onPickLemma) return undefined;
    const handler = (evt: cytoscape.EventObject) => {
      const lemma = evt.target?.data?.('lemma');
      if (typeof lemma === 'string') onPickLemma(lemma);
    };
    cy.on('tap', 'node', handler);
    return () => {
      cy.off('tap', 'node', handler);
    };
  }, [onPickLemma]);

  // Reset layout whenever the elements change (filter toggles, refetch). We
  // call `layout(...).run()` explicitly so the consumer's `onLayoutStop` can
  // fire; react-cytoscapejs' internal layout handling skips the event.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const t0 = performance.now();
    const layout = cy.layout({
      name: 'fcose',
      quality: 'default',
      animate: false,
      randomize: true,
      nodeRepulsion: () => 4500,
      idealEdgeLength: () => 80,
      gravity: 0.25,
      numIter: 2500,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const onStop = () => {
      const elapsed = performance.now() - t0;
      onLayoutStop?.(elapsed);
      setLayoutTick((v) => v + 1);
    };
    layout.one('layoutstop', onStop);
    layout.run();
    return () => {
      layout.removeListener('layoutstop', onStop);
    };
  }, [elements, onLayoutStop]);

  // Reflect `selectedLemma` as a ring. We look up the node by `lemma` data
  // rather than id so the caller doesn't need to know DB ids.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$('node').removeClass('selected');
    if (!selectedLemma) return;
    cy.$(`node[lemma = "${escapeSelector(selectedLemma)}"]`).addClass('selected');
  }, [selectedLemma, elements]);

  // Reapply the stylesheet when the theme flips. `react-cytoscapejs` only
  // applies its `stylesheet` prop on init, so we drive the update by hand.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style().fromJson(stylesheet).update();
  }, [stylesheet]);

  return (
    <CytoscapeComponent
      elements={elements}
      style={{ width: '100%', height: '100%', ...style }}
      cy={(cy: Core) => {
        cyRef.current = cy;
      }}
      wheelSensitivity={0.2}
      stylesheet={stylesheet}
    />
  );
}

/** Node radius = log(exposure+1) scaled to a comfortable visual range. */
function nodeSize(exposureCount: number): number {
  const base = Math.log(Math.max(0, exposureCount) + 1);
  // Clamp so a single super-exposed word doesn't dominate.
  return Math.min(46, 14 + base * 7);
}

/** Edge opacity = log(weight+1) scaled into [0.18, 0.85]. */
function edgeOpacity(weight: number): number {
  const base = Math.log(Math.max(0, weight) + 1);
  return Math.min(0.85, 0.18 + base * 0.18);
}

/** Escape quotes so a lemma like `don't` is a valid selector literal. */
function escapeSelector(lemma: string): string {
  return lemma.replace(/["\\]/g, (c) => `\\${c}`);
}

// Cytoscape stylesheet, parameterised by theme. Light keeps the original
// indigo-on-white palette; dark inverts text and outlines so labels remain
// readable against the app's slate canvas.
function buildStylesheet(theme: EffectiveTheme): cytoscape.StylesheetJsonBlock[] {
  const isDark = theme === 'dark';
  const labelColor = isDark ? '#e2e8f0' : '#111827';
  const outlineColor = isDark ? '#0f172a' : '#ffffff';
  const edgeColor = isDark ? '#475569' : '#9ca3af';
  const selectedRing = isDark ? '#e2e8f0' : '#111827';
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        label: 'data(lemma)',
        color: labelColor,
        'font-size': 10,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-outline-color': outlineColor,
        'text-outline-width': 1.2,
        width: 'data(size)' as unknown as number,
        height: 'data(size)' as unknown as number,
        'border-width': 0,
      },
    },
    {
      selector: 'node.selected',
      style: {
        'border-color': selectedRing,
        'border-width': 3,
        'font-weight': 700,
      },
    },
    {
      selector: 'edge',
      style: {
        'line-color': edgeColor,
        'curve-style': 'haystack',
        opacity: 'data(opacity)' as unknown as number,
        width: 1.2,
      },
    },
  ];
}
