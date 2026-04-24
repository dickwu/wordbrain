//! Tauri IPC surface for Phase-3 material library + recommender, plus the
//! Phase-5 EPUB ingestion command.

use std::path::PathBuf;

use crate::db;
use crate::db::materials::{
    MaterialCloseOutcome, MaterialForWord, MaterialFull, MaterialSummary, RecommendedMaterial,
    SaveMaterialInput, SaveMaterialOutput,
};
use crate::parsers::epub::Chapter;

/// Default `auto_exposure_threshold` — five closes before `unknown → learning`.
/// Overridable via `settings` key `auto_exposure_threshold`.
const DEFAULT_AUTO_EXPOSURE_THRESHOLD: i64 = 5;

#[tauri::command]
pub async fn save_material(input: SaveMaterialInput) -> Result<SaveMaterialOutput, String> {
    db::materials::save_material(&input)
        .await
        .map_err(|e| format!("save_material: {e}"))
}

#[tauri::command]
pub async fn list_materials() -> Result<Vec<MaterialSummary>, String> {
    db::materials::list_materials()
        .await
        .map_err(|e| format!("list_materials: {e}"))
}

#[tauri::command]
pub async fn list_child_materials(parent_id: i64) -> Result<Vec<MaterialSummary>, String> {
    db::materials::list_child_materials(parent_id)
        .await
        .map_err(|e| format!("list_child_materials: {e}"))
}

#[tauri::command]
pub async fn load_material(material_id: i64) -> Result<Option<MaterialFull>, String> {
    db::materials::load_material(material_id)
        .await
        .map_err(|e| format!("load_material: {e}"))
}

/// Phase-5 — parse an EPUB on disk into a `Vec<Chapter>` for the chapter
/// picker UI. Pure read; no DB side effects. Each chapter is returned to the
/// frontend which tokenises + calls `save_material` per chapter with
/// `parent_material_id` set to a parent book row the frontend created first.
#[tauri::command]
pub async fn parse_epub(path: String) -> Result<Vec<Chapter>, String> {
    // Parsing is CPU-bound; hop to blocking so we never stall the tokio
    // runtime on a ~1 MB zip decompression.
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || crate::parsers::epub::parse_epub(&p))
        .await
        .map_err(|e| format!("parse_epub join: {e}"))?
}

#[tauri::command]
pub async fn materials_for_word(lemma: String) -> Result<Vec<MaterialForWord>, String> {
    db::materials::materials_for_word(lemma.trim())
        .await
        .map_err(|e| format!("materials_for_word: {e}"))
}

#[tauri::command]
pub async fn record_material_close(
    material_id: i64,
    threshold: Option<i64>,
) -> Result<MaterialCloseOutcome, String> {
    let thr = threshold.unwrap_or_else(load_threshold_blocking_default);
    db::materials::record_material_close(material_id, thr)
        .await
        .map_err(|e| format!("record_material_close: {e}"))
}

#[tauri::command]
pub async fn undo_auto_exposure(
    to_unknown: Vec<String>,
    to_learning: Vec<String>,
) -> Result<(), String> {
    db::materials::undo_graduation(&to_unknown, &to_learning)
        .await
        .map_err(|e| format!("undo_auto_exposure: {e}"))
}

#[tauri::command]
pub async fn recommend_next(
    target_ratio: Option<f64>,
    limit: Option<u32>,
) -> Result<Vec<RecommendedMaterial>, String> {
    let target = target_ratio.unwrap_or(0.035);
    let limit = limit.unwrap_or(5).max(1) as usize;
    db::materials::recommend_next(target, limit)
        .await
        .map_err(|e| format!("recommend_next: {e}"))
}

/// Synchronous fallback if we cannot reach the settings table. Keeps the
/// default surface rigid when storage is broken.
fn load_threshold_blocking_default() -> i64 {
    DEFAULT_AUTO_EXPOSURE_THRESHOLD
}
