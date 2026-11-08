use super::{
    cover::CoverCache,
    http::{digest, fetch, media_url, verified},
    model::{Connection, Song, Source},
};
use crate::{
    local_audio,
    network_cache::{self, CacheKey},
};
use reqwest::Client;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MIB: usize = 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

pub(super) enum File {
    #[cfg(mobile)]
    Local(local_audio::TemporaryFile),
    #[cfg(not(mobile))]
    Original(PathBuf),
    Staged(tempfile::TempPath),
}

impl File {
    fn local(app: &AppHandle, id: i64, lyrics: bool) -> Result<Self> {
        #[cfg(mobile)]
        return local_audio::materialize_for_playback(app, id, lyrics).map(Self::Local);
        #[cfg(not(mobile))]
        return local_audio::desktop_playback_path(app, id, lyrics).map(Self::Original);
    }

    pub(super) fn path(&self) -> &Path {
        match self {
            #[cfg(mobile)]
            Self::Local(file) => &file.0,
            #[cfg(not(mobile))]
            Self::Original(path) => path,
            Self::Staged(file) => file,
        }
    }
}

pub(super) struct Prepared {
    pub(super) file: File,
    pub(super) lyrics: Option<String>,
    pub(super) warning: Option<String>,
    pub(super) cache: Option<(CacheKey, Vec<u8>)>,
}

pub(super) fn staging(app: &AppHandle) -> Result<tempfile::TempDir> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join(if cfg!(mobile) {
            "mobile-playback"
        } else {
            "native-playback"
        });
    // A terminated process cannot release its staging files.
    #[cfg(mobile)]
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    tempfile::tempdir_in(root).map_err(|e| e.to_string())
}

fn key(song: &Song, connection: &Connection) -> Option<CacheKey> {
    let settings = serde_json::to_vec(&[&connection.server_url, &connection.token]).ok()?;
    serde_json::from_value(serde_json::json!({
        "connection": digest(&settings),
        "folderId": song.folder_id,
        "audioId": song.id,
        "folderName": song.folder_name.as_ref()?,
        "filename": song.filename.as_ref()?,
        "hash": song.hash.as_ref()?,
        "lyricsHash": if song.has_lyrics { song.lyrics_hash.as_deref() } else { None },
        "hasLyrics": song.has_lyrics
    }))
    .ok()
}

pub(super) async fn prepare_local(app: AppHandle, song: Song) -> Result<Prepared> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = File::local(&app, song.id, false)?;
        let lyrics = song
            .has_lyrics
            .then(|| {
                let file = File::local(&app, song.id, true).ok()?;
                fs::read(file.path())
                    .ok()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            })
            .flatten();
        let warning = (song.has_lyrics && lyrics.is_none()).then(|| "歌词读取失败".into());
        Ok(Prepared {
            file,
            lyrics,
            warning,
            cache: None,
        })
    })
    .await
    .map_err(|_| "无法读取本地歌曲")?
}

pub(super) async fn prepare_network(
    app: AppHandle,
    client: Client,
    directory: PathBuf,
    song: Song,
    connection: Connection,
) -> Result<Prepared> {
    let audio_url = media_url(&connection, &song.link, song.id, "audio")?;
    let key = key(&song, &connection);
    let (mut staged, cached) = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let key = key.clone();
        move || {
            let staged = tempfile::Builder::new()
                .suffix(".mp3")
                .tempfile_in(directory)
                .map_err(|_| "无法创建播放临时文件")?;
            let cached = key.as_ref().and_then(|key| {
                network_cache::copy_for_playback(&app, key, staged.path())
                    .ok()
                    .flatten()
            });
            Ok::<_, String>((staged, cached))
        }
    })
    .await
    .map_err(|_| "无法读取磁盘缓存")??;
    if let Some(lyrics) = cached {
        return Ok(Prepared {
            file: File::Staged(staged.into_temp_path()),
            lyrics,
            warning: None,
            cache: None,
        });
    }

    let audio = async {
        let bytes = verified(
            fetch(&client, audio_url, 50 * MIB).await?,
            song.hash.as_deref(),
        )?;
        if bytes.is_empty() {
            return Err("音频文件为空".into());
        }
        Ok::<_, String>(bytes)
    };
    let lyrics = async {
        if !song.has_lyrics {
            return Ok(None);
        }
        let url = media_url(&connection, &song.lrc_link, song.id, "lyrics")?;
        let bytes =
            tokio::time::timeout(std::time::Duration::from_secs(5), fetch(&client, url, MIB))
                .await
                .map_err(|_| "歌词下载超时")??;
        let bytes = verified(bytes, song.lyrics_hash.as_deref())?;
        Ok::<_, String>(Some(String::from_utf8_lossy(&bytes).into_owned()))
    };
    let (bytes, lyrics) = tokio::try_join!(audio, async { Ok(lyrics.await) })?;
    let (lyrics, warning) = match lyrics {
        Ok(lyrics) => (
            lyrics,
            key.is_none().then(|| "本地缓存不可用，本次仍可播放".into()),
        ),
        Err(_) => (None, Some("歌词加载失败，请重试播放".into())),
    };
    tauri::async_runtime::spawn_blocking(move || {
        staged
            .as_file_mut()
            .set_len(0)
            .map_err(|_| "无法写入播放临时文件")?;
        staged
            .write_all(&bytes)
            .map_err(|_| "无法写入播放临时文件")?;
        let cache = key
            .filter(|_| !song.has_lyrics || lyrics.is_some())
            .map(|key| (key, bytes));
        Ok(Prepared {
            file: File::Staged(staged.into_temp_path()),
            lyrics,
            warning,
            cache,
        })
    })
    .await
    .map_err(|_| "无法准备音频文件")?
}

pub(super) async fn artwork(
    app: AppHandle,
    client: Option<Client>,
    directory: PathBuf,
    song: Song,
    connection: Connection,
) -> Result<tempfile::TempPath> {
    let bytes = if song.source == Source::Network {
        let client = client.ok_or("无法加载网络封面")?;
        app.state::<CoverCache>()
            .load(
                cover_directory(&app),
                &client,
                &connection,
                song.id,
                song.cover_link.as_deref().unwrap_or_default(),
            )
            .await?
    } else {
        local_audio::get_cover(app, song.id)
            .await?
            .map(|cover| cover.data)
            .ok_or("封面不存在")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = tempfile::Builder::new()
            .suffix(".img")
            .tempfile_in(directory)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        Ok(file.into_temp_path())
    })
    .await
    .map_err(|_| "无法准备歌曲封面")?
}

pub(super) fn cover_directory(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_cache_dir()
        .ok()
        .map(|root| root.join("network-covers"))
}

#[cfg(all(test, not(mobile)))]
mod tests {
    use super::*;

    #[test]
    fn releasing_a_local_source_keeps_the_original_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("原始歌曲.mp3");
        fs::write(&path, b"original audio").unwrap();
        let file = File::Original(path.clone());
        assert_eq!(file.path(), path);
        drop(file);
        assert_eq!(fs::read(path).unwrap(), b"original audio");
    }
}
