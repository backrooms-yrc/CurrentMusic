package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func TestDesktopInstanceHelper(t *testing.T) {
	name := os.Getenv("CURRENTMUSIC_TEST_INSTANCE")
	if name == "" {
		t.Skip("requires an instance test parent")
	}
	instance, err := claimDesktopInstance(name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if instance != nil {
		instance.close()
		t.Fatal("a second process became the primary instance")
	}
}

func signalFromSecondProcess(t *testing.T, name string) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestDesktopInstanceHelper$")
	cmd.Env = append(os.Environ(), "CURRENTMUSIC_TEST_INSTANCE="+name, "CURRENTMUSIC_NATIVE_CAPTURE_DIR=")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("secondary process: %v\n%s", err, output)
	}
}

func TestDesktopInstanceActivation(t *testing.T) {
	name := fmt.Sprintf(`Local\CurrentMusic.Test.%d`, os.Getpid())
	primary, err := claimDesktopInstance(name, nil)
	if err != nil || primary == nil {
		t.Fatalf("claim desktop instance: %v", err)
	}
	defer primary.close()
	signalFromSecondProcess(t, name)
	activated := make(chan struct{}, 1)
	primary.watch(func() { activated <- struct{}{} })
	select {
	case <-activated:
	case <-time.After(3 * time.Second):
		t.Fatal("activation sent during startup was lost")
	}
}

func TestDesktopLyricsPlacement(t *testing.T) {
	work := mygo.Rectangle{X: -1152, Y: 32, Width: 1152, Height: 768}
	current := mygo.Rectangle{X: -220, Y: 744, Width: 620, Height: 128}
	if got, want := desktopLyricsBounds(current, work), (mygo.Rectangle{X: -620, Y: 672, Width: 620, Height: 128}); got != want {
		t.Fatalf("desktop lyrics at negative monitor coordinates: got %+v, want %+v", got, want)
	}
	primary := mygo.Rectangle{Width: 540, Height: 460}
	if got, want := desktopLyricsBounds(current, primary), (mygo.Rectangle{X: 0, Y: 308, Width: 540, Height: 128}); got != want {
		t.Fatalf("desktop lyrics on the remaining display: got %+v, want %+v", got, want)
	}
}

