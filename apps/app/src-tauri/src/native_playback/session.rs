use super::{
    cover::CoverCache,
    http, media,
    model::{Connection, PlayState, Snapshot, Song, Source},
    queue::{Mode, Queue, Step},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::AbortHandle,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Playlist {
    audio_list: Vec<Song>,
    playlist_folder_id: Option<i64>,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Command {
    Play {
        audio: Box<Song>,
        playlist: Option<Playlist>,
    },
    UpdateFolder {
        folder_id: i64,
        source: Source,
        audios: Vec<Song>,
    },
    RemoveFolder {
        folder_id: i64,
        source: Source,
    },
    Connection {
        server_url: String,
        token: String,
    },
    Mode {
        mode: Mode,
    },
    Volume {
        value: f64,
    },
    Seek {
        value: f64,
    },
    Pause,
    Resume,
    Toggle,
    Previous,
    Next,
    Stop,
    Snapshot,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineEvent {
    generation: u64,
    #[serde(flatten)]
    kind: EngineEventKind,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum EngineEventKind {
    Status {
        state: PlayState,
        current_time: f64,
        duration: Option<f64>,
        buffering: bool,
        ready: bool,
    },
    Ended,
    Error,
    ArtworkError,
    Released,
    TaskRemoved,
    ResumeAfterInterruption,
    Pause,
    Resume,
    Previous,
    Next,
    Seek {
        value: f64,
    },
    Toggle,
    Stop,
}

enum Message {
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    Shutdown(oneshot::Sender<()>),
    Command(Command, oneshot::Sender<Option<Snapshot>>),
    Event(EngineEvent),
    Prepared(u64, Result<media::Prepared, String>),
    Artwork(u64, Result<tempfile::TempPath, String>),
    CacheFailed(u64),
}

struct CachePublication {
    key: crate::network_cache::CacheKey,
    bytes: Vec<u8>,
    lyrics: Option<String>,
}

#[derive(Clone)]
enum Engine {
    #[cfg(mobile)]
    Mobile(tauri::plugin::PluginHandle<tauri::Wry>),
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    Desktop(super::desktop::Engine),
    #[cfg(test)]
    Test(mpsc::UnboundedSender<(String, u64, Value)>),
}

struct Session {
    app: Option<AppHandle>,
    engine: Engine,
    sender: mpsc::UnboundedSender<Message>,
    snapshot: Snapshot,
    queue: Queue,
    mode: Mode,
    volume: f64,
    wants_play: bool,
    connection: Connection,
    cover_connection: watch::Sender<Connection>,
    stage: Option<tempfile::TempDir>,
    client: Result<reqwest::Client, String>,
    file: Option<media::File>,
    cache_publication: Option<CachePublication>,
    artwork: Option<tempfile::TempPath>,
    jobs: Vec<AbortHandle>,
    active: Arc<AtomicBool>,
    attached: bool,
}

impl Session {
    fn new(
        app: Option<AppHandle>,
        engine: Engine,
        sender: mpsc::UnboundedSender<Message>,
        cover_connection: watch::Sender<Connection>,
        client: Result<reqwest::Client, String>,
    ) -> Self {
        Self {
            app,
            engine,
            sender,
            cover_connection,
            client,
            snapshot: Snapshot::default(),
            queue: Queue::default(),
            mode: Mode::default(),
            volume: 1.0,
            wants_play: false,
            connection: Connection::default(),
            stage: None,
            file: None,
            cache_publication: None,
            artwork: None,
            jobs: vec![],
            active: Arc::new(AtomicBool::new(true)),
            attached: false,
        }
    }

    async fn native(&self, kind: &str, payload: Value) -> Result<(), String> {
        let generation = self.snapshot.generation;
        match &self.engine {
            #[cfg(mobile)]
            Engine::Mobile(engine) => {
                engine
                    .run_mobile_plugin_async::<Value>(
                        "engine",
                        json!({ "kind": kind, "generation": generation, "payload": payload }),
                    )
                    .await
                    .map_err(|_| "无法控制原生播放器".to_owned())?;
                Ok(())
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            Engine::Desktop(engine) => engine.command(kind, generation, payload).await,
            #[cfg(test)]
            Engine::Test(engine) => engine
                .send((kind.to_owned(), generation, payload))
                .map_err(|_| "test engine closed".into()),
        }
    }

    async fn attach(&mut self) -> Result<(), String> {
        if self.attached {
            return Ok(());
        }
        #[cfg(mobile)]
        match &self.engine {
            Engine::Mobile(engine) => {
                let sender = self.sender.clone();
                let channel = tauri::ipc::Channel::<EngineEvent>::new(move |body| {
                    if let Ok(event) = body.deserialize::<EngineEvent>() {
                        let _ = sender.send(Message::Event(event));
                    }
                    Ok(())
                });
                engine
                    .run_mobile_plugin_async::<Value>("attach", json!({ "channel": channel }))
                    .await
                    .map_err(|_| "无法连接原生播放器")?;
            }
            #[cfg(test)]
            Engine::Test(_) => {}
        }
        self.attached = true;
        Ok(())
    }

    fn publish(&mut self) {
        self.snapshot.revision += 1;
        if let Some(app) = &self.app {
            let _ = app.emit("native-playback-state", &self.snapshot);
        }
    }

    fn reset_queue(&mut self) {
        self.queue.reset(
            self.snapshot.audio_list.iter().map(Song::key).collect(),
            self.snapshot
                .current_audio_info
                .as_ref()
                .map(Song::key)
                .as_deref(),
        );
    }

    fn controls(&self) -> Value {
        json!({
            "previous": self.queue.can_step(self.mode, Step::Previous),
            "next": self.queue.can_step(self.mode, Step::Next),
        })
    }

    fn cancel_load(&mut self) {
        self.active.store(false, Ordering::Release);
        self.cache_publication = None;
        self.active = Arc::new(AtomicBool::new(true));
        for job in self.jobs.drain(..) {
            job.abort();
        }
        self.snapshot.generation += 1;
    }

    async fn stop(&mut self) {
        self.cancel_load();
        self.wants_play = false;
        if !self.attached || self.native("stop", Value::Null).await.is_ok() {
            self.file = None;
            self.artwork = None;
        }
        self.snapshot = Snapshot {
            revision: self.snapshot.revision,
            generation: self.snapshot.generation,
            ..Snapshot::default()
        };
        self.reset_queue();
        self.publish();
    }

    async fn fail(&mut self, message: String) {
        self.cancel_load();
        self.wants_play = false;
        if !self.attached || self.native("fail", Value::Null).await.is_ok() {
            self.file = None;
            self.artwork = None;
        }
        self.snapshot.error = Some(message);
        self.snapshot.state = PlayState::Paused;
        self.snapshot.is_loading = false;
        self.publish();
    }

    async fn start(&mut self, song: Song) {
        self.load(song, 0.0, true).await;
    }

    async fn load(&mut self, song: Song, position: f64, autoplay: bool) {
        self.cancel_load();
        self.wants_play = autoplay;
        self.snapshot.current_audio_info = Some(song.clone());
        self.snapshot.state = PlayState::None;
        self.snapshot.is_loading = true;
        self.snapshot.current_time = position;
        self.snapshot.duration = song.duration_ms.map(|ms| ms / 1000.0);
        self.snapshot.current_lrc = None;
        self.snapshot.error = None;
        self.snapshot.warning = None;
        self.publish();

        if let Err(error) = self.attach().await {
            self.fail(error).await;
            return;
        }
        let begin = self
            .native(
                "begin",
                json!({
                    "title": song.title.as_deref().unwrap_or(&song.name),
                    "artist": song.artist,
                    "duration": self.snapshot.duration,
                    "autoplay": self.wants_play,
                    "controls": self.controls(),
                }),
            )
            .await;
        if let Err(error) = begin {
            self.fail(error).await;
            return;
        }
        self.file = None;
        self.artwork = None;
        let Some(app) = self.app.clone() else { return };
        let network = song.source == Source::Network;
        if (network || song.has_cover) && self.stage.is_none() {
            match media::staging(&app) {
                Ok(stage) => self.stage = Some(stage),
                Err(error) if network => {
                    self.fail(error).await;
                    return;
                }
                Err(_) => self.warn("封面加载失败"),
            }
        }
        let directory = self.stage.as_ref().map(|stage| stage.path().to_owned());
        let network_media = if network {
            match (&self.client, &directory) {
                (Ok(client), Some(directory)) => {
                    Some((client.clone(), directory.clone(), self.connection.clone()))
                }
                (Err(error), _) => {
                    self.fail(error.clone()).await;
                    return;
                }
                _ => {
                    self.fail("无法创建播放临时目录".into()).await;
                    return;
                }
            }
        } else {
            None
        };
        let generation = self.snapshot.generation;
        if let Some(directory) = directory.filter(|_| song.has_cover) {
            let (app, client, song, connection, sender) = (
                app.clone(),
                network_media.as_ref().map(|(client, _, _)| client.clone()),
                song.clone(),
                self.connection.clone(),
                self.sender.clone(),
            );
            let task = tauri::async_runtime::spawn(async move {
                let result = media::artwork(app, client, directory, song, connection).await;
                let _ = sender.send(Message::Artwork(generation, result));
            });
            self.jobs.push(task.inner().abort_handle());
        }
        let sender = self.sender.clone();
        let task = tauri::async_runtime::spawn(async move {
            let result = match network_media {
                Some((client, directory, connection)) => {
                    media::prepare_network(app, client, directory, song, connection).await
                }
                None => media::prepare_local(app, song).await,
            };
            let _ = sender.send(Message::Prepared(generation, result));
        });
        self.jobs.push(task.inner().abort_handle());
    }

    async fn prepared(&mut self, prepared: Result<media::Prepared, String>) {
        let media::Prepared {
            file,
            lyrics,
            warning,
            cache,
        } = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.fail(error).await;
                return;
            }
        };
        let path = json!(file.path());
        self.file = Some(file);
        let result = self
            .native(
                "load",
                json!({
                    "path": path,
                    "autoplay": self.wants_play,
                    "volume": self.volume,
                    "position": self.snapshot.current_time,
                }),
            )
            .await;
        if let Err(error) = result {
            self.fail(error).await;
            return;
        }
        self.snapshot.current_lrc.clone_from(&lyrics);
        if let Some(warning) = warning {
            self.warn(&warning);
        } else {
            self.publish();
        }
        self.cache_publication = cache.map(|(key, bytes)| CachePublication { key, bytes, lyrics });
    }

    fn publish_cache(&mut self) {
        let Some(CachePublication { key, bytes, lyrics }) = self.cache_publication.take() else {
            return;
        };
        let Some(app) = self.app.clone() else { return };
        let (sender, active, generation) = (
            self.sender.clone(),
            self.active.clone(),
            self.snapshot.generation,
        );
        tauri::async_runtime::spawn_blocking(move || {
            if crate::network_cache::publish_playback(&app, key, bytes, lyrics, &active).is_err() {
                let _ = sender.send(Message::CacheFailed(generation));
            }
        });
    }

    async fn step(&mut self, step: Step) {
        let current = self.snapshot.current_audio_info.as_ref();
        let Some(key) = self
            .queue
            .select(self.mode, step, current.map(Song::key).as_deref())
        else {
            return;
        };
        if let Some(song) = self
            .snapshot
            .audio_list
            .iter()
            .find(|song| song.key() == key)
            .or_else(|| current.filter(|song| song.key() == key))
            .cloned()
        {
            self.start(song).await;
        }
    }

    async fn play_pause(&mut self, play: bool) {
        let Some(song) = self.snapshot.current_audio_info.clone() else {
            return;
        };
        if play
            && (self.snapshot.error.is_some()
                || self.snapshot.state == PlayState::Ended
                || (self.file.is_none() && !self.snapshot.is_loading))
        {
            let position = if self.snapshot.state == PlayState::Ended {
                0.0
            } else {
                self.snapshot.current_time
            };
            self.load(song, position, true).await;
            return;
        }
        self.wants_play = play;
        if self.attached {
            if let Err(error) = self
                .native(if play { "resume" } else { "pause" }, Value::Null)
                .await
            {
                self.fail(error).await;
                return;
            }
        }
        if !play {
            self.snapshot.state = PlayState::Paused;
            self.publish();
        }
    }

    async fn update_folder(&mut self, folder: i64, source: Source, audios: Vec<Song>) {
        let Some(queue_changed) = self.snapshot.refresh_folder(folder, source, audios) else {
            return;
        };
        if queue_changed {
            self.reset_queue();
        }
        if let Some(current) = &self.snapshot.current_audio_info {
            if let Some(song) = self
                .snapshot
                .audio_list
                .iter()
                .find(|song| song.key() == current.key())
                .cloned()
            {
                if !song.same_media(current) {
                    self.active.store(false, Ordering::Release);
                    if self.file.is_none() && self.snapshot.is_loading {
                        self.load(song, 0.0, self.wants_play).await;
                        return;
                    }
                }
                self.snapshot.current_audio_info = Some(song);
            }
        }
        if self.attached {
            let _ = self.native("controls", self.controls()).await;
            if let Some(song) = &self.snapshot.current_audio_info {
                let _ = self
                    .native(
                        "metadata",
                        json!({
                            "title": song.title.as_deref().unwrap_or(&song.name),
                            "artist": song.artist,
                        }),
                    )
                    .await;
            }
        }
        self.publish();
    }

    async fn remove_folder(&mut self, folder: i64, source: Source) {
        let removed = self.snapshot.remove_folder(folder, source);
        if removed {
            let retained = std::mem::take(&mut self.snapshot.audio_list);
            self.stop().await;
            self.snapshot.audio_list = retained;
        }
        self.reset_queue();
        if self.attached && !removed {
            let _ = self.native("controls", self.controls()).await;
        }
        self.publish();
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Play { audio, playlist } => {
                if let Some(playlist) = playlist {
                    self.snapshot.audio_list = playlist.audio_list;
                    self.snapshot.playlist_folder_id = playlist.playlist_folder_id;
                } else if self.snapshot.audio_list.is_empty() {
                    self.snapshot.audio_list.push(*audio.clone());
                }
                self.snapshot.current_audio_info = Some(*audio.clone());
                self.reset_queue();
                self.start(*audio).await;
            }
            Command::UpdateFolder {
                folder_id,
                source,
                audios,
            } => self.update_folder(folder_id, source, audios).await,
            Command::RemoveFolder { folder_id, source } => {
                self.remove_folder(folder_id, source).await
            }
            Command::Connection { server_url, token } => {
                let connection = Connection { server_url, token };
                if self.connection != connection {
                    self.cover_connection.send_replace(connection.clone());
                    self.connection = connection;
                    if self.snapshot.disconnect_network() {
                        self.stop().await;
                    } else {
                        self.reset_queue();
                        self.publish();
                    }
                }
            }
            Command::Mode { mode } => {
                if mode != self.mode {
                    self.mode = mode;
                    self.reset_queue();
                    if self.attached {
                        let _ = self.native("controls", self.controls()).await;
                    }
                }
            }
            Command::Volume { value } => {
                self.volume = value.clamp(0.0, 1.0);
                if self.file.is_some() {
                    let _ = self.native("volume", json!(self.volume)).await;
                }
            }
            Command::Seek { value } => {
                if self.file.is_some() {
                    let _ = self.native("seek", json!(value.max(0.0))).await;
                }
            }
            Command::Pause => self.play_pause(false).await,
            Command::Resume => self.play_pause(true).await,
            Command::Toggle => {
                let playing = self.snapshot.state == PlayState::Playing
                    || (self.snapshot.is_loading && self.wants_play);
                self.play_pause(!playing).await;
            }
            Command::Previous => self.step(Step::Previous).await,
            Command::Next => self.step(Step::Next).await,
            Command::Stop => self.stop().await,
            Command::Snapshot => {}
        }
    }

    async fn event(&mut self, event: EngineEvent) {
        if matches!(event.kind, EngineEventKind::TaskRemoved) {
            self.stop().await;
            return;
        }
        if !self.snapshot.is_current(event.generation) {
            return;
        }
        match event.kind {
            EngineEventKind::Status {
                state,
                current_time,
                duration,
                buffering,
                ready,
            } => {
                if self.file.is_none() {
                    return;
                }
                if ready {
                    self.publish_cache();
                }
                let changed = self.snapshot.state != state || self.snapshot.is_loading != buffering;
                self.snapshot.state = state;
                self.snapshot.is_loading = buffering;
                self.snapshot.current_time = current_time;
                self.snapshot.duration = duration.or(self.snapshot.duration);
                if changed {
                    self.publish();
                } else {
                    self.snapshot.revision += 1;
                    if let Some(app) = &self.app {
                        let _ = app.emit(
                            "native-playback-progress",
                            json!({
                                "revision": self.snapshot.revision,
                                "generation": self.snapshot.generation,
                                "currentTime": current_time,
                                "duration": self.snapshot.duration,
                            }),
                        );
                    }
                }
            }
            EngineEventKind::Ended => {
                self.snapshot.state = PlayState::Ended;
                self.wants_play = false;
                self.publish();
                self.step(Step::Ended).await;
            }
            EngineEventKind::Error => self.fail("音频播放失败，请重试".into()).await,
            EngineEventKind::ArtworkError => self.warn("封面加载失败"),
            EngineEventKind::Released => {
                self.cancel_load();
                self.file = None;
                self.artwork = None;
                self.wants_play = false;
                self.snapshot.state = PlayState::Paused;
                self.snapshot.is_loading = false;
                self.publish();
            }
            EngineEventKind::ResumeAfterInterruption if self.wants_play => {
                self.play_pause(true).await
            }
            EngineEventKind::ResumeAfterInterruption | EngineEventKind::TaskRemoved => {}
            EngineEventKind::Pause => self.play_pause(false).await,
            EngineEventKind::Resume => self.play_pause(true).await,
            EngineEventKind::Previous => self.step(Step::Previous).await,
            EngineEventKind::Next => self.step(Step::Next).await,
            EngineEventKind::Stop => self.stop().await,
            EngineEventKind::Seek { value } => self.command(Command::Seek { value }).await,
            EngineEventKind::Toggle => self.command(Command::Toggle).await,
        }
    }

    fn warn(&mut self, warning: &str) {
        let value = self.snapshot.warning.take();
        self.snapshot.warning = Some(match value {
            Some(value) if value.contains(warning) => value,
            Some(value) => format!("{value}，{warning}"),
            None => warning.to_owned(),
        });
        self.publish();
    }

    async fn run(mut self, mut receiver: mpsc::UnboundedReceiver<Message>) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            #[cfg(mobile)]
            let message = receiver.recv().await;
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            let message = tokio::select! {
                message = receiver.recv() => message,
                _ = tick.tick(), if self.file.is_some() && self.snapshot.error.is_none() && matches!(&self.engine, Engine::Desktop(_)) => {
                    if let Err(error) = self.native("tick", Value::Null).await {
                        self.fail(error).await;
                    }
                    continue;
                }
            };
            let Some(message) = message else { break };
            match message {
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                Message::Shutdown(reply) => {
                    self.stop().await;
                    let _ = reply.send(());
                    break;
                }
                Message::Command(command, reply) => {
                    let explicit_snapshot = matches!(command, Command::Snapshot);
                    let revision = self.snapshot.revision;
                    self.command(command).await;
                    let snapshot = (explicit_snapshot || revision != self.snapshot.revision)
                        .then(|| self.snapshot.clone());
                    let _ = reply.send(snapshot);
                }
                Message::Event(event) => self.event(event).await,
                Message::Prepared(generation, result) if self.snapshot.is_current(generation) => {
                    self.prepared(result).await
                }
                Message::Artwork(generation, result) if self.snapshot.is_current(generation) => {
                    match result {
                        Ok(file) => {
                            if self
                                .native("artwork", json!(file.to_path_buf()))
                                .await
                                .is_ok()
                            {
                                self.artwork = Some(file);
                            } else {
                                self.warn("封面加载失败");
                            }
                        }
                        Err(_) => self.warn("封面加载失败"),
                    }
                }
                Message::CacheFailed(generation) if self.snapshot.is_current(generation) => {
                    self.warn("本地缓存保存失败，本次仍可播放")
                }
                _ => {}
            }
        }
    }
}

