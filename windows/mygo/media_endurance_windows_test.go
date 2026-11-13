package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestWindowsMediaEndurance(t *testing.T) {
	raw := os.Getenv("CURRENTMUSIC_MEDIA_ENDURANCE")
	if raw == "" {
		t.Skip("set CURRENTMUSIC_MEDIA_ENDURANCE and CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	}
	target, err := time.ParseDuration(raw)
	dir := os.Getenv("CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	if err != nil || target < time.Second || dir == "" {
		t.Fatal("set a positive endurance duration and a local fixture directory")
	}
	server := httptest.NewServer(http.FileServer(http.Dir(dir)))
	defer server.Close()
	updates, failures := make(chan mediaUpdate, 32), make(chan error, 4)
	done := make(chan struct{})
	a := &validationApp{prototype: newPrototype(), tracks: []probeSource{
		{url: server.URL + "/range-44100.mp3", title: "MP3 fixture"},
		{url: server.URL + "/range-44100.flac", title: "FLAC fixture"},
	}}
	a.engine = startMediaEngine(func(update mediaUpdate) {
		select {
		case updates <- update:
		case <-done:
		}
	}, func(err error) {
		select {
		case failures <- err:
		case <-done:
		}
	})
	defer func() {
		close(done)
		close(a.engine.stop)
		<-a.engine.done
	}()
	if !a.send(setVolume, 20) || !a.open(0) {
		t.Fatal("could not start the real media engine")
	}
	t.Logf("target: %s of advancing WinRT playback, alternating loopback MP3 and FLAC", target)
	start, lastProgress := time.Now(), time.Now()
	watchdog := time.NewTicker(time.Second)
	defer watchdog.Stop()
	var played int64
	completed := 0
	nextReport := int64(time.Minute / time.Millisecond)
	for played < target.Milliseconds() || time.Since(start) < target {
		select {
		case err := <-failures:
			t.Fatal(err)
		case <-watchdog.C:
			if time.Since(lastProgress) > 12*time.Second {
				t.Fatalf("playback stopped advancing after %s, state %d", time.Duration(played)*time.Millisecond, a.state)
			}
		case s := <-updates:
			if s.Generation != a.generation {
				continue
			}
			if s.State == mediaFailed {
				t.Fatalf("media failure after %s: %v", time.Duration(played)*time.Millisecond, mediaError(s.Error))
			}
			previous := a.position
			delta := s.PositionMS - previous
			if a.playing && delta > 0 && delta <= 1500 {
				played += delta
				lastProgress = time.Now()
			}
			a.apply(s)
			if s.Events&eventEnded != 0 {
				if s.DurationMS < 59_000 || max(previous, s.PositionMS) < s.DurationMS-1500 {
					t.Fatalf("fixture ended early at %d/%d ms", max(previous, s.PositionMS), s.DurationMS)
				}
				completed++
				a.move(1)
			}
			if played >= nextReport {
				t.Logf("played %s, elapsed %s, completed tracks %d", time.Duration(played)*time.Millisecond, time.Since(start).Round(time.Second), completed)
				nextReport += time.Minute.Milliseconds()
			}
		}
	}
	t.Logf("completed %s of advancing playback over %s, %d tracks ended normally",
		time.Duration(played)*time.Millisecond, time.Since(start).Round(time.Millisecond), completed)
}
