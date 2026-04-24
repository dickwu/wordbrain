//! Phase-6 Tauri IPC for the word-network graph.

use crate::db;
use crate::db::network::{ClusterPayload, NetworkPayload};

const DEFAULT_NETWORK_LIMIT: i64 = 500;
const DEFAULT_CLUSTER_MAX_PER_HOP: i64 = 20;

#[tauri::command]
pub async fn build_network(limit: Option<i64>) -> Result<NetworkPayload, String> {
    let limit = limit.unwrap_or(DEFAULT_NETWORK_LIMIT);
    db::network::build_network(limit)
        .await
        .map_err(|e| format!("build_network: {e}"))
}

#[tauri::command]
pub async fn cluster_for_word(
    lemma: String,
    max_per_hop: Option<i64>,
) -> Result<Option<ClusterPayload>, String> {
    let max = max_per_hop.unwrap_or(DEFAULT_CLUSTER_MAX_PER_HOP);
    db::network::cluster_for_word(lemma.trim(), max)
        .await
        .map_err(|e| format!("cluster_for_word: {e}"))
}
