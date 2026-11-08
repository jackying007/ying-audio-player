use super::{valid_duration, Controls, Emit, Load, Metadata, Result};
use crate::native_playback::{model::PlayState, session::EngineEventKind as Event};
use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol, ProtocolObject},
    AllocAnyThread, MainThreadMarker,
};
use objc2_app_kit::NSImage;
use objc2_av_foundation::{
    AVPlayer, AVPlayerItem, AVPlayerItemDidPlayToEndTimeNotification,
    AVPlayerItemFailedToPlayToEndTimeNotification, AVPlayerItemStatus, AVPlayerTimeControlStatus,
};
use objc2_core_media::CMTime;
use objc2_foundation::{
    NSData, NSMutableDictionary, NSNotificationCenter, NSNumber, NSSize, NSString, NSURL,
};
use objc2_media_player::*;
use std::path::PathBuf;

pub(super) struct Player {
    player: Retained<AVPlayer>,
    item: Option<Retained<AVPlayerItem>>,
    emit: Emit,
    commands: Vec<(Retained<MPRemoteCommand>, Retained<AnyObject>)>,
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    metadata: Metadata,
    cover: Option<Retained<MPMediaItemArtwork>>,
    position: f64,
    duration: Option<f64>,
    state: MPNowPlayingPlaybackState,
    last_status: Option<(PlayState, f64, Option<f64>, bool, bool)>,
    output: Option<Output>,
    wants_play: bool,
    pending_seek: Option<f64>,
}

impl Player {
    pub(super) fn new(metadata: Metadata, emit: Emit) -> Result<Self> {
        let mtm = MainThreadMarker::new().ok_or("播放器必须在主线程初始化")?;
        // This adapter is created, used and destroyed on the Tauri main thread.
        // The OS handlers capture only the Rust event sender.
        unsafe {
            let center = MPRemoteCommandCenter::sharedCommandCenter();
            let commands = [
                (center.playCommand(), Event::Resume),
                (center.pauseCommand(), Event::Pause),
                (center.togglePlayPauseCommand(), Event::Toggle),
                (center.stopCommand(), Event::Stop),
                (center.previousTrackCommand(), Event::Previous),
                (center.nextTrackCommand(), Event::Next),
            ];
            let mut targets: Vec<_> = commands
                .into_iter()
                .map(|(command, event)| {
                    let emit = emit.clone();
                    let block = RcBlock::new(move |_: std::ptr::NonNull<MPRemoteCommandEvent>| {
                        emit(event);
                        MPRemoteCommandHandlerStatus::Success
                    });
                    command.setEnabled(true);
                    let target = command.addTargetWithHandler(&block);
                    (command, target)
                })
                .collect();
            let seek = center.changePlaybackPositionCommand();
            seek.setEnabled(false);
            let send_seek = emit.clone();
            let block = RcBlock::new(move |event: std::ptr::NonNull<MPRemoteCommandEvent>| {
                if let Some(event) = event
                    .as_ref()
                    .downcast_ref::<MPChangePlaybackPositionCommandEvent>()
                {
                    send_seek(Event::Seek {
                        value: event.positionTime(),
                    });
                    MPRemoteCommandHandlerStatus::Success
                } else {
                    MPRemoteCommandHandlerStatus::CommandFailed
                }
            });
            let target = seek.addTargetWithHandler(&block);
            targets.push((Retained::into_super(seek), target));

            let player = Self {
                player: AVPlayer::new(mtm),
                item: None,
                emit,
                commands: targets,
                observers: Vec::new(),
                duration: metadata.duration.and_then(valid_duration),
                metadata,
                cover: None,
                position: 0.0,
                state: MPNowPlayingPlaybackState::Paused,
                last_status: None,
                output: None,
                wants_play: false,
                pending_seek: None,
            };
            player.publish();
            Ok(player)
        }
    }

