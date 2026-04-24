'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Button, Empty, Space, Typography } from 'antd';
import { isTauri } from '@/app/lib/ipc';
import type { ListWordsFilter } from '@/app/lib/words/types';
import {
  useBulkUnmarkMutation,
  useMarkKnownMutation,
  useSetNoteMutation,
  useSetStateMutation,
  useUnmarkMutation,
  useWordsQuery,
} from '@/app/lib/words/useWords';
import { useDebouncedValue } from './useDebouncedValue';
import { WordsTable } from './WordsTable';
import { WordsToolbar, type StateFilter } from './WordsToolbar';

const { Title, Text } = Typography;

interface WordsViewProps {
  onSwitchToReader?: () => void;
}

export function WordsView({ onSwitchToReader }: WordsViewProps) {
  const { message, modal } = AntApp.useApp();
  const [stateFilter, setStateFilter] = useState<StateFilter>('known');
  const [sources, setSources] = useState<string[]>([]);
  const [searchPrefix, setSearchPrefix] = useState('');
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const debouncedSearch = useDebouncedValue(searchPrefix, 300);

  const filter = useMemo<ListWordsFilter>(() => {
    const states: Array<'known' | 'learning'> =
      stateFilter === 'all' ? ['known', 'learning'] : [stateFilter];
    const trimmed = debouncedSearch.trim().toLowerCase();
    return {
      states,
      sources: sources.length > 0 ? sources : undefined,
      searchPrefix: trimmed.length > 0 ? trimmed : undefined,
    };
  }, [stateFilter, sources, debouncedSearch]);

  const { data: rows = [], isFetching, error } = useWordsQuery(filter);

  const unmarkMut = useUnmarkMutation();
  const bulkUnmarkMut = useBulkUnmarkMutation();
  const markKnownMut = useMarkKnownMutation();
  const setStateMut = useSetStateMutation();
  const setNoteMut = useSetNoteMutation();

  const hasActiveFilters =
    stateFilter !== 'known' || sources.length > 0 || debouncedSearch.trim().length > 0;

  // Keyboard shortcuts scoped to the Words view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const tag = tgt?.tagName;
      const inForm = tag === 'INPUT' || tag === 'TEXTAREA' || (tgt?.isContentEditable ?? false);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape' && !inForm) {
        if (selection.size > 0) setSelection(new Set());
        else if (searchPrefix.length > 0) setSearchPrefix('');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inForm && selection.size > 0) {
        e.preventDefault();
        requestBulkUnmark();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, searchPrefix]);

  const requestBulkUnmark = () => {
    const lemmas = Array.from(selection);
    if (lemmas.length === 0) return;
    modal.confirm({
      title: `Unmark ${lemmas.length} word${lemmas.length === 1 ? '' : 's'}?`,
      content: 'They will need to be marked known again from the reader or by re-seeding.',
      okButtonProps: { danger: true },
      okText: 'Unmark',
      onOk: async () => {
        try {
          await bulkUnmarkMut.mutateAsync(lemmas);
          setSelection(new Set());
          message.success(`Unmarked ${lemmas.length} word${lemmas.length === 1 ? '' : 's'}`);
        } catch (err) {
          message.error(`Bulk unmark failed: ${err}`);
        }
      },
    });
  };

  const onAdd = async (lemma: string) => {
    try {
      const already = rows.find((r) => r.lemma === lemma);
      if (already) {
        message.info('Already in your known words');
        return;
      }
      await markKnownMut.mutateAsync({ lemma, source: 'manual_list' });
      message.success(`Added "${lemma}" to known words`);
    } catch (err) {
      message.error(`Add word failed: ${err}`);
    }
  };

  const onUnmark = async (lemma: string) => {
    try {
      await unmarkMut.mutateAsync(lemma);
      setSelection((s) => {
        if (!s.has(lemma)) return s;
        const next = new Set(s);
        next.delete(lemma);
        return next;
      });
    } catch (err) {
      message.error(`Unmark failed: ${err}`);
    }
  };

  const onStateChange = async (lemma: string, state: 'known' | 'learning') => {
    try {
      await setStateMut.mutateAsync({ lemma, state });
    } catch (err) {
      message.error(`State change failed: ${err}`);
    }
  };

  const onNoteSave = async (lemma: string, note: string | null) => {
    try {
      await setNoteMut.mutateAsync({ lemma, note });
    } catch (err) {
      message.error(`Save note failed: ${err}`);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Words
          </Title>
          <Text type="secondary">
            Browse, search, and edit your known vocabulary. The sidebar count reflects
            &ldquo;known&rdquo; rows only; &ldquo;learning&rdquo; rows still highlight in the
            reader.
          </Text>
        </div>
      </div>

      {!isTauri() && (
        <Alert
          type="info"
          showIcon
          message="Running in browser dev — word management requires the Tauri shell."
        />
      )}

      {error && (
        <Alert
          type="error"
          showIcon
          message={`Failed to load words: ${(error as Error).message}`}
        />
      )}

      <WordsToolbar
        stateFilter={stateFilter}
        onStateFilterChange={(v) => {
          setStateFilter(v);
          setSelection(new Set());
        }}
        sources={sources}
        onSourcesChange={(v) => {
          setSources(v);
          setSelection(new Set());
        }}
        search={searchPrefix}
        onSearchChange={setSearchPrefix}
        onAdd={onAdd}
        selectionCount={selection.size}
        onBulkUnmark={requestBulkUnmark}
        totalCount={rows.length}
        filteredCount={rows.length}
        onFocusSearch={(el) => {
          searchInputRef.current = el;
        }}
      />

      {rows.length === 0 && !isFetching ? (
        hasActiveFilters ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No words match your filters" />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space orientation="vertical" size={8}>
                <span>No known words yet — mark words as known while reading</span>
                {onSwitchToReader && (
                  <Button type="primary" onClick={onSwitchToReader}>
                    Open Reader
                  </Button>
                )}
              </Space>
            }
          />
        )
      ) : (
        <WordsTable
          rows={rows}
          loading={isFetching}
          selection={selection}
          onSelectionChange={setSelection}
          onUnmark={onUnmark}
          onStateChange={onStateChange}
          onNoteSave={onNoteSave}
        />
      )}
    </div>
  );
}
