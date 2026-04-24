'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal, Slider, Typography, Space, Tag, Button, App as AntApp } from 'antd';
import { hydrateFromDb } from '@/app/stores/wordStore';
import { frequencyPreview, getSetting, seedKnownFromFrequency, isTauri } from '@/app/lib/ipc';

const { Title, Paragraph, Text } = Typography;

// Empirical unknown-rate by cutoff on OpenSubtitles-style text. Approximate —
// the slider shows the user what to expect, not a promise.
const CUTOFF_PRESETS: Array<{ cutoff: number; unknownPct: number; label: string }> = [
  { cutoff: 500, unknownPct: 18, label: 'Beginner' },
  { cutoff: 1500, unknownPct: 9, label: 'Elementary' },
  { cutoff: 3000, unknownPct: 4, label: 'Intermediate' },
  { cutoff: 6000, unknownPct: 2, label: 'Upper-intermediate' },
  { cutoff: 12000, unknownPct: 1, label: 'Advanced' },
  { cutoff: 20000, unknownPct: 0.5, label: 'Near-native' },
];

const MIN = 200;
const MAX = 30000;

function estimateUnknownPct(cutoff: number): number {
  // Log-linear fit through the presets above — close enough for UX copy.
  const { unknownPct } = CUTOFF_PRESETS.reduce((best, p) =>
    Math.abs(Math.log(p.cutoff) - Math.log(cutoff)) <
    Math.abs(Math.log(best.cutoff) - Math.log(cutoff))
      ? p
      : best
  );
  return unknownPct;
}

interface Props {
  open: boolean;
  onFinish: () => void;
}

export function FirstLaunchWizard({ open, onFinish }: Props) {
  const { message } = AntApp.useApp();
  const [cutoff, setCutoff] = useState(3000);
  const [preview, setPreview] = useState<Array<[number, string]>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let cancelled = false;
    frequencyPreview(cutoff)
      .then((rows) => {
        if (!cancelled) setPreview(rows);
      })
      .catch((err) => console.warn('[wordbrain] frequency_preview failed', err));
    return () => {
      cancelled = true;
    };
  }, [open, cutoff]);

  const unknownPct = useMemo(() => estimateUnknownPct(cutoff), [cutoff]);

  const handleConfirm = async () => {
    if (!isTauri()) {
      message.warning('Tauri host not detected; skipping DB seed.');
      onFinish();
      return;
    }
    setBusy(true);
    try {
      const inserted = await seedKnownFromFrequency(cutoff);
      await hydrateFromDb();
      message.success(
        `Seeded ${inserted.toLocaleString()} known words. Typical news articles should show ≈${unknownPct}% unknown.`
      );
      onFinish();
    } catch (err) {
      console.error('[wordbrain] seeding failed', err);
      message.error(`Seeding failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      closable={false}
      mask={{ closable: false }}
      footer={null}
      width={620}
      title="Welcome to WordBrain"
      destroyOnHidden
    >
      <Space orientation="vertical" size={16} style={{ width: '100%' }}>
        <Paragraph style={{ marginBottom: 0 }}>
          Pick the point on the frequency list up to which you already know every word. We'll treat
          everything above that rank as <Text strong>known</Text> and only highlight the rest as you
          read.
        </Paragraph>

        <div>
          <Title level={5} style={{ marginBottom: 4 }}>
            I know the top {cutoff.toLocaleString()} most-common English words
          </Title>
          <Text type="secondary">Typical news articles will show ≈{unknownPct}% unknown.</Text>
          <Slider
            min={MIN}
            max={MAX}
            step={100}
            value={cutoff}
            onChange={(v) => setCutoff(Array.isArray(v) ? v[0] : v)}
            marks={Object.fromEntries(
              CUTOFF_PRESETS.map((p) => [p.cutoff, <span key={p.cutoff}>{p.label}</span>])
            )}
            tooltip={{ formatter: (v) => (v ? v.toLocaleString() : '') }}
          />
        </div>

        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Sample around rank {cutoff.toLocaleString()}:
          </Text>
          <div style={{ marginTop: 6, minHeight: 32 }}>
            {preview.map(([rank, lemma]) => (
              <Tag
                key={rank}
                color={rank <= cutoff ? 'blue' : 'default'}
                style={{ marginBottom: 4 }}
              >
                #{rank.toLocaleString()} {lemma}
              </Tag>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={onFinish} disabled={busy}>
            Skip
          </Button>
          <Button type="primary" loading={busy} onClick={handleConfirm}>
            Seed {cutoff.toLocaleString()} words
          </Button>
        </div>
      </Space>
    </Modal>
  );
}

/** Returns true if the wizard has never been completed on this machine. */
export async function needsFirstLaunchWizard(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const raw = await getSetting('freq_seed_cutoff');
    return raw === null;
  } catch {
    return false;
  }
}
