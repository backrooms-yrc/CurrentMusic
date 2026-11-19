package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
)

type driveNumber int64

func (n *driveNumber) UnmarshalJSON(raw []byte) error {
	if string(raw) == "null" || string(raw) == `""` {
		*n = 0
		return nil
	}
	text := string(raw)
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &text); err != nil {
			return err
		}
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err == nil {
		*n = driveNumber(value)
	}
	return err
}

func (n driveNumber) String() string { return strconv.FormatInt(int64(n), 10) }

type driveTrack struct {
	SongID, ID, FileSize                         driveNumber
	SongName, Name, Artist, Album, FileName, MD5 string
}

func (t driveTrack) key() driveNumber {
	if t.SongID > 0 {
		return t.SongID
	}
	return t.ID
}

func (t driveTrack) title() string {
	for _, name := range []string{t.SongName, t.Name, t.FileName} {
		if strings.TrimSpace(name) != "" {
			return name
		}
	}
	return "曲目 " + t.key().String()
}

type drivePage struct {
	Data                 []driveTrack
	Count, Size, MaxSize driveNumber
	HasMore              bool
}

type drivePersonalMedia struct {
	loaded             bool
	radioErr, audioErr string
	Radios             []struct {
		Name         string
		ProgramCount int
	}
	Audio []struct{ Name, Title, Artist string }
}

type cloudDriveState struct {
	uid                driveNumber
	tab                string
	tracks             []driveTrack
	offset             int
	count, used, quota driveNumber
	hasMore, loaded    bool
	media              drivePersonalMedia
	selected, detail   driveTrack
	action, lyrics     string
	matchID            string
	importMD5          string
	importSize         string
	importSongID       string
	importName         string
	pending            *driveUploadTicket
}

func (a cloudAPI) driveCall(ctx context.Context, method, path string, query url.Values, body, result any) error {
	endpoint := "/ncm" + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var raw json.RawMessage
	if err := a.call(ctx, method, endpoint, true, body, &raw); err != nil {
		return a.bindingError(ctx, err)
	}
	var status struct{ Code int }
	if err := json.Unmarshal(raw, &status); err != nil {
		return errors.New("无法读取网易云响应")
	}
	if status.Code == 301 || status.Code == 401 {
		return errors.New("网易云会话已失效，请重新绑定")
	}
	if status.Code != 0 && status.Code != 200 {
		return fmt.Errorf("网易云返回业务状态 %d", status.Code)
	}
	if result != nil && json.Unmarshal(raw, result) != nil {
		return errors.New("无法读取网易云云盘数据")
	}
	return nil
}

func (a cloudAPI) driveOwner(ctx context.Context, expected driveNumber) (driveNumber, error) {
	var result cloudBinding
	if err := a.call(ctx, http.MethodGet, "/ncmbind/session", true, nil, &result); err != nil {
		return 0, err
	}
	if !result.Bound || result.Profile.UID <= 0 {
		return 0, errors.New("请先绑定网易云账号")
	}
	if result.Valid != nil && !*result.Valid {
		return 0, errors.New("网易云会话已失效，请重新绑定")
	}
	if expected > 0 && expected != result.Profile.UID {
		return 0, errors.New("网易云绑定已变更，请刷新云盘后重试")
	}
	return result.Profile.UID, nil
}

func (s *cloudLibrary) loadDrive(more bool) {
	if s.busy {
		return
	}
	offset, uid := 0, s.drive.uid
	if more {
		offset = s.drive.offset
	} else {
		s.drive.loaded = false
	}
	type result struct {
		page  drivePage
		owner driveNumber
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (result, error) {
		expected := driveNumber(0)
		if more {
			expected = uid
		}
		owner, err := api.driveOwner(ctx, expected)
		if err != nil {
			return result{}, err
		}
		query := url.Values{"limit": {"50"}, "offset": {strconv.Itoa(offset)}}
		value := result{owner: owner}
		err = api.driveCall(ctx, http.MethodGet, "/user/cloud", query, nil, &value.page)
		return value, err
	}, func(result result) {
		d := &s.drive
		if d.uid != result.owner {
			*d = cloudDriveState{uid: result.owner, tab: "drive"}
		}
		if !more {
			d.tracks = nil
		}
		seen := make(map[driveNumber]bool, len(d.tracks)+len(result.page.Data))
		for _, track := range d.tracks {
			seen[track.key()] = true
		}
		for _, track := range result.page.Data {
			if id := track.key(); id > 0 && !seen[id] {
				d.tracks = append(d.tracks, track)
				seen[id] = true
			}
		}
		d.offset = offset + len(result.page.Data)
		d.count, d.used, d.quota = result.page.Count, result.page.Size, result.page.MaxSize
		d.hasMore = len(result.page.Data) > 0 && (result.page.HasMore || int64(d.offset) < int64(d.count))
		d.loaded = true
	})
}

