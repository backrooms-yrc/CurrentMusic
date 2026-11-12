package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"github.com/egoist/mygo/ui"
)

const minWindowWidth, minWindowHeight = 600, 320
const mainWindowTitle = "CurrentMusic 2.0"

type validationApp struct {
	*prototype
	window         *mygo.Window
	engine         *mediaEngine
	tracks         []probeSource
	index          int
	generation     uint64
	probeCount     int
	resolution     uint64
	resolveCancel  context.CancelFunc
	state          mediaState
	lastSeek       time.Time
	seekID         uint64
	seekTarget     int64
	seekErrorMS    int64
	seekObserved   bool
	seekPlaying    bool
	seekSamples    []int64
	seekMaxError   int64
	currentSource  probeSource
	currentSong    cloudSong
	sourceRetried  bool
	wantPlay       bool
	ended          bool
	resume         *playbackResume
	lyricCancel    context.CancelFunc
	lyricRevision  uint64
	outbox         *listenOutbox
	listen         listenEntry
	clock          listenClock
	queueFile      string
	roomAudio      bool
	roomTimeline   *roomTimeline
	roomOffset     int64
	roomStamp      uint64
	roomRetried    bool
	desktop        *desktopIntegration
	awaitingOutput bool
}

func main() {
	compact := flag.Bool("compact-preview", false, "open the preview at the minimum window size")
	flag.Parse()
	instance, err := openDesktopInstance()
	if err != nil {
		fmt.Fprintln(os.Stderr, "无法初始化 CurrentMusic 单实例", err)
		os.Exit(1)
	}
	if instance == nil {
		return
	}
	defer instance.close()
	width, height := 1200, 760
	if *compact {
		width, height = minWindowWidth, minWindowHeight
	}
	a := &validationApp{prototype: newPrototype()}
	mygo.App.SetName("CurrentMusic")
	mygo.App.WhenReady(func() {
		a.start(width, height)
		instance.watch(func() { a.window.Update(a.restoreMainWindow) })
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "CurrentMusic 无法启动")
		os.Exit(1)
	}
}

