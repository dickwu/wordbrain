import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, ConfigProvider } from 'antd';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Replace AntD's <Select> with a native <select> so jsdom can drive it
// without simulating the AntD virtual dropdown (which never opens in jsdom).
// The native element fires `change` events with `e.target.value`, which
// matches the contract our `onAnswer` callback consumes via `(v) =>`.
vi.mock('antd', async () => {
  const actual = (await vi.importActual('antd')) as Record<string, unknown>;
  type SelectOpt = { value: string; label: string };
  type SelectProps = {
    value?: string;
    disabled?: boolean;
    placeholder?: string;
    options: SelectOpt[];
    onChange?: (value: string) => void;
  };
  const NativeSelect = ({ value, disabled, placeholder, options, onChange }: SelectProps) => (
    <select
      role="combobox"
      data-testid="cloze-select"
      value={value ?? ''}
      disabled={disabled}
      aria-label={placeholder}
      onChange={(e) => onChange?.((e.target as HTMLSelectElement).value)}
    >
      <option value="">{placeholder ?? ''}</option>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
  return { ...actual, Select: NativeSelect };
});

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  invokeMock.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.resetModules();
});

async function renderStory() {
  const { StoryView } = await import('../StoryView');
  return render(
    <ConfigProvider>
      <AntApp>
        <StoryView />
      </AntApp>
    </ConfigProvider>
  );
}

describe('StoryView', () => {
  it('seeds from recent_practice_words and shows Generate button', async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'recent_practice_words') {
        return [
          { id: 1, lemma: 'alpha', usageCount: 0, level: 0, firstSeenAt: 0, state: 'learning' },
          { id: 2, lemma: 'bravo', usageCount: 1, level: 1, firstSeenAt: 0, state: 'learning' },
        ];
      }
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderStory();

    await waitFor(() => {
      expect(screen.getByText(/Generate story/i)).toBeDefined();
    });
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('bravo')).toBeDefined();
  });

  it('clicking Generate persists the story + renders blanks; +1 fires on answer', async () => {
    const story = {
      material_id: 42,
      story_text: 'The {{1}} pondered the {{2}}.',
      tiptap_json: '{}',
      blanks: [
        {
          index: 0,
          target_word_id: 1,
          options: ['alpha', 'apex', 'amber', 'angle'],
          correct_index: 0,
        },
        {
          index: 1,
          target_word_id: 2,
          options: ['bravo', 'beach', 'birch', 'bench'],
          correct_index: 0,
        },
      ],
    };

    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'recent_practice_words') {
        return [
          { id: 1, lemma: 'alpha', usageCount: 0, level: 0, firstSeenAt: 0, state: 'learning' },
          { id: 2, lemma: 'bravo', usageCount: 0, level: 0, firstSeenAt: 0, state: 'learning' },
        ];
      }
      if (cmd === 'generate_story') return story;
      if (cmd === 'register_word_use') return ((args?.wordId as number) ?? 0) + 1;
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderStory();
    fireEvent.click(await screen.findByText(/Generate story/i));

    // Wait for the generated story prose so we know the selects are mounted.
    await waitFor(() => expect(screen.getByText(/pondered/)).toBeDefined());

    const selects = screen.getAllByTestId('cloze-select');
    expect(selects.length).toBe(2);

    // Pick the correct option for the first blank ('alpha').
    fireEvent.change(selects[0]!, { target: { value: 'alpha' } });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('register_word_use', {
        wordId: 1,
        surface: 'story_review',
      });
    });
  });

  it('wrong answer triggers explanation IPC and renders the explanation block', async () => {
    const story = {
      material_id: 99,
      story_text: 'A {{1}} appeared.',
      tiptap_json: '{}',
      blanks: [
        {
          index: 0,
          target_word_id: 5,
          options: ['phantom', 'pebble', 'pillow', 'pencil'],
          correct_index: 0,
        },
      ],
    };

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'recent_practice_words') {
        return [
          {
            id: 5,
            lemma: 'phantom',
            usageCount: 0,
            level: 0,
            firstSeenAt: 0,
            state: 'learning',
          },
        ];
      }
      if (cmd === 'generate_story') return story;
      if (cmd === 'register_word_use') return 1;
      if (cmd === 'generate_mcq_explanation') return 'A pebble is a small stone, not a ghost.';
      throw new Error(`unexpected cmd ${cmd}`);
    });

    await renderStory();
    fireEvent.click(await screen.findByText(/Generate story/i));

    await waitFor(() => expect(screen.getByText(/appeared/)).toBeDefined());

    const select = screen.getByTestId('cloze-select');
    // 'pebble' is a wrong answer (correct is 'phantom').
    fireEvent.change(select, { target: { value: 'pebble' } });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('register_word_use', {
        wordId: 5,
        surface: 'story_review',
      });
    });
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter((c) => c[0] === 'generate_mcq_explanation');
      expect(calls.length).toBe(1);
    });
    await waitFor(() => {
      expect(screen.getByText(/pebble is a small stone/i)).toBeDefined();
    });
  });
});
