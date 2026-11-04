use lofty::{file::AudioFile, file::TaggedFileExt, picture::PictureType, prelude::Accessor};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile_files;

#[cfg(any(target_os = "android", target_os = "ios", test))]
struct TemporaryFile(PathBuf);

#[cfg(any(target_os = "android", target_os = "ios", test))]
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("local-audio")
        .setup(|app, _api| {
            app.manage(LocalAudioState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #![plugin(local_audio)]
            list_folders,
            import_folder,
            list_audios,
            get_cover,
            refresh_folder,
            remove_folder,
            pick_folder,
            read_audio,
            read_lyrics
        ])
        .build()
}

#[derive(Default, Clone)]
pub struct LocalAudioState {
    scanning: Arc<Mutex<HashSet<String>>>,
}

struct ScanGuard {
    state: LocalAudioState,
    key: String,
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        if let Ok(mut scanning) = self.state.scanning.lock() {
            scanning.remove(&self.key);
        }
    }
}

impl LocalAudioState {
    fn acquire(&self, key: String) -> Result<ScanGuard> {
        let key = if cfg!(windows) {
            key.to_ascii_lowercase()
        } else {
            key
        };
        let mut scanning = self.scanning.lock().map_err(|e| e.to_string())?;
        if !scanning.insert(key.clone()) {
            return Err("此文件夹正在扫描，请稍后重试".into());
        }
        Ok(ScanGuard {
            state: self.clone(),
            key,
        })
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    id: i64,
    name: String,
    link: String,
    scanned_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    id: i64,
    folder_id: i64,
    filename: String,
    name: String,
    title: Option<String>,
    artist: Option<String>,
    link: String,
    lrc_link: String,
    has_lyrics: bool,
    duration_ms: Option<i64>,
    file_size: Option<i64>,
    has_cover: bool,
    scan_error: Option<String>,
    #[serde(rename = "type")]
    mime: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    folder: Folder,
    warnings: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct Cover {
    mime: String,
    data: Vec<u8>,
}

struct ScannedAudio {
    path: String,
    filename: String,
    name: String,
    title: Option<String>,
    artist: Option<String>,
    duration_ms: Option<i64>,
    file_size: Option<i64>,
    lrc_path: String,
    has_lyrics: bool,
    cover: Option<Cover>,
    error: Option<String>,
}

fn db_error(error: impl std::fmt::Display) -> String {
    format!("音乐库数据库操作失败：{error}")
}

fn open_database(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(db_error)?;
    }
    let mut db = Connection::open(path).map_err(db_error)?;
    db.busy_timeout(Duration::from_secs(10)).map_err(db_error)?;
    db.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(db_error)?;
    let tx = db.transaction().map_err(db_error)?;
    let path_collation = if cfg!(windows) { "NOCASE" } else { "BINARY" };
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL COLLATE {path_collation} UNIQUE,
                name TEXT NOT NULL,
                scanned_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audios (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                name TEXT NOT NULL,
                title TEXT,
                artist TEXT,
                duration_ms INTEGER,
                file_size INTEGER,
                lrc_path TEXT NOT NULL,
                has_lyrics INTEGER NOT NULL,
                cover_mime TEXT,
                cover_data BLOB,
                scan_error TEXT,
                UNIQUE(folder_id, path)
            );",
    ))
    .map_err(db_error)?;
    // Migration 1: preserve original names independently of file paths or document URIs.
    let has_filename = tx
        .prepare("PRAGMA table_info(audios)")
        .map_err(db_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(db_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?
        .iter()
        .any(|name| name == "filename");
    if !has_filename {
        tx.execute_batch("ALTER TABLE audios ADD COLUMN filename TEXT NOT NULL DEFAULT '';")
            .map_err(db_error)?;
        let paths = tx
            .prepare("SELECT id, path FROM audios")
            .map_err(db_error)?
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        for (id, path) in paths {
            let filename = path.rsplit(['/', '\\']).next().unwrap_or(&path);
            tx.execute(
                "UPDATE audios SET filename = ? WHERE id = ?",
                params![filename, id],
            )
            .map_err(db_error)?;
        }
        tx.pragma_update(None, "user_version", 1)
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(db)
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if let Some(unc) = value.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        value.strip_prefix("//?/").unwrap_or(&value).to_owned()
    }
}

fn folder_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    Ok(Folder {
        id: row.get(0)?,
        name: row.get(1)?,
        link: row.get(2)?,
        scanned_at: row.get(3)?,
    })
}

