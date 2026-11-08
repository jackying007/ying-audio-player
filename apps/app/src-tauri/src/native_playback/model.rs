use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Source {
    #[default]
    Local,
    Network,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Song {
    pub(super) id: i64,
    pub(super) folder_id: i64,
    #[serde(default)]
    pub(super) source: Source,
    pub(super) link: String,
    pub(super) lrc_link: String,
    pub(super) cover_link: Option<String>,
    pub(super) filename: Option<String>,
    pub(super) folder_name: Option<String>,
    pub(super) hash: Option<String>,
    pub(super) lyrics_hash: Option<String>,
    pub(super) has_lyrics: bool,
    pub(super) has_cover: bool,
    pub(super) name: String,
    pub(super) title: Option<String>,
    pub(super) artist: Option<String>,
    pub(super) duration_ms: Option<f64>,
    #[serde(flatten)]
    pub(super) other: serde_json::Map<String, Value>,
}

impl Song {
    pub(super) fn key(&self) -> String {
        let source = if self.source == Source::Network {
            "network"
        } else {
            "local"
        };
        format!("{source}:{}:{}", self.folder_id, self.id)
    }

    pub(super) fn in_folder(&self, folder: i64, source: Source) -> bool {
        self.folder_id == folder && self.source == source
    }

    pub(super) fn same_media(&self, other: &Self) -> bool {
        self.link == other.link
            && self.lrc_link == other.lrc_link
            && self.cover_link == other.cover_link
    }
}

#[derive(Clone, Default, PartialEq)]
pub(super) struct Connection {
    pub(super) server_url: String,
    pub(super) token: String,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum PlayState {
    #[default]
    None,
    Playing,
    Paused,
    Ended,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Snapshot {
    pub(super) revision: u64,
    pub(super) generation: u64,
    pub(super) current_audio_info: Option<Song>,
    pub(super) audio_list: Vec<Song>,
    pub(super) playlist_folder_id: Option<i64>,
    pub(super) state: PlayState,
    pub(super) is_loading: bool,
    pub(super) current_time: f64,
    pub(super) duration: Option<f64>,
    pub(super) current_lrc: Option<String>,
    pub(super) error: Option<String>,
    pub(super) warning: Option<String>,
}

impl Snapshot {
    pub(super) fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub(super) fn refresh_folder(
        &mut self,
        folder: i64,
        source: Source,
        audios: Vec<Song>,
    ) -> Option<bool> {
        let index = self
            .audio_list
            .iter()
            .position(|song| song.in_folder(folder, source))
            .or_else(|| {
                (self.playlist_folder_id == Some(folder)
                    && self
                        .current_audio_info
                        .as_ref()
                        .is_some_and(|song| song.source == source))
                .then_some(0)
            })?;
        let old: Vec<_> = self.audio_list.iter().map(Song::key).collect();
        self.audio_list
            .retain(|song| !song.in_folder(folder, source));
        let index = index.min(self.audio_list.len());
        self.audio_list.splice(
            index..index,
            audios
                .into_iter()
                .filter(|song| song.in_folder(folder, source)),
        );
        Some(!self.audio_list.iter().map(Song::key).eq(old))
    }

    pub(super) fn disconnect_network(&mut self) -> bool {
        self.audio_list
            .retain(|song| song.source != Source::Network);
        self.current_audio_info
            .as_ref()
            .is_some_and(|song| song.source == Source::Network)
    }

    pub(super) fn remove_folder(&mut self, folder: i64, source: Source) -> bool {
        self.audio_list
            .retain(|song| !song.in_folder(folder, source));
        self.current_audio_info
            .as_ref()
            .is_some_and(|song| song.in_folder(folder, source))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn song(source: &str, hash: &str) -> Song {
        serde_json::from_value(serde_json::json!({
            "id": 3, "folderId": 4, "source": source,
            "link": format!("file?hash={hash}"), "lrcLink": "",
            "name": "Song", "hasLyrics": false, "hasCover": false, "hash": hash
        }))
        .unwrap()
    }

    #[test]
    fn cloud_overwrite_updates_queue_version_without_resetting_the_order() {
        let original = song("network", "before");
        let mut snapshot = Snapshot {
            generation: 9,
            audio_list: vec![original.clone(), song("local", "")],
            current_audio_info: Some(original.clone()),
            ..Snapshot::default()
        };
        assert_eq!(
            snapshot.refresh_folder(4, Source::Network, vec![song("network", "after")]),
            Some(false)
        );
        assert!(!snapshot.audio_list[0].same_media(&original));
        assert_eq!(snapshot.audio_list[0].hash.as_deref(), Some("after"));
        assert_eq!(snapshot.audio_list[1].link, "file?hash=");
        assert!(snapshot.is_current(9));
        assert!(!snapshot.is_current(8));
    }

    #[test]
    fn changing_connections_discards_network_songs_but_keeps_local_playback() {
        let local = song("local", "");
        let remote = song("network", "old");
        let mut snapshot = Snapshot {
            audio_list: vec![remote.clone(), local.clone()],
            current_audio_info: Some(local),
            ..Snapshot::default()
        };
        assert!(!snapshot.disconnect_network());
        assert_eq!(snapshot.audio_list.len(), 1);
        snapshot.current_audio_info = Some(remote);
        assert!(snapshot.disconnect_network());
    }

    #[test]
    fn removing_a_folder_only_stops_playback_from_that_source() {
        let local = song("local", "");
        let mut snapshot = Snapshot {
            audio_list: vec![song("network", "old"), local.clone()],
            current_audio_info: Some(local),
            ..Snapshot::default()
        };
        assert!(!snapshot.remove_folder(4, Source::Network));
        assert_eq!(snapshot.audio_list.len(), 1);
        assert!(snapshot.remove_folder(4, Source::Local));
        assert!(snapshot.audio_list.is_empty());
    }
}
