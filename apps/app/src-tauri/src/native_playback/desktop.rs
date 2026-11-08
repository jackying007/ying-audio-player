use super::session::EngineEventKind;
use serde::Deserialize;
use serde_json::Value;
use std::{cell::RefCell, path::PathBuf, sync::Arc};
use tauri::AppHandle;
use tokio::sync::oneshot;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::Player;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows::Player;

type Result<T> = std::result::Result<T, String>;
type Emit = Arc<dyn Fn(EngineEventKind) + Send + Sync>;

#[derive(Deserialize)]
struct Metadata {
    title: String,
    artist: Option<String>,
    duration: Option<f64>,
}

#[derive(Deserialize)]
struct Begin {
    #[serde(flatten)]
    metadata: Metadata,
    controls: Controls,
}

#[derive(Deserialize)]
struct Controls {
    previous: bool,
    next: bool,
}

#[derive(Deserialize)]
struct Load {
    path: PathBuf,
    autoplay: bool,
    volume: f64,
    position: f64,
}

// Only the main thread accesses OS media objects. Callbacks enqueue Rust events
// and never take this borrow or call into the WebView.
#[derive(Default)]
struct Slot {
    closed: bool,
    player: Option<(u64, Player)>,
}

thread_local! {
    static SLOT: RefCell<Slot> = RefCell::default();
}

pub(super) fn close() {
    SLOT.with_borrow_mut(|slot| {
        slot.closed = true;
        slot.player = None;
    });
}

#[derive(Clone)]
pub(super) struct Engine {
    app: AppHandle,
    events: Arc<dyn Fn(u64, EngineEventKind) + Send + Sync>,
}

fn decode<T: serde::de::DeserializeOwned>(payload: Value) -> Result<T> {
    serde_json::from_value(payload).map_err(|_| "无效的播放器命令".into())
}

impl Engine {
    pub(super) fn new(
        app: AppHandle,
        events: impl Fn(u64, EngineEventKind) + Send + Sync + 'static,
    ) -> Self {
        Self {
            app,
            events: Arc::new(events),
        }
    }

    pub(super) async fn command(&self, kind: &str, generation: u64, payload: Value) -> Result<()> {
        let kind = kind.to_owned();
        let events = self.events.clone();
        let (reply, response) = oneshot::channel();
        self.app
            .run_on_main_thread(move || {
                let result = SLOT.with_borrow_mut(|slot| {
                    match kind.as_str() {
                        "stop" | "fail" => {
                            slot.player = None;
                            return Ok(());
                        }
                        _ if slot.closed => return Err("原生播放会话已关闭".into()),
                        "begin" => {
                            let begin: Begin = decode(payload)?;
                            slot.player = None;
                            let emit: Emit = Arc::new(move |kind| events(generation, kind));
                            let player = Player::new(begin.metadata, emit)?;
                            player.controls(begin.controls)?;
                            slot.player = Some((generation, player));
                            return Ok(());
                        }
                        _ => {}
                    }
                    let Some((current, player)) = &mut slot.player else {
                        return Ok(());
                    };
                    if *current != generation {
                        return Ok(());
                    }
                    match kind.as_str() {
                        "load" => player.load(decode(payload)?),
                        "pause" => player.pause(),
                        "resume" => player.resume(),
                        "seek" => player.seek(decode(payload)?),
                        "volume" => player.volume(decode(payload)?),
                        "controls" => player.controls(decode(payload)?),
                        "metadata" => player.metadata(decode(payload)?),
                        "artwork" => player.artwork(decode(payload)?),
                        "tick" => player.tick(),
                        _ => Err("不支持的播放器命令".into()),
                    }
                });
                let _ = reply.send(result);
            })
            .map_err(|_| "无法连接原生播放器")?;
        response.await.map_err(|_| "原生播放器已关闭")?
    }
}

fn valid_duration(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}

#[cfg(test)]
mod tests {
    #[test]
    fn unknown_native_durations_are_not_sent_to_the_ui() {
        for value in [0.0, -1.0, f64::INFINITY, f64::NAN] {
            assert_eq!(super::valid_duration(value), None);
        }
        assert_eq!(super::valid_duration(60.0), Some(60.0));
    }
}
