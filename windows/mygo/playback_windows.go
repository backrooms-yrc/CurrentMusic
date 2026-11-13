package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/egoist/mygo/ui"
)

type playbackResume struct {
	position int64
	seekID   uint64
	fallback probeSource
	previous string
}

func (a *validationApp) fetchCloudStream(song cloudSong, quality string, refresh bool, apply func(probeSource), failed func()) {
	a.cancelResolution()
	a.queueLoading = true
	serial, api := a.resolution, a.cloud.api
	ctx, cancel := context.WithTimeout(a.cloud.scope, 20*time.Second)
	a.resolveCancel = cancel
	a.notice = "正在解析音源…"
	go func() {
		defer cancel()
		source, err := resolveCloudStream(ctx, api, song, quality, refresh)
		a.window.Update(func() {
			if serial != a.resolution {
				return
			}
			a.resolveCancel, a.queueLoading = nil, false
			if err != nil {
				var status cloudAPIError
				if errors.As(err, &status) && status.authenticated && status.status == http.StatusUnauthorized {
					a.cloud.discardSession()
				}
				a.notice = err.Error()
				a.cloud.notice = err.Error()
				if failed != nil {
					failed()
				}
				return
			}
			apply(source)
		})
	}()
}

func (a *validationApp) startCloud(song cloudSong, songs []cloudSong) {
	q := a.playQueue
	q.start(song, songs)
	a.selectQueued(q, q.index)
}

func (a *validationApp) selectQueued(q playQueue, index int) {
	if a.cloud.rooms.liveID > 0 {
		a.cloud.notice = "当前由一起听房间控制播放，可将曲目点到房间队列"
		return
	}
	if a.cloud.user.ID <= 0 || index < 0 || index >= len(q.songs) {
		return
	}
	q.index = index
	song := q.songs[index]
	a.fetchCloudStream(song, a.quality, false, func(source probeSource) {
		if !a.beginMedia(source) {
			return
		}
		a.finishListen()
		a.playQueue, a.currentSong, a.sourceRetried = q, song, false
		a.saveCurrentQueue()
		a.resume, a.ended = nil, false
		a.loadTrackPresentation(song)
		a.setIntent(true)
	}, nil)
}

func (a *validationApp) loadTrackPresentation(song cloudSong) {
	a.clearTrackPresentation()
	a.lyricStatus = "正在加载歌词…"
	ctx, cancel := context.WithTimeout(a.cloud.scope, 15*time.Second)
	a.lyricCancel = cancel
	api, revision := a.cloud.api, a.lyricRevision
	go func() {
		result, err := api.lyrics(ctx, song.ID)
		lines := result.timedLines()
		a.window.Update(func() {
			if revision != a.lyricRevision {
				return
			}
			a.cloudLyrics = lines
			switch {
			case err != nil:
				a.lyricStatus = "歌词加载失败"
			case result.Instrumental:
				a.lyricStatus = "纯音乐"
			default:
				a.lyricStatus = "此曲目暂无歌词"
			}
			a.redrawDesktopLyrics()
		})
	}()
	if song.Picture != "" {
		go func() {
			picture := fetchAlbumArt(ctx, api.http, song.Picture)
			if picture == nil {
				return
			}
			art, tint := ui.NewBitmap(picture), coverTint(picture)
			a.window.Update(func() {
				if revision == a.lyricRevision {
					a.albumArt, a.albumTint = art, tint
				}
			})
		}()
	}
}

func (a *validationApp) clearTrackPresentation() {
	a.lyricRevision++
	if a.lyricCancel != nil {
		a.lyricCancel()
		a.lyricCancel = nil
	}
	a.cloudLyrics, a.lyricStatus = nil, ""
	a.albumArt = nil
	a.followLyrics, a.lastLyric = true, -1
}

func (a *validationApp) setIntent(play bool) {
	if a.awaitingOutput {
		a.wantPlay = play
		if play {
			a.retryAudioOutput()
		}
		return
	}
	if a.resume != nil {
		a.wantPlay = play
		return
	}
	if play && a.cloudTrack && (a.ended || a.state == mediaFailed && !a.queueLoading) {
		a.selectQueued(a.playQueue, a.playQueue.index)
		return
	}
	if !a.active || a.state == mediaFailed {
		if play && len(a.playQueue.songs) > 0 {
			a.selectQueued(a.playQueue, max(0, a.playQueue.index))
		}
		return
	}
	action := pauseMedia
	if play {
		action = playMedia
	}
	if a.send(action, 0) {
		a.wantPlay = play
	}
}

func (a *validationApp) selectQuality(quality string) {
	if a.cloud != nil && a.cloud.rooms.liveID > 0 {
		a.notice = "当前使用房间共享音源"
		return
	}
	if quality == a.quality || a.queueLoading || a.resume != nil {
		return
	}
	if !a.active || !a.cloudTrack || a.ended || a.state == mediaFailed {
		a.quality = quality
		return
	}
	a.fetchCloudStream(a.currentSong, quality, false, func(source probeSource) {
		if a.ended {
			a.quality = quality
			return
		}
		previous, fallback, position := a.quality, a.currentSource, a.position
		if a.reopenAt(source, position, fallback, previous) {
			a.quality = quality
			a.sourceRetried = false
		}
	}, nil)
}

