package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
)

type cloudAPI struct {
	base, token string
	http        *http.Client
}

var cloudHTTP = &http.Client{
	Timeout:       45 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func normalizeAPIBase(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil ||
		u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") ||
		u.RawPath != "" || strings.Contains(u.Path, "\\") {
		return "", errors.New("请输入有效的 HTTPS API 基址，地址中不能含凭据、查询或片段")
	}
	host := strings.ToLower(u.Hostname())
	if port := u.Port(); port != "" && port != "443" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return "", errors.New("HTTPS 端口无效")
		}
		u.Host = net.JoinHostPort(host, strconv.Itoa(n))
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	if u.Path != "" {
		trimmed := strings.TrimRight(u.Path, "/")
		if trimmed != "" && path.Clean(trimmed) != trimmed {
			return "", errors.New("HTTPS API 路径无效")
		}
		u.Path = trimmed
	}
	return u.String(), nil
}

type cloudAPIError struct {
	status        int
	authenticated bool
}

func (e cloudAPIError) Error() string {
	switch e.status {
	case http.StatusUnauthorized:
		if e.authenticated {
			return "登录已失效，请重新登录"
		}
		return "身份验证未通过，请检查输入"
	case http.StatusForbidden:
		return "服务器拒绝此操作"
	case http.StatusTooManyRequests:
		return "请求过于频繁，请稍后再试"
	default:
		return fmt.Sprintf("服务器返回 HTTP %d", e.status)
	}
}

func (a cloudAPI) call(ctx context.Context, method, endpoint string, auth bool, body, result any) error {
	// Endpoints are internal relative paths. Query parameters are encoded separately.
	if !strings.HasPrefix(endpoint, "/") || strings.HasPrefix(endpoint, "//") {
		return errors.New("API 路径无效")
	}
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return errors.New("无法编码请求")
		}
		defer clear(data)
		input = bytes.NewReader(data)
	}
	if auth && a.token == "" {
		return errors.New("请先登录 CurrentMusic")
	}
	request, err := http.NewRequestWithContext(ctx, method, a.base+endpoint, input)
	if err != nil {
		return errors.New("无法构建 API 请求")
	}
	request.Header.Set("User-Agent", "CurrentMusic-Windows/2.0")
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if auth {
		request.Header.Set("Authorization", "Bearer "+a.token)
	}
	resp, err := a.http.Do(request)
	if err != nil {
		return errors.New("连接失败或请求超时，请检查服务器地址与网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return cloudAPIError{resp.StatusCode, auth}
	}
	if result == nil {
		return nil
	}
	const maxResponse = 8 << 20
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	defer clear(data)
	if err != nil || len(data) > maxResponse || json.Unmarshal(data, result) != nil {
		return errors.New("无法读取服务器响应")
	}
	return nil
}

type cloudUser struct {
	ID                                   int64
	Username, Nickname, Bio, PassportUID string
}

type cloudLogin struct {
	Token                    string
	User                     cloudUser
	Requires2FA              bool
	RequiresSecurityQuestion bool
	ChallengeToken           string
	SecurityQuestion         string
	ExpiresIn                int
}

func (a cloudAPI) login(ctx context.Context, email bool, identity, secret string) (cloudLogin, error) {
	endpoint := "/auth/login"
	body := map[string]string{"device": "CurrentMusic Windows", "platform": "windows"}
	if email {
		endpoint = "/auth/login/email"
		body["email"], body["code"] = strings.ToLower(identity), strings.TrimSpace(secret)
	} else {
		body["username"], body["password"] = identity, secret
	}
	return a.loginRequest(ctx, endpoint, body)
}

func (a cloudAPI) verify(ctx context.Context, challenge cloudLogin, secret string) (cloudLogin, error) {
	endpoint, field := "/auth/2fa/login", "code"
	if challenge.RequiresSecurityQuestion {
		endpoint, field = "/auth/security-question/login", "answer"
	}
	return a.loginRequest(ctx, endpoint, map[string]string{"challengeToken": challenge.ChallengeToken, field: strings.TrimSpace(secret)})
}

func (a cloudAPI) loginRequest(ctx context.Context, endpoint string, body map[string]string) (cloudLogin, error) {
	var result cloudLogin
	err := a.call(ctx, http.MethodPost, endpoint, false, body, &result)
	if err == nil {
		switch {
		case result.Requires2FA || result.RequiresSecurityQuestion:
			if result.Requires2FA == result.RequiresSecurityQuestion || result.ChallengeToken == "" ||
				result.Token != "" || result.ExpiresIn <= 0 {
				err = errors.New("服务器返回了无效的登录挑战")
			}
		case result.ChallengeToken != "" || !validSessionToken(result.Token) || result.User.ID <= 0:
			err = errors.New("服务器未签发有效会话")
		}
	}
	return result, err
}

func validSessionToken(token string) bool {
	if len(token) == 0 || len(token) > 2560 {
		return false
	}
	for _, r := range token {
		if r <= ' ' || r >= 127 {
			return false
		}
	}
	return true
}

type cloudSong struct {
	ID       int64  `json:"ncm_id"`
	Name     string `json:"name"`
	Artists  string `json:"artists"`
	Album    string `json:"album"`
	Picture  string `json:"pic"`
	Duration int64  `json:"duration"`
	Lyric    string `json:"lyric,omitempty"`
}

