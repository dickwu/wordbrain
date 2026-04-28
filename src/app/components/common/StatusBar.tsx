'use client';

import { useSrsStore } from '@/app/stores/srsStore';
import { useWordStore } from '@/app/stores/wordStore';
import { UpdateChecker } from '@/app/components/common/UpdateChecker';

/**
 * Editorial bottom bar — JetBrains Mono, dim ink, sage "live" pulse.
 * Persistent across every view; surfaces local-DB heartbeat, known/due counts,
 * and the updater (which renders its own version pill on the right).
 */
export function StatusBar() {
  const knownCount = useWordStore((s) => s.known.size);
  const dueCount = useSrsStore((s) => s.dueCount);

  return (
    <div className="statusbar">
      <span className="live">Local · Turso SQLite</span>
      <span>·</span>
      <span>{knownCount.toLocaleString()} known</span>
      <span>·</span>
      <span>{dueCount} due</span>
      <div className="sp" />
      <UpdateChecker />
    </div>
  );
}