fn get_folder(db: &Connection, id: i64) -> Result<Folder> {
    db.query_row(
        "SELECT id, name, path, scanned_at FROM folders WHERE id = ?",
        [id],
        folder_from_row,
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(|| "文件夹不存在，请从侧栏选择文件夹".into())
}

fn query_folders(db: &Connection) -> Result<Vec<Folder>> {
    db.prepare("SELECT id, name, path, scanned_at FROM folders ORDER BY id")
        .map_err(db_error)?
        .query_map([], folder_from_row)
        .map_err(db_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(db_error)
}

fn query_audios(db: &Connection, folder_id: i64) -> Result<Vec<AudioInfo>> {
    get_folder(db, folder_id)?;
    db.prepare(
        "SELECT id, folder_id, path, name, title, artist, duration_ms,
        file_size, lrc_path, has_lyrics, (cover_mime IS NOT NULL AND cover_data IS NOT NULL), scan_error, filename FROM audios
        WHERE folder_id = ? ORDER BY name COLLATE NOCASE, path",
    )
    .map_err(db_error)?
    .query_map([folder_id], |row| {
        Ok(AudioInfo {
            id: row.get(0)?,
            folder_id: row.get(1)?,
            filename: row.get(12)?,
            link: row.get(2)?,
            name: row.get(3)?,
            title: row.get(4)?,
            artist: row.get(5)?,
            duration_ms: row.get(6)?,
            file_size: row.get(7)?,
            lrc_link: row.get(8)?,
            has_lyrics: row.get(9)?,
            has_cover: row.get(10)?,
            scan_error: row.get(11)?,
            mime: "audio/mpeg",
        })
    })
    .map_err(db_error)?
    .collect::<std::result::Result<_, _>>()
    .map_err(db_error)
}

fn query_cover(db: &Connection, audio_id: i64) -> Result<Option<Cover>> {
    db.query_row(
        "SELECT cover_mime, cover_data FROM audios WHERE id = ?",
        [audio_id],
        |row| {
            let mime: Option<String> = row.get(0)?;
            let data: Option<Vec<u8>> = row.get(1)?;
            Ok(data.zip(mime).map(|(data, mime)| Cover { mime, data }))
        },
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(|| "歌曲不存在".into())
}

fn nonempty(value: Option<std::borrow::Cow<'_, str>>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

fn scan_file(path: &Path) -> ScannedAudio {
    let lrc_path = path.with_extension("lrc");
    let mut audio = ScannedAudio {
        path: display_path(path),
        filename: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        name: path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        title: None,
        artist: None,
        duration_ms: None,
        file_size: None,
        lrc_path: display_path(&lrc_path),
        has_lyrics: lrc_path.is_file(),
        cover: None,
        error: None,
    };
    match fs::metadata(path) {
        Ok(metadata) => audio.file_size = Some(metadata.len() as i64),
        Err(error) => audio.error = Some(error.to_string()),
    }
    match lofty::read_from_path(path) {
        Ok(file) => {
            audio.duration_ms =
                Some(file.properties().duration().as_millis() as i64).filter(|v| *v > 0);
            let tags: Vec<_> = file
                .primary_tag()
                .into_iter()
                .chain(file.tags().iter().filter(|tag| {
                    !file
                        .primary_tag()
                        .is_some_and(|primary| std::ptr::eq(*tag, primary))
                }))
                .collect();
            audio.title = tags.iter().find_map(|tag| nonempty(tag.title()));
            audio.artist = tags.iter().find_map(|tag| nonempty(tag.artist()));
            let pictures: Vec<_> = tags.iter().flat_map(|tag| tag.pictures()).collect();
            let picture = pictures
                .iter()
                .find(|p| p.pic_type() == PictureType::CoverFront)
                .or_else(|| pictures.first());
            if let Some(picture) = picture {
                audio.cover = Some(Cover {
                    mime: picture
                        .mime_type()
                        .map(|m| m.to_string())
                        .unwrap_or_else(|| "application/octet-stream".into()),
                    data: picture.data().to_vec(),
                });
            }
        }
        Err(error) => audio.error = Some(error.to_string()),
    }
    audio
}

#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
fn scan_directory(path: &Path) -> Result<Vec<ScannedAudio>> {
    let entries = fs::read_dir(path).map_err(|e| format!("无法读取文件夹：{e}"))?;
    let mut audios = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("无法完整读取文件夹：{e}"))?;
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mp3"))
            && entry.file_type().map_err(|e| e.to_string())?.is_file()
        {
            audios.push(scan_file(&path));
        }
    }
    Ok(audios)
}

#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
fn save_scan(db: &mut Connection, path: &str, audios: &[ScannedAudio]) -> Result<ScanResult> {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.into());
    save_named_scan(db, path, &name, audios)
}

fn save_named_scan(
    db: &mut Connection,
    path: &str,
    name: &str,
    audios: &[ScannedAudio],
) -> Result<ScanResult> {
    let tx = db.transaction().map_err(db_error)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(db_error)?
        .as_millis() as i64;
    tx.execute(
        "INSERT INTO folders(path, name, scanned_at) VALUES (?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET scanned_at = excluded.scanned_at, name = excluded.name",
        params![path, name, now],
    )
    .map_err(db_error)?;
    let folder = tx
        .query_row(
            "SELECT id, name, path, scanned_at FROM folders WHERE path = ?",
            [path],
            folder_from_row,
        )
        .map_err(db_error)?;
    // Keep IDs for surviving paths; collect old IDs to remove only vanished files.
    let mut old_ids: HashSet<i64> = tx
        .prepare("SELECT id FROM audios WHERE folder_id = ?")
        .map_err(db_error)?
        .query_map([folder.id], |r| r.get(0))
        .map_err(db_error)?
        .collect::<std::result::Result<_, _>>()
        .map_err(db_error)?;
    let mut warnings = Vec::new();
    for audio in audios {
        let id: i64 = tx.query_row("INSERT INTO audios(folder_id, path, name, title, artist, duration_ms,
            file_size, lrc_path, has_lyrics, cover_mime, cover_data, scan_error, filename) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(folder_id, path) DO UPDATE SET name=excluded.name, title=excluded.title,
            artist=excluded.artist, duration_ms=excluded.duration_ms, file_size=excluded.file_size,
            lrc_path=excluded.lrc_path, has_lyrics=excluded.has_lyrics,
            cover_mime=excluded.cover_mime, cover_data=excluded.cover_data,
            scan_error=excluded.scan_error, filename=excluded.filename RETURNING id",
            params![folder.id, audio.path, audio.name, audio.title, audio.artist, audio.duration_ms,
                audio.file_size, audio.lrc_path, audio.has_lyrics,
                audio.cover.as_ref().map(|cover| cover.mime.as_str()),
                audio.cover.as_ref().map(|cover| cover.data.as_slice()),
                audio.error, audio.filename], |r| r.get(0)).map_err(db_error)?;
        old_ids.remove(&id);
        if let Some(error) = &audio.error {
            warnings.push(format!("{}：{error}", audio.name));
        }
    }
    for id in old_ids {
        tx.execute("DELETE FROM audios WHERE id = ?", [id])
            .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(ScanResult { folder, warnings })
}

#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
fn index_folder(db: &mut Connection, state: &LocalAudioState, path: &Path) -> Result<ScanResult> {
    let canonical = fs::canonicalize(path).map_err(|e| format!("无法打开文件夹：{e}"))?;
    let path = display_path(&canonical);
    let _guard = state.acquire(path.clone())?;
    if let Some(folder) = db
        .query_row(
            "SELECT id, name, path, scanned_at FROM folders WHERE path = ?",
            [&path],
            folder_from_row,
        )
        .optional()
        .map_err(db_error)?
    {
        return Ok(ScanResult {
            folder,
            warnings: Vec::new(),
        });
    }
    let audios = scan_directory(&canonical)?;
    save_scan(db, &path, &audios)
}

#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
fn reindex_folder(
    db: &mut Connection,
    state: &LocalAudioState,
    folder_id: i64,
) -> Result<ScanResult> {
    let folder = get_folder(db, folder_id)?;
    let _guard = state.acquire(folder.link.clone())?;
    // Deletion may have completed between the lookup and acquiring the guard.
    get_folder(db, folder_id)?;
    let audios = scan_directory(Path::new(&folder.link))?;
    save_scan(db, &folder.link, &audios)
}

#[cfg(any(not(any(target_os = "android", target_os = "ios")), test))]
fn remove_indexed_folder(db: &Connection, state: &LocalAudioState, folder_id: i64) -> Result<()> {
    remove_indexed_folder_with(db, state, folder_id, |_| {})
}

fn remove_indexed_folder_with(
    db: &Connection,
    state: &LocalAudioState,
    folder_id: i64,
    after_remove: impl FnOnce(&str),
) -> Result<()> {
    let folder = get_folder(db, folder_id)?;
    let _guard = state.acquire(folder.link.clone())?;
    let removed = db
        .execute("DELETE FROM folders WHERE id = ?", [folder_id])
        .map_err(db_error)?;
    if removed == 0 {
        return Err("文件夹不存在".into());
    }
    after_remove(&folder.link);
    Ok(())
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(crate::storage::root(app)?.join("localAudio.sqlite3"))
}

#[tauri::command]
pub async fn list_folders(app: tauri::AppHandle) -> Result<Vec<Folder>> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || query_folders(&open_database(&path)?))
        .await
        .map_err(db_error)?
}

