pub mod ai;
mod commands;
// `pub` so integration tests under `src-tauri/tests/` can exercise the schema
// and the `*_on_conn` query helpers directly against a real file-backed DB.
pub mod db;
pub mod keys;
pub mod parsers;

use crate::keys::KeyVault;
use tauri::Manager;

#[cfg(feature = "dev-connector")]
const DEV_CONNECTOR_CAPABILITY: &str = include_str!("../capabilities-dev/dev-connector.json");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(feature = "dev-connector")]
    let builder = builder.plugin(tauri_plugin_connector::init());

    builder
        .setup(|app| {
            // Register the connector capability at runtime, paired with the
            // plugin above, so a plain `tauri dev` (without --features
            // dev-connector) does NOT need any dev-only capability JSON in
            // `capabilities/` — avoids "Permission connector:default not found".
            #[cfg(feature = "dev-connector")]
            app.add_capability(DEV_CONNECTOR_CAPABILITY)
                .map_err(|e| format!("dev-connector capability: {e}"))?;

            let handle = app.handle().clone();
            // Initialise the BYOK stronghold vault synchronously so state is
            // available to the first command that needs a key.
            let vault = KeyVault::init(&handle).map_err(|e| format!("stronghold vault: {e}"))?;
            handle.manage(vault);

            // Detect claude-p / codex-cli availability once so the Settings
            // panel can render ✅/❌ without a startup race.
            ai::chain::warm_provider_cache();

            let handle_db = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = db::init(&handle_db).await {
                    log::error!("db init failed: {e:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::words::seed_known_from_frequency,
            commands::words::get_all_known_lemmas,
            commands::words::get_all_known_names,
            commands::words::mark_known,
            commands::words::mark_known_name,
            commands::words::unmark_known,
            commands::words::count_known,
            commands::words::list_words,
            commands::words::bulk_unmark_known,
            commands::words::set_word_state,
            commands::words::set_user_note,
            commands::words::frequency_preview,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::dict::get_dictionary_api_config,
            commands::dict::save_dictionary_api_config,
            commands::dict::test_dictionary_api_config,
            commands::dict::list_remote_dictionaries,
            commands::dict::lookup_remote_dictionary,
            commands::dict::record_lookup_history,
            commands::dict::list_lookup_history,
            commands::dict::remove_lookup_history_word,
            commands::dict::clear_lookup_history,
            commands::keys::save_api_key,
            commands::keys::list_configured_providers,
            commands::keys::codex_auth_status,
            commands::keys::import_openai_key_from_codex_auth,
            commands::keys::list_codex_models_from_auth,
            commands::materials::save_material,
            commands::materials::list_materials,
            commands::materials::list_child_materials,
            commands::materials::load_material,
            commands::materials::materials_for_word,
            commands::materials::record_material_close,
            commands::materials::undo_auto_exposure,
            commands::materials::recommend_next,
            commands::materials::parse_epub,
            commands::srs::add_to_srs,
            commands::srs::is_in_srs,
            commands::srs::list_due_srs,
            commands::srs::count_due_srs,
            commands::srs::apply_srs_rating,
            commands::network::build_network,
            commands::network::cluster_for_word,
            commands::usage::register_word_use,
            commands::usage::recent_practice_words,
            commands::story::generate_story,
            commands::story::list_story_history,
            commands::story::load_story,
            commands::story::delete_story,
            commands::story::regenerate_story,
            commands::story::generate_mcq_explanation,
            commands::writing::submit_writing,
            ai::chain::ai_provider_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WordBrain");
}
