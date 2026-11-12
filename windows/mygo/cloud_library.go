package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

type sessionCredentials interface {
	save(string, int64, string) error
	load(string, int64) (string, error)
	remove(string, int64) error
}

type cloudPreferences struct {
	Base          string                 `json:"apiBase"`
	Accounts      map[string]int64       `json:"accounts"`
	KnownAccounts map[string][]cloudUser `json:"knownAccounts,omitempty"`
}

type cloudLibrary struct {
	api                 cloudAPI
	user                cloudUser
	challenge           cloudLogin
	challengeEnd        time.Time
	emailLogin          bool
	identity            string
	secret              string
	code                string
	account             cloudAccountPanel
	binding             cloudBindingPanel
	rooms               cloudRooms
	community           cloudCommunity
	serverInput         string
	notice              string
	busy                bool
	scope               context.Context
	cancel              context.CancelFunc
	dispatch            func(func())
	openBrowser         func(string) error
	saveFile            func(string) (string, error)
	copyText            func(string) error
	cancelPasskey       context.CancelFunc
	credentials         sessionCredentials
	prefsPath           string
	prefs               cloudPreferences
	stopPlayback        func() bool
	sessionChanged      func(cloudAPI, int64)
	roomTimelineChanged func(*roomTimeline, int64)
	beforeRevoke        func(cloudAPI, int64)
	keyword             string
	searchKind          string
	offset              int
	hasMore             bool
	results             []cloudSong
	recent              []cloudSong
	explore             cloudExploreState
	songInfo            cloudSongInfo
	searchHistory       []string
	searchTips          []string
	tipsFor             string
	historyOpen         bool
	catalog             []cloudCatalogItem
	catalogDetail       cloudCatalogDetail
	catalogBack         []cloudCatalogDetail
	likes               []cloudSong
	playlists           []cloudPlaylist
	playlist            cloudPlaylist
	selected            cloudSong
	playlistName        string
	description         string
	confirmDelete       bool
}

func newCloudLibrary(path string, credentials sessionCredentials, dispatch func(func())) *cloudLibrary {
	s := &cloudLibrary{prefsPath: path, credentials: credentials, dispatch: dispatch}
	if data, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(data, &s.prefs)
	}
	base, err := normalizeAPIBase(s.prefs.Base)
	if err != nil {
		base = officialAPI
	}
	if s.prefs.Accounts == nil {
		s.prefs.Accounts = make(map[string]int64)
	}
	if s.prefs.KnownAccounts == nil {
		s.prefs.KnownAccounts = make(map[string][]cloudUser)
	}
	s.reset(base)
	return s
}

func (s *cloudLibrary) reset(base string) {
	if s.cancel != nil {
		s.cancel()
	}
	s.stopBindingQR()
	s.stopRoom("")
	s.stopChat()
	if s.cancelPasskey != nil {
		s.cancelPasskey()
		s.cancelPasskey = nil
	}
	s.scope, s.cancel = context.WithCancel(context.Background())
	s.api = cloudAPI{base: base, http: cloudHTTP}
	s.serverInput, s.prefs.Base = base, base
	s.user, s.challenge = cloudUser{}, cloudLogin{}
	s.account = cloudAccountPanel{}
	s.binding = cloudBindingPanel{}
	s.rooms = cloudRooms{}
	s.community = cloudCommunity{}
	s.identity, s.secret, s.code, s.notice, s.busy = "", "", "", "", false
	s.keyword, s.searchKind, s.offset, s.hasMore = "", "song", 0, false
	s.results, s.likes, s.playlists = nil, nil, nil
	s.recent, s.searchHistory, s.searchTips, s.tipsFor, s.historyOpen = nil, nil, nil, "", false
	s.explore = cloudExploreState{}
	s.songInfo = cloudSongInfo{}
	s.catalog, s.catalogDetail, s.catalogBack = nil, cloudCatalogDetail{}, nil
	s.playlist, s.selected = cloudPlaylist{}, cloudSong{}
	s.playlistName, s.description, s.confirmDelete = "", "", false
	if s.sessionChanged != nil {
		s.sessionChanged(s.api, 0)
	}
}