    pub(super) fn load(&mut self, load: Load) -> Result<()> {
        let mtm = MainThreadMarker::new().ok_or("播放器必须在主线程加载")?;
        let path = load.path.to_str().ok_or("歌曲路径无效")?;
        unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let item = AVPlayerItem::playerItemWithURL(&url, mtm);
            let center = NSNotificationCenter::defaultCenter();
            for (name, event) in [
                (AVPlayerItemDidPlayToEndTimeNotification, Event::Ended),
                (AVPlayerItemFailedToPlayToEndTimeNotification, Event::Error),
            ] {
                let emit = self.emit.clone();
                let block = RcBlock::new(move |_| emit(event));
                let observer = center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    Some(&item),
                    None,
                    &block,
                );
                self.observers.push(observer);
            }
            self.player.replaceCurrentItemWithPlayerItem(Some(&item));
            self.item = Some(item);
        }
        self.volume(load.volume)?;
        self.position = load.position;
        self.pending_seek = (load.position > 0.0).then_some(load.position);
        if load.autoplay {
            self.resume()?;
        }
        Ok(())
    }

    pub(super) fn pause(&mut self) -> Result<()> {
        self.wants_play = false;
        unsafe { self.player.pause() };
        self.state = MPNowPlayingPlaybackState::Paused;
        self.publish();
        Ok(())
    }

    pub(super) fn resume(&mut self) -> Result<()> {
        self.wants_play = true;
        self.output = output();
        if self.pending_seek.is_none() {
            unsafe { self.player.play() };
        }
        Ok(())
    }

    pub(super) fn seek(&mut self, value: f64) -> Result<()> {
        if value.is_finite() {
            let value = value.clamp(0.0, self.duration.unwrap_or(f64::MAX));
            if self
                .item
                .as_ref()
                .is_some_and(|item| unsafe { item.status() == AVPlayerItemStatus::ReadyToPlay })
            {
                unsafe { self.player.seekToTime(CMTime::with_seconds(value, 1000)) };
                self.pending_seek = None;
            } else {
                self.pending_seek = Some(value);
            }
        }
        Ok(())
    }

    pub(super) fn volume(&self, value: f64) -> Result<()> {
        unsafe { self.player.setVolume(value as f32) };
        Ok(())
    }

    pub(super) fn metadata(&mut self, metadata: Metadata) -> Result<()> {
        self.metadata = metadata;
        self.publish();
        Ok(())
    }

    pub(super) fn controls(&self, controls: Controls) -> Result<()> {
        unsafe {
            let center = MPRemoteCommandCenter::sharedCommandCenter();
            center.previousTrackCommand().setEnabled(controls.previous);
            center.nextTrackCommand().setEnabled(controls.next);
        }
        Ok(())
    }

    pub(super) fn artwork(&mut self, path: PathBuf) -> Result<()> {
        let bytes = std::fs::read(path).map_err(|_| "无法读取歌曲封面")?;
        let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&bytes))
            .filter(|image| image.isValid())
            .ok_or("无法解码歌曲封面")?;
        let size = image.size();
        let block = RcBlock::new(move |_: NSSize| {
            let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(&bytes))
                .unwrap_or_else(|| NSImage::initWithSize(NSImage::alloc(), size));
            std::ptr::NonNull::from(unsafe { &*Retained::autorelease_return(image) })
        });
        self.cover = Some(unsafe {
            MPMediaItemArtwork::initWithBoundsSize_requestHandler(
                MPMediaItemArtwork::alloc(),
                size,
                &block,
            )
        });
        self.publish();
        Ok(())
    }

    pub(super) fn tick(&mut self) -> Result<()> {
        let Some(item) = &self.item else {
            return Ok(());
        };
        let (status, duration) =
            unsafe { (item.status(), valid_duration(item.duration().seconds())) };
        if status == AVPlayerItemStatus::Failed {
            (self.emit)(Event::Error);
            return Ok(());
        }
        let ready = status == AVPlayerItemStatus::ReadyToPlay;
        self.duration = duration.or(self.duration);
        if let Some(value) = self.pending_seek.filter(|_| ready) {
            self.seek(value)?;
            if self.wants_play {
                unsafe { self.player.play() };
            }
        }
        let current_output = output();
        if self.wants_play && self.output.is_some() && current_output != self.output {
            self.pause()?;
            (self.emit)(Event::Pause);
        }
        self.output = current_output;
        unsafe {
            let position = self.player.currentTime().seconds();
            if position.is_finite() {
                self.position = position.max(0.0);
            }
            let playing = self.player.timeControlStatus() == AVPlayerTimeControlStatus::Playing;
            let buffering = !ready
                || (self.wants_play
                    && self.player.timeControlStatus()
                        == AVPlayerTimeControlStatus::WaitingToPlayAtSpecifiedRate);
            let state = if playing {
                PlayState::Playing
            } else {
                PlayState::Paused
            };
            let status = (state, self.position, self.duration, buffering, ready);
            if self.last_status != Some(status) {
                self.last_status = Some(status);
                self.state = if playing {
                    MPNowPlayingPlaybackState::Playing
                } else {
                    MPNowPlayingPlaybackState::Paused
                };
                self.publish();
                MPRemoteCommandCenter::sharedCommandCenter()
                    .changePlaybackPositionCommand()
                    .setEnabled(ready && self.duration.is_some());
                (self.emit)(Event::Status {
                    state,
                    current_time: self.position,
                    duration: self.duration,
                    buffering,
                    ready,
                });
            }
        }
        Ok(())
    }

    fn publish(&self) {
        unsafe {
            let info = NSMutableDictionary::<NSString, AnyObject>::new();
            info.insert(
                MPMediaItemPropertyTitle,
                &NSString::from_str(&self.metadata.title),
            );
            if let Some(artist) = &self.metadata.artist {
                info.insert(MPMediaItemPropertyArtist, &NSString::from_str(artist));
            }
            if let Some(duration) = self.duration {
                info.insert(
                    MPMediaItemPropertyPlaybackDuration,
                    &NSNumber::new_f64(duration),
                );
            }
            if let Some(cover) = &self.cover {
                info.insert(MPMediaItemPropertyArtwork, cover);
            }
            let rate = f64::from(self.state == MPNowPlayingPlaybackState::Playing);
            info.insert(
                MPNowPlayingInfoPropertyPlaybackRate,
                &NSNumber::new_f64(rate),
            );
            info.insert(
                MPNowPlayingInfoPropertyElapsedPlaybackTime,
                &NSNumber::new_f64(self.position),
            );
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setNowPlayingInfo(Some(&info));
            center.setPlaybackState(self.state);
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            let center = NSNotificationCenter::defaultCenter();
            for observer in self.observers.drain(..) {
                center.removeObserver((&*observer).as_ref());
            }
            for (command, target) in self.commands.drain(..) {
                command.removeTarget(Some(&target));
                command.setEnabled(false);
            }
            self.player.pause();
            self.player.replaceCurrentItemWithPlayerItem(None);
            let center = MPNowPlayingInfoCenter::defaultCenter();
            center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
            center.setNowPlayingInfo(None);
        }
    }
}

#[derive(PartialEq, Eq)]
struct Output {
    device: u32,
    source: Option<u32>,
    jack: Option<u32>,
}

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const std::ffi::c_void,
        size: *mut u32,
        data: *mut u32,
    ) -> i32;
}

fn audio_property(object: u32, selector: [u8; 4], scope: [u8; 4]) -> Option<u32> {
    let address = PropertyAddress {
        selector: u32::from_be_bytes(selector),
        scope: u32::from_be_bytes(scope),
        element: 0,
    };
    let mut size = 4;
    let mut value = 0;
    // These selectors expose a single UInt32 or AudioDeviceID.
    let result = unsafe {
        AudioObjectGetPropertyData(object, &address, 0, std::ptr::null(), &mut size, &mut value)
    };
    (result == 0 && size == 4).then_some(value)
}

fn output() -> Option<Output> {
    let device = audio_property(1, *b"dOut", *b"glob").filter(|&id| id != 0)?;
    Some(Output {
        device,
        source: audio_property(device, *b"ssrc", *b"outp"),
        jack: audio_property(device, *b"jack", *b"outp"),
    })
}