#[tauri::command]
pub async fn import_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalAudioState>,
    path: String,
) -> Result<ScanResult> {
    let database = database_path(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            mobile_files::index(&app, &mut open_database(&database)?, &state, &path, false)
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            index_folder(&mut open_database(&database)?, &state, Path::new(&path))
        }
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub async fn refresh_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalAudioState>,
    folder_id: i64,
) -> Result<ScanResult> {
    let database = database_path(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let mut db = open_database(&database)?;
            let folder = get_folder(&db, folder_id)?;
            mobile_files::index(&app, &mut db, &state, &folder.link, true)
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            reindex_folder(&mut open_database(&database)?, &state, folder_id)
        }
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub async fn remove_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalAudioState>,
    folder_id: i64,
) -> Result<()> {
    let database = database_path(&app)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = open_database(&database)?;
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            remove_indexed_folder_with(&db, &state, folder_id, |uri| {
                let _ = mobile_files::release(&app, uri);
            })
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            remove_indexed_folder(&db, &state, folder_id)
        }
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub async fn list_audios(app: tauri::AppHandle, folder_id: i64) -> Result<Vec<AudioInfo>> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || query_audios(&open_database(&path)?, folder_id))
        .await
        .map_err(db_error)?
}

#[tauri::command]
pub async fn get_cover(app: tauri::AppHandle, audio_id: i64) -> Result<Option<Cover>> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || query_cover(&open_database(&path)?, audio_id))
        .await
        .map_err(db_error)?
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || mobile_files::pick_folder(&app))
            .await
            .map_err(db_error)?
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err("桌面端请使用系统文件夹选择器".into())
    }
}

