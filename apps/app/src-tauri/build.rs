fn main() {
    let attributes = tauri_build::Attributes::new()
        .plugin(
            "local-audio",
            tauri_build::InlinedPlugin::new().commands(&[
                "list_folders",
                "import_folder",
                "list_audios",
                "get_cover",
                "refresh_folder",
                "remove_folder",
                "pick_folder",
                "read_audio",
                "read_lyrics",
            ]),
        )
        .plugin(
            "network-cache",
            tauri_build::InlinedPlugin::new().commands(&[
                "read_cache",
                "save_cache",
                "begin_cache_write",
                "write_cache_chunk",
                "finish_cache_write",
                "abort_cache_write",
            ]),
        );
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
