mod commands;
// `pub` so integration tests under `src-tauri/tests/` can exercise the schema
// and the `*_on_conn` query helpers directly against a real file-backed DB.
pub mod db;
pub mod keys;
pub mod parsers;

use crate::keys::KeyVault;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_connector::init());
    }

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            // Initialise the BYOK stronghold vault synchronously so state is
            // available to the first command that needs a key.
            let vault = KeyVault::init(&handle)
                .map_err(|e| format!("stronghold vault: {e}"))?;
            handle.manage(vault);

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
            commands::words::mark_known,
            commands::words::unmark_known,
            commands::words::count_known,
            commands::words::frequency_preview,
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::dict::lookup_offline,
            commands::dict::lookup_online,
            commands::dict::lookup_ai,
            commands::keys::save_api_key,
            commands::keys::has_api_key,
            commands::keys::list_configured_providers,
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
            commands::srs::list_due_srs,
            commands::srs::count_due_srs,
            commands::srs::apply_srs_rating,
            commands::network::build_network,
            commands::network::cluster_for_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running WordBrain");
}
