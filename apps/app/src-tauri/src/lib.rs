mod local_audio;
#[cfg(any(mobile, target_os = "windows", target_os = "macos", test))]
mod native_playback;
mod network_cache;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(target_os = "macos")]
    let context = {
        let mut context = context;
        let window = context
            .config_mut()
            .app
            .windows
            .iter_mut()
            .find(|window| window.label == "main")
            .expect("main window is configured");
        window.decorations = true;
        context
    };

    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_android_files::init());
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_ios_files::init());
    #[cfg(any(mobile, target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(native_playback::init());
    #[cfg(target_os = "macos")]
    let builder = builder.setup(|app| {
        use objc2_app_kit::{NSWindow, NSWindowButton};
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .expect("main window is configured");
        // Setup runs on the main thread, and the webview window owns this NSWindow.
        let native_window = unsafe { &*window.ns_window()?.cast::<NSWindow>() };
        // Keep the native rounded frame while using the app's existing header controls.
        for button in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = native_window.standardWindowButton(button) {
                button.setHidden(true);
            }
        }
        Ok(())
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(local_audio::init())
        .plugin(network_cache::init())
        .run(context)
        .expect("error while running tauri application");
}
