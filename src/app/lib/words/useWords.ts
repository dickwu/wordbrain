import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { isTauri, markKnownIpc, unmarkKnownIpc } from '@/app/lib/ipc';
import { useWordStore } from '@/app/stores/wordStore';
import { useUsageStore } from '@/app/stores/usageStore';
import { bulkUnmarkWords, listWords, setUserNote, setWordState } from './api';
import type { ListWordsFilter, WordRecord } from './types';

const WORDS_ROOT_KEY = ['words'] as const;

export function useWordsQuery(filter: ListWordsFilter): UseQueryResult<WordRecord[]> {
  return useQuery<WordRecord[]>({
    queryKey: [...WORDS_ROOT_KEY, filter],
    queryFn: async () => {
      if (!isTauri()) return [];
      const rows = await listWords(filter);
      // Mirror server-confirmed usage_count into the usageStore so the
      // Story / Writing sidebars (and the Level column itself) render in
      // O(1) without a second IPC round-trip.
      useUsageStore.getState().setMany(rows.map((r) => [r.id, r.usageCount] as const));
      return rows;
    },
    staleTime: 30_000,
  });
}

export function useUnmarkMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (lemma) => {
      await unmarkKnownIpc(lemma);
    },
    onSuccess: (_data, lemma) => {
      useWordStore.getState().unmark(lemma);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
  });
}

export function useBulkUnmarkMutation() {
  const queryClient = useQueryClient();
  return useMutation<number, Error, string[]>({
    mutationFn: async (lemmas) => bulkUnmarkWords(lemmas),
    onSuccess: (_count, lemmas) => {
      useWordStore.getState().bulkUnmark(lemmas);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
  });
}

export interface MarkKnownVars {
  lemma: string;
  source?: string;
}

export function useMarkKnownMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, MarkKnownVars>({
    mutationFn: async ({ lemma, source }) => {
      await markKnownIpc(lemma, source ?? 'manual_list');
    },
    onSuccess: (_data, { lemma }) => {
      useWordStore.getState().markKnown(lemma);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
  });
}

export interface SetStateVars {
  lemma: string;
  state: 'known' | 'learning';
}

export function useSetStateMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, SetStateVars>({
    mutationFn: async ({ lemma, state }) => setWordState(lemma, state),
    onSuccess: (_data, { lemma, state }) => {
      useWordStore.getState().setState(lemma, state);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
  });
}

export interface SetNoteVars {
  lemma: string;
  note: string | null;
}

export function useSetNoteMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, SetNoteVars>({
    mutationFn: async ({ lemma, note }) => setUserNote(lemma, note),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: WORDS_ROOT_KEY });
    },
  });
}
