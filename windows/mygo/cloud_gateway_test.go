package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestNativeLibraryAndRoomsAgainstCurrentMusicGateway(t *testing.T) {
	python := os.Getenv("CURRENTMUSIC_PARITY_PYTHON")
	if python == "" {
		t.Skip("set CURRENTMUSIC_PARITY_PYTHON and the backend Python dependencies")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, python, "parity/smoke_gateway.py", "--fixture-stdio")
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		stdin.Close()
		if err := cmd.Wait(); err != nil && ctx.Err() == nil {
			t.Errorf("temporary gateway did not exit cleanly: %v", err)
		}
	}()
	var fixture struct {
		Base     string
		Accounts []struct {
			ID                 int64
			Username, Password string
		}
	}
	if err := json.NewDecoder(stdout).Decode(&fixture); err != nil || len(fixture.Accounts) != 2 {
		t.Fatal("temporary gateway did not expose two independent accounts")
	}
	target, err := url.Parse(fixture.Base)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" {
		t.Fatal("temporary gateway did not bind to loopback")
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = -1
	handler := http.StripPrefix("/cm", proxy)
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/cm/live/chat" {
			r.URL.Path = "/cm/chat/live"
		}
		handler.ServeHTTP(w, r)
	}))
	defer tls.Close()
	savedHTTP := cloudHTTP
	cloudHTTP = tls.Client()
	defer func() { cloudHTTP = savedHTTP }()

	callbacks := make(chan func(), 32)
	base := tls.URL + "/cm"
	wait := func(done func() bool) {
		t.Helper()
		deadline := time.After(8 * time.Second)
		for !done() {
			select {
			case apply := <-callbacks:
				apply()
			case <-deadline:
				t.Fatal("native client did not receive the expected gateway result")
			}
		}
	}
	clients := make([]*cloudLibrary, 2)
	for i, account := range fixture.Accounts {
		s := newCloudLibrary(filepath.Join(t.TempDir(), "settings.json"), testCredentials{}, func(fn func()) { callbacks <- fn })
		clients[i] = s
		defer func() { s.cancel() }()
		s.reset(base)
		s.identity, s.secret = account.Username, account.Password
		s.login()
		wait(func() bool { return !s.busy })
		if s.user.ID != account.ID || s.notice != "" {
			t.Fatal("native password login did not use the expected account")
		}
	}
	owner, guest := clients[0], clients[1]
	owner.changePlaylist(http.MethodPost, cloudPlaylist{}, "桌面验收歌单", "", func() {})
	wait(func() bool { return !owner.busy })
	if len(owner.playlists) != 1 {
		t.Fatal("native playlist creation was not visible after refresh")
	}
	playlist := owner.playlists[0]
	var readback cloudPlaylist
	if err := owner.api.call(ctx, http.MethodGet, playlist.endpoint(), true, nil, &readback); err != nil || readback.ID != playlist.ID {
		t.Fatal("Web playlist contract did not read the native write")
	}
	update := map[string]string{"name": "网页侧更新"}
	if err := owner.api.call(ctx, http.MethodPut, playlist.endpoint(), true, update, nil); err != nil {
		t.Fatal("Web playlist contract could not update the native playlist")
	}
	owner.loadPlaylists()
	wait(func() bool { return !owner.busy })
	if len(owner.playlists) != 1 || owner.playlists[0].Name != update["name"] || len(guest.playlists) != 0 {
		t.Fatal("playlist update was not visible or leaked to the other account")
	}

	owner.rooms.form = roomForm{Name: "Windows 房间验收", IsPublic: true, NeedApproval: true, Password: "fixture"}
	owner.enterRoom("create", func() {})
	wait(func() bool { return !owner.busy })
	if owner.rooms.liveID == 0 || owner.rooms.detail.Role != "owner" {
		t.Fatalf("owner did not enter the new room: %s", owner.notice)
	}
	guest.openRoom(0, owner.rooms.detail.Room.Code, func() {})
	wait(func() bool { return !guest.busy })
	guest.rooms.password = "fixture"
	guest.enterRoom("join", func() {})
	wait(func() bool { return !guest.busy })
	if guest.rooms.liveID != owner.rooms.liveID || guest.rooms.detail.Role != "member" {
		t.Fatalf("second account did not join the password-protected room: %s", guest.notice)
	}
	song := cloudSong{ID: 1, Name: "审批测试曲目", Duration: 60000}
	guest.roomWrite(http.MethodPost, guest.rooms.liveID, "/queue", map[string]cloudSong{"meta": song}, nil)
	wait(func() bool {
		queue := owner.rooms.detail.Queue
		return len(queue) == 1 && queue[0].Status == "pending"
	})
	qid := owner.rooms.detail.Queue[0].ID
	owner.roomWrite(http.MethodPost, owner.rooms.liveID, "/queue/"+strconv.FormatInt(qid, 10)+"/approve", nil, nil)
	wait(func() bool {
		queue := guest.rooms.detail.Queue
		return len(queue) == 1 && queue[0].Status == "queued"
	})
	t.Log("two native sessions verified playlist readback, password-protected room joining and cross-client approval")
	owner.startChat()
	guest.community.chatDraft = "临时聊天室验收"
	guest.sendChat()
	wait(func() bool {
		return len(owner.community.chat) == 1 && owner.community.chat[0].UserID == guest.user.ID
	})
	guest.community.postDraft = "临时动态验收"
	guest.postText(0)
	wait(func() bool { return !guest.busy })
	owner.loadPosts(false)
	wait(func() bool { return !owner.busy })
	if len(owner.community.posts) != 1 || owner.community.posts[0].Author.ID != guest.user.ID {
		t.Fatal("the other account could not read the published post")
	}
	t.Log("the temporary gateway delivered chat and post changes to the other account")
}
