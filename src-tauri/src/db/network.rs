//! Phase-6 word-network graph builder (§Phase 6 of `.omc/plans/wordbrain-v1.md`).
//!
//! `build_network(limit)` returns a `{nodes, edges}` payload derived from the
//! bipartite `word_materials` table. Two lemmas share an edge when they both
//! appear in ≥1 saved material; the edge weight is the number of shared
//! materials. The node set is pre-filtered to the top `limit` most-connected
//! words so the frontend renders a stable, interesting cluster instead of a
//! hairball when the library explodes.
//!
//! The cluster drill-down surface (1-hop / 2-hop neighbours, shared materials,
//! co-occurrence sentences) is exposed via [`cluster_for_word`].

use serde::Serialize;
use turso::Connection;

use super::{get_connection, DbResult};

// ---------------------------------------------------------------------------
// Output shapes. Mirrored in `src/app/lib/ipc.ts`.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct NetworkNode {
    pub id: i64,
    pub lemma: String,
    pub state: String,
    pub exposure_count: i64,
    /// Number of edges this node participates in inside the returned subgraph.
    /// Handy for the frontend when it wants to size / filter without a second
    /// pass over the edge list.
    pub degree: i64,
    /// Every material id this lemma appears in. Used by the "material subset"
    /// filter on the frontend without a second round-trip.
    pub material_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkEdge {
    pub source: i64,
    pub target: i64,
    /// Number of distinct materials in which both endpoints co-occur.
    pub weight: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkPayload {
    pub nodes: Vec<NetworkNode>,
    pub edges: Vec<NetworkEdge>,
    /// Total words currently in the library regardless of the `limit`. Useful
    /// for the header badge ("showing top 500 of N").
    pub total_words: i64,
}

/// Shared-material summary between two lemmas in [`cluster_for_word`].
#[derive(Debug, Clone, Serialize)]
pub struct SharedMaterial {
    pub material_id: i64,
    pub title: String,
    /// The `sentence_preview` most recently stored for the *neighbour* word —
    /// we surface that line because the drill-down panel is reading about the
    /// neighbour, not the anchor word.
    pub sentence_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterNeighbour {
    pub lemma: String,
    pub state: String,
    pub exposure_count: i64,
    /// 1 for direct neighbours, 2 for neighbours-of-neighbours.
    pub hop: i64,
    /// Shared materials (drill-down into the docs where the pair co-occurs).
    /// Only populated for 1-hop neighbours; 2-hop neighbours omit this to keep
    /// the payload bounded (they still list in the side panel for context).
    pub shared_materials: Vec<SharedMaterial>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterPayload {
    pub anchor: String,
    pub anchor_state: String,
    pub anchor_exposure_count: i64,
    pub neighbours: Vec<ClusterNeighbour>,
}

// ---------------------------------------------------------------------------
// build_network
// ---------------------------------------------------------------------------

/// Build the top-`limit` most-connected subgraph from `word_materials`.
///
/// Degree here is "number of distinct words that share ≥1 material with me" —
/// a lemma stranded in a doc by itself has degree 0 and will only make it into
/// the node list if we still have room under the cap. Edges are undirected;
/// we canonicalise `(source < target)` so `(a,b)` and `(b,a)` collapse to one
/// row.
pub async fn build_network_on_conn(conn: &Connection, limit: i64) -> DbResult<NetworkPayload> {
    let limit = limit.max(1);

    // 1. Top-`limit` word ids ordered by co-occurrence degree DESC, then by
    //    exposure_count DESC as a tiebreaker. We compute degree inside the
    //    query so it matches the edge set we'll emit below.
    //
    // The inner subquery deduplicates the `(word, neighbour)` pairs across
    // materials so a lemma sharing ten docs with the same partner still only
    // counts as degree 1.
    let mut rows = conn
        .query(
            "SELECT w.id, w.lemma, w.state, w.exposure_count, d.degree \
               FROM words w \
               JOIN ( \
                    SELECT wm1.word_id AS word_id, \
                           COUNT(DISTINCT wm2.word_id) AS degree \
                      FROM word_materials wm1 \
                      JOIN word_materials wm2 \
                        ON wm2.material_id = wm1.material_id \
                       AND wm2.word_id <> wm1.word_id \
                     GROUP BY wm1.word_id \
               ) d ON d.word_id = w.id \
              ORDER BY d.degree DESC, w.exposure_count DESC, w.id ASC \
              LIMIT ?1",
            turso::params![limit],
        )
        .await?;

    let mut nodes: Vec<NetworkNode> = Vec::new();
    let mut keep_ids: Vec<i64> = Vec::new();
    while let Some(row) = rows.next().await? {
        let id: i64 = row.get(0)?;
        let lemma: String = row.get(1)?;
        let state: String = row.get(2)?;
        let exposure_count: i64 = row.get(3)?;
        let degree: i64 = row.get(4)?;
        keep_ids.push(id);
        nodes.push(NetworkNode {
            id,
            lemma,
            state,
            exposure_count,
            degree,
            material_ids: Vec::new(),
        });
    }
    drop(rows);

    // 1a. Attach material_ids to each node so the frontend can do the
    //     "material subset" filter client-side. One IN-list query keeps this
    //     to a single round-trip even with 500 nodes.
    if !keep_ids.is_empty() {
        let id_list = keep_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT word_id, material_id FROM word_materials \
              WHERE word_id IN ({id_list}) \
              ORDER BY word_id ASC"
        );
        let mut rows = conn.query(&sql, ()).await?;
        // Build a tiny id→index map so we don't do a linear scan per row.
        let index: std::collections::HashMap<i64, usize> = nodes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id, i))
            .collect();
        while let Some(row) = rows.next().await? {
            let word_id: i64 = row.get(0)?;
            let material_id: i64 = row.get(1)?;
            if let Some(&idx) = index.get(&word_id) {
                nodes[idx].material_ids.push(material_id);
            }
        }
    }

    // 2. Edges within that subset. We filter to `wm1.word_id < wm2.word_id` so
    //    each undirected pair appears once, then keep only pairs where BOTH
    //    endpoints survived the node cap. The `IN (...)` filter uses a
    //    comma-separated literal because Turso's positional-params API doesn't
    //    expand slices; the ids come straight from our own SELECT so there is
    //    no injection surface.
    let mut edges: Vec<NetworkEdge> = Vec::new();
    if !keep_ids.is_empty() {
        let id_list = keep_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");

        let sql = format!(
            "SELECT wm1.word_id, wm2.word_id, COUNT(DISTINCT wm1.material_id) AS weight \
               FROM word_materials wm1 \
               JOIN word_materials wm2 \
                 ON wm2.material_id = wm1.material_id \
                AND wm1.word_id < wm2.word_id \
              WHERE wm1.word_id IN ({id_list}) \
                AND wm2.word_id IN ({id_list}) \
              GROUP BY wm1.word_id, wm2.word_id"
        );
        let mut rows = conn.query(&sql, ()).await?;
        while let Some(row) = rows.next().await? {
            edges.push(NetworkEdge {
                source: row.get::<i64>(0)?,
                target: row.get::<i64>(1)?,
                weight: row.get::<i64>(2)?,
            });
        }
    }

    // 3. Total words (used by the UI header badge).
    let mut rows = conn.query("SELECT COUNT(*) FROM words", ()).await?;
    let total_words: i64 = if let Some(row) = rows.next().await? {
        row.get::<i64>(0)?
    } else {
        0
    };

    Ok(NetworkPayload {
        nodes,
        edges,
        total_words,
    })
}