func (a *validationApp) start(width, height int) {
	prefsPath, outboxPath, desktopPath := "", "", ""
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		prefsPath = filepath.Join(local, "CurrentMusic", "MyGo", "settings.json")
		outboxPath = filepath.Join(filepath.Dir(prefsPath), "pending-listens.json")
		desktopPath = filepath.Join(filepath.Dir(prefsPath), "desktop.json")
	}
	a.cloud = newCloudLibrary(prefsPath, windowsCredentials{}, func(fn func()) { a.window.Update(fn) })
	a.cloud.openBrowser = mygo.Shell.OpenExternal
	a.cloud.copyText = func(value string) error { return mygo.Clipboard.Write(transfer.TextData(value)) }
	a.cloud.saveFile = func(name string) (string, error) {
		return mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: a.window, Title: "保存歌曲", DefaultPath: name})
	}
	a.cloud.roomTimelineChanged = a.receiveRoomTimeline
	a.outbox = newListenOutbox(outboxPath)
	listenCtx, stopListen := context.WithCancel(context.Background())
	go a.outbox.run(listenCtx)
	a.cloud.sessionChanged = func(api cloudAPI, user int64) {
		a.outbox.setSession(api, user)
		dir := ""
		if prefsPath != "" {
			dir = filepath.Dir(prefsPath)
		}
		a.queueFile = queueSettingsPath(dir, api.base, user)
		if user > 0 && !a.active {
			a.playQueue = restoreQueue(a.queueFile)
		}
	}
	a.cloud.beforeRevoke = func(api cloudAPI, user int64) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		a.outbox.flush(ctx, api, user)
	}
	a.position, a.duration, a.seekable = 0, 0, false
	a.window = mygo.NewWindow(mygo.WindowOptions{
		Title: mainWindowTitle,
		Width: width, Height: height, MinWidth: minWindowWidth, MinHeight: minWindowHeight,
		Content: ui.View(a.view),
	})
	a.openSource = func(raw string) {
		if a.cloud.rooms.liveID > 0 {
			a.notice = "请先退出一起听房间"
			return
		}
		a.cancelResolution()
		source, err := validateSource(raw)
		if err != nil {
			a.notice = err.Error()
			return
		}
		a.probeCount++
		a.appendSource(probeSource{url: source, title: fmt.Sprintf("HTTPS 验证音源 %d", a.probeCount), details: "测试流"})
	}
	a.resolve = a.resolveSong
	a.exitProbe = func() bool {
		a.cancelResolution()
		return !a.active || a.stop()
	}
	a.probeQueue = func() []string {
		var others []string
		for i, source := range a.tracks {
			if i != a.index {
				others = append(others, source.title)
			}
		}
		return others
	}
	a.seek = func(ms int64) {
		if a.cloud.rooms.liveID > 0 {
			a.cloud.roomTransport("seek", ms)
			return
		}
		if a.resume == nil {
			a.requestSeek(ms)
		}
	}
	a.setVolume = func(value float64) { a.send(setVolume, int64(value*1000)) }
	a.previous = func() { a.move(-1) }
	a.next = func() { a.move(1) }
	a.toggle = func() { a.userPlaybackIntent(a.state == mediaFailed || !a.wantPlay) }
	a.playIntent = func() bool { return a.active && a.state != mediaFailed && a.wantPlay }
	a.fullScreen = func(toggle bool) bool {
		wasFull := a.window.IsFullScreen()
		if toggle {
			a.window.SetFullScreen(!wasFull)
		} else if wasFull {
			a.window.SetFullScreen(false)
		}
		return wasFull
	}
	a.highContrast = mygo.Theme.Preferences().HighContrast
	mygo.Theme.OnUpdated(func() {
		a.window.Update(func() {
			a.highContrast = mygo.Theme.Preferences().HighContrast
			a.redrawDesktopLyrics()
		})
	})
	a.engine = startMediaEngine(func(s mediaUpdate) {
		a.window.Update(func() { a.apply(s) })
	}, func(err error) {
		a.window.Update(func() {
			a.notice = err.Error()
			a.lastSeek = time.Time{}
		})
	})
	a.cloud.stopPlayback = func() bool {
		a.cancelResolution()
		if a.active && !a.stop() {
			return false
		}
		a.tracks, a.index = nil, 0
		a.playQueue.clear()
		a.demoStarted, a.playing, a.seekable = false, false, false
		a.position, a.duration = 0, 0
		return true
	}
	a.playCloud = a.startCloud
	a.enqueueCloud = func(song cloudSong, next bool) {
		a.playQueue.enqueue(song, next)
		a.cloud.notice = "已加入播放队列"
		a.queueChanged()
	}
	a.openQueued = func(index int) { a.selectQueued(a.playQueue, index) }
	a.queueChanged = func() {
		a.saveCurrentQueue()
		if a.active && a.cloudTrack && a.state != mediaOpening && a.state != mediaFailed && a.resume == nil {
			a.publishNowPlaying()
		}
	}
	a.changeQuality = a.selectQuality
	a.installDesktop(desktopPath)
	a.cloud.restore()
	a.bindSystemMediaCommands()
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		if a.desktop.tray != nil {
			a.desktop.tray.Destroy()
		}
		a.cloud.cancel()
		a.cancelResolution()
		a.clearTrackPresentation()
		a.finishListen()
		stopListen()
		mygo.NowPlaying.Clear()
		close(a.engine.stop)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		a.outbox.flush(ctx, a.cloud.api, a.cloud.user.ID)
		select {
		case <-a.engine.done:
		case <-time.After(2 * time.Second):
		}
	})
}

func (a *validationApp) saveCurrentQueue() {
	if err := a.playQueue.save(a.queueFile); err != nil {
		a.notice = "无法保存当前播放队列"
	}
}

func (a *validationApp) bindSystemMediaCommands() func() {
	return mygo.NowPlaying.OnCommand(func(cmd mygo.MediaCommand, position time.Duration) {
		a.window.Update(func() {
			switch cmd {
			case mygo.MediaPlay:
				a.userPlaybackIntent(true)
			case mygo.MediaPause:
				a.userPlaybackIntent(false)
			case mygo.MediaStop:
				if a.cloud != nil && a.cloud.rooms.liveID > 0 {
					a.cloud.roomTransport("pause", 0)
				} else {
					a.stop()
				}
			case mygo.MediaPrevious:
				a.move(-1)
			case mygo.MediaNext:
				a.move(1)
			case mygo.MediaSeek:
				a.seekTo(position.Milliseconds())
			}
		})
	})
}

func (a *validationApp) requestSeek(ms int64) bool {
	id := a.seekID + 1
	if !a.engine.send(mediaCommand{action: seekMedia, generation: a.generation, value: ms, seekID: id}) {
		a.notice = "媒体组件不可用或正忙"
		return false
	}
	a.seekID = id
	a.lastSeek, a.seekTarget = time.Now(), ms
	a.seekObserved, a.seekPlaying = false, a.playing
	a.notice = "正在定位…"
	return true
}

