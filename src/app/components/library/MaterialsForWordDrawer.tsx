'use client';

import { useEffect, useRef, useState } from 'react';
import { Drawer, Empty, List, Spin, Tag, Typography } from 'antd';
import { isTauri, materialsForWord, type MaterialForWord } from '@/app/lib/ipc';

const { Text, Paragraph } = Typography;

interface MaterialsForWordDrawerProps {
  /** Lemma to look up; when null the drawer is closed. */
  lemma: string | null;
  onClose: () => void;
  /** Optional callback when a linked material is clicked. */
  onOpenMaterial?: (m: MaterialForWord) => void;
}

export function MaterialsForWordDrawer({
  lemma,
  onClose,
  onOpenMaterial,
}: MaterialsForWordDrawerProps) {
  const [items, setItems] = useState<MaterialForWord[] | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadIdRef = useRef(0);

  useEffect(() => {
    if (!lemma) {
      setItems(null);
      setElapsedMs(null);
      setErr(null);
      return;
    }
    if (!isTauri()) {
      setErr('Drawer requires the Tauri shell.');
      setItems([]);
      return;
    }
    const id = ++loadIdRef.current;
    const t0 = performance.now();
    materialsForWord(lemma)
      .then((rows) => {
        if (id !== loadIdRef.current) return;
        const elapsed = performance.now() - t0;
        setItems(rows);
        setElapsedMs(elapsed);
        setErr(null);
        // AC3: we explicitly want <100 ms for a 100-material library. Log a
        // warning so QA can spot regressions without extra tooling.
        if (elapsed > 100 && rows.length <= 100) {
          console.warn(
            `[wordbrain] materials_for_word(${lemma}) took ${elapsed.toFixed(1)} ms (budget 100 ms)`
          );
        }
      })
      .catch((e) => {
        if (id !== loadIdRef.current) return;
        setErr(String(e));
        setItems([]);
      });
  }, [lemma]);

  const open = Boolean(lemma);

  return (
    <Drawer
      title={lemma ? `Docs containing “${lemma}”` : 'Materials'}
      open={open}
      onClose={onClose}
      size={520}
      placement="right"
    >
      {err && <Text type="danger">{err}</Text>}
      {items === null && !err && <Spin />}

      {items && items.length === 0 && !err && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`No saved material mentions “${lemma}” yet.`}
        />
      )}

      {items && items.length > 0 && (
        <>
          {elapsedMs !== null && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {items.length} match{items.length === 1 ? '' : 'es'} · fetched in{' '}
              {elapsedMs.toFixed(1)} ms
            </Text>
          )}
          <List
            style={{ marginTop: 8 }}
            dataSource={items}
            renderItem={(m) => (
              <List.Item
                onClick={() => onOpenMaterial?.(m)}
                style={{ cursor: 'pointer', alignItems: 'flex-start' }}
              >
                <List.Item.Meta
                  title={
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <Text strong>{m.title}</Text>
                      <Tag color="blue">{m.occurrence_count}×</Tag>
                      {m.read_at ? (
                        <Tag color="default">read</Tag>
                      ) : (
                        <Tag color="processing">unread</Tag>
                      )}
                    </div>
                  }
                  description={
                    m.sentence_preview ? (
                      <Paragraph
                        type="secondary"
                        style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}
                      >
                        “{m.sentence_preview}”
                      </Paragraph>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        (no sentence preview stored)
                      </Text>
                    )
                  }
                />
              </List.Item>
            )}
          />
        </>
      )}
    </Drawer>
  );
}