fn indexed_file(db: &Connection, audio_id: i64, lyrics: bool) -> Result<String> {
    let (audio, lrc, has_lyrics): (String, String, bool) = db
        .query_row(
            "SELECT path, lrc_path, has_lyrics FROM audios WHERE id = ?",
            [audio_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(db_error)?
        .ok_or("歌曲不存在")?;
    if lyrics && !has_lyrics {
        return Err("歌曲没有歌词".into());
    }
    Ok(if lyrics { lrc } else { audio })
}

async fn read_indexed_file(
    app: tauri::AppHandle,
    audio_id: i64,
    lyrics: bool,
) -> Result<tauri::ipc::Response> {
    let database = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = indexed_file(&open_database(&database)?, audio_id, lyrics)?;
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let temporary = mobile_files::materialize(&app, &path)?;
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let path = &temporary.0;
        fs::read(path)
            .map(tauri::ipc::Response::new)
            .map_err(|e| format!("无法读取文件：{e}"))
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub async fn read_audio(app: tauri::AppHandle, audio_id: i64) -> Result<tauri::ipc::Response> {
    read_indexed_file(app, audio_id, false).await
}

#[tauri::command]
pub async fn read_lyrics(app: tauri::AppHandle, audio_id: i64) -> Result<tauri::ipc::Response> {
    read_indexed_file(app, audio_id, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use lofty::{
        config::WriteOptions,
        picture::{MimeType, Picture},
        tag::{Tag, TagExt, TagType},
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn temporary_mobile_read_is_cleaned_up_on_error() {
        let fixture = Fixture::new();
        let path = fixture.0.join("materialized.mp3");
        fs::write(&path, b"music").unwrap();
        let read = || -> Result<()> {
            let _copy = TemporaryFile(path.clone());
            Err("read failed".into())
        };
        assert!(read().is_err());
        assert!(!path.exists());
    }

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "ying-local-audio-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn db(&self) -> Connection {
            open_database(&self.0.join("data/localAudio.sqlite3")).unwrap()
        }

        fn music(&self) -> PathBuf {
            let path = self.0.join("歌曲 Music");
            fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only remove the uniquely created test directory, after connections have dropped.
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mp3(path: &Path, tagged: bool) {
        // MPEG-1 Layer III, 128 kbps, 44.1 kHz: synthetic frames for metadata parsing.
        let mut frame = vec![0; 417];
        frame[..4].copy_from_slice(&[0xff, 0xfb, 0x90, 0x00]);
        fs::write(path, frame.repeat(100)).unwrap();
        if tagged {
            let mut tag = Tag::new(TagType::Id3v2);
            tag.set_title("标签标题".into());
            tag.set_artist("测试歌手".into());
            for (kind, data) in [
                (PictureType::CoverBack, vec![1; 16]),
                (PictureType::CoverFront, vec![2; 16]),
            ] {
                tag.push_picture(
                    Picture::unchecked(data)
                        .pic_type(kind)
                        .mime_type(MimeType::Png)
                        .build(),
                );
            }
            tag.save_to_path(path, WriteOptions::default()).unwrap();
        }
    }

    #[test]
    fn filename_migration_preserves_ids_metadata_and_cover_and_is_idempotent() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("中文 原版.MP3"), true);
        let mut db = fixture.db();
        let folder = index_folder(&mut db, &LocalAudioState::default(), &music)
            .unwrap()
            .folder;
        let original = query_audios(&db, folder.id).unwrap().remove(0);
        let old_path = "C:\\Music\\中文 原版.MP3";
        db.execute(
            "UPDATE audios SET path = ? WHERE id = ?",
            params![old_path, original.id],
        )
        .unwrap();
        db.execute_batch("ALTER TABLE audios DROP COLUMN filename; PRAGMA user_version = 0;")
            .unwrap();
        drop(db);
        for _ in 0..2 {
            let db = fixture.db();
            let migrated = query_audios(&db, folder.id).unwrap().remove(0);
            assert_eq!(migrated.filename, "中文 原版.MP3");
            assert_eq!(migrated.id, original.id);
            assert_eq!(migrated.link, old_path);
            assert_eq!(migrated.title, original.title);
            assert_eq!(
                query_cover(&db, original.id).unwrap().unwrap().data,
                vec![2; 16]
            );
            assert_eq!(
                db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
    }

    #[test]
    fn document_uris_and_display_names_are_saved_without_path_parsing() {
        let fixture = Fixture::new();
        let file = fixture.0.join("temp.mp3");
        mp3(&file, true);
        let mut audio = scan_file(&file);
        audio.path = "content://provider/tree/opaque/document/unrelated%2F123".into();
        audio.filename = "歌曲 空格.MP3".into();
        audio.lrc_path = "content://provider/tree/opaque/document/another%2F456".into();
        audio.has_lyrics = true;
        let mut db = fixture.db();
        let tree = "content://provider/tree/opaque%3Aidentifier";
        let folder = save_named_scan(&mut db, tree, "我的音乐", &[audio])
            .unwrap()
            .folder;
        assert_eq!(folder.name, "我的音乐");
        assert_eq!(folder.link, tree);
        let indexed = query_audios(&db, folder.id).unwrap().remove(0);
        assert_eq!(indexed.filename, "歌曲 空格.MP3");
        assert_eq!(indexed_file(&db, indexed.id, false).unwrap(), indexed.link);
        assert_eq!(
            indexed_file(&db, indexed.id, true).unwrap(),
            indexed.lrc_link
        );
        assert!(indexed_file(&db, i64::MAX, false).is_err());
        db.execute(
            "UPDATE audios SET has_lyrics = 0 WHERE id = ?",
            [indexed.id],
        )
        .unwrap();
        assert!(indexed_file(&db, indexed.id, true).is_err());
    }

    #[test]
    fn removal_cascades_preserves_files_and_other_folders_and_allows_reimport() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("song.mp3"), true);
        fs::write(music.join("song.lrc"), "lyrics").unwrap();
        let other = fixture.0.join("other");
        fs::create_dir(&other).unwrap();
        mp3(&other.join("other.mp3"), false);
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let folder = index_folder(&mut db, &state, &music).unwrap().folder;
        let other_folder = index_folder(&mut db, &state, &other).unwrap().folder;
        let guard = state.acquire(folder.link.clone()).unwrap();
        assert!(remove_indexed_folder(&db, &state, folder.id).is_err());
        drop(guard);
        remove_indexed_folder(&db, &state, folder.id).unwrap();
        let count: i64 = db
            .query_row(
                "SELECT count(*) FROM audios WHERE folder_id = ?",
                [folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(query_folders(&db).unwrap().len(), 1);
        assert_eq!(query_audios(&db, other_folder.id).unwrap().len(), 1);
        assert!(music.join("song.mp3").exists());
        assert_eq!(
            fs::read_to_string(music.join("song.lrc")).unwrap(),
            "lyrics"
        );
        let imported = index_folder(&mut db, &state, &music).unwrap();
        assert_ne!(imported.folder.id, folder.id);
        assert_eq!(query_audios(&db, imported.folder.id).unwrap().len(), 1);
        drop(db);
        let db = fixture.db();
        assert!(get_folder(&db, folder.id).is_err());
    }

    #[test]
    fn removal_works_with_missing_source_directory_and_sql_failure_preserves_index() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("song.mp3"), false);
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let folder = index_folder(&mut db, &state, &music).unwrap().folder;
        db.execute_batch("CREATE TRIGGER fail_removal BEFORE DELETE ON folders BEGIN SELECT RAISE(ABORT, 'failure'); END;").unwrap();
        assert!(remove_indexed_folder(&db, &state, folder.id).is_err());
        assert_eq!(query_audios(&db, folder.id).unwrap().len(), 1);
        db.execute_batch("DROP TRIGGER fail_removal;").unwrap();
        fs::rename(&music, fixture.0.join("offline")).unwrap();
        remove_indexed_folder(&db, &state, folder.id).unwrap();
        assert!(query_folders(&db).unwrap().is_empty());
        assert!(remove_indexed_folder(&db, &state, folder.id).is_err());
    }

    #[test]
    fn scans_metadata_cover_lyrics_and_only_direct_mp3s() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("完整.MP3"), true);
        mp3(&music.join("无标签.mp3"), false);
        fs::write(music.join("完整.lrc"), "[00:00.000]歌词").unwrap();
        fs::write(music.join("损坏.mp3"), "not audio").unwrap();
        fs::write(music.join("ignore.wav"), "not mp3").unwrap();
        fs::create_dir(music.join("nested")).unwrap();
        mp3(&music.join("nested/ignored.mp3"), false);
        let mut db = fixture.db();
        let result = index_folder(&mut db, &LocalAudioState::default(), &music).unwrap();
        assert_eq!(result.warnings.len(), 1);
        let audios = query_audios(&db, result.folder.id).unwrap();
        assert_eq!(audios.len(), 3);
        let full = audios.iter().find(|t| t.has_lyrics).unwrap();
        assert_eq!(full.name, "完整");
        assert_eq!(full.title.as_deref(), Some("标签标题"));
        assert_eq!(full.artist.as_deref(), Some("测试歌手"));
        assert!(full.duration_ms.unwrap() > 2000);
        assert_eq!(
            full.file_size,
            Some(fs::metadata(music.join("完整.MP3")).unwrap().len() as i64)
        );
        assert!(full.has_cover);
        let serialized = serde_json::to_value(full).unwrap();
        assert_eq!(serialized["hasCover"], true);
        assert!(serialized.get("cover").is_none());
        assert!(serialized.get("coverMime").is_none());
        assert!(serialized.get("coverData").is_none());
        let cover = query_cover(&db, full.id).unwrap().unwrap();
        assert_eq!(cover.data, vec![2; 16]);
        assert_eq!(cover.mime, "image/png");
        let bare = audios.iter().find(|t| t.name == "无标签").unwrap();
        assert_eq!(bare.name, "无标签");
        assert!(!bare.has_cover && bare.artist.is_none() && bare.title.is_none());
        assert!(query_cover(&db, bare.id).unwrap().is_none());
        assert!(bare.scan_error.is_none());
        let bad = audios.iter().find(|t| t.name == "损坏").unwrap();
        assert!(bad.scan_error.is_some() && bad.duration_ms.is_none());
        assert_eq!(bad.file_size, Some(9));
    }

    #[test]
    fn refresh_preserves_ids_and_removes_vanished_audios_with_covers() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("a.mp3"), true);
        mp3(&music.join("b.mp3"), true);
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let initial = index_folder(&mut db, &state, &music).unwrap();
        let first = query_audios(&db, initial.folder.id).unwrap();
        let old_cover = query_cover(&db, first[0].id).unwrap().unwrap();
        let duplicate = index_folder(&mut db, &state, &music.join(".")).unwrap();
        assert_eq!(initial.folder.id, duplicate.folder.id);
        assert_eq!(query_folders(&db).unwrap().len(), 1);
        fs::remove_file(music.join("b.mp3")).unwrap();
        mp3(&music.join("c.mp3"), false);
        fs::write(music.join("a.lrc"), "lyrics").unwrap();
        // Merely querying the index does not rescan the changed source directory.
        assert!(!query_audios(&db, initial.folder.id).unwrap()[0].has_lyrics);
        let refreshed = reindex_folder(&mut db, &state, initial.folder.id).unwrap();
        assert_eq!(refreshed.folder.id, initial.folder.id);
        let after = query_audios(&db, initial.folder.id).unwrap();
        assert_eq!(after.len(), 2);
        assert_eq!(after[0].id, first[0].id);
        assert!(after[0].has_lyrics);
        assert!(after[0].has_cover);
        assert_eq!(
            query_cover(&db, after[0].id).unwrap().unwrap().data,
            old_cover.data
        );
        assert!(query_cover(&db, first[1].id).is_err());
        assert!(query_cover(&db, after[1].id).unwrap().is_none());
        assert_eq!(after[1].name, "c");
        assert_ne!(after[1].id, first[1].id);
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM audios WHERE cover_data IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        drop(db);
        let db = fixture.db();
        assert_eq!(
            query_audios(&db, initial.folder.id).unwrap()[0].id,
            first[0].id
        );
    }

    #[test]
    fn missing_directory_and_sql_failure_preserve_previous_index() {
        let fixture = Fixture::new();
        let music = fixture.music();
        mp3(&music.join("old.mp3"), true);
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let initial = index_folder(&mut db, &state, &music).unwrap();
        let old = query_audios(&db, initial.folder.id).unwrap().remove(0);
        let old_cover = query_cover(&db, old.id).unwrap().unwrap();
        let previous_time = initial.folder.scanned_at;
        db.execute_batch("CREATE TRIGGER fail_audio BEFORE INSERT ON audios BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(reindex_folder(&mut db, &state, initial.folder.id).is_err());
        assert_eq!(
            get_folder(&db, initial.folder.id).unwrap().scanned_at,
            previous_time
        );
        assert_eq!(
            query_cover(&db, old.id).unwrap().unwrap().data,
            old_cover.data
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM audios WHERE cover_data IS NOT NULL",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
        fs::rename(&music, fixture.0.join("offline")).unwrap();
        assert!(reindex_folder(&mut db, &state, initial.folder.id).is_err());
        assert_eq!(query_audios(&db, initial.folder.id).unwrap()[0].id, old.id);
        assert_eq!(query_folders(&db).unwrap().len(), 1);
    }

    #[test]
    fn covers_follow_the_index_after_refresh_and_folder_removal() {
        let fixture = Fixture::new();
        let music = fixture.music();
        let song = music.join("song.mp3");
        mp3(&song, true);
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let folder = index_folder(&mut db, &state, &music).unwrap().folder;
        let audio_id = query_audios(&db, folder.id).unwrap()[0].id;

        // A source-file change is only reflected after an explicit refresh.
        mp3(&song, false);
        assert!(query_audios(&db, folder.id).unwrap()[0].has_cover);
        assert!(query_cover(&db, audio_id).unwrap().is_some());
        reindex_folder(&mut db, &state, folder.id).unwrap();
        assert!(!query_audios(&db, folder.id).unwrap()[0].has_cover);
        assert!(query_cover(&db, audio_id).unwrap().is_none());

        mp3(&song, true);
        reindex_folder(&mut db, &state, folder.id).unwrap();
        assert!(query_audios(&db, folder.id).unwrap()[0].has_cover);
        assert_eq!(
            query_cover(&db, audio_id).unwrap().unwrap().data,
            vec![2; 16]
        );
        remove_indexed_folder(&db, &state, folder.id).unwrap();
        assert_eq!(query_cover(&db, audio_id).unwrap_err(), "歌曲不存在");
    }

    #[test]
    fn empty_folders_and_scan_guard_and_failed_import() {
        let fixture = Fixture::new();
        let music = fixture.music();
        let mut db = fixture.db();
        let state = LocalAudioState::default();
        let key = display_path(&fs::canonicalize(&music).unwrap());
        let guard = state.acquire(key).unwrap();
        assert!(index_folder(&mut db, &state, &music).is_err());
        drop(guard);
        let folder = index_folder(&mut db, &state, &music).unwrap().folder;
        assert!(query_audios(&db, folder.id).unwrap().is_empty());
        assert!(index_folder(&mut db, &state, &fixture.0.join("missing")).is_err());
        assert_eq!(query_folders(&db).unwrap().len(), 1);
    }
}