func (a *validationApp) send(action mediaAction, value int64) bool {
	if a.engine.send(mediaCommand{action: action, generation: a.generation, value: value}) {
		return true
	}
	a.notice = "媒体组件不可用或正忙"
	return false
}

func (a *validationApp) cancelResolution() {
	a.resolution++
	a.queueLoading = false
	if a.resolveCancel != nil {
		a.resolveCancel()
		a.resolveCancel = nil
	}
}

func (a *validationApp) resolveSong(songID, username, password, quality string) {
	if a.cloud != nil && a.cloud.rooms.liveID > 0 {
		a.notice = "请先退出一起听房间"
		return
	}
	a.cancelResolution()
	serial := a.resolution
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	a.resolveCancel = cancel
	a.notice = "正在解析测试账号音源…"
	go func() {
		defer cancel()
		source, err := resolveProbeSource(ctx, songID, username, password, quality)
		a.window.Update(func() {
			if serial != a.resolution {
				return
			}
			a.resolveCancel = nil
			if err != nil {
				a.notice = err.Error()
				return
			}
			a.appendSource(source)
		})
	}()
}

func (a *validationApp) appendSource(source probeSource) bool {
	// Retain only the current and preceding source for testing Next/Previous.
	previous := a.tracks
	a.tracks = []probeSource{source}
	if len(previous) > 0 {
		a.tracks = []probeSource{previous[a.index], source}
	}
	if !a.open(len(a.tracks) - 1) {
		a.tracks = previous
		return false
	}
	return true
}

func (a *validationApp) move(delta int) {
	if a.cloud != nil && a.cloud.rooms.liveID > 0 {
		action := "next"
		if delta < 0 {
			action = "prev"
		}
		a.cloud.roomTransport(action, 0)
		return
	}
	if a.cloudTrack || !a.active && len(a.playQueue.songs) != 0 {
		index := a.playQueue.neighbor(delta, false)
		if index >= 0 {
			a.selectQueued(a.playQueue, index)
		} else if delta < 0 {
			a.seekTo(0)
		}
		return
	}
	if len(a.tracks) > 1 {
		a.open((a.index + delta + len(a.tracks)) % len(a.tracks))
	}
}

func (a *validationApp) open(index int) bool {
	if !a.beginMedia(a.tracks[index]) {
		return false
	}
	a.finishListen()
	a.clearTrackPresentation()
	a.index, a.resume, a.ended = index, nil, false
	a.setIntent(true)
	return true
}

func (a *validationApp) beginMedia(track probeSource) bool {
	next := a.generation + 1
	if !a.engine.send(mediaCommand{action: openMedia, generation: next, source: track.url}) {
		a.notice = "无法打开媒体组件"
		return false
	}
	a.generation, a.currentSource = next, track
	a.awaitingOutput = false
	a.active, a.playing, a.seekable = true, false, false
	a.state, a.position, a.duration = mediaOpening, 0, 0
	a.seeking, a.lastSeek = false, time.Time{}
	a.seekSamples, a.seekMaxError = a.seekSamples[:0], 0
	a.title, a.artist = track.title, track.details
	a.cloudTrack = track.catalog
	a.audioSpec = track.spec
	a.notice = "正在打开 · " + track.details
	mygo.NowPlaying.Clear()
	return true
}

func (a *validationApp) stop() bool {
	generation := a.generation + 1
	if !a.engine.send(mediaCommand{action: closeMedia, generation: generation}) {
		a.notice = "媒体组件不可用或正忙"
		return false
	}
	a.cancelResolution()
	a.finishListen()
	a.clearTrackPresentation()
	a.wantPlay, a.cloudTrack, a.ended, a.resume = false, false, false, nil
	a.roomAudio = false
	a.currentSong, a.currentSource = cloudSong{}, probeSource{}
	a.generation = generation
	a.awaitingOutput = false
	a.active, a.playing, a.seeking, a.seekable = false, false, false, true
	a.state, a.position, a.duration = mediaEmpty, 0, demoTracks[a.track].length
	if a.cloud != nil {
		a.demoStarted, a.seekable, a.duration = false, false, 0
	}
	a.lastSeek = time.Time{}
	mygo.NowPlaying.Clear()
	a.redrawDesktopLyrics()
	return true
}

