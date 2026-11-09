package main

import (
	"context"
	"fmt"
	"os"
	"slices"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type validationApp struct {
	*prototype
	window        *mygo.Window
	engine        *mediaEngine
	tracks        []probeSource
	index         int
	generation    uint64
	probeCount    int
	resolution    uint64
	resolveCancel context.CancelFunc
	state         mediaState
	lastSeek      time.Time
	seekTarget    int64
	seekErrorMS   int64
	seekObserved  bool
	seekPlaying   bool
	seekSamples   []int64
	seekMaxError  int64
}

func main() {
	a := &validationApp{prototype: newPrototype()}
	mygo.App.SetName("CurrentMusic")
	mygo.App.WhenReady(a.start)
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "CurrentMusic 无法启动")
		os.Exit(1)
	}
}

func (a *validationApp) start() {
	a.window = mygo.NewWindow(mygo.WindowOptions{
		Title: "CurrentMusic · 技术验证",
		Width: 1200, Height: 760, MinWidth: 600, MinHeight: 320,
		Content: ui.View(a.view),
	})
	a.openSource = func(raw string) {
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
	a.seek = func(ms int64) {
		if a.send(seekMedia, ms) {
			a.lastSeek, a.seekTarget = time.Now(), ms
			a.seekObserved, a.seekPlaying = false, a.playing
			a.notice = "正在定位…"
		}
	}
	a.setVolume = func(value float64) { a.send(setVolume, int64(value*1000)) }
	a.previous = func() { a.move(-1) }
	a.next = func() { a.move(1) }
	a.toggle = func() {
		if a.playing {
			a.send(pauseMedia, 0)
		} else {
			a.send(playMedia, 0)
		}
	}
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
		a.window.Update(func() { a.highContrast = mygo.Theme.Preferences().HighContrast })
	})
	a.engine = startMediaEngine(func(s mediaSnapshot) {
		a.window.Update(func() { a.apply(s) })
	}, func(err error) {
		a.window.Update(func() {
			a.notice = err.Error()
			a.lastSeek = time.Time{}
		})
	})
	mygo.NowPlaying.OnCommand(func(cmd mygo.MediaCommand, position time.Duration) {
		a.window.Update(func() {
			switch cmd {
			case mygo.MediaPlay:
				a.send(playMedia, 0)
			case mygo.MediaPause:
				a.send(pauseMedia, 0)
			case mygo.MediaStop:
				a.stop()
			case mygo.MediaPrevious:
				a.move(-1)
			case mygo.MediaNext:
				a.move(1)
			case mygo.MediaSeek:
				a.seekTo(position.Milliseconds())
			}
		})
	})
	mygo.App.OnWillQuit(func(_ *mygo.QuitEvent) {
		a.cancelResolution()
		mygo.NowPlaying.Clear()
		close(a.engine.stop)
		select {
		case <-a.engine.done:
		case <-time.After(2 * time.Second):
		}
	})
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
	if a.resolveCancel != nil {
		a.resolveCancel()
		a.resolveCancel = nil
	}
}

func (a *validationApp) resolveSong(songID, username, password, quality string) {
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

func (a *validationApp) appendSource(source probeSource) {
	// Retain only the current and preceding source for testing Next/Previous.
	if len(a.tracks) == 2 {
		a.tracks = a.tracks[1:]
	}
	a.tracks = append(a.tracks, source)
	a.open(len(a.tracks) - 1)
}

func (a *validationApp) move(delta int) {
	if len(a.tracks) > 1 {
		a.open((a.index + delta + len(a.tracks)) % len(a.tracks))
	}
}

func (a *validationApp) open(index int) {
	track := a.tracks[index]
	next := a.generation + 1
	if !a.engine.send(mediaCommand{action: openMedia, generation: next, source: track.url}) {
		a.notice = "无法打开媒体组件"
		return
	}
	a.generation, a.index = next, index
	a.active, a.playing, a.seekable = true, false, false
	a.state, a.position, a.duration = mediaOpening, 0, 0
	a.seeking, a.lastSeek = false, time.Time{}
	a.seekSamples, a.seekMaxError = a.seekSamples[:0], 0
	a.title, a.artist = track.title, track.details
	a.notice = "正在打开 · " + track.details
	mygo.NowPlaying.Clear()
	a.send(playMedia, 0)
}

func (a *validationApp) stop() {
	a.generation++
	a.send(closeMedia, 0)
	a.active, a.playing, a.seeking, a.seekable = false, false, false, true
	a.state, a.position, a.duration = mediaEmpty, 0, demoTracks[a.track].length
	a.lastSeek = time.Time{}
	mygo.NowPlaying.Clear()
}

func (a *validationApp) apply(s mediaSnapshot) {
	if s.Generation != a.generation || !a.active {
		return
	}
	wasState, wasSeekable, wasDuration, wasPosition := a.state, a.seekable, a.duration, a.position
	a.state = s.State
	a.position, a.duration = s.PositionMS, s.DurationMS
	a.seekable, a.playing = s.CanSeek != 0, s.State == mediaPlaying
	if s.State == mediaFailed {
		a.notice = mediaError(s.Error).Error()
		a.lastSeek = time.Time{}
		mygo.NowPlaying.Clear()
		return
	}
	if s.Events&eventSeeked != 0 {
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
		a.notice = "测试音源已播完"
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
	if s.Events&eventOpened != 0 || wasSeekable != a.seekable || wasDuration != a.duration || wasState == mediaOpening {
		commands := mygo.MediaPlay | mygo.MediaPause | mygo.MediaStop
		if a.seekable {
			commands |= mygo.MediaSeek
		}
		if len(a.tracks) > 1 {
			commands |= mygo.MediaNext | mygo.MediaPrevious
		}
		mygo.NowPlaying.Set(mygo.NowPlayingInfo{
			Title: a.title, Artist: a.artist, State: state, Position: position,
			Duration: time.Duration(a.duration) * time.Millisecond, Commands: commands,
		})
	} else if s.State != wasState || s.Events != 0 {
		mygo.NowPlaying.SetPlayback(state, position)
	}
}
