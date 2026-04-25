'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Input,
  Space,
  Tabs,
  theme,
  Typography,
  Upload,
  App as AntApp,
} from 'antd';
import { InboxOutlined, FolderOpenOutlined } from '@ant-design/icons';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { isTauri, parseEpub, type EpubChapter } from '@/app/lib/ipc';
import { stripSrt, looksLikeSrt } from '@/app/lib/parsers/srt';

const { TextArea } = Input;
const { Paragraph, Text } = Typography;

/** File extensions recognised by the drag-drop / open-file path. */
const TEXT_EXTS = ['.md', '.markdown', '.txt', '.srt'];
const EPUB_EXTS = ['.epub'];

export interface ImportedFile {
  /** Cleaned text (SRT timestamps stripped, raw text otherwise). */
  text: string;
  /** Suggested material title = filename without extension. */
  suggestedTitle: string;
  /** Absolute path of the source file, used as `origin_path`. */
  originPath: string;
  /** Source-kind tag mirrored to the `materials.source_kind` column. */
  sourceKind: 'file';
}

export interface ImportedEpub {
  originPath: string;
  suggestedTitle: string;
  chapters: EpubChapter[];
}

interface MaterialImportModalProps {
  open: boolean;
  onCancel: () => void;
  /** Paste flow — raw text entered in the textarea. */
  onSubmit: (raw: string) => void;
  /** Single text file picked or dropped (md/txt/srt). */
  onFilePicked?: (payload: ImportedFile) => void;
  /** EPUB picked or dropped — caller opens the chapter picker. */
  onEpubPicked?: (payload: ImportedEpub) => void;
}

export function MaterialImportModal({
  open,
  onCancel,
  onSubmit,
  onFilePicked,
  onEpubPicked,
}: MaterialImportModalProps) {
  const { message } = AntApp.useApp();
  const { token } = theme.useToken();
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Route one path by extension. Shared between "open file" and drag-drop.
  const ingestPath = useCallback(
    async (path: string) => {
      setError(null);
      setBusy(true);
      try {
        const lower = path.toLowerCase();
        if (EPUB_EXTS.some((e) => lower.endsWith(e))) {
          const chapters = await parseEpub(path);
          if (chapters.length === 0) {
            throw new Error('EPUB contained no readable chapters.');
          }
          onEpubPicked?.({
            originPath: path,
            suggestedTitle: deriveTitleFromPath(path),
            chapters,
          });
          return;
        }
        if (TEXT_EXTS.some((e) => lower.endsWith(e))) {
          const body = await readTextFile(path);
          const cleaned = lower.endsWith('.srt') || looksLikeSrt(body) ? stripSrt(body) : body;
          onFilePicked?.({
            text: cleaned,
            suggestedTitle: deriveTitleFromPath(path),
            originPath: path,
            sourceKind: 'file',
          });
          return;
        }
        throw new Error(
          `Unsupported file type. Drop .md, .txt, .srt, or .epub (got "${path.split('/').pop()}").`
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        message.error(msg);
      } finally {
        setBusy(false);
      }
    },
    [message, onEpubPicked, onFilePicked]
  );

  // Subscribe to Tauri's webview drag-drop event while the modal is open.
  useEffect(() => {
    if (!open || !isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;
    (async () => {
      const webview = getCurrentWebviewWindow();
      unlisten = await webview.onDragDropEvent((evt) => {
        if (cancelled) return;
        if (evt.payload.type !== 'drop') return;
        const paths = evt.payload.paths ?? [];
        const picked = paths.find((p) => {
          const l = p.toLowerCase();
          return TEXT_EXTS.some((e) => l.endsWith(e)) || EPUB_EXTS.some((e) => l.endsWith(e));
        });
        if (!picked) {
          setError('Drop a .md, .txt, .srt, or .epub file.');
          return;
        }
        void ingestPath(picked);
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, ingestPath]);

  const pickFile = useCallback(async () => {
    if (!isTauri()) {
      setError('File picker requires the Tauri shell — run `bun run tauri dev`.');
      return;
    }
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'Reading material', extensions: ['md', 'markdown', 'txt', 'srt', 'epub'] }],
    });
    if (!selected || Array.isArray(selected)) return;
    await ingestPath(selected);
  }, [ingestPath]);

  const handleCancel = useCallback(() => {
    setRaw('');
    setError(null);
    onCancel();
  }, [onCancel]);

  const handlePasteSubmit = useCallback(() => {
    onSubmit(raw);
    setRaw('');
    setError(null);
  }, [onSubmit, raw]);

  return (
    <Modal
      open={open}
      title="Add reading material"
      width={720}
      footer={null}
      onCancel={handleCancel}
      destroyOnHidden
    >
      <Tabs
        defaultActiveKey="paste"
        items={[
          {
            key: 'paste',
            label: 'Paste text',
            children: (
              <>
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  Paste an article, a few paragraphs, or a chapter excerpt. Tokenisation + highlight
                  happen instantly against your known-word list.
                </Paragraph>
                <TextArea
                  value={raw}
                  onChange={(e) => setRaw(e.target.value)}
                  placeholder="Paste text here (≥ 100 characters recommended for a meaningful preview)"
                  autoSize={{ minRows: 10, maxRows: 20 }}
                />
                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button onClick={handleCancel}>Cancel</Button>
                  <Button
                    type="primary"
                    disabled={raw.trim().length === 0}
                    onClick={handlePasteSubmit}
                  >
                    Load into reader
                  </Button>
                </div>
              </>
            ),
          },
          {
            key: 'file',
            label: 'Drop or open a file',
            children: (
              <>
                <Paragraph type="secondary" style={{ fontSize: 12 }}>
                  Drop a <Text code>.md</Text>, <Text code>.txt</Text>, <Text code>.srt</Text>, or{' '}
                  <Text code>.epub</Text> file anywhere in this window, or click below to open a
                  file picker. SRT timestamps are stripped automatically; EPUBs are split into
                  chapters.
                </Paragraph>
                <Upload.Dragger
                  multiple={false}
                  showUploadList={false}
                  openFileDialogOnClick={false}
                  beforeUpload={() => false /* I/O is handled via Tauri, not the browser */}
                  style={{ background: token.colorPrimaryBg }}
                >
                  <p style={{ fontSize: 36, margin: 0 }}>
                    <InboxOutlined style={{ color: token.colorPrimary }} />
                  </p>
                  <p style={{ margin: 0, fontWeight: 500 }}>Drop file here</p>
                  <p style={{ fontSize: 12, color: token.colorTextSecondary }}>
                    .md · .txt · .srt · .epub
                  </p>
                </Upload.Dragger>
                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <Space>
                    <Button icon={<FolderOpenOutlined />} onClick={pickFile} loading={busy}>
                      Open file…
                    </Button>
                  </Space>
                  <Button onClick={handleCancel}>Cancel</Button>
                </div>
                {error && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginTop: 12 }}
                    message={error}
                    closable
                    onClose={() => setError(null)}
                  />
                )}
              </>
            ),
          },
        ]}
      />
    </Modal>
  );
}

function deriveTitleFromPath(path: string): string {
  const fname = path.split(/[/\\]/).pop() ?? 'Untitled';
  return fname.replace(/\.[^./]+$/, '').trim() || 'Untitled';
}
