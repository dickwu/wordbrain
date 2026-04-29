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

export async function getAllKnownNames(): Promise<string[]> {
  return invoke<string[]>('get_all_known_names');
}

export async function markKnownIpc(lemma: string, source = 'manual'): Promise<void> {
  return invoke<void>('mark_known', { lemma, source });
}

export async function markKnownNameIpc(name: string, source = 'manual'): Promise<void> {
  return invoke<void>('mark_known_name', { name, source });
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
  source_kind: 'paste' | 'file' | 'url' | 'epub' | 'epub_chapter';
  origin_path: string | null;
  tiptap_json: string;
  raw_text: string;
  total_tokens: number;
  unique_tokens: number;
  tokens: TokenEdgeInput[];
  /** Phase 5 — set when this material is an EPUB chapter. */
  parent_material_id?: number | null;
  /** Phase 5 — 0-based index within the parent EPUB spine. */
  chapter_index?: number | null;
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
  parent_material_id: number | null;
  chapter_index: number | null;
}

export interface MaterialFull {
  id: number;
  title: string;
  source_kind: string;
  origin_path: string | null;
  raw_text: string;
  tiptap_json: string;
  total_tokens: number;
  unique_tokens: number;
  created_at: number;
  read_at: number | null;
  parent_material_id: number | null;
  chapter_index: number | null;
}

