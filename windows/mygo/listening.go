package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

const listeningInterval = int64(30_000)

type listenClock struct {
	at      time.Time
	pos     int64
	total   int64
	playing bool
}

func (c *listenClock) sample(at time.Time, pos int64, playing, continuous bool) {
	if c.playing && continuous {
		elapsed := at.Sub(c.at).Milliseconds()
		delta := pos - c.pos
		if elapsed > 0 && elapsed <= 1500 && delta > 0 && delta <= elapsed+175 {
			c.total += min(delta, elapsed)
		}
	}
	c.at, c.pos, c.playing = at, pos, playing
}

func firstListenReport(duration int64) int64 {
	if duration <= 0 {
		return listeningInterval
	}
	return min(listeningInterval, max(1000, duration/2))
}

type listenEntry struct {
	Key, Base string
	User      int64
	Song      cloudSong
	PlayID    int64
	Total     int64
	Sent      int64
	Finished  bool
}

func newListenEntry(api cloudAPI, user int64, song cloudSong) listenEntry {
	var id [16]byte
	rand.Read(id[:])
	song.Picture = ""
	return listenEntry{Key: hex.EncodeToString(id[:]), Base: api.base, User: user, Song: song}
}

type listenOutbox struct {
	mu      sync.Mutex
	entries []listenEntry
	path    string
	api     cloudAPI
	user    int64
	wake    chan struct{}
	flight  chan struct{}
	checked map[string]listenCapability // Accessed only while holding flight.
}

type listenCapability struct {
	available bool
	until     time.Time
}

func newListenOutbox(path string) *listenOutbox {
	o := &listenOutbox{path: path, wake: make(chan struct{}, 1), flight: make(chan struct{}, 1), checked: make(map[string]listenCapability)}
	var entries []listenEntry
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &entries) == nil {
		o.entries = entries
		for i := range o.entries {
			o.entries[i].Finished = true
		}
	}
	return o
}

func (o *listenOutbox) setSession(api cloudAPI, user int64) {
	o.mu.Lock()
	o.api, o.user = api, user
	o.mu.Unlock()
	o.notify()
}

func (o *listenOutbox) notify() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func (o *listenOutbox) update(entry listenEntry) error {
	o.mu.Lock()
	i := o.find(entry.Key)
	if i < 0 {
		o.entries = append(o.entries, entry)
	} else {
		o.entries[i].Total = max(o.entries[i].Total, entry.Total)
		o.entries[i].Finished = o.entries[i].Finished || entry.Finished
	}
	err := o.save()
	o.mu.Unlock()
	o.notify()
	return err
}

func (o *listenOutbox) find(key string) int {
	for i, entry := range o.entries {
		if entry.Key == key {
			return i
		}
	}
	return -1
}

func (o *listenOutbox) save() error {
	if o.path == "" {
		return nil
	}
	return writeLocalJSON(o.path, o.entries)
}

func (o *listenOutbox) run(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.wake:
		case <-tick.C:
		}
		o.mu.Lock()
		api, user := o.api, o.user
		o.mu.Unlock()
		attempt, cancel := context.WithTimeout(ctx, 8*time.Second)
		o.flush(attempt, api, user)
		cancel()
	}
}

func (o *listenOutbox) flush(ctx context.Context, api cloudAPI, user int64) {
	if user <= 0 || api.token == "" {
		return
	}
	select {
	case o.flight <- struct{}{}:
		defer func() { <-o.flight }()
	case <-ctx.Done():
		return
	}
	o.mu.Lock()
	var pending []listenEntry
	for _, entry := range o.entries {
		if entry.Base == api.base && entry.User == user && (entry.PlayID == 0 || entry.Total > entry.Sent || entry.Finished) {
			pending = append(pending, entry)
		}
	}
	o.mu.Unlock()
	if len(pending) == 0 || !o.canReport(ctx, api) {
		return
	}
	for _, entry := range pending {
		if ctx.Err() != nil {
			return
		}
		playID, err := api.reportListen(ctx, entry)
		o.mu.Lock()
		i := o.find(entry.Key)
		if err == nil && entry.Finished {
			o.entries = append(o.entries[:i], o.entries[i+1:]...)
		} else {
			o.entries[i].PlayID = playID
			if err == nil {
				o.entries[i].Sent = entry.Total
			}
		}
		_ = o.save()
		o.mu.Unlock()
		var status cloudAPIError
		if errors.As(err, &status) && (status.status == http.StatusUnauthorized || status.status == http.StatusTooManyRequests) {
			return
		}
	}
}

func (o *listenOutbox) canReport(ctx context.Context, api cloudAPI) bool {
	if feature := o.checked[api.base]; time.Now().Before(feature.until) {
		return feature.available
	}
	var feature struct{ ClientPlayID bool }
	err := api.call(ctx, http.MethodGet, "/plays/capabilities", false, nil, &feature)
	var status cloudAPIError
	if err == nil || errors.As(err, &status) && status.status == http.StatusNotFound {
		o.checked[api.base] = listenCapability{feature.ClientPlayID, time.Now().Add(time.Minute)}
	}
	return err == nil && feature.ClientPlayID
}

func (a cloudAPI) reportListen(ctx context.Context, entry listenEntry) (int64, error) {
	endpoint := fmt.Sprintf("/plays/%d", entry.Song.ID)
	playID := entry.PlayID
	if playID == 0 {
		var result struct{ PlayID int64 }
		start := struct {
			cloudSong
			Platform     string `json:"platform"`
			ClientPlayID string `json:"clientPlayId"`
		}{entry.Song, "windows", entry.Key}
		if err := a.call(ctx, http.MethodPost, endpoint, true, start, &result); err != nil {
			return 0, err
		}
		if result.PlayID <= 0 {
			return 0, errors.New("服务器未返回播放记录编号")
		}
		playID = result.PlayID
	}
	if entry.Total > entry.Sent || entry.Finished {
		body := struct {
			PlayID   int64  `json:"playId"`
			Total    int64  `json:"totalMs"`
			Finished bool   `json:"finished"`
			Platform string `json:"platform"`
		}{playID, entry.Total, entry.Finished, "windows"}
		err := a.call(ctx, http.MethodPost, endpoint, true, body, nil)
		var status cloudAPIError
		if errors.As(err, &status) && status.status == http.StatusNotFound {
			return 0, err
		}
		return playID, err
	}
	return playID, nil
}
