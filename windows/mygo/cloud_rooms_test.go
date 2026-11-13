package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestRoomEventWatcherRecoversFromResetAndFallback(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer room-fixture" || r.URL.Query().Has("token") {
			t.Error("room stream leaked or omitted the scoped authorization")
		}
		switch r.URL.Path {
		case "/cm/rooms/23":
			_, _ = fmt.Fprintf(w, `{"room":{"id":23},"role":"member","latestSeq":14,"serverTime":%d,"timeline":{"trackRevision":4}}`, time.Now().UnixMilli())
		case "/cm/rooms/23/events":
			q := r.URL.Query()
			if q.Get("sse") == "1" {
				switch q.Get("since") {
				case "10":
					http.Error(w, "fixture SSE unavailable", http.StatusBadGateway)
				case "14":
					if r.Header.Get("Last-Event-ID") != "14" {
						t.Error("SSE did not resume from the reconciled snapshot")
					}
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprint(w, "data: {\"seq\":15,\"type\":\"play\",\"payload\":{\"timeline\":{\"trackRevision\":5}}}\n\n"+
						"data: {\"seq\":15,\"type\":\"close\"}\n\n")
				default:
					t.Errorf("unexpected SSE cursor %s", q.Get("since"))
					w.WriteHeader(http.StatusBadRequest)
				}
			} else if q.Get("since") == "10" && q.Get("wait") == "20" {
				_, _ = fmt.Fprint(w, `{"events":[{"seq":11,"type":"reset"}],"latestSeq":90}`)
			} else {
				t.Error("long polling skipped unprocessed events")
				w.WriteHeader(http.StatusBadRequest)
			}
		default:
			t.Errorf("unexpected room endpoint %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	callbacks := make(chan func(), 32)
	library := newCloudLibrary("", nil, func(fn func()) { callbacks <- fn })
	defer library.cancel()
	library.api = cloudAPI{base: server.URL + "/cm", token: "room-fixture", http: server.Client()}
	var revisions []int64
	library.roomTimelineChanged = func(timeline *roomTimeline, offset int64) {
		if timeline == nil {
			revisions = append(revisions, -1)
		} else {
			revisions = append(revisions, timeline.TrackRevision)
		}
	}
	library.watchRoom(roomSnapshot{
		Room: cloudRoom{ID: 23}, Role: "owner", LatestSeq: 10,
		Timeline: &roomTimeline{TrackRevision: 3},
	})
	timeout := time.After(5 * time.Second)
	for library.rooms.liveID != 0 {
		select {
		case fn := <-callbacks:
			fn()
		case <-timeout:
			t.Fatal("room watcher did not finish")
		}
	}
	if !reflect.DeepEqual(revisions, []int64{3, 4, 5, -1}) {
		t.Fatalf("unexpected timeline sequence %v", revisions)
	}
}
