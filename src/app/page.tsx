'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button, Divider, Drawer, Layout, Space, Typography } from 'antd';
import {
  BookOutlined,
  PlusOutlined,
  ReadOutlined,
  SettingOutlined,
  ShareAltOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { ReaderPane } from '@/app/components/reader/ReaderPane';
import {
  MaterialImportModal,
  type ImportedEpub,
  type ImportedFile,
} from '@/app/components/reader/MaterialImportModal';
import { EpubChapterPicker } from '@/app/components/reader/EpubChapterPicker';
import { ApiKeysPanel } from '@/app/components/settings/ApiKeysPanel';
import { LibraryView } from '@/app/components/library/LibraryView';
import { MaterialsForWordDrawer } from '@/app/components/library/MaterialsForWordDrawer';
import { NetworkView } from '@/app/components/network/NetworkView';
import { ReviewSession } from '@/app/components/srs/ReviewSession';
import { DueQueueBadge } from '@/app/components/srs/DueQueueBadge';
import { useWordStore, hydrateFromDb } from '@/app/stores/wordStore';
import { refreshDueCount } from '@/app/stores/srsStore';
import {
  FirstLaunchWizard,
  needsFirstLaunchWizard,
} from '@/app/components/onboarding/FirstLaunchWizard';
import {
  isTauri,
  listChildMaterials,
  loadMaterial,
  recordMaterialClose,
  saveMaterial,
  undoAutoExposure,
  type EpubChapter,
  type MaterialForWord,
  type MaterialSummary,
} from '@/app/lib/ipc';
import { buildMaterialInput, deriveTitle } from '@/app/lib/material-builder';

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const DEMO_TEXT = `Curiosity is the engine of every vocabulary you will ever own. Pick up a book, notice the words that snag your attention, and start turning strangers into acquaintances one sentence at a time. The network grows whether you are watching it or not.`;

type ViewMode = 'reader' | 'library' | 'review' | 'network';

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

  // EPUB chapter-picker state. `activeBookId` is the `materials.id` of the
  // parent book row; `pickerChapters` is either the freshly-parsed in-memory
  // list (new drops) or the saved-summary list fetched from SQLite (re-opening
  // from the library). The picker prefers the in-memory list if present.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBookTitle, setPickerBookTitle] = useState('');
  const [pickerChapters, setPickerChapters] = useState<EpubChapter[] | null>(null);
  const [pickerSaved, setPickerSaved] = useState<MaterialSummary[] | null>(null);
  const [activeBookId, setActiveBookId] = useState<number | null>(null);

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
        void refreshDueCount();
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

  const onFilePicked = useCallback(
    async (payload: ImportedFile) => {
      setImportOpen(false);
      setReaderSeed(payload.text);
      if (!isTauri()) {
        message.success(`Loaded ${payload.suggestedTitle} into reader`);
        return;
      }
      try {
        const input = buildMaterialInput({
          title: payload.suggestedTitle || deriveTitle(payload.text),
          raw: payload.text,
          sourceKind: 'file',
          originPath: payload.originPath,
        });
        const out = await saveMaterial(input);
        setActiveMaterialId(out.material_id);
        setLibraryRefresh((n) => n + 1);
        message.success(
          `Imported "${payload.suggestedTitle}" · ${out.unique_tokens.toLocaleString()} unique words (${out.unknown_count_at_import} unknown).`
        );
      } catch (err) {
        message.error(`save_material failed: ${err}`);
      }
    },
    [message]
  );

  const onEpubPicked = useCallback(
    async (payload: ImportedEpub) => {
      setImportOpen(false);
      if (!isTauri()) {
        message.info('EPUB import requires the Tauri shell.');
        return;
      }
      const { chapters, suggestedTitle, originPath } = payload;
      if (chapters.length === 0) {
        message.error('EPUB contained no chapters.');
        return;
      }
      try {
        // 1. Persist the book-level parent material. Its `raw_text` is a
        //    concatenation of chapter bodies so search / library summaries
        //    still see the full corpus; `tiptap_json` is a minimal stub
        //    pointing readers at the chapter picker instead of the body.
        const aggregateRaw = chapters.map((c) => c.raw_text).join('\n\n');
        const bookInput = buildMaterialInput({
          title: suggestedTitle,
          raw: aggregateRaw,
          sourceKind: 'epub',
          originPath,
          tiptapJson: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: `${suggestedTitle} — ${chapters.length} chapters. Open a chapter from the picker.`,
                  },
                ],
              },
            ],
          },
        });
        const bookOut = await saveMaterial(bookInput);

        // 2. Persist every chapter as a child. Each chapter gets its own
        //    `word_materials` edges so the bipartite graph still reflects
        //    where a lemma actually appeared.
        for (const ch of chapters) {
          const tiptapJson = safeParseTiptap(ch.tiptap_json) ?? {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: ch.raw_text }] }],
          };
          const chInput = buildMaterialInput({
            title: ch.title,
            raw: ch.raw_text,
            sourceKind: 'epub_chapter',
            originPath,
            tiptapJson,
          });
          chInput.parent_material_id = bookOut.material_id;
          chInput.chapter_index = ch.index;
          await saveMaterial(chInput);
        }

        // 3. Pull the freshly-saved chapter summaries so badges use the same
        //    unknown count the DB sees; keep the in-memory chapters too so
        //    the picker has body text for instant "open chapter" hand-off.
        const saved = await listChildMaterials(bookOut.material_id).catch(() => []);

        setActiveBookId(bookOut.material_id);
        setPickerBookTitle(suggestedTitle);
        setPickerChapters(chapters);
        setPickerSaved(saved);
        setPickerOpen(true);
        setLibraryRefresh((n) => n + 1);
        message.success(
          `Imported "${suggestedTitle}" · ${chapters.length} chapter${chapters.length === 1 ? '' : 's'}.`
        );
      } catch (err) {
        message.error(`EPUB import failed: ${err}`);
      }
    },
    [message]
  );

  /** Open a chapter from the picker — set the reader content, track its id
   * as the active material so auto-exposure fires on switch. Prefers the
   * in-memory chapter body if available (fresh drop), otherwise falls back
   * to `load_material`. */
  const onOpenPickerChapter = useCallback(
    async (index: number) => {
      try {
        if (pickerChapters && pickerChapters[index]) {
          setReaderSeed(pickerChapters[index].raw_text);
          const savedRow = pickerSaved?.[index];
          if (savedRow) setActiveMaterialId(savedRow.id);
          setView('reader');
          setPickerOpen(false);
          return;
        }
        if (pickerSaved && pickerSaved[index]) {
          const row = pickerSaved[index];
          const full = await loadMaterial(row.id);
          if (!full) {
            message.error('Chapter not found.');
            return;
          }
          setReaderSeed(full.raw_text);
          setActiveMaterialId(full.id);
          setView('reader');
          setPickerOpen(false);
        }
      } catch (err) {
        message.error(`Open chapter failed: ${err}`);
      }
    },
    [message, pickerChapters, pickerSaved]
  );

  const onOpenFromLibrary = useCallback(
    async (mat: MaterialSummary) => {
      try {
        // Book-level EPUB row → open the chapter picker instead of the reader.
        if (mat.source_kind === 'epub') {
          const saved = await listChildMaterials(mat.id);
          setActiveBookId(mat.id);
          setPickerBookTitle(mat.title);
          setPickerChapters(null); // no in-memory bodies; picker will load on open
          setPickerSaved(saved);
          setPickerOpen(true);
          return;
        }
        // Standalone or chapter row → load full body into the reader.
        const full = await loadMaterial(mat.id);
        if (!full) {
          message.error('Material not found');
          return;
        }
        setReaderSeed(full.raw_text);
        setActiveMaterialId(mat.id);
        setView('reader');
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
            v0.1.0
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
          <DueQueueBadge>
            <SidebarEntry
              icon={<ThunderboltOutlined />}
              label="Review"
              active={view === 'review'}
              onClick={() => setView('review')}
            />
          </DueQueueBadge>
          <SidebarEntry
            icon={<ShareAltOutlined />}
            label="Network"
            active={view === 'network'}
            onClick={() => setView('network')}
          />
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

      <Content
        style={{
          padding: 40,
          maxWidth: view === 'network' ? undefined : 960,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {view === 'reader' ? (
          <ReaderView
            readerSeed={readerSeed}
            setImportOpen={setImportOpen}
            onLemmaDrill={setWordDrawerLemma}
          />
        ) : view === 'review' ? (
          <ReviewSession />
        ) : view === 'network' ? (
          <NetworkView
            refreshKey={libraryRefresh}
            onOpenMaterial={async (id) => {
              try {
                const full = await loadMaterial(id);
                if (!full) {
                  message.error('Material not found');
                  return;
                }
                setReaderSeed(full.raw_text);
                setActiveMaterialId(id);
                setView('reader');
              } catch (err) {
                message.error(`open material failed: ${err}`);
              }
            }}
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
        onFilePicked={onFilePicked}
        onEpubPicked={onEpubPicked}
      />

      <EpubChapterPicker
        open={pickerOpen}
        bookTitle={pickerBookTitle}
        chapters={pickerChapters}
        savedChapters={pickerSaved}
        onClose={() => setPickerOpen(false)}
        onOpenChapter={onOpenPickerChapter}
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

      <ReaderPane initialContent={readerSeed} onDrillLemma={onLemmaDrill} />

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16 }}>
        Closing (switching away from) a material auto-bumps exposure counters and graduates
        frequently-seen words into the known set. Use the sidebar to jump to the Library view.
      </Paragraph>
    </>
  );
}

/** Safe JSON parse for Tiptap JSON returned from Rust; falls back to `null`
 * so the caller can construct a minimal paragraph doc. */
function safeParseTiptap(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
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
