'use client';

import { useEffect, useState } from 'react';
import { Badge } from 'antd';
import { isTauri, listMaterials } from '@/app/lib/ipc';

interface StoryUnreadBadgeProps {
  children: React.ReactNode;
  /** Poll interval in ms; default 30s — stories are generated less often than SRS reviews drain. */
  pollMs?: number;
}

/**
 * Sidebar badge that shows the count of unread AI-generated stories
 * (`materials.source_kind='ai_story' AND read_at IS NULL`).
 *
 * Mirrors the pattern from `DueQueueBadge` — pulls the materials list and
 * filters in-memory so we do not need a dedicated count IPC. The list is
 * already fetched on mount of the Library view; the extra poll is cheap.
 */
export function StoryUnreadBadge({ children, pollMs = 30_000 }: StoryUnreadBadgeProps) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (!isTauri()) return;
      try {
        const rows = await listMaterials();
        if (cancelled) return;
        setCount(rows.filter((m) => m.source_kind === 'ai_story' && m.read_at === null).length);
      } catch (err) {
        console.warn('[wordbrain] story badge listMaterials failed', err);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return (
    <Badge count={count} size="small" offset={[4, -2]}>
      {children}
    </Badge>
  );
}
