package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// Run from a test executable beside the media bridge with an active audio endpoint.
func TestWindowsQualityResume(t *testing.T) {
	dir := os.Getenv("CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	if dir == "" {
		t.Skip("set CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	}
	server := httptest.NewServer(http.FileServer(http.Dir(dir)))
	defer server.Close()
	updates, failures := make(chan mediaUpdate, 64), make(chan error, 4)
	stop := make(chan struct{})
	a := &validationApp{prototype: newPrototype(), currentSong: cloudSong{ID: 1, Name: "合成音源"}}
	a.cloud = &cloudLibrary{user: cloudUser{ID: 1}}
	a.outbox = newListenOutbox("")
	a.engine = startMediaEngine(func(s mediaUpdate) {
		select {
		case updates <- s:
		case <-stop:
		}
	}, func(err error) {
		select {
		case failures <- err:
		case <-stop:
		}
	})
	defer func() {
		close(stop)
		close(a.engine.stop)
		<-a.engine.done
		mygo.NowPlaying.Clear()
	}()
	mp3 := probeSource{url: server.URL + "/range-44100.mp3", title: "合成音源", catalog: true}
	flac := probeSource{url: server.URL + "/range-44100.flac", title: "合成音源", catalog: true}
	wait := func(label string, match func(mediaUpdate) bool) mediaUpdate {
		t.Helper()
		deadline := time.NewTimer(10 * time.Second)
		defer deadline.Stop()
		for {
			select {
			case err := <-failures:
				t.Fatalf("%s: %v", label, err)
			case s := <-updates:
				if s.Generation != a.generation {
					continue
				}
				if s.State == mediaFailed {
					t.Fatalf("%s: %v", label, mediaError(s.Error))
				}
				a.apply(s)
				if match(s) {
					return s
				}
			case <-deadline.C:
				t.Fatalf("%s: timed out (state %d, position %d)", label, a.state, a.position)
			}
		}
	}
	if !a.beginMedia(mp3) {
		t.Fatal("could not open MP3")
	}
	a.toggle = func() { a.setIntent(!a.wantPlay) }
	a.seek = func(ms int64) { a.requestSeek(ms) }
	a.setVolume = func(value float64) { a.send(setVolume, int64(value*1000)) }
	controls := ui.NewTester(a.view, 584, 281)
	click := func(label string) {
		t.Helper()
		controls.Frame()
		if err := controls.Click(label); err != nil {
			t.Fatal(err)
		}
	}
	click("播放")
	if !a.wantPlay {
		t.Fatal("transport did not send play to the MediaPlayer controller")
	}
	wait("initial MP3", func(s mediaUpdate) bool { return a.playing && a.seekable && a.position > 400 })
	key := a.listen.Key
	if key == "" || a.clock.total == 0 {
		t.Fatal("actual MediaPlayer playback did not start the listening clock")
	}
	controls.Frame()
	progress, ok := controls.Find("播放进度")
	if !ok {
		t.Fatal("native progress control was not laid out")
	}
	y := progress.Y + progress.H/2
	controls.Press(progress.X+progress.W*.1, y)
	controls.Move(progress.X+progress.W*.4, y)
	if a.seekID != 0 {
		t.Fatal("drag submitted a MediaPlayer seek before release")
	}
	controls.Release(progress.X+progress.W*.4, y)
	if a.seekID != 1 || a.seekTarget < 21_000 || a.seekTarget > 27_000 {
		t.Fatalf("drag sent %d seeks, target %d ms", a.seekID, a.seekTarget)
	}
	wait("seek before quality change", func(s mediaUpdate) bool { return a.lastSeek.IsZero() && a.position >= a.seekTarget-500 })
	if a.clock.total > 2000 {
		t.Fatal("seek distance leaked into the listening clock")
	}
	click("调节音量")
	click("音量")
	if a.volume >= .7 {
		t.Fatal("volume control did not update the real playback controller")
	}
	click("调节音量")
	click("暂停")
	wait("pause via transport", func(s mediaUpdate) bool { return s.State == mediaPaused })
	click("播放")
	wait("resume via transport", func(s mediaUpdate) bool { return s.State == mediaPlaying })
	t.Log("minimum transport played, paused, resumed, committed a drag and adjusted volume")
	switchSource := func(source probeSource, play bool) {
		t.Helper()
		position := a.position
		if !a.beginMedia(source) {
			t.Fatal("could not open replacement source")
		}
		a.clock.playing = false
		a.resume = &playbackResume{position: position}
		wait("replacement seek", func(s mediaUpdate) bool { return a.resume == nil })
		if info, visible := mygo.NowPlaying.Info(); !visible || info.Title != source.title {
			t.Fatal("system media metadata was not restored after replacing the source")
		}
		if diff := a.position - position; diff < -500 || diff > 500 || a.listen.Key != key {
			t.Fatalf("quality change lost position or identity: %d -> %d", position, a.position)
		}
		if play {
			wait("replacement resumed", func(s mediaUpdate) bool { return a.playing && a.position > position })
		} else if a.state != mediaPaused {
			t.Fatalf("replacement should stay paused, state %d", a.state)
		}
		t.Logf("quality change at %d ms, replacement %d ms, playing %v", position, a.position, a.playing)
	}
	switchSource(flac, true)
	click("暂停")
	wait("pause before quality change", func(s mediaUpdate) bool { return s.State == mediaPaused })
	switchSource(mp3, false)
	a.finishListen()
	if len(a.outbox.entries) != 1 || !a.outbox.entries[0].Finished || a.outbox.entries[0].Total <= 0 || a.outbox.entries[0].Total > 3000 {
		t.Fatalf("wrong actual listening tail after seek and quality changes: %+v", a.outbox.entries)
	}
	// Exercise the same next command used by the transport against the local validation playlist.
	flac.catalog, a.cloudTrack = false, false
	a.tracks = []probeSource{mp3, flac}
	a.next = func() { a.move(1) }
	click("下一首")
	if a.index != 1 || a.currentSource.url != flac.url {
		t.Fatal("next track button did not open the next validation source")
	}
	wait("next track via transport", func(s mediaUpdate) bool { return a.playing && a.position > 0 })
	t.Log("minimum transport played, paused, committed a drag, adjusted volume and advanced to the next source")
}