func (a *validationApp) apply(s mediaUpdate) {
	if s.Generation != a.generation || !a.active {
		return
	}
	defer a.redrawDesktopLyrics()
	if s.Events&eventOutputChanged != 0 {
		a.refreshAfterDesktopChange()
	}
	wasState, wasSeekable, wasDuration, wasPosition := a.state, a.seekable, a.duration, a.position
	a.state = s.State
	a.position, a.duration = s.PositionMS, s.DurationMS
	a.seekable, a.playing = s.CanSeek != 0, s.State == mediaPlaying
	if s.State == mediaFailed {
		// Error snapshots do not carry the old source position.
		a.position, a.duration = wasPosition, wasDuration
		a.lastSeek = time.Time{}
		mygo.NowPlaying.Clear()
		if mediaError(s.Error).outputUnavailable() {
			a.waitForOutput(s.Error)
			return
		}
		a.playbackFailure(mediaError(s.Error).Error())
		return
	}
	a.trackListening(s, wasState)
	resumeFinished := false
	if a.resume != nil {
		generation := a.generation
		a.restorePosition(s)
		if a.resume != nil || generation != a.generation {
			return
		}
		resumeFinished = true
	}
	if !a.lastSeek.IsZero() && s.SeekID == a.seekID && s.Events&eventSeeked != 0 {
		a.seekObserved, a.seekErrorMS = true, s.PositionMS-a.seekTarget
	}
	seekResumed := s.Events&eventSeeked == 0 && a.playing && s.PositionMS > wasPosition
	if !a.lastSeek.IsZero() && a.seekObserved && (!a.seekPlaying || seekResumed) {
		elapsed := time.Since(a.lastSeek).Milliseconds()
		a.notice = fmt.Sprintf("定位完成 · %d 毫秒 · 位置误差 %+d 毫秒", elapsed, a.seekErrorMS)
		if a.seekPlaying {
			a.seekSamples = append(a.seekSamples, elapsed)
			a.seekMaxError = max(a.seekMaxError, a.seekErrorMS, -a.seekErrorMS)
			sorted := slices.Clone(a.seekSamples)
			slices.Sort(sorted)
			p95 := sorted[len(sorted)-len(sorted)/20-1]
			a.notice += fmt.Sprintf(" · %d 次 · P95 %d 毫秒 · 最大误差 %d 毫秒", len(sorted), p95, a.seekMaxError)
		}
		a.lastSeek = time.Time{}
	} else if s.Events&eventEnded != 0 {
		a.wantPlay = false
		if a.cloudTrack {
			a.ended = true
			a.finishListen()
			a.notice = "已播完"
			if a.roomAudio && a.cloud != nil {
				a.cloud.roomTransport("next", 0)
			} else if index := a.playQueue.neighbor(1, true); index >= 0 {
				a.selectQueued(a.playQueue, index)
			}
		} else {
			a.notice = "测试音源已播完"
		}
	} else if s.State != wasState {
		switch s.State {
		case mediaBuffering:
			a.notice = "正在缓冲…"
		case mediaPlaying:
			a.notice = "正在播放 · " + a.artist
		case mediaPaused:
			a.notice = "已暂停"
		}
	}
	if s.State == mediaOpening {
		return
	}
	state := mygo.PlaybackPaused
	if a.playing {
		state = mygo.PlaybackPlaying
	}
	position := time.Duration(a.position) * time.Millisecond
	if resumeFinished || s.Events&eventOpened != 0 || wasSeekable != a.seekable || wasDuration != a.duration || wasState == mediaOpening {
		a.publishNowPlaying()
	} else if s.State != wasState || s.Events != 0 {
		mygo.NowPlaying.SetPlayback(state, position)
	}
}

func (a *validationApp) publishNowPlaying() {
	state := mygo.PlaybackPaused
	if a.playing {
		state = mygo.PlaybackPlaying
	}
	commands := mygo.MediaPlay | mygo.MediaPause | mygo.MediaStop
	if a.seekable {
		commands |= mygo.MediaSeek
	}
	if a.cloudTrack && len(a.playQueue.songs) > 1 || !a.cloudTrack && len(a.tracks) > 1 {
		commands |= mygo.MediaNext | mygo.MediaPrevious
	}
	if a.roomAudio && a.cloud != nil {
		if a.cloud.rooms.detail.controller() {
			commands |= mygo.MediaNext | mygo.MediaPrevious
		} else {
			commands = 0
		}
	}
	mygo.NowPlaying.Set(mygo.NowPlayingInfo{
		Title: a.title, Artist: a.artist, State: state, Position: time.Duration(a.position) * time.Millisecond,
		Duration: time.Duration(a.duration) * time.Millisecond, Commands: commands,
	})
}