export interface EpubChapter {
  index: number;
  title: string;
  raw_text: string;
  tiptap_json: string;
  word_count: number;
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

export async function listChildMaterials(parentId: number): Promise<MaterialSummary[]> {
  return invoke<MaterialSummary[]>('list_child_materials', { parentId });
}

export async function loadMaterial(materialId: number): Promise<MaterialFull | null> {
  return invoke<MaterialFull | null>('load_material', { materialId });
}

export async function parseEpub(path: string): Promise<EpubChapter[]> {
  return invoke<EpubChapter[]>('parse_epub', { path });
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

// ---------------------------------------------------------------------------
// Phase 4 — FSRS review queue. Mirrors `src-tauri/src/commands/srs.rs`.
// ---------------------------------------------------------------------------

export interface AddToSrsOutcome {
  word_id: number;
  already_scheduled: boolean;
  due: number;
}

export interface DueCardIpc {
  word_id: number;
  lemma: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  last_review: number | null;
  due: number;
}

export interface SchedulingUpdateIpc {
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  due: number;
}

export interface ApplyRatingOutcome {
  reps: number;
  lapses: number;
  due: number;
  graduated_to_known: boolean;
}

export async function addToSrs(lemma: string): Promise<AddToSrsOutcome> {
  return invoke<AddToSrsOutcome>('add_to_srs', { lemma });
}

export async function isInSrs(lemma: string): Promise<boolean> {
  return invoke<boolean>('is_in_srs', { lemma });
}

export async function listDueSrs(nowOverride?: number): Promise<DueCardIpc[]> {
  return invoke<DueCardIpc[]>('list_due_srs', { nowOverride: nowOverride ?? null });
}

export async function countDueSrs(nowOverride?: number): Promise<number> {
  return invoke<number>('count_due_srs', { nowOverride: nowOverride ?? null });
}

export async function applySrsRating(
  lemma: string,
  rating: number,
  update: SchedulingUpdateIpc,
  opts?: { nowOverride?: number; graduationReps?: number }
): Promise<ApplyRatingOutcome> {
  return invoke<ApplyRatingOutcome>('apply_srs_rating', {
    lemma,
    rating,
    update,
    nowOverride: opts?.nowOverride ?? null,
    graduationReps: opts?.graduationReps ?? null,
  });
}

// ---------------------------------------------------------------------------
// Phase 6 — Word network graph. Mirrors `src-tauri/src/db/network.rs`.
// ---------------------------------------------------------------------------

export type WordState = 'known' | 'learning' | 'unknown' | string;

export interface NetworkNode {
  id: number;
  lemma: string;
  state: WordState;
  exposure_count: number;
  /** Co-occurrence degree inside the returned subgraph. */
  degree: number;
  /** Every material id this lemma appears in. */
  material_ids: number[];
}

export interface NetworkEdge {
  source: number;
  target: number;
  /** Number of distinct materials where both endpoints co-occur. */
  weight: number;
}

export interface NetworkPayload {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Total words in the library regardless of the limit. */
  total_words: number;
}

export interface SharedMaterial {
  material_id: number;
  title: string;
  sentence_preview: string | null;
}

export interface ClusterNeighbour {
  lemma: string;
  state: WordState;
  exposure_count: number;
  hop: 1 | 2 | number;
  shared_materials: SharedMaterial[];
}

export interface ClusterPayload {
  anchor: string;
  anchor_state: WordState;
  anchor_exposure_count: number;
  neighbours: ClusterNeighbour[];
}

export async function buildNetwork(limit = 500): Promise<NetworkPayload> {
  return invoke<NetworkPayload>('build_network', { limit });
}

export async function clusterForWord(
  lemma: string,
  maxPerHop = 20
): Promise<ClusterPayload | null> {
  return invoke<ClusterPayload | null>('cluster_for_word', {
    lemma,
    maxPerHop,
  });
}

// ---------------------------------------------------------------------------
// Learning-loop telemetry — mirrors `src-tauri/src/commands/usage.rs`.
// Both surfaces (Story Review + Writing Train) call `registerWordUseIpc` on
// every "use" event; the result is the post-increment `usage_count` value
// (cap to derive level 0–10 in the UI).
// ---------------------------------------------------------------------------

export type UsageSurface = 'story_review' | 'writing_train';

export interface RecentWordIpc {
  id: number;
  lemma: string;
  usageCount: number;
  level: number;
  firstSeenAt: number | null;
  state: WordState;
}

export async function registerWordUseIpc(wordId: number, surface: UsageSurface): Promise<number> {
  return invoke<number>('register_word_use', { wordId, surface });
}

export async function recentPracticeWordsIpc(
  windowDays: number,
  limit: number
): Promise<RecentWordIpc[]> {
  return invoke<RecentWordIpc[]>('recent_practice_words', { windowDays, limit });
}

// ---------------------------------------------------------------------------
// Story Review — mirrors `src-tauri/src/commands/story.rs`.
// `generate_story` persists an `ai_story` material + cloze MCQ payload and
// returns the renderable story shape; `generate_mcq_explanation` returns a
// known-words-only paragraph for wrong-answer feedback.
// ---------------------------------------------------------------------------

export interface ClozeBlankIpc {
  /** 0-based index in story.story_text placeholders. */
  index: number;
  /** word_id of the lemma the blank was created for. */
  target_word_id: number;
  /** 4 MCQ options; one is the correct word, three are distractors. */
  options: string[];
  /** Position in `options` of the correct answer. */
  correct_index: number;
}

export interface StoryMaterialIpc {
  material_id: number;
  /** Body with `{{1}}`, `{{2}}`, ... placeholders for each blank. */
  story_text: string;
  /** Tiptap doc JSON (also persisted on the materials row). */
  tiptap_json: string;
  blanks: ClozeBlankIpc[];
}

export interface StoryHistoryItemIpc {
  material_id: number;
  title: string;
  created_at: number;
  read_at: number | null;
  blank_count: number;
}

export async function generateStory(wordIds: number[]): Promise<StoryMaterialIpc> {
  return invoke<StoryMaterialIpc>('generate_story', { wordIds });
}

export async function listStoryHistory(): Promise<StoryHistoryItemIpc[]> {
  return invoke<StoryHistoryItemIpc[]>('list_story_history');
}

export async function loadStory(materialId: number): Promise<StoryMaterialIpc | null> {
  return invoke<StoryMaterialIpc | null>('load_story', { materialId });
}

export async function deleteStory(materialId: number): Promise<boolean> {
  return invoke<boolean>('delete_story', { materialId });
}

export async function regenerateStory(materialId: number): Promise<StoryMaterialIpc> {
  return invoke<StoryMaterialIpc>('regenerate_story', { materialId });
}

export async function generateMcqExplanation(
  wordId: number,
  wrongAnswerText: string,
  correctAnswerText: string,
  knownLemmas: string[]
): Promise<string> {
  return invoke<string>('generate_mcq_explanation', {
    wordId,
    wrongAnswerText,
    correctAnswerText,
    knownLemmas,
  });
}

// ---------------------------------------------------------------------------
// Writing Train — mirrors `src-tauri/src/commands/writing.rs`.
// `submit_writing` grades the learner's sentence with the AI chain, persists
// the submission as a `materials` row with `source_kind='writing_submission'`,
// upserts edges in `word_materials`, and fires +1 on `usage_count` for the
// target word and any other recent-list lemmas the learner used.
// ---------------------------------------------------------------------------

export type WritingUsageVerdict = 'correct' | 'incorrect' | 'ambiguous';

export interface WritingDiffSpan {
  from: number;
  to: number;
  kind: 'insert' | 'delete' | 'equal';
  text: string;
}

export interface WritingSynonymSpan {
  from: number;
  to: number;
  synonyms: string[];
}

export interface WritingFeedbackIpc {
  material_id: number;
  corrected_text: string;
  diff_spans: WritingDiffSpan[];
  usage_verdict: WritingUsageVerdict;
  usage_explanation: string;
  synonym_spans: WritingSynonymSpan[];
  new_usage_count: number;
}

export interface SubmitWritingInput {
  target_word_id: number;
  raw_text: string;
  tiptap_json: string;
}

export async function submitWriting(input: SubmitWritingInput): Promise<WritingFeedbackIpc> {
  return invoke<WritingFeedbackIpc>('submit_writing', { input });
}