func TestNativeDesktopIntegration(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("requires the native MyGo test event loop")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf(`Local\CurrentMusic.Test.Native.%d`, os.Getpid())
	instance, err := claimDesktopInstance(name, nil)
	if err != nil || instance == nil {
		t.Fatalf("claim desktop instance: %v", err)
	}
	defer instance.close()
	a := &validationApp{prototype: newPrototype()}
	mygo.RunOnMain(func() {
		a.window = mygo.NewWindow(mygo.WindowOptions{Title: "CurrentMusic desktop fixture", Hidden: true,
			Width: 740, Height: 460, Content: ui.View(a.view)})
		a.installDesktop("")
		a.window.ShowInactive()
	})
	d := a.desktop
	defer mygo.RunOnMain(func() {
		d.quitting = true
		if d.tray != nil {
			d.tray.Destroy()
		}
		if d.lyrics != nil {
			d.lyrics.Destroy()
		}
		a.window.Destroy()
	})
	if d.tray == nil {
		t.Fatal("native tray creation failed")
	}
	a.window.Close()
	if a.window.IsVisible() || a.window.NativeHandle() == 0 {
		t.Fatal("closing the main window did not leave a live hidden window")
	}
	restored := make(chan bool, 1)
	instance.watch(func() {
		a.window.Update(func() {
			a.restoreMainWindow()
			restored <- a.window.IsVisible()
		})
	})
	signalFromSecondProcess(t, name)
	select {
	case visible := <-restored:
		if !visible {
			t.Fatal("second process did not restore the hidden window")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("second process did not reach the main window")
	}
	t.Log("native close-to-tray and restore from a second process passed")

	var topmost, movable, locked, through, interactive, hidden, visible, slept, woke bool
	var screenshot []byte
	var captureErr, settingsErr error
	mygo.RunOnMain(func() {
		settings := ui.NewTester(d.viewSettings, 640, 320)
		if settingsErr = settings.Click("显示桌面歌词"); settingsErr != nil || d.lyrics == nil {
			return
		}
		topmost, movable = d.lyrics.IsAlwaysOnTop(), d.lyrics.IsMovable()
		if settingsErr = settings.Click("锁定歌词位置"); settingsErr != nil {
			return
		}
		locked = !d.lyrics.IsMovable()
		if settingsErr = settings.Click("歌词点击穿透"); settingsErr != nil {
			return
		}
		through = lyricsClickThroughStyle(d.lyrics)
		d.setClickThrough(false)
		interactive = !lyricsClickThroughStyle(d.lyrics)
		d.locked = true
		d.syncLyricsWindow()
		hidden = !d.lyrics.IsVisible()
		d.locked = false
		d.syncLyricsWindow()
		visible = d.lyrics.IsVisible()
		d.sleeping = true
		d.syncLyricsWindow()
		slept = !d.lyrics.IsVisible()
		d.sleeping = false
		d.syncLyricsWindow()
		woke = d.lyrics.IsVisible()
		screenshot, captureErr = d.lyrics.CapturePage()
	})
	if settingsErr != nil {
		t.Fatal(settingsErr)
	}
	if !topmost || !movable || !locked || !through || !interactive || !hidden || !visible || !slept || !woke {
		t.Fatalf("native lyrics state topmost=%t movable=%t locked=%t through=%t interactive=%t session lock=%t/%t sleep=%t/%t",
			topmost, movable, locked, through, interactive, hidden, visible, slept, woke)
	}
	if captureErr != nil {
		t.Fatal(captureErr)
	}
	if err := os.WriteFile(filepath.Join(out, "desktop-lyrics.png"), screenshot, 0600); err != nil {
		t.Fatal(err)
	}
	t.Log("native topmost, movement lock, layered click-through and simulated lock/suspend visibility passed")
	verifyOutputRecovery(t, a)
	if probe := os.Getenv("CURRENTMUSIC_SMTC_PROBE"); probe != "" {
		verifyNativeSystemMedia(t, a, probe)
	}
}

func verifyOutputRecovery(t *testing.T, a *validationApp) {
	t.Helper()
	commands := make(chan mediaCommand, 4)
	const position = 25_400
	mygo.RunOnMain(func() {
		a.engine = &mediaEngine{commands: commands, done: make(chan struct{})}
		a.active, a.wantPlay, a.state, a.position = true, true, mediaPlaying, position
		a.currentSource = probeSource{url: "https://example.test/fixture.mp3"}
		a.apply(mediaUpdate{mediaSnapshot: mediaSnapshot{
			Generation: a.generation, State: mediaFailed, Events: eventOutputChanged, Error: -1072875782,
		}})
		a.setIntent(false)
	})
	var reopened mediaCommand
	select {
	case reopened = <-commands:
		if reopened.action != openMedia {
			t.Fatalf("output recovery sent %v before opening a source", reopened.action)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("output change did not reopen the failed source")
	}
	mygo.RunOnMain(func() {
		a.apply(mediaUpdate{mediaSnapshot: mediaSnapshot{
			Generation: reopened.generation, State: mediaPaused, CanSeek: 1, DurationMS: 60_000, Events: eventOpened,
		}})
	})
	select {
	case seek := <-commands:
		if seek.action != seekMedia || seek.value != position {
			t.Fatalf("output recovery lost the position: %+v", seek)
		}
		mygo.RunOnMain(func() {
			a.apply(mediaUpdate{mediaSnapshot: mediaSnapshot{
				Generation: seek.generation, PositionMS: position, State: mediaPaused, CanSeek: 1,
				DurationMS: 60_000, Events: eventSeeked,
			}, SeekID: seek.seekID})
		})
	default:
		t.Fatal("output recovery did not seek after opening")
	}
	if len(commands) != 0 {
		t.Fatal("output recovery started playing after the user paused")
	}
	mygo.RunOnMain(func() { a.stop() })
	t.Log("simulated audio output recovery reopened at the last position and retained pause intent")
}

func verifyNativeSystemMedia(t *testing.T, a *validationApp, probe string) {
	t.Helper()
	dir := os.Getenv("CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	if dir == "" {
		verifySystemMediaDispatch(t, a, probe)
		return
	}
	server := httptest.NewServer(http.FileServer(http.Dir(dir)))
	defer server.Close()
	title := fmt.Sprintf("CurrentMusic desktop media fixture %d", os.Getpid())
	failures := make(chan error, 4)
	off := a.bindSystemMediaCommands()
	defer off()
	mygo.RunOnMain(func() {
		a.engine = startMediaEngine(func(s mediaUpdate) {
			a.window.Update(func() { a.apply(s) })
		}, func(err error) { failures <- err })
		a.beginMedia(probeSource{url: server.URL + "/range-44100.mp3", title: title})
		a.setIntent(true)
	})
	defer func() {
		close(a.engine.stop)
		<-a.engine.done
		mygo.NowPlaying.Clear()
	}()
	await := func(label string, condition func() bool) {
		t.Helper()
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			var ok, unavailable bool
			var notice string
			mygo.RunOnMain(func() { ok, unavailable, notice = condition(), a.awaitingOutput, a.notice })
			if ok {
				return
			}
			if unavailable {
				t.Fatalf("%s: %s", label, notice)
			}
			select {
			case err := <-failures:
				t.Fatalf("%s: %v", label, err)
			case <-time.After(50 * time.Millisecond):
			}
		}
		t.Fatalf("%s timed out", label)
	}
	await("WinRT playing", func() bool { return a.playing && a.position >= 500 })
	a.window.Close()
	if a.window.IsVisible() {
		t.Fatal("window became visible during background playback")
	}
	callSystemMediaProbe(t, probe, title, "pause")
	await("system pause reached WinRT", func() bool { return a.state == mediaPaused })
	callSystemMediaProbe(t, probe, title, "play")
	await("system play reached WinRT", func() bool { return a.state == mediaPlaying })
	mygo.RunOnMain(func() { a.stop() })
	callSystemMediaProbe(t, probe, title, "absent")
}

func verifySystemMediaDispatch(t *testing.T, a *validationApp, probe string) {
	t.Helper()
	title := fmt.Sprintf("CurrentMusic desktop media fixture %d", os.Getpid())
	commands := make(chan mediaCommand, 4)
	off := a.bindSystemMediaCommands()
	defer off()
	defer mygo.NowPlaying.Clear()
	mygo.RunOnMain(func() {
		a.engine = &mediaEngine{commands: commands, done: make(chan struct{})}
		a.title, a.state, a.generation = title, mediaPlaying, 1
		a.active, a.playing, a.wantPlay = true, true, true
		a.position, a.duration = 1200, 60_000
		a.publishNowPlaying()
	})
	a.window.Close()
	t.Log("using a real Windows media session with a synthetic engine to verify command dispatch")
	assertCommand := func(action string, want mediaAction) {
		t.Helper()
		callSystemMediaProbe(t, probe, title, action)
		select {
		case command := <-commands:
			if command.action != want || command.generation != 1 {
				t.Fatalf("system %s dispatched %+v", action, command)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("system %s never reached the Go controller", action)
		}
	}
	assertCommand("pause", pauseMedia)
	mygo.RunOnMain(func() {
		a.apply(mediaUpdate{mediaSnapshot: mediaSnapshot{Generation: 1, State: mediaPaused, PositionMS: 1500, DurationMS: 60_000}})
	})
	assertCommand("play", playMedia)
	mygo.NowPlaying.Clear()
	callSystemMediaProbe(t, probe, title, "absent")
}

func callSystemMediaProbe(t *testing.T, probe, title, action string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, probe, title, action).CombinedOutput()
	if err != nil {
		t.Fatalf("Windows media session %s: %v\n%s", action, err, output)
	}
	t.Logf("SMTC %s: %s", action, strings.TrimSpace(string(output)))
}

func lyricsClickThroughStyle(w *mygo.Window) bool {
	getStyle := instanceUser32.NewProc("GetWindowLongPtrW")
	const transparent, layered = 0x20, 0x80000
	style, _, _ := getStyle.Call(w.NativeHandle(), ^uintptr(19)) // GWL_EXSTYLE = -20.
	return style&(transparent|layered) == transparent|layered
}

func TestAudioOutputErrorPreservesPlayIntent(t *testing.T) {
	a := &validationApp{prototype: newPrototype(), wantPlay: true, resume: &playbackResume{position: 42300}}
	code := int32(-1072875782) // MF_E_CANNOT_CREATE_SINK
	if !mediaError(code).outputUnavailable() {
		t.Fatal("endpoint failure must be recoverable")
	}
	a.waitForOutput(code)
	if !a.awaitingOutput || !a.wantPlay || a.position != 42300 || a.resume != nil || !strings.Contains(a.notice, "输出设备") {
		t.Fatal("endpoint loss discarded playback intent or position")
	}
	a.setIntent(false)
	if a.wantPlay {
		t.Fatal("pause while disconnected did not update playback intent")
	}
}