func (s *cloudLibrary) savePrefs() error {
	if err := writeLocalJSON(s.prefsPath, s.prefs); err != nil {
		return errors.New("无法保存服务器设置")
	}
	return nil
}

func writeLocalJSON(path string, value any) error {
	if path == "" {
		return errors.New("missing local data path")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".currentmusic-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func (s *cloudLibrary) switchServer() bool {
	base, err := normalizeAPIBase(s.serverInput)
	if err != nil {
		s.notice = err.Error()
		return false
	}
	if base == s.api.base {
		s.serverInput = base
		return false
	}
	if s.stopPlayback != nil && !s.stopPlayback() {
		s.notice = "媒体组件正忙，请重试切换"
		return false
	}
	s.reset(base)
	if err := s.savePrefs(); err != nil {
		s.notice = err.Error()
	}
	s.restore()
	return true
}

func requestCloud[T any](s *cloudLibrary, request func(context.Context, cloudAPI) (T, error), apply func(T)) {
	if s.busy {
		return
	}
	s.busy = true
	s.notice = ""
	ctx, api := s.scope, s.api
	go func() {
		result, err := request(ctx, api)
		s.dispatch(func() {
			if ctx.Err() != nil {
				return
			}
			s.busy = false
			if err != nil {
				var status cloudAPIError
				if errors.As(err, &status) && status.authenticated && status.status == http.StatusUnauthorized {
					s.discardSession()
				}
				s.addNotice(err.Error())
				return
			}
			apply(result)
		})
	}()
}

func (s *cloudLibrary) addNotice(message string) {
	if s.notice != "" {
		s.notice += " · "
	}
	s.notice += message
}

func (s *cloudLibrary) restore() {
	id := s.prefs.Accounts[s.api.base]
	if id <= 0 {
		return
	}
	base, store := s.api.base, s.credentials
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudLogin, error) {
		token, err := store.load(base, id)
		if err != nil || token == "" {
			return cloudLogin{}, err
		}
		api.token = token
		result := cloudLogin{Token: token}
		err = api.call(ctx, http.MethodGet, "/auth/me", true, nil, &result.User)
		if err == nil && result.User.ID != id {
			err = cloudAPIError{http.StatusUnauthorized, true}
		}
		return result, err
	}, func(result cloudLogin) {
		s.user, s.api.token = result.User, result.Token
		if result.User.ID > 0 {
			if s.rememberAccount(result.User) {
				if err := s.savePrefs(); err != nil {
					s.addNotice(err.Error())
				}
			}
			if s.sessionChanged != nil {
				s.sessionChanged(s.api, s.user.ID)
			}
			s.refreshAccountLibrary()
		} else {
			delete(s.prefs.Accounts, base)
			s.forgetAccount(base, id)
			if err := s.savePrefs(); err != nil {
				s.notice = err.Error()
			}
		}
	})
}

func (s *cloudLibrary) discardSession() {
	base := s.api.base
	stopped := s.stopPlayback == nil || s.stopPlayback()
	remembered := s.prefs.Accounts[base]
	id := s.user.ID
	if id == 0 {
		id = remembered
	}
	if id == remembered {
		delete(s.prefs.Accounts, base)
	}
	s.forgetAccount(base, id)
	s.reset(base)
	if !stopped {
		s.addNotice("媒体组件正忙，请手动停止播放")
	}
	if id > 0 {
		if err := s.credentials.remove(base, id); err != nil {
			s.addNotice(err.Error())
		}
	}
	if err := s.savePrefs(); err != nil {
		s.addNotice(err.Error())
	}
}

func (s *cloudLibrary) logout() {
	api, id, dispatch := s.api, s.user.ID, s.dispatch
	s.discardSession()
	s.addNotice("已退出本机账号")
	scope := s.scope
	go func() {
		if s.beforeRevoke != nil {
			s.beforeRevoke(api, id)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := api.call(ctx, http.MethodPost, "/auth/logout", true, struct{}{}, nil); err != nil {
			dispatch(func() {
				if scope.Err() == nil {
					s.addNotice("服务器会话撤销未确认")
				}
			})
		}
	}()
}

func (s *cloudLibrary) sendEmailCode() {
	email := strings.ToLower(strings.TrimSpace(s.identity))
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		err := api.call(ctx, http.MethodPost, "/auth/login/email/code", false, map[string]string{"email": email}, nil)
		return struct{}{}, err
	}, func(struct{}) { s.notice = "验证码已发送，5 分钟内有效" })
}