type cloudSongs struct {
	Songs []cloudSong `json:"songs"`
}

type cloudSearchResult struct {
	cloudSongs
	CatalogSongs []cloudSong
	Artists      []cloudCatalogItem
	Albums       []cloudCatalogItem
	Playlists    []cloudCatalogItem
	HasMore      map[string]bool
}

type cloudCatalogItem struct {
	ID                   int64
	Name, Artist, Alias  string
	Creator, Description string
	Kind                 string `json:"-"`
}

type cloudCatalogDetail struct {
	cloudCatalogItem
	cloudSongs
	Albums      []cloudCatalogItem
	More        bool
	AlbumsMore  bool
	songOffset  int
	albumOffset int
}

const cloudSearchLimit = 30
const cloudSearchMaxOffset = 1000

func (a cloudAPI) search(ctx context.Context, query, kind string, offset int) (cloudSearchResult, error) {
	q := url.Values{"keywords": {query}, "type": {kind}, "offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(cloudSearchLimit)}}
	var result cloudSearchResult
	err := a.call(ctx, http.MethodGet, "/ncm/search?"+q.Encode(), false, nil, &result)
	return result, err
}

func (a cloudAPI) searchMatches(ctx context.Context, query string) (cloudSearchResult, error) {
	type artist struct{ Name string }
	var response struct {
		Result struct {
			Song []struct {
				ID, DT, Duration int64
				Name             string
				Ar, Artists      []artist
				Al, Album        struct{ Name, PicURL string }
			}
			Artist, Album, Playlist []cloudCatalogItem
		}
	}
	if err := a.call(ctx, http.MethodGet, "/ncm/search/multimatch?keywords="+url.QueryEscape(query), false, nil, &response); err != nil {
		return cloudSearchResult{}, err
	}
	raw := response.Result
	result := cloudSearchResult{Artists: raw.Artist, Albums: raw.Album, Playlists: raw.Playlist}
	for _, item := range raw.Song {
		artists := item.Ar
		if len(artists) == 0 {
			artists = item.Artists
		}
		names := make([]string, 0, len(artists))
		for _, artist := range artists {
			names = append(names, artist.Name)
		}
		album := item.Al
		if album.Name == "" {
			album = item.Album
		}
		result.Songs = append(result.Songs, cloudSong{
			ID: item.ID, Name: item.Name, Artists: strings.Join(names, " / "),
			Album: album.Name, Picture: album.PicURL, Duration: max(item.DT, item.Duration),
		})
	}
	return result, nil
}

func (a cloudAPI) catalogDetail(ctx context.Context, item cloudCatalogItem, offset int, albums bool) (cloudCatalogDetail, error) {
	q := url.Values{"id": {strconv.FormatInt(item.ID, 10)}, "offset": {strconv.Itoa(offset)}, "limit": {strconv.Itoa(cloudSearchLimit)}}
	endpoint := "/ncm/" + item.Kind
	if albums {
		endpoint += "/albums"
	}
	var result cloudCatalogDetail
	err := a.call(ctx, http.MethodGet, endpoint+"?"+q.Encode(), false, nil, &result)
	result.Kind = item.Kind
	return result, err
}

type cloudPlaylist struct {
	ID          int64
	UserID      int64 `json:"user_id"`
	Name        string
	Description string
	Source      string
	TrackCount  int `json:"track_count"`
	Tracks      []cloudSong
}

func (p cloudPlaylist) endpoint() string { return fmt.Sprintf("/playlists/%d", p.ID) }

func (p cloudPlaylist) editableBy(id int64) bool {
	return p.ID > 0 && id > 0 && p.UserID == id && p.Source != "ncm"
}

func (a cloudAPI) stream(ctx context.Context, song cloudSong, quality string, refresh bool) (probeSource, error) {
	level := map[string]string{"标准": "standard", "极高": "exhigh", "无损": "lossless"}[quality]
	q := url.Values{"id": {strconv.FormatInt(song.ID, 10)}, "level": {level}}
	if level == "" {
		q.Set("level", "auto")
		q.Set("maxBr", "907568")
	}
	if refresh {
		q.Set("refresh", "1")
	}
	var result struct {
		URL, Type string
		SR, Bits  int
	}
	if err := a.call(ctx, http.MethodGet, "/ncm/song/url?"+q.Encode(), true, nil, &result); err != nil {
		return probeSource{}, err
	}
	address, err := validateSource(result.URL)
	if err != nil {
		return probeSource{}, errors.New("服务器未返回可用的 HTTPS 音源")
	}
	return probeSource{url: address, title: song.Name, details: song.Artists, catalog: true, spec: sourceSpec(result.Type, result.SR, result.Bits)}, nil
}

func resolveCloudStream(ctx context.Context, api cloudAPI, song cloudSong, quality string, refresh bool) (probeSource, error) {
	source, err := api.stream(ctx, song, quality, refresh)
	var status cloudAPIError
	if err == nil || refresh || ctx.Err() != nil ||
		errors.As(err, &status) && status.status < http.StatusInternalServerError {
		return source, err
	}
	timer := time.NewTimer(450 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return probeSource{}, ctx.Err()
	case <-timer.C:
		return api.stream(ctx, song, quality, true)
	}
}
