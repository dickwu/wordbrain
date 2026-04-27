import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// jsdom doesn't implement layout — Tiptap's scrollToSelection calls
// coordsAtPos which calls Range.getClientRects. Polyfill them so the editor
// can mount without throwing on `setContent`/`focus()`.
function installLayoutPolyfills() {
  const empty = () => [] as unknown as DOMRectList;
  const rangePrototype = Range.prototype as Range & {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (!rangePrototype.getClientRects) {
    rangePrototype.getClientRects = empty;
  }
  if (!rangePrototype.getBoundingClientRect) {
    rangePrototype.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
}

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
  installLayoutPolyfills();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

async function renderWriting() {
  const { WritingView } = await import('../WritingView');
  return render(
    <ConfigProvider>
      <AntApp>
        <WritingView />
      </AntApp>
    </ConfigProvider>
  );
}

describe('WritingView', () => {
  it('lists recent practice words from the IPC and shows level chips', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'recent_practice_words') {
        return [
          {
            id: 1,
            lemma: 'trepidation',
            usageCount: 0,
            level: 0,
            firstSeenAt: 0,
            state: 'learning',
          },
          {
            id: 2,
            lemma: 'brilliant',
            usageCount: 1,
            level: 1,
            firstSeenAt: 0,
            state: 'learning',
          },
        ];
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderWriting();

    // The lemma appears in the sidebar row, in the target Tag, and as an
    // unknown-word highlight inside the editor's seeded text — match any.
    await waitFor(() => {
      expect(screen.getAllByText('trepidation').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('brilliant').length).toBeGreaterThan(0);
    // Both level chips render.
    expect(screen.getByText('lvl 0')).toBeDefined();
    expect(screen.getByText('lvl 1')).toBeDefined();
  });

  it('submit_writing fires +1 path and renders the verdict + accept buttons', async () => {
    const feedback = {
      material_id: 7,
      corrected_text: 'trepidation: I felt great trepidation before the test.',
      diff_spans: [
        { from: 0, to: 12, kind: 'equal', text: 'trepidation: ' },
        { from: 13, to: 18, kind: 'insert', text: 'I felt' },
      ],
      usage_verdict: 'correct',
      usage_explanation: '',
      synonym_spans: [{ from: 25, to: 36, synonyms: ['fear', 'dread', 'worry'] }],
      new_usage_count: 1,
    };
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'recent_practice_words') {
        return [
          {
            id: 11,
            lemma: 'trepidation',
            usageCount: 0,
            level: 0,
            firstSeenAt: 0,
            state: 'learning',
          },
        ];
      }
      if (cmd === 'submit_writing') {
        const input = (args ?? {})['input'] as { target_word_id: number; raw_text: string };
        expect(input.target_word_id).toBe(11);
        expect(input.raw_text.toLowerCase()).toContain('trepidation');
        return feedback;
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderWriting();
    await waitFor(() => expect(screen.getAllByText('trepidation').length).toBeGreaterThan(0));
    // Wait for the editor to render and seed itself with `${lemma}: ` so the
    // submit handler's `raw.length < 5` guard doesn't short-circuit. Tiptap
    // renders a contenteditable .ProseMirror — its text content is what
    // `editor.getText()` reads.
    await waitFor(() => {
      const editor = document.querySelector('.ProseMirror');
      expect(editor?.textContent ?? '').toContain('trepidation');
    });

    fireEvent.click(screen.getByText(/Submit for grading/i));

    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === 'submit_writing');
      expect(calls.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(screen.getByText(/Correct usage/i)).toBeDefined();
      expect(screen.getByText(/Accept rewrite/i)).toBeDefined();
    });
  });
});