func (s *cloudLibrary) login() {
	email, identity, secret := s.emailLogin, strings.TrimSpace(s.identity), s.secret
	if email {
		secret = s.code
	}
	s.secret, s.code = "", ""
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudLogin, error) {
		return api.login(ctx, email, identity, secret)
	}, s.finishLogin)
}

func (s *cloudLibrary) verify() {
	if time.Now().After(s.challengeEnd) {
		s.challenge, s.code = cloudLogin{}, ""
		s.notice = "挑战已过期，请重新登录"
		return
	}
	challenge, code := s.challenge, s.code
	s.code = ""
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudLogin, error) {
		return api.verify(ctx, challenge, code)
	}, s.finishLogin)
}

func (s *cloudLibrary) finishLogin(result cloudLogin) {
	if result.ChallengeToken != "" {
		s.challenge, s.challengeEnd = result, time.Now().Add(time.Duration(min(result.ExpiresIn, 300))*time.Second)
		return
	}
	s.challenge, s.user, s.api.token = cloudLogin{}, result.User, result.Token
	if s.sessionChanged != nil {
		s.sessionChanged(s.api, s.user.ID)
	}
	s.identity = ""
	base, id := s.api.base, result.User.ID
	old := s.prefs.Accounts[base]
	if err := s.credentials.save(base, id, result.Token); err != nil {
		s.notice = err.Error() + "，本次登录仍有效"
		return
	}
	s.prefs.Accounts[base] = id
	known := slices.Clone(s.prefs.KnownAccounts[base])
	s.rememberAccount(result.User)
	if err := s.savePrefs(); err != nil {
		s.prefs.KnownAccounts[base] = known
		if old != id {
			if !slices.ContainsFunc(known, func(user cloudUser) bool { return user.ID == id }) {
				_ = s.credentials.remove(base, id)
			}
			if old == 0 {
				delete(s.prefs.Accounts, base)
			} else {
				s.prefs.Accounts[base] = old
			}
		}
		s.notice = err.Error() + "，本次登录仍有效"
		return
	}
	s.account = cloudAccountPanel{}
	if s.notice == "" {
		s.refreshAccountLibrary()
	}
}

func (s *cloudLibrary) refreshAccountLibrary() {
	type accountLibrary struct {
		cloudSongs
		Playlists []cloudPlaylist
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (accountLibrary, error) {
		var result accountLibrary
		if err := api.call(ctx, http.MethodGet, "/likes/mine", true, nil, &result); err != nil {
			return result, err
		}
		err := api.call(ctx, http.MethodGet, "/playlists", true, nil, &result)
		return result, err
	}, func(result accountLibrary) {
		s.likes = appendCloudSongs(nil, result.Songs)
		s.setPlaylists(result.Playlists)
	})
}

func (s *cloudLibrary) search(query string, more bool) {
	s.searchCatalog(query, s.searchKind, more, false)
}

