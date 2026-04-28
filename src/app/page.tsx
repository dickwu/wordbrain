'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Button } from 'antd';
import { ReaderPane } from '@/app/components/reader/ReaderPane';
import {
  MaterialImportModal,
  type ImportedEpub,
  type ImportedFile,
} from '@/app/components/reader/MaterialImportModal';
import { EpubChapterPicker } from '@/app/components/reader/EpubChapterPicker';
import { SettingsView } from '@/app/components/settings/SettingsView';
import { StatusBar } from '@/app/components/common/StatusBar';
import { LibraryView } from '@/app/components/library/LibraryView';
import { MaterialsForWordDrawer } from '@/app/components/library/MaterialsForWordDrawer';
import { DictionaryFloat } from '@/app/components/dictionary/DictionaryFloat';
import { SearchHistoryView } from '@/app/components/dictionary/SearchHistoryView';
import { WordLookupModal } from '@/app/components/dictionary/WordLookupModal';
import { NetworkView } from '@/app/components/network/NetworkView';
import { WordsView } from '@/app/components/words/WordsView';
import { ReviewSession } from '@/app/components/srs/ReviewSession';
import { StoryView } from '@/app/components/story/StoryView';
import { WritingView } from '@/app/components/writing/WritingView';
import { AppSidebar, type ViewId } from '@/app/components/shell/AppSidebar';
import { AppToolbar } from '@/app/components/shell/AppToolbar';
import { Icons } from '@/app/components/shell/Icons';
import { useUsageStore } from '@/app/stores/usageStore';
import { recentPracticeWordsIpc } from '@/app/lib/ipc';
import { useWordStore, hydrateFromDb } from '@/app/stores/wordStore';
import { useSettingsStore } from '@/app/stores/settingsStore';
import { refreshDueCount, useSrsStore } from '@/app/stores/srsStore';
import {
  FirstLaunchWizard,
  needsFirstLaunchWizard,
} from '@/app/components/onboarding/FirstLaunchWizard';
import {
  isTauri,
  listChildMaterials,
  listMaterials,
  loadMaterial,
  recordMaterialClose,
  saveMaterial,
  undoAutoExposure,
  type EpubChapter,
  type MaterialForWord,
  type MaterialSummary,
} from '@/app/lib/ipc';
import { buildMaterialInput, deriveTitle } from '@/app/lib/material-builder';

const APP_VERSION = '0.1.9';

const DEMO_TEXT = `Curiosity is the engine of every vocabulary you will ever own. Pick up a book, notice the words that snag your attention, and start turning strangers into acquaintances one sentence at a time. The network grows whether you are watching it or not.`;

const VIEW_LABELS: Record<ViewId, string> = {
  reader: 'Reader',
  library: 'Library',
  review: 'Review',
  story: 'Story',
  writing: 'Writing',
  words: 'Words',
  network: 'Network',
  searches: 'Searches',
  settings: 'Settings',
};