func (s *cloudLibrary) readDriveTrack(track driveTrack, action string) {
	uid, id := s.drive.uid, track.key()
	type result struct {
		track  driveTrack
		lyrics string
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (result, error) {
		if _, err := api.driveOwner(ctx, uid); err != nil {
			return result{}, err
		}
		if action == "detail" {
			var response struct{ Data []driveTrack }
			err := api.driveCall(ctx, http.MethodGet, "/user/cloud/detail", url.Values{"id": {id.String()}}, nil, &response)
			if err != nil {
				return result{}, err
			}
			if len(response.Data) == 0 {
				return result{}, errors.New("网易云未返回云盘曲目详情")
			}
			return result{track: response.Data[0]}, nil
		}
		var response struct {
			Lyric string
			Data  struct{ Lyric, LRC string }
		}
		query := url.Values{"sid": {id.String()}, "uid": {uid.String()}}
		err := api.driveCall(ctx, http.MethodGet, "/cloud/lyric/get", query, nil, &response)
		for _, lyric := range []string{response.Data.Lyric, response.Data.LRC, response.Lyric} {
			if strings.TrimSpace(lyric) != "" {
				return result{lyrics: lyric}, err
			}
		}
		return result{}, err
	}, func(value result) {
		s.drive.selected, s.drive.detail, s.drive.lyrics, s.drive.action = track, value.track, value.lyrics, action
	})
}

func (s *cloudLibrary) changeDriveTrack() {
	d := &s.drive
	uid, id := d.uid, d.selected.key()
	if id <= 0 {
		return
	}
	endpoint := "/user/cloud/del"
	query := url.Values{"id": {id.String()}, "confirm": {"1"}}
	if d.action == "match" {
		target, err := strconv.ParseInt(strings.TrimSpace(d.matchID), 10, 64)
		if err != nil || target <= 0 {
			s.notice = "请输入有效的网易云歌曲 ID"
			return
		}
		endpoint = "/cloud/match"
		query = url.Values{"sid": {id.String()}, "uid": {uid.String()}, "asid": {strconv.FormatInt(target, 10)}, "confirm": {"1"}}
	}
	s.writeDrive(uid, endpoint, query, "云盘已更新")
}

func (s *cloudLibrary) writeDrive(uid driveNumber, endpoint string, query url.Values, notice string) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		if _, err := api.driveOwner(ctx, uid); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, api.driveCall(ctx, http.MethodPost, endpoint, query, struct{}{}, nil)
	}, func(struct{}) {
		s.drive.action, s.drive.matchID = "", ""
		s.loadDrive(false)
		s.notice = notice
	})
}

func (s *cloudLibrary) downloadDriveTrack(track driveTrack) {
	if s.saveFile == nil {
		return
	}
	uid, save := s.drive.uid, s.saveFile
	requestCloud(s, func(ctx context.Context, api cloudAPI) (bool, error) {
		if _, err := api.driveOwner(ctx, uid); err != nil {
			return false, err
		}
		type downloadData struct {
			URL, Type, MD5 string
			Size           driveNumber
		}
		var response struct {
			downloadData
			Data downloadData
		}
		query := url.Values{"id": {track.key().String()}}
		if err := api.driveCall(ctx, http.MethodGet, "/song/cloud/download", query, nil, &response); err != nil {
			return false, err
		}
		source := response.Data
		if source.URL == "" {
			source = response.downloadData
		}
		address, err := validateSource(source.URL)
		if err != nil {
			return false, errors.New("网易云未返回可用的 HTTPS 云盘下载地址")
		}
		source.URL = address
		if source.Type == "" {
			source.Type = strings.TrimPrefix(filepath.Ext(track.FileName), ".")
		}
		destination, err := save(songDownloadName(cloudSong{ID: int64(track.key()), Name: track.title(), Artists: track.Artist}, source.Type))
		if err != nil || destination == "" {
			return false, err
		}
		return true, saveMediaDownload(ctx, mediaDownload{URL: source.URL, Type: source.Type, MD5: source.MD5, Size: int64(source.Size)}, destination)
	}, func(saved bool) {
		if saved {
			s.notice = "云盘文件已下载"
		}
	})
}

func (s *cloudLibrary) loadDrivePersonalMedia() {
	if s.busy {
		return
	}
	s.drive.media = drivePersonalMedia{}
	type result struct {
		owner driveNumber
		media drivePersonalMedia
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (result, error) {
		owner, err := api.driveOwner(ctx, 0)
		if err != nil {
			return result{}, err
		}
		var radios struct {
			DJRadios, Data []struct {
				Name         string
				ProgramCount int
			}
		}
		var audio struct {
			Data, Programs []struct{ Name, Title, Artist string }
		}
		media := drivePersonalMedia{loaded: true}
		query := url.Values{"uid": {owner.String()}, "limit": {"50"}, "offset": {"0"}}
		if err := api.driveCall(ctx, http.MethodGet, "/user/dj", query, nil, &radios); err != nil {
			media.radioErr = err.Error()
		}
		if err := api.driveCall(ctx, http.MethodGet, "/user/audio", query, nil, &audio); err != nil {
			media.audioErr = err.Error()
		}
		if len(radios.DJRadios) == 0 {
			radios.DJRadios = radios.Data
		}
		if len(audio.Data) == 0 {
			audio.Data = audio.Programs
		}
		media.Radios, media.Audio = radios.DJRadios, audio.Data
		return result{owner, media}, nil
	}, func(value result) {
		if s.drive.uid != value.owner {
			s.drive = cloudDriveState{uid: value.owner}
		}
		s.drive.tab, s.drive.media = "personal", value.media
	})
}
