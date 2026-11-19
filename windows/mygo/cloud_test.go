package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

type testCredentials map[string]map[int64]string

func (c testCredentials) save(base string, id int64, token string) error {
	if c[base] == nil {
		c[base] = make(map[int64]string)
	}
	c[base][id] = token
	return nil
}
func (c testCredentials) load(base string, id int64) (string, error) { return c[base][id], nil }
func (c testCredentials) remove(base string, id int64) error {
	delete(c[base], id)
	return nil
}

func TestCloudAccountAndLibrary(t *testing.T) {
	logout := make(chan struct{}, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		write := func(payload string) { _, _ = w.Write([]byte(payload)) }
		path := strings.TrimPrefix(r.URL.Path, "/cm")
		auth := strings.HasPrefix(path, "/playlists") || strings.HasPrefix(path, "/likes") ||
			path == "/auth/me" || path == "/auth/logout"
		wantBearer := ""
		if auth {
			wantBearer = "Bearer first-fixture"
		}
		if got := r.Header.Get("Authorization"); got != wantBearer {
			t.Error("request bearer did not match its endpoint scope")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		body := map[string]json.RawMessage{}
		if r.Method != http.MethodGet {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error("invalid JSON request")
			}
		}
		switch path {
		case "/auth/login":
			if string(body["platform"]) != `"windows"` || string(body["username"]) != `"test-user"` {
				t.Error("wrong password-login contract")
			}
			write(`{"requires2FA":true,"challengeToken":"totp-fixture","expiresIn":300}`)
		case "/auth/2fa/login":
			if string(body["challengeToken"]) != `"totp-fixture"` || string(body["code"]) != `"123456"` {
				t.Error("wrong verification contract")
			}
			write(`{"token":"first-fixture","user":{"id":3,"username":"test-user"}}`)
		case "/auth/me":
			write(`{"id":3,"username":"test-user"}`)
		case "/auth/logout":
			write(`{"ok":true}`)
			logout <- struct{}{}
		case "/ncm/search":
			if r.URL.Query().Get("keywords") != "潮汐 + test" || r.URL.Query().Get("type") != "song" {
				t.Error("incorrect search query encoding")
			}
			if r.URL.Query().Get("offset") == "0" {
				write(`{"catalogSongs":[{"ncm_id":9,"name":"目录曲目"}],"songs":[{"ncm_id":4,"name":"潮汐"},{"ncm_id":9,"name":"重复"}],"hasMore":{"song":true}}`)
			} else if r.URL.Query().Get("offset") == "2" {
				write(`{"songs":[{"ncm_id":6,"name":"下一页"}],"hasMore":{"song":false}}`)
			} else {
				t.Error("catalog supplements changed upstream offset")
				w.WriteHeader(http.StatusBadRequest)
			}
		case "/ncm/song/detail":
			if r.URL.Query().Get("ids") != "4" {
				t.Error("wrong detail ID")
			}
			write(`{"songs":[{"ncm_id":4,"name":"潮汐","artists":"白岛","album":"潮汐线"}]}`)
		case "/likes/mine":
			write(`{"songs":[]}`)
		case "/likes/4":
			write(`{"on":true}`)
		case "/playlists":
			if r.Method == http.MethodPost {
				write(`{"id":7,"user_id":3,"name":"测试歌单"}`)
			} else {
				write(`{"playlists":[{"id":7,"user_id":3,"name":"测试歌单"},{"id":8,"user_id":99,"name":"外部账号"}]}`)
			}
		case "/playlists/7":
			write(`{"id":7,"user_id":3,"name":"测试歌单","tracks":[]}`)
		case "/playlists/7/tracks":
			if !strings.Contains(string(body["songs"]), `"ncm_id":4`) {
				t.Error("wrong playlist track mutation body")
			}
			write(`{"ok":true}`)
		default:
			t.Errorf("unexpected endpoint %s", path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	oldHTTP := cloudHTTP
	cloudHTTP = server.Client()
	defer func() { cloudHTTP = oldHTTP }()

	callbacks := make(chan func(), 4)
	store := testCredentials{}
	prefsPath := filepath.Join(t.TempDir(), "settings.json")
	s := newCloudLibrary(prefsPath, store, func(fn func()) { callbacks <- fn })
	t.Cleanup(func() { s.cancel() })
	complete := func() {
		t.Helper()
		select {
		case fn := <-callbacks:
			fn()
		case <-time.After(3 * time.Second):
			t.Fatal("API operation did not complete")
		}
		if s.notice != "" && s.notice != "歌单已更新" {
			t.Fatalf("unexpected client notice %q", s.notice)
		}
	}
	base := server.URL + "/cm"
	s.serverInput = base
	if !s.switchServer() {
		t.Fatal("server selection failed")
	}
	s.identity, s.secret = "test-user", "fixture password"
	s.login()
	complete()
	if s.challenge.ChallengeToken == "" || s.api.token != "" || len(store) != 0 || s.secret != "" {
		t.Fatal("login challenge was retained as a session")
	}
	s.code = "123456"
	s.verify()
	complete()
	complete()
	if s.user.ID != 3 || store[base][3] != "first-fixture" || len(s.playlists) != 1 {
		t.Fatal("verified session or isolated library missing")
	}
	data, _ := os.ReadFile(prefsPath)
	if strings.Contains(string(data), "first-fixture") || strings.Contains(string(data), "fixture password") {
		t.Fatal("secret written to preferences")
	}
	s.search("潮汐 + test", false)
	complete()
	if len(s.results) != 2 || s.results[0].ID != 9 || s.offset != 2 || !s.hasMore {
		t.Fatal("incorrect first search page")
	}
	s.search(s.keyword, true)
	complete()
	if len(s.results) != 3 || s.hasMore {
		t.Fatal("incorrect next search page")
	}
	s.selected = s.results[1]
	s.detail(s.selected)
	complete()
	if s.selected.Album != "潮汐线" {
		t.Fatal("song details were not adopted")
	}
	s.toggleLike(s.selected)
	complete()
	if !s.liked(4) {
		t.Fatal("like state missing")
	}
	song := s.selected
	s.loadPlaylist(s.playlists[0], func() {})
	complete()
	s.changePlaylistTrack(http.MethodPost, s.playlist, song)
	complete()
	if len(s.playlist.Tracks) != 1 {
		t.Fatal("added track missing")
	}
	s.changePlaylistTrack(http.MethodDelete, s.playlist, song)
	complete()
	if len(s.playlist.Tracks) != 0 {
		t.Fatal("removed track still present")
	}
	releaseOldRequest := make(chan struct{})
	requestCloud(s, func(context.Context, cloudAPI) (int, error) {
		<-releaseOldRequest
		return 42, nil
	}, func(int) { t.Error("a previous server's response modified the current state") })
	s.serverInput = server.URL + "/mirror"
	if !s.switchServer() || s.api.token != "" || s.user.ID != 0 || len(s.results) != 0 || len(s.likes) != 0 || len(s.playlists) != 0 {
		close(releaseOldRequest)
		t.Fatal("switching API path retained the previous account's state")
	}
	close(releaseOldRequest)
	complete()
	s.serverInput = base
	s.switchServer()
	complete()
	complete()
	if s.user.ID != 3 {
		t.Fatal("remembered server account did not restore")
	}
	s.logout()
	if s.api.token != "" || s.user.ID != 0 || store[base][3] != "" {
		t.Fatal("logout retained local credentials")
	}
	select {
	case <-logout:
	case <-time.After(3 * time.Second):
		t.Fatal("server logout was not sent")
	}
}

func TestCloudEmailAndSecurityQuestion(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch r.URL.Path {
		case "/auth/login/email":
			if body["email"] != "user@example.test" || body["code"] != "123456" {
				t.Error("wrong email-login request")
			}
			_, _ = w.Write([]byte(`{"requiresSecurityQuestion":true,"challengeToken":"question-fixture","securityQuestion":"你的测试问题？","expiresIn":300}`))
		case "/auth/security-question/login":
			if body["answer"] != "test answer" || body["challengeToken"] != "question-fixture" || r.Header.Get("Authorization") != "" {
				t.Error("wrong security-question request")
			}
			_, _ = w.Write([]byte(`{"token":"email-fixture","user":{"id":11,"username":"email-user"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	api := cloudAPI{base: server.URL, http: server.Client()}
	challenge, err := api.login(context.Background(), true, "USER@example.test", "123456")
	if err != nil || challenge.Token != "" || !challenge.RequiresSecurityQuestion || challenge.SecurityQuestion == "" {
		t.Fatal("missing email-login security question")
	}
	result, err := api.verify(context.Background(), challenge, "test answer")
	if err != nil || result.User.ID != 11 || result.Token == "" {
		t.Fatal("security-question login did not complete")
	}
}

func TestCloudHTTPSAndRedirectBoundary(t *testing.T) {
	for _, raw := range []string{"http://example.test/cm", "https://u@example.test/cm", "https://example.test/cm?", "https://example.test/cm#", "https://example.test/a/../cm", "https://example.test/a%2fcm"} {
		if _, err := normalizeAPIBase(raw); err == nil {
			t.Errorf("accepted ambiguous or unsafe base %s", raw)
		}
	}
	if base, err := normalizeAPIBase(" https://Example.Test:443/cm/ "); err != nil || base != "https://example.test/cm" {
		t.Fatalf("base normalization = %q, %v", base, err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cm/auth/me" {
			t.Error("authenticated redirect was followed")
		}
		http.Redirect(w, r, "/unrelated", http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = cloudHTTP.CheckRedirect
	api := cloudAPI{base: server.URL + "/cm", token: "redirect-fixture", http: client}
	err := api.call(context.Background(), http.MethodGet, "/auth/me", true, nil, nil)
	if e, ok := err.(cloudAPIError); !ok || e.status != http.StatusTemporaryRedirect {
		t.Fatalf("redirect handling = %v", err)
	}
}

func TestCloudSearchAndPlayFromView(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cm/ncm/search":
			if r.URL.Query().Get("keywords") != "潮汐" || r.Header.Get("Authorization") != "" {
				t.Error("search field sent incorrect query or credentials")
			}
			_, _ = w.Write([]byte(`{"songs":[{"ncm_id":4,"name":"潮汐线","artists":"白岛","duration":236000}]}`))
		case "/cm/ncm/song/url":
			if r.URL.Query().Get("id") != "4" || r.Header.Get("Authorization") != "Bearer playback-fixture" {
				t.Error("playback request lacked the selected song or current session")
			}
			_, _ = w.Write([]byte(`{"url":"https://fixture.example.test/media.mp3"}`))
		case "/cm/search/history":
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer playback-fixture" {
				t.Error("search history request lacked the current session")
			}
			_, _ = w.Write([]byte(`{"history":["潮汐"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	callbacks := make(chan func(), 1)
	a := newPrototype()
	a.cloud = newCloudLibrary("", nil, func(fn func()) { callbacks <- fn })
	defer a.cloud.cancel()
	a.cloud.api = cloudAPI{base: server.URL + "/cm", token: "playback-fixture", http: server.Client()}
	a.cloud.user = cloudUser{ID: 1}
	var opened probeSource
	a.playCloud = func(song cloudSong, list []cloudSong) {
		if len(list) != 1 || list[0].ID != song.ID {
			t.Fatal("search results did not become the playback context")
		}
		var err error
		opened, err = resolveCloudStream(context.Background(), a.cloud.api, song, a.quality, false)
		if err != nil {
			t.Error(err)
		}
	}
	tester := ui.NewTester(a.view, 600, 320)
	complete := func() {
		t.Helper()
		select {
		case fn := <-callbacks:
			fn()
			tester.Frame()
		case <-time.After(3 * time.Second):
			t.Fatal("view did not trigger API request")
		}
	}
	tester.Key(ui.Ctrl, ui.KeyF)
	tester.Type("潮汐")
	tester.Key(0, ui.KeyEnter)
	complete()
	if err := tester.Click("潮汐线"); err != nil {
		t.Fatal(err)
	}
	if a.cloud.selected.ID != 4 || opened.url != "" {
		t.Fatal("single click should select without playing")
	}
	tester.Key(0, ui.KeyEnter)
	if !opened.catalog || opened.title != "潮汐线" || opened.url != "https://fixture.example.test/media.mp3" {
		t.Fatal("Enter did not open the selected cloud track")
	}
}

func TestSavedCloudAccountsSwitchWithoutSharingState(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cm/auth/me":
			if r.Header.Get("Authorization") != "Bearer first-account-fixture" {
				t.Error("restoring the first account used a different session")
			}
			_, _ = w.Write([]byte(`{"id":11,"username":"first"}`))
		case "/cm/likes/mine":
			_, _ = w.Write([]byte(`{"songs":[]}`))
		case "/cm/playlists":
			_, _ = w.Write([]byte(`{"playlists":[]}`))
		default:
			t.Errorf("unexpected account endpoint %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	previousHTTP := cloudHTTP
	cloudHTTP = server.Client()
	defer func() { cloudHTTP = previousHTTP }()
	callbacks := make(chan func(), 4)
	store := testCredentials{}
	s := newCloudLibrary(filepath.Join(t.TempDir(), "settings.json"), store, func(fn func()) { callbacks <- fn })
	defer func() { s.cancel() }()
	base := server.URL + "/cm"
	s.reset(base)
	finish := func() {
		t.Helper()
		select {
		case fn := <-callbacks:
			fn()
		case <-time.After(3 * time.Second):
			t.Fatal("account request did not complete")
		}
	}
	s.finishLogin(cloudLogin{Token: "first-account-fixture", User: cloudUser{ID: 11, Username: "first"}})
	finish()
	s.switchAccount(0)
	s.finishLogin(cloudLogin{Token: "second-account-fixture", User: cloudUser{ID: 22, Username: "second"}})
	finish()
	s.results = []cloudSong{{ID: 9, Name: "second account result"}}
	s.switchAccount(11)
	finish()
	finish()
	if s.user.ID != 11 || len(s.results) != 0 || len(s.prefs.KnownAccounts[base]) != 2 {
		t.Fatal("switching accounts lost a saved login or leaked the previous account's state")
	}
}
