use super::{valid_duration, Controls, Emit, Load, Metadata, Result};
use crate::native_playback::{model::PlayState, session::EngineEventKind as Event};
use std::{
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use windows::{
    core::{h, IInspectable, Interface, HSTRING, PCWSTR},
    Foundation::{TimeSpan, TypedEventHandler},
    Media::{
        Core::MediaSource,
        Devices::{AudioDeviceRole, MediaDevice},
        MediaPlaybackStatus, MediaPlaybackType,
        Playback::{
            MediaPlaybackState, MediaPlayer, MediaPlayerAudioCategory, MediaPlayerFailedEventArgs,
        },
        PlaybackPositionChangeRequestedEventArgs, SystemMediaTransportControls,
        SystemMediaTransportControlsButton as Button,
        SystemMediaTransportControlsButtonPressedEventArgs,
        SystemMediaTransportControlsTimelineProperties,
    },
    Storage::Streams::{IRandomAccessStream, RandomAccessStreamReference},
    Win32::{
        Media::{
            Audio::{
                eMultimedia, eRender, IDeviceTopology, IMMDevice, IMMDeviceEnumerator, IPart,
                MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
            },
            KernelStreaming::{
                IKsJackDescription, IKsJackDescription2, JACKDESC2_PRESENCE_DETECT_CAPABILITY,
                KSJACK_DESCRIPTION,
            },
        },
        System::{
            Com::{CoCreateInstance, CLSCTX_INPROC_SERVER},
            WinRT::{
                CreateRandomAccessStreamOnFile, RoInitialize, RoUninitialize,
                RO_INIT_SINGLETHREADED,
            },
        },
    },
};

const TICKS_PER_SECOND: f64 = 10_000_000.0;

fn seconds(time: TimeSpan) -> f64 {
    time.Duration as f64 / TICKS_PER_SECOND
}

fn ticks(seconds: f64) -> TimeSpan {
    TimeSpan {
        Duration: (seconds.max(0.0) * TICKS_PER_SECOND).round() as i64,
    }
}

fn native<T>(result: windows::core::Result<T>) -> Result<T> {
    result.map_err(|_| "无法控制 Windows 原生播放器".into())
}

fn file_stream(path: &Path) -> Result<IRandomAccessStream> {
    let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // Read-only access mode is zero. Use a Win32 stream so the portable build can read
    // local files directly without requiring package identity or a picker.
    native(unsafe { CreateRandomAccessStreamOnFile(PCWSTR(path.as_ptr()), 0) })
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub(super) struct Player {
    player: MediaPlayer,
    controls: SystemMediaTransportControls,
    buttons: Option<i64>,
    seek_requests: Option<i64>,
    opened_token: Option<i64>,
    ended_token: Option<i64>,
    failed_token: Option<i64>,
    opened: Arc<AtomicBool>,
    source: Option<(MediaSource, IRandomAccessStream)>,
    cover: Option<IRandomAccessStream>,
    emit: Emit,
    duration: Option<f64>,
    last_status: Option<(PlayState, f64, Option<f64>, bool, bool)>,
    pending_seek: Option<f64>,
    wants_play: bool,
    output: Option<Output>,
    _apartment: Apartment,
}

impl Player {
    pub(super) fn new(metadata: Metadata, emit: Emit) -> Result<Self> {
        native(unsafe { RoInitialize(RO_INIT_SINGLETHREADED) })?;
        let apartment = Apartment;
        let player = native(MediaPlayer::new())?;
        let controls = native(player.SystemMediaTransportControls())?;
        let mut player = Self {
            player,
            controls,
            buttons: None,
            seek_requests: None,
            opened_token: None,
            ended_token: None,
            failed_token: None,
            opened: Arc::new(AtomicBool::new(false)),
            source: None,
            cover: None,
            emit,
            duration: metadata.duration.and_then(valid_duration),
            last_status: None,
            pending_seek: None,
            wants_play: false,
            output: None,
            _apartment: apartment,
        };
        player.attach()?;
        player.metadata(metadata)?;
        Ok(player)
    }

    fn attach(&mut self) -> Result<()> {
        native(
            self.player
                .CommandManager()
                .and_then(|manager| manager.SetIsEnabled(false)),
        )?;
        native(
            self.player
                .SetAudioCategory(MediaPlayerAudioCategory::Media),
        )?;
        native(self.player.SetAutoPlay(false))?;
        let emit = self.emit.clone();
        self.buttons = Some(native(self.controls.ButtonPressed(&TypedEventHandler::<
            SystemMediaTransportControls,
            SystemMediaTransportControlsButtonPressedEventArgs,
        >::new(
            move |_, args| {
                if let Some(args) = args.as_ref() {
                    let event = match args.Button()? {
                        Button::Play => Event::Resume,
                        Button::Pause => Event::Pause,
                        Button::Previous => Event::Previous,
                        Button::Next => Event::Next,
                        Button::Stop => Event::Stop,
                        _ => return Ok(()),
                    };
                    emit(event);
                }
                Ok(())
            },
        )))?);
        let emit = self.emit.clone();
        self.seek_requests = Some(native(self.controls.PlaybackPositionChangeRequested(
            &TypedEventHandler::<
                SystemMediaTransportControls,
                PlaybackPositionChangeRequestedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    emit(Event::Seek {
                        value: seconds(args.RequestedPlaybackPosition()?),
                    });
                }
                Ok(())
            }),
        ))?);
        let opened = self.opened.clone();
        self.opened_token = Some(native(self.player.MediaOpened(&TypedEventHandler::<
            MediaPlayer,
            IInspectable,
        >::new(
            move |_, _| {
                opened.store(true, Ordering::Release);
                Ok(())
            },
        )))?);
        let emit = self.emit.clone();
        self.ended_token = Some(native(self.player.MediaEnded(&TypedEventHandler::<
            MediaPlayer,
            IInspectable,
        >::new(
            move |_, _| {
                emit(Event::Ended);
                Ok(())
            },
        )))?);
        let emit = self.emit.clone();
        self.failed_token = Some(native(self.player.MediaFailed(&TypedEventHandler::<
            MediaPlayer,
            MediaPlayerFailedEventArgs,
        >::new(
            move |_, _| {
                emit(Event::Error);
                Ok(())
            },
        )))?);
        native(self.controls.SetIsPlayEnabled(true))?;
        native(self.controls.SetIsPauseEnabled(true))?;
        native(self.controls.SetIsStopEnabled(true))?;
        native(self.controls.SetPlaybackStatus(MediaPlaybackStatus::Paused))?;
        native(self.controls.SetIsEnabled(true))
    }

    pub(super) fn load(&mut self, load: Load) -> Result<()> {
        let stream = file_stream(&load.path)?;
        let source = native(MediaSource::CreateFromStream(&stream, h!("audio/mpeg")))?;
        self.source = Some((source, stream));
        self.pending_seek = (load.position > 0.0).then_some(load.position);
        self.volume(load.volume)?;
        native(self.player.SetSource(&self.source.as_ref().unwrap().0))?;
        if load.autoplay {
            self.resume()?;
        }
        Ok(())
    }

    pub(super) fn pause(&mut self) -> Result<()> {
        self.wants_play = false;
        if self.source.is_some() {
            native(self.player.Pause())?;
        }
        native(self.controls.SetPlaybackStatus(MediaPlaybackStatus::Paused))
    }

    pub(super) fn resume(&mut self) -> Result<()> {
        self.wants_play = true;
        self.output = Some(Output::current());
        if self.source.is_some() && self.pending_seek.is_none() {
            native(self.player.Play())?;
        }
        Ok(())
    }

    pub(super) fn seek(&mut self, value: f64) -> Result<()> {
        if value.is_finite() {
            let value = value.clamp(0.0, self.duration.unwrap_or(f64::MAX));
            if self.opened.load(Ordering::Acquire) {
                native(
                    self.player
                        .PlaybackSession()
                        .and_then(|session| session.SetPosition(ticks(value))),
                )?;
                self.pending_seek = None;
            } else {
                self.pending_seek = Some(value);
            }
        }
        Ok(())
    }

    pub(super) fn volume(&self, value: f64) -> Result<()> {
        native(self.player.SetVolume(value))
    }

    pub(super) fn metadata(&self, metadata: Metadata) -> Result<()> {
        let updater = native(self.controls.DisplayUpdater())?;
        if let Ok(id) = crate::windows_identity::process_app_id() {
            let _ = updater.SetAppMediaId(&id);
        }
        native(updater.SetType(MediaPlaybackType::Music))?;
        let music = native(updater.MusicProperties())?;
        native(music.SetTitle(&HSTRING::from(metadata.title)))?;
        native(music.SetArtist(&HSTRING::from(metadata.artist.unwrap_or_default())))?;
        native(updater.Update())
    }

    pub(super) fn controls(&self, controls: Controls) -> Result<()> {
        native(self.controls.SetIsPreviousEnabled(controls.previous))?;
        native(self.controls.SetIsNextEnabled(controls.next))
    }

    pub(super) fn artwork(&mut self, path: PathBuf) -> Result<()> {
        let stream = file_stream(&path)?;
        let reference = native(RandomAccessStreamReference::CreateFromStream(&stream))?;
        let updater = native(self.controls.DisplayUpdater())?;
        native(updater.SetThumbnail(&reference))?;
        self.cover = Some(stream);
        if let Err(error) = native(updater.Update()) {
            let _ = updater.SetThumbnail(None::<&RandomAccessStreamReference>);
            if let Some(stream) = self.cover.take() {
                let _ = stream.Close();
            }
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn tick(&mut self) -> Result<()> {
        if self.source.is_none() {
            return Ok(());
        }
        if self.wants_play && self.output.as_ref().is_some_and(Output::disconnected) {
            let result = self.pause();
            (self.emit)(Event::Pause);
            result?;
        }
        let session = native(self.player.PlaybackSession())?;
        let ready = self.opened.load(Ordering::Acquire);
        self.duration = session
            .NaturalDuration()
            .ok()
            .and_then(|time| valid_duration(seconds(time)))
            .or(self.duration);
        if let Some(value) = self.pending_seek.filter(|_| ready) {
            self.seek(value)?;
            if self.wants_play {
                native(self.player.Play())?;
            }
        }
        let native_state = native(session.PlaybackState())?;
        let playing = native_state == MediaPlaybackState::Playing;
        let buffering = !ready
            || native_state == MediaPlaybackState::Buffering
            || native_state == MediaPlaybackState::Opening;
        let state = if playing {
            PlayState::Playing
        } else {
            PlayState::Paused
        };
        let position = session.Position().map(seconds).unwrap_or_default().max(0.0);
        let status = (state, position, self.duration, buffering, ready);
        if self.last_status != Some(status) {
            self.last_status = Some(status);
            (self.emit)(Event::Status {
                state,
                current_time: position,
                duration: self.duration,
                buffering,
                ready,
            });
            let _ = self.publish_status(
                playing,
                buffering,
                ready && session.CanSeek().unwrap_or(false),
                position,
            );
        }
        Ok(())
    }

    fn publish_status(
        &self,
        playing: bool,
        buffering: bool,
        seekable: bool,
        position: f64,
    ) -> windows::core::Result<()> {
        let state = if playing {
            MediaPlaybackStatus::Playing
        } else if buffering && self.wants_play {
            MediaPlaybackStatus::Changing
        } else {
            MediaPlaybackStatus::Paused
        };
        self.controls.SetPlaybackStatus(state)?;
        if let Some(duration) = self.duration {
            let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
            timeline.SetStartTime(ticks(0.0))?;
            timeline.SetMinSeekTime(ticks(0.0))?;
            timeline.SetEndTime(ticks(duration))?;
            timeline.SetMaxSeekTime(ticks(if seekable { duration } else { 0.0 }))?;
            timeline.SetPosition(ticks(position.min(duration)))?;
            self.controls.UpdateTimelineProperties(&timeline)?;
        }
        Ok(())
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        if let Some(token) = self.buttons.take() {
            let _ = self.controls.RemoveButtonPressed(token);
        }
        if let Some(token) = self.seek_requests.take() {
            let _ = self.controls.RemovePlaybackPositionChangeRequested(token);
        }
        if let Some(token) = self.opened_token.take() {
            let _ = self.player.RemoveMediaOpened(token);
        }
        if let Some(token) = self.ended_token.take() {
            let _ = self.player.RemoveMediaEnded(token);
        }
        if let Some(token) = self.failed_token.take() {
            let _ = self.player.RemoveMediaFailed(token);
        }
        let _ = self.controls.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        let _ = self.controls.SetIsEnabled(false);
        if let Ok(updater) = self.controls.DisplayUpdater() {
            let _ = updater.ClearAll();
            let _ = updater.Update();
        }
        let _ = self.player.Close();
        if let Some((source, stream)) = self.source.take() {
            let _ = source.Close();
            let _ = stream.Close();
        }
        if let Some(stream) = self.cover.take() {
            let _ = stream.Close();
        }
    }
}

fn default_output_id() -> Option<HSTRING> {
    MediaDevice::GetDefaultAudioRenderId(AudioDeviceRole::Default)
        .ok()
        .filter(|id| !id.is_empty())
}

struct Output {
    id: Option<HSTRING>,
    endpoint: Option<IMMDevice>,
    jacks: Option<(IKsJackDescription, Vec<u32>)>,
}

impl Output {
    fn current() -> Self {
        // The WinRT player and the endpoint probes share the main COM apartment.
        let endpoint = unsafe {
            CoCreateInstance::<_, IMMDeviceEnumerator>(
                &MMDeviceEnumerator,
                None,
                CLSCTX_INPROC_SERVER,
            )
            .and_then(|devices| devices.GetDefaultAudioEndpoint(eRender, eMultimedia))
            .ok()
        };
        let jacks = endpoint.as_ref().and_then(connected_jacks);
        Self {
            id: default_output_id(),
            endpoint,
            jacks,
        }
    }

    fn disconnected(&self) -> bool {
        (self.id.is_some() && default_output_id() != self.id)
            || self.endpoint.as_ref().is_some_and(|endpoint| unsafe {
                endpoint
                    .GetState()
                    .is_ok_and(|state| state != DEVICE_STATE_ACTIVE)
            })
            || self.jacks.as_ref().is_some_and(|(jacks, connected)| {
                connected
                    .iter()
                    .any(|&index| jack_connected(jacks, index) == Some(false))
            })
    }
}

fn connected_jacks(endpoint: &IMMDevice) -> Option<(IKsJackDescription, Vec<u32>)> {
    unsafe {
        let topology: IDeviceTopology = endpoint.Activate(CLSCTX_INPROC_SERVER, None).ok()?;
        let part: IPart = topology
            .GetConnector(0)
            .ok()?
            .GetConnectedTo()
            .ok()?
            .cast()
            .ok()?;
        let jacks: IKsJackDescription = activate_jack_interface(&part)?;
        let capabilities: IKsJackDescription2 = activate_jack_interface(&part)?;
        let connected = (0..jacks.GetJackCount().ok()?)
            .filter(|&index| {
                capabilities
                    .GetJackDescription2(index)
                    .is_ok_and(|description| {
                        description.JackCapabilities & JACKDESC2_PRESENCE_DETECT_CAPABILITY != 0
                    })
                    && jack_connected(&jacks, index) == Some(true)
            })
            .collect();
        Some((jacks, connected))
    }
}

fn activate_jack_interface<T: Interface>(part: &IPart) -> Option<T> {
    let mut interface = std::ptr::null_mut();
    // IPart::Activate transfers a reference of the requested interface on success.
    unsafe {
        part.Activate(CLSCTX_INPROC_SERVER.0 as u32, &T::IID, Some(&mut interface))
            .ok()?;
        (!interface.is_null()).then(|| T::from_raw(interface))
    }
}

fn jack_connected(jacks: &IKsJackDescription, index: u32) -> Option<bool> {
    let mut description = KSJACK_DESCRIPTION::default();
    unsafe { jacks.GetJackDescription(index, &mut description) }.ok()?;
    Some(description.IsConnected.as_bool())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_seek_uses_hundred_nanosecond_ticks() {
        assert_eq!(ticks(1.25).Duration, 12_500_000);
        assert_eq!(
            seconds(TimeSpan {
                Duration: 21_000_000
            }),
            2.1
        );
    }
}
