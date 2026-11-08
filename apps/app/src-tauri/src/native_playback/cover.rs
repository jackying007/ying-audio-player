use super::{
    http::{digest, fetch, media_url},
    model::Connection,
};
use reqwest::Client;
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};

const MAX_BYTES: usize = 10 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;

#[derive(Default)]
pub(super) struct CoverCache {
    // Serialize reads and misses for one song without blocking the rest of the list.
    locks: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
}

impl CoverCache {
    pub(super) async fn load(
        &self,
        root: Option<PathBuf>,
        client: &Client,
        connection: &Connection,
        id: i64,
        link: &str,
    ) -> Result<Vec<u8>> {
        let url = media_url(connection, link, id, "cover")?;
        let hash = url
            .query_pairs()
            .find(|(key, _)| key == "hash")
            .map(|(_, hash)| hash.into_owned())
            .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("无效的封面版本")?;
        let Some(root) = root else {
            return fetch_cover(client, url).await;
        };

        let settings = serde_json::to_vec(&[&connection.server_url, &connection.token])
            .map_err(|_| "无效的封面缓存连接")?;
        let path = root.join(digest(&settings)).join(format!("{id}.cover"));
        let lock = {
            let mut locks = self.locks.lock().map_err(|_| "无法访问封面缓存")?;
            locks.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(path.clone(), Arc::downgrade(&lock));
                lock
            }
        };
        let guard = lock.lock_owned().await;
        let cached = tauri::async_runtime::spawn_blocking({
            let (path, hash) = (path.clone(), hash.clone());
            move || read_cover(&path, &hash)
        })
        .await
        .ok()
        .flatten();
        if let Some(bytes) = cached {
            return Ok(bytes);
        }

        let bytes = fetch_cover(client, url).await?;
        tauri::async_runtime::spawn_blocking(move || {
            // Keep the per-song lock until publication even if the caller is cancelled.
            let _guard = guard;
            let _ = save_cover(&path, &hash, &bytes);
            bytes
        })
        .await
        .map_err(|_| "无法准备歌曲封面".to_owned())
    }
}

async fn fetch_cover(client: &Client, url: reqwest::Url) -> Result<Vec<u8>> {
    let bytes = fetch(client, url, MAX_BYTES).await?;
    if bytes.is_empty() {
        return Err("歌曲封面为空".into());
    }
    Ok(bytes)
}

fn read_cover(path: &Path, hash: &str) -> Option<Vec<u8>> {
    let mut file = fs::File::open(path).ok()?;
    let mut version = [0; 64];
    file.read_exact(&mut version).ok()?;
    if version != hash.as_bytes() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (!bytes.is_empty() && bytes.len() <= MAX_BYTES).then_some(bytes)
}

fn save_cover(path: &Path, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().expect("cover cache entry has a parent");
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(hash.as_bytes())?;
    file.write_all(bytes)?;
    file.persist(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
    };

    #[test]
    fn list_and_player_share_a_download_and_reuse_it_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(&socket);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\ncover",
                )
                .unwrap();
        });
        let root = Some(directory.path().to_path_buf());
        let connection = Connection {
            server_url: base.clone(),
            token: "fixture-key".into(),
        };
        let link = format!("{base}/api/audios/7/cover?hash={}", "a".repeat(64));
        let client = super::super::http::client().unwrap();
        tauri::async_runtime::block_on(async {
            let cache = CoverCache::default();
            let (list, player) = tokio::join!(
                cache.load(root.clone(), &client, &connection, 7, &link),
                cache.load(root.clone(), &client, &connection, 7, &link)
            );
            assert_eq!(list.unwrap(), b"cover");
            assert_eq!(player.unwrap(), b"cover");
            server.join().unwrap();

            let restarted = CoverCache::default();
            assert_eq!(
                restarted
                    .load(root.clone(), &client, &connection, 7, &link)
                    .await
                    .unwrap(),
                b"cover",
            );
            let changed = format!("{base}/api/audios/7/cover?hash={}", "b".repeat(64));
            assert!(restarted
                .load(root.clone(), &client, &connection, 7, &changed)
                .await
                .is_err());
            let other = Connection {
                token: "other-key".into(),
                ..connection
            };
            assert!(restarted
                .load(root, &client, &other, 7, &link)
                .await
                .is_err());
        });
    }
}