func (s *cloudLibrary) searchCatalog(query, kind string, more, record bool) {
	query = strings.TrimSpace(query)
	if query == "" || more && (!s.hasMore || query != s.keyword || kind != s.searchKind) {
		return
	}
	offset := 0
	if more {
		offset = s.offset
	}
	type searchResponse struct {
		cloudSearchResult
		history   []string
		historyOK bool
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (searchResponse, error) {
		var response searchResponse
		var err error
		if kind == "match" {
			response.cloudSearchResult, err = api.searchMatches(ctx, query)
		} else {
			response.cloudSearchResult, err = api.search(ctx, query, kind, offset)
		}
		if err == nil && record && api.token != "" {
			historyCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			defer cancel()
			response.history, err = api.searchHistory(historyCtx, http.MethodPost, map[string]string{"keyword": query})
			response.historyOK = err == nil
			err = nil
		}
		return response, err
	}, func(result searchResponse) {
		s.keyword, s.searchKind = query, kind
		if !more {
			s.selected, s.catalogDetail, s.catalogBack = cloudSong{}, cloudCatalogDetail{}, nil
			s.results, s.catalog = nil, nil
			s.searchTips, s.tipsFor, s.historyOpen = nil, "", false
		}
		if result.historyOK {
			s.searchHistory = result.history
		}
		count, countKey := len(result.Songs), "song"
		switch kind {
		case "album":
			count, countKey = len(result.Albums), kind
			s.catalog = appendCatalog(s.catalog, result.Albums, kind)
		case "artist":
			count, countKey = len(result.Artists), kind
			s.catalog = appendCatalog(s.catalog, result.Artists, kind)
		case "playlist":
			count, countKey = len(result.Playlists), kind
			s.catalog = appendCatalog(s.catalog, result.Playlists, kind)
		case "match":
			s.results = appendCloudSongs(nil, result.Songs)
			s.catalog = appendCatalog(nil, result.Artists, "artist")
			s.catalog = appendCatalog(s.catalog, result.Albums, "album")
			s.catalog = appendCatalog(s.catalog, result.Playlists, "playlist")
		default:
			if !more && kind == "song" {
				s.results = appendCloudSongs(s.results, result.CatalogSongs)
			}
			s.results = appendCloudSongs(s.results, result.Songs)
		}
		s.offset = offset + count
		s.hasMore = count > 0 && result.HasMore[countKey] && s.offset <= cloudSearchMaxOffset
	})
}

func appendCatalog(existing, incoming []cloudCatalogItem, kind string) []cloudCatalogItem {
	for _, item := range incoming {
		if item.ID <= 0 || strings.TrimSpace(item.Name) == "" {
			continue
		}
		if !slices.ContainsFunc(existing, func(current cloudCatalogItem) bool {
			return current.ID == item.ID && current.Kind == kind
		}) {
			item.Kind = kind
			existing = append(existing, item)
		}
	}
	return existing
}

func (s *cloudLibrary) openCatalog(item cloudCatalogItem) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudCatalogDetail, error) {
		return api.catalogDetail(ctx, item, 0, false)
	}, func(result cloudCatalogDetail) {
		if result.ID != item.ID || result.Name == "" {
			s.notice = "服务器暂无该条目的详情"
			return
		}
		if s.catalogDetail.ID > 0 {
			s.catalogBack = append(s.catalogBack, s.catalogDetail)
		}
		result.songOffset, result.albumOffset = len(result.Songs), len(result.Albums)
		result.Songs = appendCloudSongs(nil, result.Songs)
		result.Albums = appendCatalog(nil, result.Albums, "album")
		s.catalogDetail, s.selected = result, cloudSong{}
	})
}

func (s *cloudLibrary) loadMoreCatalog(albums bool) {
	item, offset := s.catalogDetail.cloudCatalogItem, s.catalogDetail.songOffset
	if albums {
		offset = s.catalogDetail.albumOffset
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudCatalogDetail, error) {
		return api.catalogDetail(ctx, item, offset, albums)
	}, func(result cloudCatalogDetail) {
		if albums {
			s.catalogDetail.albumOffset += len(result.Albums)
			s.catalogDetail.Albums = appendCatalog(s.catalogDetail.Albums, result.Albums, "album")
			s.catalogDetail.AlbumsMore = result.More && len(result.Albums) > 0
		} else {
			s.catalogDetail.songOffset += len(result.Songs)
			s.catalogDetail.Songs = appendCloudSongs(s.catalogDetail.Songs, result.Songs)
			s.catalogDetail.More = result.More && len(result.Songs) > 0
		}
	})
}

func appendCloudSongs(existing, incoming []cloudSong) []cloudSong {
	seen := make(map[int64]bool, len(existing)+len(incoming))
	for _, song := range existing {
		seen[song.ID] = true
	}
	for _, song := range incoming {
		if song.ID > 0 && strings.TrimSpace(song.Name) != "" && !seen[song.ID] {
			existing = append(existing, song)
			seen[song.ID] = true
		}
	}
	return existing
}

func (s *cloudLibrary) detail(song cloudSong) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudSongs, error) {
		var result cloudSongs
		err := api.call(ctx, http.MethodGet, "/ncm/song/detail?ids="+strconv.FormatInt(song.ID, 10), false, nil, &result)
		return result, err
	}, func(result cloudSongs) {
		if s.selected.ID != song.ID {
			return
		}
		for _, item := range result.Songs {
			if item.ID == song.ID && item.Name != "" {
				s.selected = item
				return
			}
		}
		s.notice = "服务器暂无这首歌的详情"
	})
}