struct Control {
    sender: mpsc::UnboundedSender<Message>,
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    exit: std::sync::atomic::AtomicU8,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn request_exit(app: &AppHandle) {
    let control = app.state::<Control>();
    if control
        .exit
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    super::desktop::close();
    let (reply, response) = oneshot::channel();
    let _ = control.sender.send(Message::Shutdown(reply));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), response).await;
        app.state::<Control>().exit.store(2, Ordering::Release);
        app.exit(0);
    });
}

struct CoverAccess {
    connection: watch::Receiver<Connection>,
    client: Result<reqwest::Client, String>,
}

#[tauri::command]
async fn load_cover(
    app: AppHandle,
    audio_id: i64,
    cover_link: String,
    server_url: String,
    token: String,
) -> Result<tauri::ipc::Response, String> {
    let access = app.state::<CoverAccess>();
    let mut settings = access.connection.clone();
    let expected = Connection { server_url, token };
    // A list may request its first cover while the frontend's connection update is in flight.
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        settings.wait_for(|settings| *settings == expected),
    )
    .await
    .map_err(|_| "服务端设置已变更，请刷新列表")?
    .map_err(|_| "原生播放会话已关闭")?;
    let client = access.client.as_ref().map_err(Clone::clone)?;
    let cache = app.state::<CoverCache>();
    tokio::select! {
        biased;
        _ = settings.changed() => Err("服务端设置已变更，请刷新列表".into()),
        bytes = cache.load(media::cover_directory(&app), client, &expected, audio_id, &cover_link) => {
            bytes.map(tauri::ipc::Response::new)
        }
    }
}

