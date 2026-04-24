mod commands;
// `pub` so integration tests under `src-tauri/tests/` can exercise the schema
// and the `*_on_conn` query helpers directly against a real file-backed DB.
pub mod db;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = db::init(&handle).await {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running WordBrain");
}