func (s *cloudLibrary) loadLikes() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudSongs, error) {
		var result cloudSongs
		err := api.call(ctx, http.MethodGet, "/likes/mine", true, nil, &result)
		return result, err
	}, func(result cloudSongs) { s.likes = appendCloudSongs(nil, result.Songs) })
}

func (s *cloudLibrary) liked(id int64) bool {
	return slices.ContainsFunc(s.likes, func(item cloudSong) bool { return item.ID == id })
}

func (s *cloudLibrary) toggleLike(song cloudSong) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (bool, error) {
		var result struct{ On bool }
		err := api.call(ctx, http.MethodPost, fmt.Sprintf("/likes/%d", song.ID), true, song, &result)
		return result.On, err
	}, func(on bool) {
		if on {
			s.likes = appendCloudSongs(s.likes, []cloudSong{song})
		} else {
			s.likes = slices.DeleteFunc(s.likes, func(item cloudSong) bool { return item.ID == song.ID })
		}
	})
}

func (s *cloudLibrary) loadPlaylists() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudPlaylist, error) {
		var result struct{ Playlists []cloudPlaylist }
		err := api.call(ctx, http.MethodGet, "/playlists", true, nil, &result)
		return result.Playlists, err
	}, s.setPlaylists)
}

func (s *cloudLibrary) setPlaylists(items []cloudPlaylist) {
	s.playlists = slices.DeleteFunc(items, func(p cloudPlaylist) bool { return p.ID <= 0 || p.UserID != s.user.ID })
}

func (s *cloudLibrary) loadPlaylist(item cloudPlaylist, apply func()) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudPlaylist, error) {
		var result cloudPlaylist
		err := api.call(ctx, http.MethodGet, item.endpoint(), true, nil, &result)
		return result, err
	}, func(result cloudPlaylist) {
		if result.ID != item.ID || result.UserID != s.user.ID {
			s.notice = "歌单不属于当前账号"
			return
		}
		result.Tracks = appendCloudSongs(nil, result.Tracks)
		s.playlist, s.selected = result, cloudSong{}
		s.playlistName, s.description, s.confirmDelete = result.Name, result.Description, false
		apply()
	})
}

func (s *cloudLibrary) changePlaylist(method string, item cloudPlaylist, name, description string, apply func()) {
	endpoint := "/playlists"
	if item.ID > 0 {
		if !item.editableBy(s.user.ID) {
			return
		}
		endpoint = item.endpoint()
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudPlaylist, error) {
		var result cloudPlaylist
		err := api.call(ctx, method, endpoint, true, map[string]string{"name": name, "description": description}, &result)
		return result, err
	}, func(result cloudPlaylist) {
		s.confirmDelete = false
		if method == http.MethodPut {
			s.playlist.Name, s.playlist.Description = result.Name, result.Description
		}
		apply()
		s.loadPlaylists()
	})
}

func (s *cloudLibrary) changePlaylistTrack(method string, item cloudPlaylist, song cloudSong) {
	if !item.editableBy(s.user.ID) {
		return
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (int, error) {
		var result struct{ Count int }
		err := api.call(ctx, method, item.endpoint()+"/tracks", true, cloudSongs{Songs: []cloudSong{song}}, &result)
		return result.Count, err
	}, func(count int) {
		for i := range s.playlists {
			if s.playlists[i].ID == item.ID {
				s.playlists[i].TrackCount = count
				break
			}
		}
		if s.playlist.ID == item.ID {
			s.playlist.TrackCount = count
			if method == http.MethodPost {
				s.playlist.Tracks = appendCloudSongs(s.playlist.Tracks, []cloudSong{song})
			} else {
				s.playlist.Tracks = slices.DeleteFunc(s.playlist.Tracks, func(track cloudSong) bool { return track.ID == song.ID })
				if s.selected.ID == song.ID {
					s.selected = cloudSong{}
				}
			}
		}
		s.notice = "歌单已更新"
	})
}
