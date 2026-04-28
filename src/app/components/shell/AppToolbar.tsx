'use client';

import { Fragment, type ReactNode } from 'react';

interface ToolbarProps {
  crumbs: ReadonlyArray<string>;
  right?: ReactNode;
}

export function AppToolbar({ crumbs, right }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            <span className={i === crumbs.length - 1 ? 'here' : undefined}>{c}</span>
          </Fragment>
        ))}
      </div>
      <div className="sp" />
      <div className="row gap-8">{right}</div>
    </div>
  );
}