export default function Home() {
  const { message } = AntApp.useApp();
  const [importOpen, setImportOpen] = useState(false);
  const [historyLookup, setHistoryLookup] = useState<{ word: string; nonce: number } | null>(null);
  const [readerSeed, setReaderSeed] = useState<string>(DEMO_TEXT);
  const [activeMaterialId, setActiveMaterialId] = useState<number | null>(null);
  const [view, setView] = useState<ViewId>('reader');
  const [wordDrawerLemma, setWordDrawerLemma] = useState<string | null>(null);
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [storyUnread, setStoryUnread] = useState(0);
  const [writingHint, setWritingHint] = useState<string | null>(null);
  const knownCount = useWordStore((s) => s.known.size);
  const hydrated = useWordStore((s) => s.hydrated);
  const dueCount = useSrsStore((s) => s.dueCount);
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
  const [, setActiveBookId] = useState<number | null>(null);

  // Hydrate known-set from the DB on first mount; show the first-launch wizard
  // if the user has never picked a cutoff.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await useSettingsStore.getState().hydrate();
        if (isTauri() && (await needsFirstLaunchWizard())) {
          if (!cancelled) setWizardOpen(true);
          return;
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

  // Poll for due-count + story-unread so the sidebar badges stay live without
  // us having to wire each mutation site up to call refresh on its own.
  useEffect(() => {
    if (!isTauri()) return;
    const tick = async () => {
      try {
        const rows = await listMaterials();
        setStoryUnread(
          rows.filter((m) => m.source_kind === 'ai_story' && m.read_at === null).length
        );
      } catch (err) {
        console.warn('[wordbrain] story badge listMaterials failed', err);
      }
      void refreshDueCount();
    };
    void tick();
    const id = window.setInterval(() => void tick(), 30_000);
    return () => window.clearInterval(id);
  }, [libraryRefresh]);

  // Compute the writing-hint label for the sidebar tooltip — lowest-level
  // recent practice word, so the user knows what they would be drilling.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) return;
      try {
        const rows = await recentPracticeWordsIpc(14, 50);
        if (cancelled || rows.length === 0) {
          setWritingHint(null);
          return;
        }
        const lowest = rows[0];
        setWritingHint(`next: ${lowest.lemma} (lvl ${lowest.level})`);
        useUsageStore.getState().setMany(rows.map((r) => [r.id, r.usageCount] as const));
      } catch {
        if (!cancelled) setWritingHint(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-exposure flush + graduation toast when reader switches material.
  const closeMaterial = useCallback(
    async (materialId: number) => {
      if (!isTauri()) return;
      try {
        const outcome = await recordMaterialClose(materialId);
        const learned = outcome.graduated_to_learning;
        const mastered = outcome.graduated_to_known;
        if (learned.length === 0 && mastered.length === 0) return;

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
        const input = buildMaterialInput({ title: deriveTitle(raw), raw });
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
        if (mat.source_kind === 'epub') {
          const saved = await listChildMaterials(mat.id);
          setActiveBookId(mat.id);
          setPickerBookTitle(mat.title);
          setPickerChapters(null);
          setPickerSaved(saved);
          setPickerOpen(true);
          return;
        }
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

  const toolbarRight = useMemo(() => {
    switch (view) {
      case 'reader':
        return (
          <>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                const selection = window.getSelection?.()?.toString().trim().toLowerCase();
                if (!selection) return;
                setWordDrawerLemma(selection.split(/\s+/)[0] ?? selection);
              }}
            >
              <Icons.Search size={12} /> Related docs
            </button>
            <button type="button" className="btn primary sm" onClick={() => setImportOpen(true)}>
              <Icons.Plus size={12} /> Paste material
            </button>
          </>
        );
      case 'library':
        return (
          <button type="button" className="btn primary sm" onClick={() => setImportOpen(true)}>
            <Icons.Plus size={12} /> Import
          </button>
        );
      default:
        return null;
    }
  }, [view]);

  const renderView = () => {
    switch (view) {
      case 'reader':
        return <ReaderView readerSeed={readerSeed} onLemmaDrill={setWordDrawerLemma} />;
      case 'review':
        return <ReviewSession />;
      case 'story':
        return <StoryView onDrillLemma={setWordDrawerLemma} />;
      case 'writing':
        return <WritingView />;
      case 'network':
        return (
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
        );
      case 'words':
        return <WordsView onSwitchToReader={() => setView('reader')} />;
      case 'searches':
        return (
          <SearchHistoryView onSearch={(word) => setHistoryLookup({ word, nonce: Date.now() })} />
        );
      case 'settings':
        return <SettingsView />;
      case 'library':
      default:
        return <LibraryView refreshKey={libraryRefresh} onOpen={onOpenFromLibrary} />;
    }
  };

  return (
    <div className="app-shell">
      <div className="app-body">
        <AppSidebar
          view={view}
          onChange={setView}
          knownCount={knownCount}
          dueCount={dueCount}
          storyUnread={storyUnread}
          hydrated={hydrated}
          appVersion={APP_VERSION}
          writingHint={writingHint}
        />
        <div className="main">
          <AppToolbar crumbs={['WordBrain', VIEW_LABELS[view]]} right={toolbarRight} />
          <div className="view">{renderView()}</div>
          <StatusBar />
        </div>
      </div>

      <MaterialsForWordDrawer
        lemma={wordDrawerLemma}
        onClose={() => setWordDrawerLemma(null)}
        onOpenMaterial={onOpenMaterialFromDrawer}
      />

      {historyLookup && (
        <WordLookupModal
          key={`${historyLookup.word}-${historyLookup.nonce}`}
          visible={true}
          initialQuery={historyLookup.word}
          contextSentence={historyLookup.word}
          autoSearch={true}
          onClose={() => setHistoryLookup(null)}
          onOpenSettings={() => setView('settings')}
          onShowLinked={setWordDrawerLemma}
        />
      )}

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

      <DictionaryFloat
        onOpenSettings={() => setView('settings')}
        onShowLinked={setWordDrawerLemma}
      />
    </div>
  );
}

/**
 * Reader view shell — editorial header (eyebrow / serif title / sub) wrapping
 * the existing Tiptap-backed `ReaderPane`. The pane itself keeps its in-place
 * decorations and word-card popover.
 */
function ReaderView({
  readerSeed,
  onLemmaDrill,
}: {
  readerSeed: string;
  onLemmaDrill: (lemma: string) => void;
}) {
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-header">
        <div>
          <div className="page-eyebrow">Reading · current</div>
          <h1 className="page-title">
            Reader<em>.</em>
          </h1>
          <p className="page-sub">
            Plum-tinted words are unknown. Click one to look it up; the marginalia stack remembers
            the trail.
          </p>
        </div>
      </div>
      <ReaderPane initialContent={readerSeed} onDrillLemma={onLemmaDrill} />
    </div>
  );
}

function safeParseTiptap(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
