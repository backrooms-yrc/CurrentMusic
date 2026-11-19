package main

import "time"

func (a *validationApp) userPlaybackIntent(play bool) {
	if a.cloud != nil && a.cloud.rooms.liveID > 0 {
		action := "pause"
		if play {
			action = "play"
		}
		a.cloud.roomTransport(action, 0)
		return
	}
	a.setIntent(play)
}

func (a *validationApp) receiveRoomTimeline(timeline *roomTimeline, offset int64) {
	previous := a.roomTimeline
	a.roomTimeline, a.roomOffset = timeline, offset
	a.roomStamp++
	if timeline == nil {
		if a.roomAudio {
			a.stop()
		}
		return
	}
	if previous == nil {
		a.cancelResolution()
		if a.active && !a.stop() {
			return
		}
	}
	if timeline.TrackMeta == nil || timeline.Stream == nil || timeline.Stream.URL == "" {
		if a.roomAudio {
			a.stop()
		}
		return
	}
	address, err := validateSource(timeline.Stream.URL)
	if err != nil {
		if a.roomAudio {
			a.stop()
		}
		a.notice = "房间没有可用的 HTTPS 音源"
		return
	}
	serverNow := time.Now().UnixMilli() + offset
	play := timeline.Playing && serverNow >= timeline.BaseAt
	target := timeline.position(serverNow)
	song := *timeline.TrackMeta
	sameTrack := previous != nil && a.roomAudio && a.currentSong.ID == song.ID &&
		previous.TrackRevision == timeline.TrackRevision
	newSource := !sameTrack || a.currentSource.url != address
	if newSource {
		source := probeSource{url: address, title: song.Name, details: song.Artists, catalog: true}
		if !sameTrack {
			a.finishListen()
		}
		if !a.reopenAt(source, target, probeSource{}, "") {
			return
		}
		a.currentSong, a.roomAudio, a.roomRetried = song, true, false
		a.ended, a.wantPlay = false, play
		if !sameTrack {
			a.loadTrackPresentation(song)
		}
	} else if a.state != mediaFailed || a.awaitingOutput {
		if a.ended && (previous.BaseAt != timeline.BaseAt || previous.BasePosition != timeline.BasePosition) {
			a.ended = false
		}
		changed := previous.BaseAt != timeline.BaseAt || previous.BasePosition != timeline.BasePosition
		a.alignRoomAudio(target, play, changed)
	}
	if timeline.Playing && !play {
		stamp := a.roomStamp
		delay := time.Duration(max(0, timeline.BaseAt-serverNow)) * time.Millisecond
		if delay > 30*time.Second {
			return
		}
		time.AfterFunc(delay, func() {
			a.window.Update(func() {
				if a.roomStamp == stamp && a.roomAudio {
					a.alignRoomAudio(timeline.position(time.Now().UnixMilli()+a.roomOffset), true, false)
				}
			})
		})
	}
}

func (a *validationApp) alignRoomAudio(position int64, play, timelineChanged bool) {
	if a.ended || a.state == mediaFailed && !a.awaitingOutput {
		return
	}
	if a.resume != nil || a.awaitingOutput {
		a.wantPlay = play
		if a.resume != nil && a.resume.seekID == 0 {
			a.resume.position = position
		}
		return
	}
	if !play && a.playing {
		a.send(pauseMedia, 0)
	}
	tolerance := int64(1100)
	if timelineChanged {
		tolerance = 250
	}
	if a.seekable && a.lastSeek.IsZero() && (a.position-position > tolerance || position-a.position > tolerance) {
		a.requestSeek(min(position, a.duration))
	}
	if play && !a.playing {
		a.send(playMedia, 0)
	}
	a.wantPlay = play
}
