package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"
)

// Compile the test executable into the directory containing CurrentMusic.Media.dll.
// The loopback option is for bring-up. HTTPS acceptance uses the deployment URL.
func TestWindowsMediaFixtures(t *testing.T) {
	base, dir := os.Getenv("CURRENTMUSIC_MEDIA_FIXTURE_BASE"), os.Getenv("CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	switch {
	case base != "" && dir != "":
		t.Fatal("choose either an HTTPS base URL or a local fixture directory")
	case base != "":
		normalized, err := validateSource(base)
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(normalized)
		if u.RawQuery != "" || u.ForceQuery {
			t.Fatal("use an HTTPS directory URL without a query")
		}
		base = normalized
	case dir != "":
		server := httptest.NewServer(http.FileServer(http.Dir(dir)))
		t.Cleanup(server.Close)
		base = server.URL
		t.Log("transport: loopback HTTP (bring-up)")
	default:
		t.Skip("set CURRENTMUSIC_MEDIA_FIXTURE_BASE or CURRENTMUSIC_MEDIA_FIXTURE_DIR")
	}

	fixtures := []struct {
		name  string
		seeks int
	}{
		{"range-44100.mp3", 20},
		{"range-44100.flac", 20},
		{"range-96000-24bit.flac", 20},
		{"range-48000.m4a", 2},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			source, err := url.JoinPath(base, fixture.name)
			if err != nil {
				t.Fatal("could not construct fixture URL")
			}
			checkFixtureRange(t, source)
			runMediaFixture(t, source, fixture.seeks)
		})
	}
}

func checkFixtureRange(t *testing.T, source string) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, source, nil)
	if err != nil {
		t.Fatal("could not construct Range request")
	}
	request.Header.Set("Range", "bytes=0-1023")
	client := http.Client{Timeout: 10 * time.Second, CheckRedirect: probeClient.CheckRedirect}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("Range request failed")
	}
	defer response.Body.Close()
	var length int64
	rangeHeader := response.Header.Get("Content-Range")
	_, scanErr := fmt.Sscanf(rangeHeader, "bytes 0-1023/%d", &length)
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 1025))
	if response.StatusCode != http.StatusPartialContent || scanErr != nil || length < 1024 ||
		rangeHeader != fmt.Sprintf("bytes 0-1023/%d", length) || readErr != nil || len(body) != 1024 {
		t.Fatalf("invalid Range response (HTTP %d, %d bytes read)", response.StatusCode, len(body))
	}
	t.Logf("Range: HTTP 206, 1024/%d bytes", length)
}

