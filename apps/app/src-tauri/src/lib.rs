mod local_audio;
mod network_cache;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(local_audio::init())
        .plugin(network_cache::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
