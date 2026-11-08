mod local_audio;
#[cfg(any(mobile, target_os = "windows", target_os = "macos", test))]
mod native_playback;
mod network_cache;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_files::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ios_files::init());
    #[cfg(any(mobile, target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(native_playback::init());
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(local_audio::init())
        .plugin(network_cache::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
