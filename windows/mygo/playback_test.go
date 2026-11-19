package main

import (
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestPlaybackQueueModes(t *testing.T) {
	a, b, c := cloudSong{ID: 1}, cloudSong{ID: 2}, cloudSong{ID: 3}
	q := playQueue{index: -1}
	q.enqueue(a, true)
	if q.neighbor(1, false) != 0 {
		t.Fatal("queue must start with its first enqueued song")
	}
	q.start(b, []cloudSong{a, b, c})
	q.enqueue(a, true)
	q.enqueue(b, false)
	if q.index != 1 || !slices.Equal(q.songs, []cloudSong{a, b, a, c, b}) || q.neighbor(1, true) != 2 {
		t.Fatalf("unexpected queue: %+v", q)
	}
	q.mode = repeatSong
	if q.neighbor(1, true) != q.index || q.neighbor(1, false) != 2 {
		t.Fatal("single repeat should apply only at natural end")
	}
	q.index, q.mode = len(q.songs)-1, repeatQueue
	if q.neighbor(1, true) != 0 {
		t.Fatal("list repeat did not wrap")
	}
	q.remove(0)
	if q.songs[q.index] != b || q.index != len(q.songs)-1 {
		t.Fatal("removing an earlier track changed the current song")
	}
	q.mode = shuffleQueue
	q.start(c, []cloudSong{a, b, c})
	if q.index != 0 || q.songs[0] != c || !slices.Contains(q.songs[1:], a) || !slices.Contains(q.songs[1:], b) {
		t.Fatalf("shuffle lost songs or displaced the selection: %+v", q)
	}
}

func TestSavedQueueIsScopedAndRetainsCurrentTrack(t *testing.T) {
	dir := t.TempDir()
	path := queueSettingsPath(dir, "https://first.example.test/cm", 7)
	queue := playQueue{index: 109, mode: shuffleQueue}
	for id := int64(1); id <= 120; id++ {
		queue.songs = append(queue.songs, cloudSong{ID: id, Name: "测试曲目"})
	}
	if err := queue.save(path); err != nil {
		t.Fatal(err)
	}
	restored := restoreQueue(path)
	if len(restored.songs) != savedQueueLimit || restored.songs[restored.index].ID != 110 || restored.mode != shuffleQueue {
		t.Fatal("restored queue lost its current track or play mode")
	}
	for _, other := range []string{
		queueSettingsPath(dir, "https://second.example.test/cm", 7),
		queueSettingsPath(dir, "https://first.example.test/cm", 8),
	} {
		if restored := restoreQueue(other); len(restored.songs) != 0 || restored.index != -1 {
			t.Fatal("queue crossed server or account boundary")
		}
	}
}

func TestCloudLyricsNormalizeTokens(t *testing.T) {
	var response lyricResponse
	err := json.Unmarshal([]byte(`{"lines":[
		{"t":3000,"txt":"行级","w":[[3000,"错"]]},
		{"t":1000,"txt":"你好 world","trans":"翻译","words":[{"start":1000,"end":1500,"text":"你好 "},{"start":1500,"end":1800,"text":"world"}]},
		{"t":2000,"txt":"估算","w":[[2000,"估"],[2400,"算"]],"wSynth":true}
	]}`), &response)
	if err != nil {
		t.Fatal(err)
	}
	lines := response.timedLines()
	if len(lines) != 3 || lines[0].translation != "翻译" || len(lines[0].tokens) != 2 ||
		lines[0].tokens[1].Start != 1500 || !lines[1].estimated || len(lines[1].tokens) != 2 || len(lines[2].tokens) != 0 {
		t.Fatalf("unexpected lyric normalization: %+v", lines)
	}
}

func TestCloudAlbumArtUsesHTTPS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.Header.Get("Authorization") != "" {
			t.Error("artwork must use TLS without an account token")
		}
		art := image.NewRGBA(image.Rect(0, 0, 1, 1))
		art.SetRGBA(0, 0, color.RGBA{R: 16, G: 80, B: 64, A: 255})
		if err := png.Encode(w, art); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	art := fetchAlbumArt(context.Background(), server.Client(), "http"+strings.TrimPrefix(server.URL, "https"))
	if art == nil || coverTint(art).G != 80 {
		t.Fatal("album art was not upgraded to HTTPS or sampled correctly")
	}
}

