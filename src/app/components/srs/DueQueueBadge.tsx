'use client';

import { useEffect } from 'react';
import { Badge } from 'antd';
import { useSrsStore, refreshDueCount } from '@/app/stores/srsStore';

interface DueQueueBadgeProps {
  children: React.ReactNode;
  /** Poll interval in ms so the badge stays live even without user clicks. */
  pollMs?: number;
}

/**
 * Wraps its children with an AntD Badge whose count == number of SRS rows
 * where `due <= now()`. Polls every `pollMs` (default 15s) so the pip goes
 * red as soon as the next card is due, even if the user is sitting on the
 * reader and not touching SRS.
 */
export function DueQueueBadge({ children, pollMs = 15_000 }: DueQueueBadgeProps) {
  const dueCount = useSrsStore((s) => s.dueCount);

  useEffect(() => {
    void refreshDueCount();
    const id = window.setInterval(() => {
      void refreshDueCount();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs]);

  return (
    <Badge count={dueCount} size="small" offset={[4, -2]}>
      {children}
    </Badge>
  );
}