func runMediaFixture(t *testing.T, source string, seeks int) {
	t.Helper()
	const generation = 1
	const seekTimeout = 8 * time.Second
	snapshots := make(chan mediaUpdate, 16)
	errors := make(chan error, 4)
	stop := make(chan struct{})
	engine := startMediaEngine(func(s mediaUpdate) {
		select {
		case snapshots <- s:
		case <-stop:
		}
	}, func(err error) {
		select {
		case errors <- err:
		case <-stop:
		}
	})
	t.Cleanup(func() {
		close(stop)
		close(engine.stop)
		select {
		case <-engine.done:
		case <-time.After(2 * time.Second):
			t.Error("media engine did not stop")
		}
	})
	var seekID uint64
	send := func(action mediaAction, value int64) {
		t.Helper()
		cmd := mediaCommand{action: action, value: value, generation: generation, source: source}
		if action == seekMedia {
			seekID++
			cmd.seekID = seekID
		}
		if !engine.send(cmd) {
			t.Fatal("media engine unavailable")
		}
	}
	wait := func(description string, deadline time.Time, match func(mediaUpdate) bool) mediaUpdate {
		t.Helper()
		timer := time.NewTimer(time.Until(deadline))
		defer timer.Stop()
		for {
			select {
			case err := <-errors:
				t.Fatalf("%s: %v", description, err)
			case s := <-snapshots:
				if s.Generation != generation {
					continue
				}
				if s.State == mediaFailed {
					t.Fatalf("%s: %v", description, mediaError(s.Error))
				}
				if match(s) {
					return s
				}
			case <-timer.C:
				t.Fatalf("%s timed out", description)
			}
		}
	}

	send(openMedia, 0)
	send(playMedia, 0)
	opened := wait("open and play", time.Now().Add(15*time.Second), func(s mediaUpdate) bool {
		return s.State == mediaPlaying && s.CanSeek != 0 && s.PositionMS > 0
	})
	if opened.DurationMS < 59000 || opened.DurationMS > 61000 {
		t.Fatalf("expected a 60-second fixture, got %d ms", opened.DurationMS)
	}
	t.Logf("MediaPlayer playing; duration %d ms", opened.DurationMS)

	latencies := make([]int64, 0, seeks)
	var worstError int64
	for i := range seeks {
		// Alternate forward/backward across a substantial part of the fixture.
		target := int64(5000 + 2000*(i/2))
		if i%2 == 0 {
			target = int64(52000 - 2000*(i/2))
		}
		start := time.Now()
		send(seekMedia, target)
		description := fmt.Sprintf("seek %d/%d to %d ms", i+1, seeks, target)
		completed := wait(description, start.Add(seekTimeout), func(s mediaUpdate) bool {
			return s.Events&eventSeeked != 0 && s.SeekID == seekID
		})
		wait(description+" resume", start.Add(seekTimeout), func(s mediaUpdate) bool {
			return s.State == mediaPlaying && s.PositionMS > completed.PositionMS
		})
		elapsed := time.Since(start).Milliseconds()
		offset := completed.PositionMS - target
		latencies = append(latencies, elapsed)
		worstError = max(worstError, offset, -offset)
		t.Logf("%s: %d ms, position error %+d ms", description, elapsed, offset)
	}
	slices.Sort(latencies)
	p95 := latencies[len(latencies)-len(latencies)/20-1]
	t.Logf("%d completed seeks, P95 %d ms, maximum position error %d ms", seeks, p95, worstError)
	if p95 > 2000 || worstError > 500 {
		t.Errorf("seek thresholds failed (P95 ≤ 2000 ms, maximum error ≤ 500 ms)")
	}

	send(pauseMedia, 0)
	wait("pause", time.Now().Add(seekTimeout), func(s mediaUpdate) bool { return s.State == mediaPaused })
	const pausedTarget = 18000
	send(seekMedia, pausedTarget)
	paused := wait("seek while paused", time.Now().Add(seekTimeout), func(s mediaUpdate) bool {
		return s.Events&eventSeeked != 0 && s.SeekID == seekID
	})
	if paused.State != mediaPaused || paused.PositionMS < pausedTarget-500 || paused.PositionMS > pausedTarget+500 {
		t.Errorf("paused seek ended in state %d at %d ms", paused.State, paused.PositionMS)
	}
	send(playMedia, 0)
	wait("resume after paused seek", time.Now().Add(seekTimeout), func(s mediaUpdate) bool {
		return s.State == mediaPlaying && s.PositionMS > paused.PositionMS
	})

	// All three arrive during the previous seek's cooldown.
	send(seekMedia, 48000)
	send(seekMedia, 6000)
	const lastTarget = 28000
	send(seekMedia, lastTarget)
	burst := wait("seek burst", time.Now().Add(seekTimeout), func(s mediaUpdate) bool {
		if s.Events&eventSeeked == 0 {
			return false
		}
		if s.SeekID != seekID {
			t.Fatalf("an intermediate seek completed (ID %d, expected %d)", s.SeekID, seekID)
		}
		return true
	})
	if burst.PositionMS < lastTarget-500 || burst.PositionMS > lastTarget+500 {
		t.Errorf("seek burst finished at %d ms, expected %d ms", burst.PositionMS, lastTarget)
	}
	t.Logf("seek burst: final target %d ms, position %d ms", lastTarget, burst.PositionMS)
}
