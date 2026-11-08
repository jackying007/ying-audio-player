use super::model::Connection;
use reqwest::{Client, Url};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, String>;

pub(super) fn client() -> Result<Client> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(90))
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化媒体下载".into())
}

pub(super) fn media_url(connection: &Connection, link: &str, id: i64, kind: &str) -> Result<Url> {
    let invalid = || "网络歌曲地址无效，请刷新列表".to_owned();
    let server = Url::parse(&connection.server_url).map_err(|_| invalid())?;
    let mut url = Url::parse(link).map_err(|_| invalid())?;
    if !matches!(server.scheme(), "http" | "https")
        || url.origin() != server.origin()
        || url.path() != format!("/api/audios/{id}/{kind}")
        || !url.username().is_empty()
        || url.password().is_some()
        || connection.token.is_empty()
    {
        return Err(invalid());
    }
    let query: Vec<_> = url
        .query_pairs()
        .into_owned()
        .filter(|(key, _)| key != "authToken")
        .collect();
    url.set_fragment(None);
    url.set_query(None);
    url.query_pairs_mut()
        .extend_pairs(query)
        .append_pair("authToken", &connection.token);
    Ok(url)
}

async fn read_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err("媒体文件超过大小限制".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "媒体下载中断")? {
        if chunk.len() > limit - bytes.len() {
            return Err("媒体文件超过大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) async fn fetch(client: &Client, url: Url, limit: usize) -> Result<Vec<u8>> {
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "authToken")
        .map(|(_, token)| token.into_owned());
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法连接媒体服务器")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = read_body(response, 4096).await.unwrap_or_default();
        let message = String::from_utf8_lossy(&body);
        // Never surface a server response that echoes a credential or a request URL.
        return Err(
            if message.trim().is_empty()
                || message.contains("authToken")
                || token
                    .as_ref()
                    .is_some_and(|value| message.contains(value.as_str()))
            {
                format!("媒体请求失败 ({status})")
            } else {
                message.trim().to_owned()
            },
        );
    }
    read_body(response, limit).await
}

pub(super) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn verified(bytes: Vec<u8>, expected: Option<&str>) -> Result<Vec<u8>> {
    if expected.is_some_and(|hash| digest(&bytes) == hash) {
        Ok(bytes)
    } else {
        Err("媒体文件校验失败，请刷新网络列表".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
    };

    fn connection(server_url: String) -> Connection {
        Connection {
            server_url,
            token: "key &/+中文".into(),
        }
    }

    #[test]
    fn only_current_servers_media_route_receives_current_query_credentials() {
        let connection = connection("https://music.example".into());
        let url = media_url(
            &connection,
            "https://music.example/api/audios/7/audio?hash=abc&authToken=stale#ignored",
            7,
            "audio",
        )
        .unwrap();
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            [
                ("hash".into(), "abc".into()),
                ("authToken".into(), connection.token.clone()),
            ]
        );
        assert!(url.fragment().is_none());
        for invalid in [
            "http://music.example/api/audios/7/audio",
            "https://other.example/api/audios/7/audio",
            "https://music.example/api/audios/8/audio",
            "https://user@music.example/api/audios/7/audio",
        ] {
            assert!(
                media_url(&connection, invalid, 7, "audio").is_err(),
                "{invalid}"
            );
        }
    }

    fn response(raw: &'static str, limit: usize) -> Result<Vec<u8>> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = String::new();
            let mut reader = BufReader::new(&socket);
            reader.read_line(&mut request).unwrap();
            assert!(request.starts_with("GET /api/audios/7/audio?hash=abc&authToken="));
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            socket.write_all(raw.as_bytes()).unwrap();
        });
        let url = media_url(
            &connection(base.clone()),
            &format!("{base}/api/audios/7/audio?hash=abc"),
            7,
            "audio",
        )
        .unwrap();
        let result =
            tauri::async_runtime::block_on(async { fetch(&client().unwrap(), url, limit).await });
        server.join().unwrap();
        result
    }

    #[test]
    fn network_media_keeps_text_errors_and_enforces_the_limit_without_a_content_length() {
        let unauthorized = response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 10\r\nConnection: close\r\n\r\nbad token!", 1024);
        assert_eq!(unauthorized.unwrap_err(), "bad token!");
        let too_large = response("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ndata\r\n0\r\n\r\n", 3);
        assert_eq!(too_large.unwrap_err(), "媒体文件超过大小限制");
        let redirect = response("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", 1024);
        assert_eq!(redirect.unwrap_err(), "媒体请求失败 (302)");
    }

    #[test]
    fn cancelling_a_pending_media_download_closes_the_response() {
        use std::{sync::mpsc, time::Duration};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (headers_sent, ready) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&socket);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
            }
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\na")
                .unwrap();
            headers_sent.send(()).unwrap();
            // Only one byte was sent. Completing this request would require more bytes.
            match socket.read(&mut [0; 1]) {
                Ok(0) => true,
                Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => true,
                _ => false,
            }
        });
        let url = media_url(
            &connection(base.clone()),
            &format!("{base}/api/audios/7/audio?hash=abc"),
            7,
            "audio",
        )
        .unwrap();
        let download =
            tauri::async_runtime::spawn(async move { fetch(&client().unwrap(), url, 1024).await });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        download.abort();
        assert!(tauri::async_runtime::block_on(download).is_err());
        assert!(server.join().unwrap(), "cancellation must close the socket");
    }

    #[test]
    fn downloaded_bytes_must_match_the_published_hash() {
        let hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(verified(b"abc".to_vec(), Some(hash)).unwrap(), b"abc");
        assert!(verified(b"abx".to_vec(), Some(hash)).is_err());
    }
}
