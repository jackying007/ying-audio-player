fn main() {
    let attributes = tauri_build::Attributes::new().plugin(
        "local-audio",
        tauri_build::InlinedPlugin::new().commands(&[
            "list_folders",
            "import_folder",
            "list_audios",
            "refresh_folder",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
