use super::*;
use tauri_plugin_android_files::AndroidFilesExt;

pub struct TemporaryFile(pub PathBuf);

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn materialize(app: &tauri::AppHandle, uri: &str) -> Result<TemporaryFile> {
    app.android_files()
        .materialize(uri)
        .map(|file| TemporaryFile(file.path.into()))
}

pub fn index(
    app: &tauri::AppHandle,
    db: &mut Connection,
    state: &LocalAudioState,
    uri: &str,
    refresh: bool,
) -> Result<ScanResult> {
    let _guard = state.acquire(uri.to_owned())?;
    let existing = db
        .query_row(
            "SELECT id, name, path, scanned_at FROM folders WHERE path = ?",
            [uri],
            folder_from_row,
        )
        .optional()
        .map_err(db_error)?;
    if !refresh {
        if let Some(folder) = existing {
            return Ok(ScanResult {
                folder,
                warnings: Vec::new(),
            });
        }
    } else if existing.is_none() {
        return Err("文件夹不存在".into());
    }
    // Listing must complete before publishing anything, including an empty directory.
    let directory = app.android_files().list(uri)?;
    let mut audios = Vec::with_capacity(directory.files.len());
    for document in directory.files {
        let mut audio = match materialize(app, &document.uri) {
            Ok(temporary) => scan_file(&temporary.0),
            Err(error) if error.contains("授权已失效") => return Err(error),
            Err(error) => ScannedAudio {
                path: String::new(),
                filename: String::new(),
                name: String::new(),
                title: None,
                artist: None,
                duration_ms: None,
                file_size: document.size,
                lrc_path: String::new(),
                has_lyrics: false,
                cover: None,
                error: Some(error),
            },
        };
        audio.path = document.uri;
        // Display names come from the document provider, never from parsing a URI.
        audio.name = document.name[..document.name.len() - 4].to_owned();
        audio.filename = document.name;
        audio.file_size = document.size.or(audio.file_size);
        audio.has_lyrics = document.lyrics_uri.is_some();
        audio.lrc_path = document.lyrics_uri.unwrap_or_default();
        audios.push(audio);
    }
    save_named_scan(db, uri, &directory.name, &audios)
}
