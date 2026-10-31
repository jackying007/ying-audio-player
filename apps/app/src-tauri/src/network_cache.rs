use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;

// Serialize cache reads and publication.
static CACHE_LOCK: Mutex<()> = Mutex::new(());
const MAX_CACHE_PAYLOAD_SIZE: usize = 52 * 1024 * 1024 + 4;
const MAX_CACHE_CHUNK_SIZE: usize = 64 * 1024;

struct PendingCacheWrite {
    size: usize,
    bytes: Vec<u8>,
}

impl PendingCacheWrite {
    fn new(size: usize) -> Result<Self> {
        if !(4..=MAX_CACHE_PAYLOAD_SIZE).contains(&size) {
            return Err("缓存请求超过大小限制或不完整".into());
        }
        Ok(Self {
            size,
            bytes: Vec::with_capacity(size),
        })
    }

    fn append(&mut self, offset: usize, data: &[u8]) -> Result<()> {
        if data.is_empty()
            || data.len() > MAX_CACHE_CHUNK_SIZE
            || offset != self.bytes.len()
            || data.len() > self.size - self.bytes.len()
        {
            return Err("缓存数据块超限、顺序错误或超出声明大小".into());
        }
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    fn take_payload(&mut self) -> Result<Vec<u8>> {
        if self.bytes.len() != self.size {
            return Err("缓存请求不完整".into());
        }
        Ok(std::mem::take(&mut self.bytes))
    }
}

struct CacheWrite {
    pending: Mutex<PendingCacheWrite>,
}

// Tauri releases the buffer on completion, cancellation or app shutdown.
impl tauri::Resource for CacheWrite {}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheKey {
    connection: String,
    folder_id: u64,
    folder_name: String,
    audio_id: u64,
    filename: String,
    hash: String,
    lyrics_hash: Option<String>,
    has_lyrics: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    key: CacheKey,
    audio_size: u64,
    lyrics_size: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFiles {
    audio_path: String,
    lyrics_path: Option<String>,
}

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("network-cache")
        .invoke_handler(tauri::generate_handler![
            #![plugin(network_cache)]
            read_cache,
            save_cache,
            begin_cache_write,
            write_cache_chunk,
            finish_cache_write,
            abort_cache_write
        ])
        .build()
}

fn safe_name(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim_matches([' ', '.']);
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(*prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
    if name.is_empty() || reserved {
        format!("_{name}")
    } else {
        name.to_owned()
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}

fn validate_key(key: &CacheKey) -> Result<()> {
    if key.connection.len() != 64
        || !key.connection.bytes().all(|c| c.is_ascii_hexdigit())
        || key.folder_id == 0
        || key.audio_id == 0
        || key.filename.is_empty()
        || !valid_hash(&key.hash)
        || key.has_lyrics != key.lyrics_hash.is_some()
        || key
            .lyrics_hash
            .as_ref()
            .is_some_and(|value| !valid_hash(value))
    {
        return Err("无效的网络缓存标识".into());
    }
    Ok(())
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(crate::storage::root(app)?.join("network"))
}

// Reject links/junctions so cache operations stay inside the executable's network directory.
fn directory(path: &Path, create: bool) -> Result<PathBuf> {
    if create {
        match fs::create_dir(path) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let parent =
        fs::canonicalize(path.parent().ok_or("无效缓存目录")?).map_err(|e| e.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || canonical != parent.join(path.file_name().ok_or("无效缓存目录")?)
    {
        return Err("缓存目录不能是链接或重定向目录".into());
    }
    Ok(canonical)
}

fn entry_directory(root: &Path, key: &CacheKey, create: bool) -> Result<PathBuf> {
    validate_key(key)?;
    let root = directory(root, create)?;
    directory(&root.join(safe_name(&key.folder_name)), create)
}

fn marker_path(entry: &Path, key: &CacheKey) -> PathBuf {
    entry
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(".network-cache")
        .join(entry.file_name().unwrap())
        .join(format!("{}.json", audio_filename(key)))
}

fn metadata_directory(entry: &Path, create: bool) -> Result<PathBuf> {
    let executable_dir = entry
        .parent()
        .and_then(Path::parent)
        .ok_or("无效缓存目录")?;
    let metadata = directory(&executable_dir.join(".network-cache"), create)?;
    directory(
        &metadata.join(entry.file_name().ok_or("无效缓存目录")?),
        create,
    )
}

fn file_size(path: &Path) -> Option<u64> {
    let metadata = fs::symlink_metadata(path).ok()?;
    (metadata.is_file() && !metadata.file_type().is_symlink()).then_some(metadata.len())
}

fn cached_files(entry: &Path, key: &CacheKey) -> Option<CachedFiles> {
    metadata_directory(entry, false).ok()?;
    let marker = marker_path(entry, key);
    if file_size(&marker)? > 16 * 1024 {
        return None;
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(marker).ok()?).ok()?;
    if manifest.key != *key
        || manifest.audio_size == 0
        || manifest.audio_size > 50 * 1024 * 1024
        || manifest.lyrics_size.is_some_and(|size| size > 1024 * 1024)
    {
        return None;
    }
    let audio = entry.join(audio_filename(key));
    let lyrics = audio.with_extension("lrc");
    if file_size(&audio)? != manifest.audio_size {
        return None;
    }
    if key.has_lyrics && file_size(&lyrics) != manifest.lyrics_size {
        return None;
    }
    if key.has_lyrics && manifest.lyrics_size.is_none() {
        return None;
    }
    Some(CachedFiles {
        audio_path: audio.to_string_lossy().into_owned(),
        lyrics_path: key
            .has_lyrics
            .then(|| lyrics.to_string_lossy().into_owned()),
    })
}

fn audio_filename(key: &CacheKey) -> String {
    safe_name(&key.filename)
}

fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_file_name(format!(
        ".{}.tmp",
        path.file_name().ok_or("无效缓存文件名")?.to_string_lossy()
    ));
    // Unlink old names before writing; never follow an existing file link.
    for target in [&temporary, path] {
        match fs::remove_file(target) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn save_files(root: &Path, key: CacheKey, audio: Vec<u8>, lyrics: Option<String>) -> Result<()> {
    if audio.is_empty()
        || audio.len() > 50 * 1024 * 1024
        || lyrics.as_ref().is_some_and(|text| text.len() > 1024 * 1024)
        || key.has_lyrics != lyrics.is_some()
    {
        return Err("缓存音频或歌词不完整，或超过大小限制".into());
    }
    let entry = entry_directory(root, &key, true)?;
    metadata_directory(&entry, true)?;
    // Replace even a same-version entry: the frontend may have failed to read its files.
    let marker = marker_path(&entry, &key);
    match fs::remove_file(&marker) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.to_string()),
    }
    let audio_path = entry.join(audio_filename(&key));
    replace_file(&audio_path, &audio)?;
    if let Some(text) = &lyrics {
        replace_file(&audio_path.with_extension("lrc"), text.as_bytes())?;
    } else {
        match fs::remove_file(audio_path.with_extension("lrc")) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    let manifest = Manifest {
        key: key.clone(),
        audio_size: audio.len() as u64,
        lyrics_size: lyrics.as_ref().map(|text| text.len() as u64),
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
    replace_file(&marker, &bytes)?;
    Ok(())
}

fn read_files(root: &Path, key: &CacheKey) -> Result<Option<CachedFiles>> {
    validate_key(key)?;
    Ok(entry_directory(root, key, false)
        .ok()
        .and_then(|entry| cached_files(&entry, key)))
}

#[tauri::command]
async fn read_cache(app: tauri::AppHandle, key: CacheKey) -> Result<Option<CachedFiles>> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CACHE_LOCK.lock().map_err(|e| e.to_string())?;
        read_files(&cache_root(&app)?, &key)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize)]
struct SaveMetadata {
    key: CacheKey,
    lyrics: Option<String>,
}

fn save_payload(root: &Path, mut payload: Vec<u8>) -> Result<()> {
    // Wire format: 4-byte little-endian metadata length, JSON metadata, raw audio.
    let prefix: [u8; 4] = payload
        .get(..4)
        .ok_or("缓存请求不完整")?
        .try_into()
        .map_err(|_| "无效缓存请求")?;
    let metadata_size = u32::from_le_bytes(prefix) as usize;
    if metadata_size > 2 * 1024 * 1024 || payload.len() > MAX_CACHE_PAYLOAD_SIZE {
        return Err("缓存请求超过大小限制".into());
    }
    let offset = 4 + metadata_size;
    let metadata: SaveMetadata =
        serde_json::from_slice(payload.get(4..offset).ok_or("缓存请求不完整")?)
            .map_err(|e| e.to_string())?;
    let audio = payload.split_off(offset);
    save_files(root, metadata.key, audio, metadata.lyrics)
}

#[tauri::command]
async fn save_cache(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<()> {
    let payload = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) if bytes.len() <= MAX_CACHE_PAYLOAD_SIZE => {
            bytes.clone()
        }
        _ => return Err("缓存请求必须为大小限制内的二进制数据".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CACHE_LOCK.lock().map_err(|e| e.to_string())?;
        save_payload(&cache_root(&app)?, payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn begin_cache_write(app: tauri::AppHandle, size: usize) -> Result<tauri::ResourceId> {
    let pending = PendingCacheWrite::new(size)?;
    Ok(app.resources_table().add(CacheWrite {
        pending: Mutex::new(pending),
    }))
}

#[tauri::command]
async fn write_cache_chunk(
    app: tauri::AppHandle,
    rid: tauri::ResourceId,
    offset: usize,
    data: Vec<u8>,
) -> Result<()> {
    let write = app
        .resources_table()
        .get::<CacheWrite>(rid)
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        write
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .append(offset, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn finish_cache_write(app: tauri::AppHandle, rid: tauri::ResourceId) -> Result<()> {
    let write = app
        .resources_table()
        .take::<CacheWrite>(rid)
        .map_err(|e| e.to_string())?;
    let root = cache_root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let payload = write
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .take_payload()?;
        let _guard = CACHE_LOCK.lock().map_err(|e| e.to_string())?;
        save_payload(&root, payload)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn abort_cache_write(app: tauri::AppHandle, rid: tauri::ResourceId) -> Result<()> {
    app.resources_table()
        .take::<CacheWrite>(rid)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static COUNTER: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "ying-network-cache-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn root(&self) -> PathBuf {
            self.0.join("network")
        }

        fn entry(&self, key: &CacheKey) -> PathBuf {
            entry_directory(&self.root(), key, false).unwrap()
        }

        fn save(&self, key: &CacheKey) {
            save_files(
                &self.root(),
                key.clone(),
                b"music".to_vec(),
                key.has_lyrics.then(|| "[00:01]歌词".into()),
            )
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // This fixture owns only a uniquely created child of the system temp directory.
            if let (Ok(path), Ok(temporary)) = (
                fs::canonicalize(&self.0),
                fs::canonicalize(std::env::temp_dir()),
            ) {
                if path.starts_with(&temporary) && path != temporary {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }

    fn key() -> CacheKey {
        CacheKey {
            connection: "a".repeat(64),
            folder_id: 1,
            folder_name: "我的音乐".into(),
            audio_id: 1,
            filename: "song.mp3".into(),
            hash: "a".repeat(64),
            lyrics_hash: Some("b".repeat(64)),
            has_lyrics: true,
        }
    }

    #[test]
    fn android_json_chunks_publish_exact_audio_and_unicode_lyrics_only_when_complete() {
        let fixture = Fixture::new();
        let key = key();
        fixture.save(&key);
        let original = read_files(&fixture.root(), &key).unwrap().unwrap();
        let metadata =
            serde_json::to_vec(&serde_json::json!({ "key": key, "lyrics": "[00:01]中文歌词" }))
                .unwrap();
        let audio: Vec<u8> = (0..MAX_CACHE_CHUNK_SIZE + 37)
            .map(|index| index as u8)
            .collect();
        let mut payload = (metadata.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&metadata);
        payload.extend_from_slice(&audio);
        let mut pending = PendingCacheWrite::new(payload.len()).unwrap();
        for chunk in payload.chunks(MAX_CACHE_CHUNK_SIZE) {
            // Android serializes typed arrays as JSON arrays rather than a raw InvokeBody.
            let data: Vec<u8> = serde_json::from_value(serde_json::json!(chunk)).unwrap();
            pending.append(pending.bytes.len(), &data).unwrap();
            assert_eq!(fs::read(&original.audio_path).unwrap(), b"music");
        }
        save_payload(&fixture.root(), pending.take_payload().unwrap()).unwrap();
        let files = read_files(&fixture.root(), &key).unwrap().unwrap();
        assert_eq!(fs::read(files.audio_path).unwrap(), audio);
        assert_eq!(
            fs::read_to_string(files.lyrics_path.unwrap()).unwrap(),
            "[00:01]中文歌词"
        );
    }

    #[test]
    fn chunks_reject_invalid_sizes_offsets_and_incomplete_transfers_without_changing_old_cache() {
        let fixture = Fixture::new();
        let key = key();
        fixture.save(&key);
        for size in [0, 3, MAX_CACHE_PAYLOAD_SIZE + 1] {
            assert!(PendingCacheWrite::new(size).is_err());
        }
        let mut pending = PendingCacheWrite::new(8).unwrap();
        for (offset, data) in [
            (0, vec![]),
            (1, vec![1]),
            (0, vec![0; MAX_CACHE_CHUNK_SIZE + 1]),
            (0, vec![0; 9]),
        ] {
            assert!(pending.append(offset, &data).is_err());
            assert!(pending.bytes.is_empty());
        }
        pending.append(0, &[0, 128, 255, 42]).unwrap();
        assert!(pending.append(0, &[1]).is_err());
        assert!(pending.take_payload().is_err());
        let old = read_files(&fixture.root(), &key).unwrap().unwrap();
        assert_eq!(fs::read(old.audio_path).unwrap(), b"music");
    }

    #[test]
    fn cancelled_chunk_resources_release_the_buffer_and_cannot_be_used_again() {
        let mut resources = tauri::ResourceTable::default();
        let rid = resources.add(CacheWrite {
            pending: Mutex::new(PendingCacheWrite::new(8).unwrap()),
        });
        let write = resources.get::<CacheWrite>(rid).unwrap();
        write
            .pending
            .lock()
            .unwrap()
            .append(0, &[0, 128, 255, 42])
            .unwrap();
        let weak = std::sync::Arc::downgrade(&write);
        drop(write);
        drop(resources.take::<CacheWrite>(rid).unwrap());
        assert!(weak.upgrade().is_none());
        assert!(resources.get::<CacheWrite>(rid).is_err());
    }

    #[test]
    fn binary_payload_preserves_audio_and_lyrics_and_rejects_incomplete_data() {
        let fixture = Fixture::new();
        let key = key();
        let metadata = serde_json::to_vec(&serde_json::json!({
            "key": key,
            "lyrics": "[00:01]歌词"
        }))
        .unwrap();
        let mut payload = (metadata.len() as u32).to_le_bytes().to_vec();
        payload.extend_from_slice(&metadata);
        let audio = [0, 128, 255, 42];
        payload.extend_from_slice(&audio);
        save_payload(&fixture.root(), payload).unwrap();
        let cached = read_files(&fixture.root(), &key).unwrap().unwrap();
        assert_eq!(fs::read(cached.audio_path).unwrap(), audio);
        assert_eq!(
            fs::read_to_string(cached.lyrics_path.unwrap()).unwrap(),
            "[00:01]歌词"
        );
        for invalid in [vec![], vec![1, 2, 3], vec![255; 4], vec![10, 0, 0, 0, b'{']] {
            assert!(save_payload(&fixture.root(), invalid).is_err());
        }
    }

    #[test]
    fn saves_complete_audio_and_lyrics_with_persistent_paths() {
        let fixture = Fixture::new();
        let key = key();
        fixture.save(&key);
        let entry = fixture.entry(&key);
        let cached = cached_files(&entry, &key).unwrap();
        assert_eq!(fs::read(&cached.audio_path).unwrap(), b"music");
        assert_eq!(
            fs::read_to_string(cached.lyrics_path.unwrap()).unwrap(),
            "[00:01]歌词"
        );
        assert_eq!(
            entry,
            fs::canonicalize(fixture.root().join("我的音乐")).unwrap()
        );
        assert_eq!(Path::new(&cached.audio_path), entry.join("song.mp3"));
        assert!(marker_path(&entry, &key).is_file());
        assert_eq!(fs::read_dir(&entry).unwrap().count(), 2);
    }

    #[test]
    fn legacy_manifest_without_hashes_is_rejected() {
        let old = r#"{"connection":"abc","folderId":1,"folderName":"music","audioId":1,"filename":"song.mp3","version":"v1","hasLyrics":false}"#;
        assert!(serde_json::from_str::<CacheKey>(old).is_err());
    }

    #[test]
    fn no_lyrics_song_only_requires_audio() {
        let fixture = Fixture::new();
        let key = CacheKey {
            has_lyrics: false,
            lyrics_hash: None,
            ..key()
        };
        fixture.save(&key);
        let cached = cached_files(&fixture.entry(&key), &key).unwrap();
        assert!(cached.lyrics_path.is_none());
        assert!(!fixture.entry(&key).join("song.lrc").exists());
    }

    #[test]
    fn missing_truncated_and_unpublished_files_are_cache_misses_and_can_be_repaired() {
        let fixture = Fixture::new();
        let key = key();
        fixture.save(&key);
        let entry = fixture.entry(&key);
        for path in [
            entry.join("song.mp3"),
            entry.join("song.lrc"),
            marker_path(&entry, &key),
        ] {
            fs::remove_file(&path).unwrap();
            assert!(cached_files(&entry, &key).is_none());
            fixture.save(&key);
            assert!(cached_files(&entry, &key).is_some());
            fs::write(&path, b"x").unwrap();
            assert!(cached_files(&entry, &key).is_none());
            fixture.save(&key);
            assert!(cached_files(&entry, &key).is_some());
        }
        let changed_key = CacheKey {
            filename: "different.mp3".into(),
            ..key.clone()
        };
        assert!(cached_files(&entry, &changed_key).is_none());
    }

    #[test]
    fn incomplete_downloads_and_failed_publication_keep_the_old_version() {
        let fixture = Fixture::new();
        let old = key();
        fixture.save(&old);
        let new = CacheKey {
            hash: "c".repeat(64),
            filename: "blocked.mp3".into(),
            ..old.clone()
        };
        assert!(save_files(&fixture.root(), new.clone(), b"music".to_vec(), None).is_err());
        assert!(save_files(
            &fixture.root(),
            new.clone(),
            Vec::new(),
            Some("lyrics".into())
        )
        .is_err());
        let new_entry = entry_directory(&fixture.root(), &new, true).unwrap();
        // Force a lyrics write failure after the audio has been written.
        fs::create_dir(new_entry.join("blocked.lrc")).unwrap();
        assert!(save_files(
            &fixture.root(),
            new.clone(),
            b"music".to_vec(),
            Some("lyrics".into())
        )
        .is_err());
        assert!(!marker_path(&new_entry, &new).exists());
        assert!(cached_files(&new_entry, &new).is_none());
        assert!(cached_files(&fixture.entry(&old), &old).is_some());
    }

    #[test]
    fn replacement_uses_original_path_and_manifest_prevents_cross_connection_hits() {
        let fixture = Fixture::new();
        let old = key();
        fixture.save(&old);
        let other_song = CacheKey {
            audio_id: 12,
            filename: "other.mp3".into(),
            ..old.clone()
        };
        let other_connection = CacheKey {
            connection: "b".repeat(64),
            ..old.clone()
        };
        fixture.save(&other_song);
        fixture.save(&other_connection);
        assert!(cached_files(&fixture.entry(&old), &old).is_none());
        assert!(cached_files(&fixture.entry(&other_connection), &other_connection).is_some());
        let new = CacheKey {
            hash: "c".repeat(64),
            has_lyrics: false,
            lyrics_hash: None,
            ..old.clone()
        };
        fixture.save(&new);
        fixture.save(&new);
        assert!(cached_files(&fixture.entry(&old), &old).is_none());
        assert!(cached_files(&fixture.entry(&new), &new).is_some());
        assert!(!fixture.entry(&new).join("song.lrc").exists());
        assert!(cached_files(&fixture.entry(&other_song), &other_song).is_some());
        assert!(cached_files(&fixture.entry(&other_connection), &other_connection).is_none());
    }

    #[test]
    fn original_unicode_names_and_extension_case_are_preserved() {
        let fixture = Fixture::new();
        let key = CacheKey {
            filename: format!("中文{} 原版.MP3", "a".repeat(90)),
            folder_name: "中文 歌单".into(),
            ..key()
        };
        fixture.save(&key);
        let entry = fixture.entry(&key);
        assert!(entry.join(&key.filename).is_file());
        assert!(entry
            .join(Path::new(&key.filename).with_extension("lrc"))
            .is_file());
        assert!(read_files(&fixture.root(), &key).unwrap().is_some());
    }

    #[test]
    fn unsafe_names_are_confined_and_invalid_identifiers_are_rejected() {
        let fixture = Fixture::new();
        let key = CacheKey {
            folder_name: "../../CON:<>".into(),
            filename: "../../NUL.mp3".into(),
            ..key()
        };
        fixture.save(&key);
        let cached = cached_files(&fixture.entry(&key), &key).unwrap();
        let root = fs::canonicalize(fixture.root()).unwrap();
        assert!(Path::new(&cached.audio_path).starts_with(root));
        for name in ["CON.mp3", "NUL.mp3", "COM1.mp3", "LPT9.mp3", "COM¹.mp3"] {
            assert!(safe_name(name).starts_with('_'));
        }
        assert!(!safe_name(" song. ").ends_with([' ', '.']));
        for version in ["../escape", "", "a/b", "a\\b", "C:escape"] {
            let invalid = CacheKey {
                hash: version.into(),
                ..key.clone()
            };
            assert!(save_files(
                &fixture.root(),
                invalid,
                b"music".to_vec(),
                Some("lyrics".into())
            )
            .is_err());
        }
        let invalid = CacheKey {
            connection: "../escape".into(),
            ..key
        };
        assert!(validate_key(&invalid).is_err());
    }
}
