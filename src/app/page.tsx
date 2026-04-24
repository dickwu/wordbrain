'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Divider, Drawer, Layout, Space, Tag, Typography } from 'antd';
import {
  BookOutlined,
  PlusOutlined,
  ReadOutlined,
  SettingOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { ReaderPane } from '@/app/components/reader/ReaderPane';
import { MaterialImportModal } from '@/app/components/reader/MaterialImportModal';
import { ApiKeysPanel } from '@/app/components/settings/ApiKeysPanel';
import { LibraryView } from '@/app/components/library/LibraryView';
import { MaterialsForWordDrawer } from '@/app/components/library/MaterialsForWordDrawer';
import { useWordStore, hydrateFromDb } from '@/app/stores/wordStore';
import {
  FirstLaunchWizard,
  needsFirstLaunchWizard,
} from '@/app/components/onboarding/FirstLaunchWizard';
import {
  isTauri,
  recordMaterialClose,
  saveMaterial,
  undoAutoExposure,
  type MaterialForWord,
  type MaterialSummary,
} from '@/app/lib/ipc';
import { buildMaterialInput, deriveTitle } from '@/app/lib/material-builder';

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const DEMO_TEXT = `Curiosity is the engine of every vocabulary you will ever own. Pick up a book, notice the words that snag your attention, and start turning strangers into acquaintances one sentence at a time. The network grows whether you are watching it or not.`;

type ViewMode = 'reader' | 'library';

export default function Home() {
  const { message } = AntApp.useApp();
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [readerSeed, setReaderSeed] = useState<string>(DEMO_TEXT);
  const [activeMaterialId, setActiveMaterialId] = useState<number | null>(null);
  const [view, setView] = useState<ViewMode>('reader');
  const [wordDrawerLemma, setWordDrawerLemma] = useState<string | null>(null);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const knownCount = useWordStore((s) => s.known.size);
  const hydrated = useWordStore((s) => s.hydrated);
  const [wizardOpen, setWizardOpen] = useState(false);
  const prevMaterialRef = useRef<number | null>(null);

  // Hydrate known-set from the DB on first mount; show the first-launch wizard
  // if the user has never picked a cutoff.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isTauri() && (await needsFirstLaunchWizard())) {
          if (!cancelled) setWizardOpen(true);
          return; // wizard's onFinish triggers the hydrate
        }
        await hydrateFromDb();
      } catch (err) {
        console.warn('[wordbrain] startup hydrate skipped', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the active material changes (reader switches away from it), flush an
  // auto-exposure close for the outgoing material and surface the graduation
  // toast. See AC4 of Phase-3 story.
  const closeMaterial = useCallback(
    async (materialId: number) => {
      if (!isTauri()) return;
      try {
        const outcome = await recordMaterialClose(materialId);
        const learned = outcome.graduated_to_learning;
        const mastered = outcome.graduated_to_known;
        if (learned.length === 0 && mastered.length === 0) return;

        // Mirror the graduation into the in-memory store so reader highlight
        // updates immediately — 'learning' is still shown as unknown, but
        // 'known' should disappear from the highlights at once.
        if (mastered.length) {
          const store = useWordStore.getState();
          for (const lemma of mastered) store.markKnown(lemma);
        }

        const total = learned.length + mastered.length;
        message.success({
          content: (
            <span>
              Auto-exposure graduated <strong>{total}</strong> word{total === 1 ? '' : 's'}
              {mastered.length ? ` (${mastered.length} → known)` : ''}
              {learned.length ? ` (${learned.length} → learning)` : ''}.{' '}
              <Button
                type="link"
                size="small"
                style={{ padding: 0 }}
                onClick={async () => {
                  try {
                    await undoAutoExposure(mastered, learned);
                    // Re-hydrate so the in-memory set mirrors the DB.
                    await hydrateFromDb();
                    message.info('Undid auto-exposure graduation');
                    setLibraryRefresh((n) => n + 1);
                  } catch (err) {
                    message.error(`Undo failed: ${err}`);
                  }
                }}
              >
                Undo
              </Button>
            </span>
          ),
          duration: 8,
        });
        setLibraryRefresh((n) => n + 1);
      } catch (err) {
        console.warn('[wordbrain] record_material_close failed', err);
      }
    },
    [message]
  );

  // Watch activeMaterialId transitions: whenever it changes to something new
  // (or to null), record a close on the previous one.
  useEffect(() => {
    const prev = prevMaterialRef.current;
    if (prev !== null && prev !== activeMaterialId) {
      void closeMaterial(prev);
    }
    prevMaterialRef.current = activeMaterialId;
  }, [activeMaterialId, closeMaterial]);

  const onImportSubmit = useCallback(
    async (raw: string) => {
      setReaderSeed(raw);
      setImportOpen(false);
      if (!isTauri()) {
        message.success(`Loaded ${raw.length.toLocaleString()} chars into reader`);
        return;
      }
      try {
        const input = buildMaterialInput({
          title: deriveTitle(raw),
          raw,
        });
        const out = await saveMaterial(input);
        setActiveMaterialId(out.material_id);
        setLibraryRefresh((n) => n + 1);
        message.success(
          `Saved ${out.unique_tokens.toLocaleString()} unique words (${out.unknown_count_at_import} unknown).`
        );
      } catch (err) {
        message.error(`save_material failed: ${err}`);
      }
    },
    [message]
  );

  const onOpenFromLibrary = useCallback(
    async (mat: MaterialSummary) => {
      setView('reader');
      // LibraryView returns summaries; we need the raw text from the DB to
      // re-render Tiptap. For now we reuse whatever is stored in `raw_text` by
      // re-fetching a single material via list_materials. A dedicated
      // load_material IPC would be a nice future addition; right now we keep
      // state light and refetch on demand.
      try {
        const mats = await import('@/app/lib/ipc').then((m) => m.listMaterials());
        const row = mats.find((m) => m.id === mat.id);
        if (!row) {
          message.error('Material not found');
          return;
        }
        // `list_materials` does not carry raw_text to keep the list cheap — we
        // simply use title+preview for now. Users paste fresh text to edit.
        // Track the active material so auto-exposure fires on the next switch.
        setActiveMaterialId(mat.id);
      } catch (err) {
        message.error(`open material failed: ${err}`);
      }
    },
    [message]
  );

  const onOpenMaterialFromDrawer = useCallback((m: MaterialForWord) => {
    setView('reader');
    setActiveMaterialId(m.material_id);
    setWordDrawerLemma(null);
  }, []);

  const sidebar = useMemo(
    () => (
      <Sider width={220} theme="light" style={{ borderRight: '1px solid rgba(0,0,0,0.06)' }}>
        <div style={{ padding: 20 }}>
          <Title level={4} style={{ margin: 0 }}>
            WordBrain
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            v0.1.0 · Phase 3
          </Text>
        </div>
        <Space direction="vertical" style={{ padding: '0 12px', width: '100%' }} size={4}>
          <SidebarEntry
            icon={<BookOutlined />}
            label="Library"
            active={view === 'library'}
            onClick={() => setView('library')}
          />
          <SidebarEntry
            icon={<ReadOutlined />}
            label="Reader"
            active={view === 'reader'}
            onClick={() => setView('reader')}
          />
          <SidebarEntry icon={<ThunderboltOutlined />} label="Review" disabled />
          <SidebarEntry icon={<ShareAltOutlined />} label="Network" disabled />
          <SidebarEntry
            icon={<SettingOutlined />}
            label="Settings"
            onClick={() => setSettingsOpen(true)}
          />
        </Space>
        <Divider style={{ margin: '24px 12px' }} />
        <div style={{ padding: '0 20px' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Known words
          </Text>
          <div style={{ fontSize: 24, fontWeight: 600 }}>{knownCount.toLocaleString()}</div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {hydrated ? 'hydrated from Turso SQLite' : 'using Phase-1 fallback seed'}
          </Text>
        </div>
      </Sider>
    ),
    [view, knownCount, hydrated]
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {sidebar}

      <Content style={{ padding: 40, maxWidth: 960, width: '100%' }}>
        {view === 'reader' ? (
          <ReaderView
            readerSeed={readerSeed}
            setImportOpen={setImportOpen}
            onLemmaDrill={setWordDrawerLemma}
          />
        ) : (
          <LibraryView refreshKey={libraryRefresh} onOpen={onOpenFromLibrary} />
        )}
      </Content>

      <Drawer
        title="Settings"
        placement="right"
        width={520}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      >
        <ApiKeysPanel />
      </Drawer>

      <MaterialsForWordDrawer
        lemma={wordDrawerLemma}
        onClose={() => setWordDrawerLemma(null)}
        onOpenMaterial={onOpenMaterialFromDrawer}
      />

      <MaterialImportModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onSubmit={onImportSubmit}
      />

      <FirstLaunchWizard
        open={wizardOpen}
        onFinish={async () => {
          setWizardOpen(false);
          await hydrateFromDb();
        }}
      />
    </Layout>
  );
}

function ReaderView({
  readerSeed,
  setImportOpen,
  onLemmaDrill,
}: {
  readerSeed: string;
  setImportOpen: (v: boolean) => void;
  onLemmaDrill: (lemma: string) => void;
}) {
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Reader
          </Title>
          <Text type="secondary">
            Unknown words are highlighted. Click one to open the word card.
          </Text>
        </div>
        <Space>
          <Button
            onClick={() => {
              const selection = window.getSelection?.()?.toString().trim().toLowerCase();
              if (!selection) return;
              onLemmaDrill(selection.split(/\s+/)[0] ?? selection);
            }}
          >
            Related docs for selection
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setImportOpen(true)}>
            Paste reading material
          </Button>
        </Space>
      </div>

      <Tag color="processing" style={{ marginBottom: 16 }}>
        Phase 3 · Material library + bipartite edges + recommender
      </Tag>

      <ReaderPane initialContent={readerSeed} onDrillLemma={onLemmaDrill} />

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
        Closing (switching away from) a material auto-bumps exposure counters and graduates
        frequently-seen words into the known set. Use the sidebar to jump to the Library view.
      </Paragraph>
    </>
  );
}

function SidebarEntry({
  icon,
  label,
  disabled,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        color: disabled ? 'rgba(0,0,0,0.35)' : active ? '#4f46e5' : 'inherit',
        background: active ? 'rgba(79,70,229,0.08)' : 'transparent',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      <span>{label}</span>
    </div>
  );
}
