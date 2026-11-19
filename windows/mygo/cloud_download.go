package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type mediaDownload struct {
	URL, Type, MD5 string
	Size           int64
}

var downloadHTTP = &http.Client{
	Timeout: 10 * time.Minute,
	CheckRedirect: func(r *http.Request, previous []*http.Request) error {
		if r.URL.Scheme != "https" || r.URL.User != nil || len(previous) >= 6 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

func (s *cloudLibrary) downloadSong(song cloudSong, quality string) {
	if s.saveFile == nil {
		return
	}
	save := s.saveFile
	requestCloud(s, func(ctx context.Context, api cloudAPI) (bool, error) {
		source, err := api.songDownload(ctx, song.ID, quality)
		if err != nil {
			return false, err
		}
		destination, err := save(songDownloadName(song, source.Type))
		if err != nil || destination == "" {
			return false, err
		}
		return true, saveMediaDownload(ctx, source, destination)
	}, func(saved bool) {
		if saved {
			s.notice = "歌曲已下载"
		}
	})
}

func (a cloudAPI) songDownload(ctx context.Context, id int64, quality string) (mediaDownload, error) {
	level := map[string]string{"标准": "standard", "极高": "exhigh", "无损": "lossless"}[quality]
	if level == "" {
		level = "exhigh"
	}
	idString := strconv.FormatInt(id, 10)
	queries := []string{
		"/ncm/song/download/url/v1?" + url.Values{"id": {idString}, "level": {level}}.Encode(),
		"/ncm/song/download/url?" + url.Values{"id": {idString}, "br": {"320000"}}.Encode(),
	}
	for _, endpoint := range queries {
		var response struct {
			mediaDownload
			Data mediaDownload
		}
		if err := a.call(ctx, http.MethodGet, endpoint, true, nil, &response); err != nil {
			var status cloudAPIError
			if errors.As(err, &status) && status.status == http.StatusUnauthorized {
				return mediaDownload{}, err
			}
			continue
		}
		source := response.Data
		if source.URL == "" {
			source = response.mediaDownload
		}
		if address, err := validateSource(source.URL); err == nil {
			source.URL = address
			return source, nil
		}
	}
	var source mediaDownload
	query := url.Values{"id": {idString}, "level": {level}}
	if err := a.call(ctx, http.MethodGet, "/ncm/song/url?"+query.Encode(), true, nil, &source); err != nil {
		return mediaDownload{}, err
	}
	address, err := validateSource(source.URL)
	source.URL = address
	return source, err
}

func songDownloadName(song cloudSong, kind string) string {
	name := strings.Trim(strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune(`\/:*?"<>|`, r) {
			return '_'
		}
		return r
	}, song.Name+" - "+song.Artists), ". ")
	runes := []rune(name)
	if len(runes) > 100 {
		name = strings.Trim(string(runes[:100]), ". ")
	}
	if name == "" {
		name = "CurrentMusic-" + strconv.FormatInt(song.ID, 10)
	}
	kind = strings.ToLower(strings.TrimPrefix(kind, "."))
	switch kind {
	case "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "ape", "eac3":
		return name + "." + kind
	default:
		return name + ".audio"
	}
}

func saveMediaDownload(ctx context.Context, source mediaDownload, destination string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.URL, nil)
	if err != nil {
		return errors.New("无法构建下载请求")
	}
	response, err := downloadHTTP.Do(request)
	if err != nil {
		return errors.New("音源下载失败或已取消")
	}
	defer response.Body.Close()
	contentType := response.Header.Get("Content-Type")
	if response.StatusCode != http.StatusOK || strings.HasPrefix(contentType, "text/") || strings.Contains(contentType, "json") {
		return errors.New("服务器未返回音频文件")
	}
	file, err := os.CreateTemp(filepath.Dir(destination), ".currentmusic-download-*.tmp")
	if err != nil {
		return errors.New("无法写入所选目录")
	}
	defer os.Remove(file.Name())
	digest := md5.New()
	size, readErr := io.Copy(io.MultiWriter(file, digest), response.Body)
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || ctx.Err() != nil || size == 0 {
		return errors.New("下载未完成")
	}
	if source.Size > 0 && size != source.Size {
		return errors.New("下载大小与音源资料不一致")
	}
	if source.MD5 != "" && !strings.EqualFold(source.MD5, hex.EncodeToString(digest.Sum(nil))) {
		return errors.New("下载文件校验失败")
	}
	if err := os.Rename(file.Name(), destination); err != nil {
		return errors.New("无法保存下载文件")
	}
	return nil
}

func (s *cloudLibrary) copySongLink(id int64) {
	if s.copyText == nil || id <= 0 {
		return
	}
	base, err := url.Parse(s.api.base)
	if err != nil {
		return
	}
	link := url.URL{Scheme: base.Scheme, Host: base.Host, Path: "/app/", Fragment: "/song/" + strconv.FormatInt(id, 10)}
	if err := s.copyText(link.String()); err != nil {
		s.notice = "无法写入系统剪贴板"
	} else {
		s.notice = "歌曲链接已复制"
	}
}
