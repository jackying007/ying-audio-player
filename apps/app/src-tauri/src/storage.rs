use std::path::PathBuf;

pub fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_android_files::AndroidFilesExt;
        let path = app.android_files().storage_root()?;
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(path)
    }
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_ios_files::IosFilesExt;
        app.ios_files().storage_root()
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        executable
            .parent()
            .map(|p| p.to_owned())
            .ok_or_else(|| "无法获取应用所在目录".into())
    }
}