pub async fn build_network(limit: i64) -> DbResult<NetworkPayload> {
    let conn = get_connection()?.lock().await;
    build_network_on_conn(&conn, limit).await
}

// ---------------------------------------------------------------------------
// cluster_for_word — 1-hop + 2-hop drill-down
// ---------------------------------------------------------------------------

/// 1-hop + 2-hop neighbourhood of `lemma`, deduplicated. Excludes the anchor
/// lemma itself from the neighbour list.
pub async fn cluster_for_word_on_conn(
    conn: &Connection,
    lemma: &str,
    max_per_hop: i64,
) -> DbResult<Option<ClusterPayload>> {
    // 0. Anchor metadata.
    let mut rows = conn
        .query(
            "SELECT id, state, exposure_count FROM words WHERE lemma = ?1",
            turso::params![lemma],
        )
        .await?;
    let Some(row) = rows.next().await? else {
        return Ok(None);
    };
    let anchor_id: i64 = row.get(0)?;
    let anchor_state: String = row.get(1)?;
    let anchor_exposure_count: i64 = row.get(2)?;
    drop(rows);

    let max = max_per_hop.max(1);

    // 1. 1-hop neighbours — anything that shares a material with the anchor.
    //    Rank by how many materials we share (desc) then exposure_count.
    let mut rows = conn
        .query(
            "SELECT w.id, w.lemma, w.state, w.exposure_count, \
                    COUNT(DISTINCT wm2.material_id) AS shared \
               FROM word_materials wm1 \
               JOIN word_materials wm2 ON wm2.material_id = wm1.material_id \
               JOIN words w ON w.id = wm2.word_id \
              WHERE wm1.word_id = ?1 \
                AND wm2.word_id <> wm1.word_id \
              GROUP BY w.id, w.lemma, w.state, w.exposure_count \
              ORDER BY shared DESC, w.exposure_count DESC, w.lemma ASC \
              LIMIT ?2",
            turso::params![anchor_id, max],
        )
        .await?;

    let mut one_hop_ids: Vec<i64> = Vec::new();
    let mut neighbours: Vec<ClusterNeighbour> = Vec::new();
    while let Some(row) = rows.next().await? {
        let neighbour_id: i64 = row.get(0)?;
        let neighbour_lemma: String = row.get(1)?;
        let state: String = row.get(2)?;
        let exposure_count: i64 = row.get(3)?;
        one_hop_ids.push(neighbour_id);
        neighbours.push(ClusterNeighbour {
            lemma: neighbour_lemma,
            state,
            exposure_count,
            hop: 1,
            shared_materials: Vec::new(),
        });
    }
    drop(rows);

    // 1a. For every 1-hop neighbour, fetch the shared-material set + a
    //     sentence preview. We issue one query per neighbour; with `max_per_hop`
    //     in the low tens this stays well below ~50 ms locally.
    for n in neighbours.iter_mut() {
        let mut srows = conn
            .query(
                "SELECT m.id, m.title, wm2.sentence_preview \
                   FROM word_materials wm1 \
                   JOIN word_materials wm2 ON wm2.material_id = wm1.material_id \
                   JOIN words wn ON wn.id = wm2.word_id \
                   JOIN materials m ON m.id = wm1.material_id \
                  WHERE wm1.word_id = ?1 AND wn.lemma = ?2 \
                  ORDER BY m.created_at DESC \
                  LIMIT 20",
                turso::params![anchor_id, n.lemma.as_str()],
            )
            .await?;
        while let Some(row) = srows.next().await? {
            let preview = match row.get_value(2)? {
                turso::Value::Null => None,
                turso::Value::Text(s) => Some(s),
                _ => None,
            };
            n.shared_materials.push(SharedMaterial {
                material_id: row.get::<i64>(0)?,
                title: row.get::<String>(1)?,
                sentence_preview: preview,
            });
        }
    }

    // 2. 2-hop neighbours — neighbours of 1-hop that aren't themselves 1-hop
    //    or the anchor. We use the same id-literal trick as build_network so
    //    the IN filter is explicit. Skip this pass if 1-hop was empty.
    if !one_hop_ids.is_empty() {
        let already: std::collections::HashSet<i64> =
            one_hop_ids.iter().copied().chain(std::iter::once(anchor_id)).collect();
        let id_list = one_hop_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT w.id, w.lemma, w.state, w.exposure_count, \
                    COUNT(DISTINCT wm2.material_id) AS shared \
               FROM word_materials wm1 \
               JOIN word_materials wm2 ON wm2.material_id = wm1.material_id \
               JOIN words w ON w.id = wm2.word_id \
              WHERE wm1.word_id IN ({id_list}) \
                AND wm2.word_id <> wm1.word_id \
              GROUP BY w.id, w.lemma, w.state, w.exposure_count \
              ORDER BY shared DESC, w.exposure_count DESC, w.lemma ASC \
              LIMIT ?1"
        );
        let mut rows = conn
            .query(&sql, turso::params![max.saturating_mul(4)])
            .await?;
        while let Some(row) = rows.next().await? {
            let id: i64 = row.get(0)?;
            if already.contains(&id) {
                continue;
            }
            let lemma: String = row.get(1)?;
            let state: String = row.get(2)?;
            let exposure_count: i64 = row.get(3)?;
            neighbours.push(ClusterNeighbour {
                lemma,
                state,
                exposure_count,
                hop: 2,
                shared_materials: Vec::new(),
            });
            if neighbours
                .iter()
                .filter(|n| n.hop == 2)
                .count() as i64
                >= max
            {
                break;
            }
        }
    }

    Ok(Some(ClusterPayload {
        anchor: lemma.to_string(),
        anchor_state,
        anchor_exposure_count,
        neighbours,
    }))
}

pub async fn cluster_for_word(
    lemma: &str,
    max_per_hop: i64,
) -> DbResult<Option<ClusterPayload>> {
    let conn = get_connection()?.lock().await;
    cluster_for_word_on_conn(&conn, lemma, max_per_hop).await
}
