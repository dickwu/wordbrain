'use client';

// Placeholder Learning view (v0.3 Fri-night MVP scaffolding).
//
// Renders the page chrome (editorial header) plus a quiet "Garden coming
// Sat AM" body so the new default landing has something to show while the
// cytoscape Scatter is still on the bench. See
// `~/.gstack/projects/dickwu-wordbrain/lifefarmer-main-design-20260515-160613.md`
// for the full design — Sat AM swaps this body for `LearningActionBar` +
// `LearningGarden` over the canonical learning pool.

export function LearningView() {
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">In process · learning-first</div>
          <h1 className="page-title">
            Learning<em>.</em>
          </h1>
          <p className="page-sub">Your in-process vocabulary lives here. Garden coming Sat AM.</p>
        </div>
      </div>
    </div>
  );
}