func (a *validationApp) reopenAt(source probeSource, position int64, fallback probeSource, previous string) bool {
	if !a.beginMedia(source) {
		return false
	}
	a.clock.playing = false
	a.resume = &playbackResume{position: position, fallback: fallback, previous: previous}
	serial := a.generation
	time.AfterFunc(11*time.Second, func() {
		a.window.Update(func() {
			if a.generation == serial && a.resume != nil {
				a.playbackFailure("无法恢复换档前的播放位置")
			}
		})
	})
	return true
}

func (a *validationApp) restorePosition(s mediaUpdate) {
	r := a.resume
	if r.seekID == 0 {
		if s.State == mediaOpening || s.State == mediaBuffering && s.Events&eventOpened == 0 {
			return
		}
		if a.roomAudio && a.roomTimeline != nil {
			r.position = a.roomTimeline.position(time.Now().UnixMilli() + a.roomOffset)
		}
		if r.position > 0 {
			if a.duration <= 0 {
				return
			}
			if !a.seekable || !a.requestSeek(min(r.position, a.duration)) {
				a.playbackFailure("新音源无法定位")
				return
			}
			r.seekID = a.seekID
			return
		}
	} else if s.Events&eventSeeked == 0 || s.SeekID != r.seekID {
		return
	}
	a.resume = nil
	if a.wantPlay {
		a.send(playMedia, 0)
	} else {
		a.notice = "已恢复暂停位置"
	}
}

func (a *validationApp) playbackFailure(message string) {
	a.notice = message
	if a.roomAudio && a.cloud != nil {
		a.resume = nil
		if !a.roomRetried {
			a.roomRetried = true
			a.cloud.roomTransport("stream/renew", 0)
		}
		return
	}
	if !a.cloudTrack || a.queueLoading {
		return
	}
	if r := a.resume; r != nil && r.fallback.url != "" {
		if a.reopenAt(r.fallback, r.position, probeSource{}, "") {
			a.quality = r.previous
			a.notice = "换档失败，正在恢复原音质"
			return
		}
	}
	position := a.position
	if a.resume != nil {
		position = a.resume.position
		a.resume = nil
	}
	if !a.sourceRetried {
		a.sourceRetried = true
		a.fetchCloudStream(a.currentSong, a.quality, true, func(source probeSource) {
			if !a.reopenAt(source, position, probeSource{}, "") {
				a.finishListen()
			}
		}, a.finishListen)
		return
	}
	a.state, a.playing, a.wantPlay = mediaFailed, false, false
	a.finishListen()
}

func (a *validationApp) waitForOutput(code int32) {
	if a.resume != nil {
		a.position, a.resume = a.resume.position, nil
	}
	a.awaitingOutput = true
	a.clock.playing = false
	a.saveListening(false)
	a.notice = mediaError(code).Error() + "，等待输出设备恢复"
}

func (a *validationApp) refreshAfterDesktopChange() {
	a.clock.playing = false
	if !a.active || a.ended || a.window == nil {
		return
	}
	serial := a.generation
	time.AfterFunc(650*time.Millisecond, func() {
		a.window.Update(func() {
			if serial != a.generation || !a.active || a.ended || a.desktop != nil && a.desktop.quitting {
				return
			}
			if a.awaitingOutput {
				a.retryAudioOutput()
			} else if a.resume == nil && a.state != mediaOpening && a.state != mediaFailed {
				a.publishNowPlaying()
			}
		})
	})
}

func (a *validationApp) retryAudioOutput() {
	if a.currentSource.url == "" || a.queueLoading {
		return
	}
	if a.reopenAt(a.currentSource, a.position, probeSource{}, "") {
		a.notice = "正在恢复音频输出…"
	}
}

func (a *validationApp) trackListening(s mediaUpdate, previous mediaState) {
	if !a.cloudTrack || a.resume != nil || a.currentSong.ID <= 0 {
		return
	}
	if a.listen.Key == "" && s.State == mediaPlaying && !a.ended {
		song := a.currentSong
		if a.duration > 0 {
			song.Duration = a.duration
		}
		a.listen = newListenEntry(a.cloud.api, a.cloud.user.ID, song)
		a.saveListening(false)
	}
	if a.listen.Key == "" {
		return
	}
	continuous := a.lastSeek.IsZero() && s.Events&eventSeeked == 0 &&
		(s.State == mediaPlaying || s.State == mediaPaused)
	a.clock.sample(s.At, s.PositionMS, s.State == mediaPlaying && continuous, continuous)
	threshold := firstListenReport(a.listen.Song.Duration)
	if a.listen.Total >= threshold {
		threshold = a.listen.Total + listeningInterval
	}
	if a.clock.total >= threshold || previous == mediaPlaying && s.State == mediaPaused && a.clock.total > a.listen.Total {
		a.saveListening(false)
	}
}

func (a *validationApp) saveListening(finished bool) {
	if a.listen.Key != "" && a.outbox != nil {
		a.listen.Total, a.listen.Finished = a.clock.total, finished
		if err := a.outbox.update(a.listen); err != nil {
			a.notice = "无法保存待同步的收听记录"
		}
	}
}

func (a *validationApp) finishListen() {
	a.saveListening(true)
	a.listen, a.clock = listenEntry{}, listenClock{}
}
