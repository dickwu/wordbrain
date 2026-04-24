// Thin wrapper around `@tauri-apps/api/core.invoke`. All WordBrain IPC goes
// through here so commands are typed and mockable in unit tests.
import { invoke } from '@tauri-apps/api/core';

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function seedKnownFromFrequency(cutoff: number): Promise<number> {
  return invoke<number>('seed_known_from_frequency', { cutoff });
}

export async function getAllKnownLemmas(): Promise<string[]> {
  return invoke<string[]>('get_all_known_lemmas');
}

export async function markKnownIpc(lemma: string, source = 'manual'): Promise<void> {
  return invoke<void>('mark_known', { lemma, source });
}

export async function unmarkKnownIpc(lemma: string): Promise<void> {
  return invoke<void>('unmark_known', { lemma });
}

export async function frequencyPreview(cutoff: number): Promise<Array<[number, string]>> {
  return invoke<Array<[number, string]>>('frequency_preview', { cutoff });
}

export async function getSetting(key: string): Promise<string | null> {
  const raw = await invoke<string | null>('get_setting', { key });
  return raw ?? null;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  return invoke<void>('set_setting', { key, value: JSON.stringify(value) });
}

// ---------------------------------------------------------------------------
// Phase 3 — materials / bipartite edges / recommender.
// Every shape mirrors the `#[derive(Serialize/Deserialize)]` structs in
// `src-tauri/src/db/materials.rs`.
// ---------------------------------------------------------------------------

export interface TokenEdgeInput {
  lemma: string;
  occurrence_count: number;
  first_position: number;
  sentence_preview: string | null;
}

export interface SaveMaterialInput {
  title: string;
  source_kind: 'paste' | 'file' | 'url';
  origin_path: string | null;
  tiptap_json: string;
  raw_text: string;
  total_tokens: number;
  unique_tokens: number;
  tokens: TokenEdgeInput[];
}

export interface SaveMaterialOutput {
  material_id: number;
  unknown_count_at_import: number;
  total_tokens: number;
  unique_tokens: number;
}

export interface MaterialSummary {
  id: number;
  title: string;
  source_kind: string;
  total_tokens: number;
  unique_tokens: number;
  unknown_count: number;
  unknown_count_at_import: number;
  created_at: number;
  read_at: number | null;
}

export interface MaterialForWord {
  material_id: number;
  title: string;
  created_at: number;
  read_at: number | null;
  occurrence_count: number;
  first_position: number;
  sentence_preview: string | null;
}

export interface MaterialCloseOutcome {
  graduated_to_learning: string[];
  graduated_to_known: string[];
  exposure_threshold: number;
}

export interface RecommendedMaterial {
  id: number;
  title: string;
  total_tokens: number;
  unique_tokens: number;
  unknown_count: number;
  unknown_ratio: number;
  score: number;
  created_at: number;
}

export async function saveMaterial(input: SaveMaterialInput): Promise<SaveMaterialOutput> {
  return invoke<SaveMaterialOutput>('save_material', { input });
}

export async function listMaterials(): Promise<MaterialSummary[]> {
  return invoke<MaterialSummary[]>('list_materials');
}

export async function materialsForWord(lemma: string): Promise<MaterialForWord[]> {
  return invoke<MaterialForWord[]>('materials_for_word', { lemma });
}

export async function recordMaterialClose(
  materialId: number,
  threshold?: number
): Promise<MaterialCloseOutcome> {
  return invoke<MaterialCloseOutcome>('record_material_close', {
    materialId,
    threshold: threshold ?? null,
  });
}

export async function undoAutoExposure(toUnknown: string[], toLearning: string[]): Promise<void> {
  return invoke<void>('undo_auto_exposure', { toUnknown, toLearning });
}

export async function recommendNext(
  targetRatio = 0.035,
  limit = 5
): Promise<RecommendedMaterial[]> {
  return invoke<RecommendedMaterial[]>('recommend_next', {
    targetRatio,
    limit,
  });
}