#[tauri::command]
async fn control(app: AppHandle, command: Command) -> Result<Option<Snapshot>, String> {
    let (reply, response) = oneshot::channel();
    let failed = |_| "原生播放会话已关闭".to_owned();
    app.state::<Control>()
        .sender
        .send(Message::Command(command, reply))
        .map_err(failed)?;
    response.await.map_err(|_| "原生播放会话已关闭".to_owned())
}

pub(crate) fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let builder = tauri::plugin::Builder::new("native-playback");
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let builder = builder.on_event(|app, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => {
            api.prevent_close();
            request_exit(app);
        }
        tauri::RunEvent::ExitRequested { api, .. }
            if app.state::<Control>().exit.load(Ordering::Acquire) != 2 =>
        {
            api.prevent_exit();
            request_exit(app);
        }
        tauri::RunEvent::Exit => super::desktop::close(),
        _ => {}
    });
    builder
        .setup(|app, _api| {
            #[cfg(target_os = "android")]
            let engine = Engine::Mobile(_api.register_android_plugin(
                "ying.audio.player.androidfiles",
                "MobilePlaybackPlugin",
            )?);
            #[cfg(target_os = "ios")]
            let engine = Engine::Mobile(tauri_plugin_ios_files::register_playback(&_api)?);
            let (sender, receiver) = mpsc::unbounded_channel();
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            let engine = Engine::Desktop(super::desktop::Engine::new(app.clone(), {
                let sender = sender.clone();
                move |generation, kind| {
                    let _ = sender.send(Message::Event(EngineEvent { generation, kind }));
                }
            }));
            app.manage(Control {
                sender: sender.clone(),
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                exit: Default::default(),
            });
            app.manage(CoverCache::default());
            let (cover_connection, connection) = watch::channel(Connection::default());
            let client = http::client();
            app.manage(CoverAccess {
                connection,
                client: client.clone(),
            });
            let session = Session::new(Some(app.clone()), engine, sender, cover_connection, client);
            tauri::async_runtime::spawn(session.run(receiver));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![#![plugin(native_playback)] control, load_cover])
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(id: i64) -> Song {
        serde_json::from_value(json!({
            "id": id, "folderId": 1, "name": format!("song {id}"),
            "link": "", "lrcLink": "", "hasLyrics": false, "hasCover": false
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn system_controls_share_the_queue_and_cannot_change_a_newer_song() {
        let (events, mut commands) = mpsc::unbounded_channel();
        let (sender, _inbox) = mpsc::unbounded_channel();
        let (settings, _) = watch::channel(Connection::default());
        let mut session =
            Session::new(None, Engine::Test(events), sender, settings, http::client());
        session
            .command(Command::Play {
                audio: Box::new(song(1)),
                playlist: Some(Playlist {
                    audio_list: vec![song(1), song(2), song(3)],
                    playlist_folder_id: Some(1),
                }),
            })
            .await;
        let (_, first, _) = commands.try_recv().unwrap();
        session
            .event(EngineEvent {
                generation: first,
                kind: EngineEventKind::Next,
            })
            .await;
        let (kind, second, _) = commands.try_recv().unwrap();
        assert_eq!(kind, "begin");
        assert_eq!(session.snapshot.current_audio_info.as_ref().unwrap().id, 2);
        session
            .event(EngineEvent {
                generation: first,
                kind: EngineEventKind::Error,
            })
            .await;
        session
            .event(EngineEvent {
                generation: first,
                kind: EngineEventKind::Ended,
            })
            .await;
        assert!(session.snapshot.error.is_none());
        assert!(commands.try_recv().is_err());

        let path = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let saved_path = path.to_path_buf();
        session
            .prepared(Ok(media::Prepared {
                file: media::File::Staged(path),
                lyrics: None,
                warning: None,
                cache: None,
            }))
            .await;
        assert_eq!(commands.try_recv().unwrap().0, "load");
        session
            .event(EngineEvent {
                generation: second,
                kind: EngineEventKind::Seek { value: 1.25 },
            })
            .await;
        assert_eq!(
            commands.try_recv().unwrap(),
            ("seek".into(), second, json!(1.25))
        );
        assert!(saved_path.exists());
        session.command(Command::Next).await;
        assert_eq!(session.snapshot.current_audio_info.as_ref().unwrap().id, 3);
        assert!(!saved_path.exists());
    }
}