func TestCloudStreamRetriesWithRefresh(t *testing.T) {
	var refresh []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		refresh = append(refresh, r.URL.Query().Get("refresh"))
		if r.URL.Query().Get("level") != "lossless" {
			t.Error("request lost the selected quality")
		}
		if len(refresh) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"url":"https://media.example.test/song.flac","type":"flac","sr":96000,"bits":24}`))
	}))
	defer server.Close()
	api := cloudAPI{base: server.URL, token: "stream-fixture", http: server.Client()}
	source, err := resolveCloudStream(context.Background(), api, cloudSong{ID: 1}, "无损", false)
	if err != nil || source.spec != "FLAC · 96.0 kHz · 24 bit" || !slices.Equal(refresh, []string{"", "1"}) {
		t.Fatalf("retry or source specification failed: %v, %q, %v", err, source.spec, refresh)
	}
}

func TestListeningClockExcludesDiscontinuities(t *testing.T) {
	var c listenClock
	now := time.Now()
	c.sample(now, 0, true, true)
	c.sample(now.Add(time.Second), 1000, true, true)
	c.sample(now.Add(2*time.Second), 30_000, true, false)
	c.sample(now.Add(3*time.Second), 31_000, false, true)
	c.sample(now.Add(4*time.Second), 31_000, false, false)
	c.sample(now.Add(5*time.Second), 31_000, true, true)
	c.sample(now.Add(20*time.Second), 46_000, true, true)
	c.sample(now.Add(21*time.Second), 47_000, true, true)
	if c.total != 3000 || firstListenReport(24_000) != 12_000 || firstListenReport(120_000) != 30_000 {
		t.Fatalf("wrong actual time or initial threshold: %d", c.total)
	}
}

func TestListeningOutboxRestartsAndRetries(t *testing.T) {
	var keys []string
	var totals []int64
	var final []bool
	offline := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/plays/capabilities" {
			if r.Header.Get("Authorization") != "" {
				t.Error("capability check sent credentials")
			}
			_, _ = w.Write([]byte(`{"clientPlayId":true}`))
			return
		}
		var body struct {
			ClientPlayID, Platform string
			PlayID, TotalMS        int64
			Finished               bool
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Platform != "windows" || r.Header.Get("Authorization") != "Bearer report-fixture" {
			t.Error("report did not use the correct platform and scoped account")
		}
		if body.PlayID == 0 {
			keys = append(keys, body.ClientPlayID)
			if len(keys) == 1 {
				w.WriteHeader(http.StatusServiceUnavailable) // Server accepted it but the client missed the ACK.
				return
			}
			_, _ = w.Write([]byte(`{"playId":17}`))
			return
		}
		if offline {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		totals, final = append(totals, body.TotalMS), append(final, body.Finished)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "outbox.json")
	api := cloudAPI{base: server.URL, token: "report-fixture", http: server.Client()}
	entry := newListenEntry(api, 1, cloudSong{ID: 2, Name: "测试歌曲", Duration: 200_000})
	o := newListenOutbox(path)
	update := func() {
		if err := o.update(entry); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	update()
	o.flush(ctx, api, 1)
	entry.Total = 30_000
	update()
	o.flush(ctx, api, 2)
	o.flush(ctx, api, 1)
	offline = true
	entry.Total, entry.Finished = 37_000, true
	update()
	o.flush(ctx, api, 1)
	saved, err := os.ReadFile(path)
	if err != nil || strings.Contains(string(saved), api.token) {
		t.Fatal("outbox failed to save without the bearer token")
	}
	offline = false
	o = newListenOutbox(path)
	o.flush(ctx, api, 1)
	o.flush(ctx, api, 1)
	if !slices.Equal(keys, []string{entry.Key, entry.Key}) || !slices.Equal(totals, []int64{30_000, 37_000}) ||
		!slices.Equal(final, []bool{false, true}) || len(o.entries) != 0 {
		t.Fatalf("incorrect retry, scope or final delivery: starts %d, totals %v, finished %v", len(keys), totals, final)
	}
}
