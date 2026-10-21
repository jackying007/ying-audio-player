fn main() {
    let attributes = tauri_build::Attributes::new()
        .plugin(
            "local-audio",
            tauri_build::InlinedPlugin::new().commands(&[
                "list_folders",
                "import_folder",
                "list_audios",
                "refresh_folder",
                "remove_folder",
            ]),
        )
        .plugin(
            "network-cache",
            tauri_build::InlinedPlugin::new().commands(&["read_cache", "save_cache"]),
        );
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
