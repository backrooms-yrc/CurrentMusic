package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const officialAPI = "https://music.20110208.xyz/cm"

type probeSource struct {
	url, title, details string
}

func validateSource(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return "", errors.New("请输入有效的 HTTPS 音源地址")
	}
	return u.String(), nil
}

var probeClient = http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func resolveProbeSource(ctx context.Context, songID, username, password, quality string) (probeSource, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(songID), 10, 64)
	if err != nil || id <= 0 {
		return probeSource{}, errors.New("请输入有效的歌曲 ID")
	}
	login, err := json.Marshal(map[string]string{
		"username": strings.TrimSpace(username),
		"password": password,
		"device":   "CurrentMusic Windows 验证原型",
		"platform": "app",
	})
	if err != nil {
		return probeSource{}, errors.New("无法构建测试登录请求")
	}
	var session struct {
		Token string `json:"token"`
	}
	if err := probeJSON(ctx, http.MethodPost, "/auth/login", "", login, &session); err != nil {
		return probeSource{}, fmt.Errorf("测试账号登录失败：%w", err)
	}
	if session.Token == "" {
		return probeSource{}, errors.New("验证原型需要可直接用密码登录的独立测试账号")
	}
	defer func() {
		logout, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = probeJSON(logout, http.MethodPost, "/auth/logout", session.Token, []byte("{}"), nil)
	}()
	query := url.Values{"id": {strconv.FormatInt(id, 10)}, "alts": {"1"}}
	switch quality {
	case "标准":
		query.Set("level", "standard")
	case "极高":
		query.Set("level", "exhigh")
	case "无损":
		query.Set("level", "lossless")
	default:
		query.Set("level", "auto")
		query.Set("maxBr", "907568")
	}
	var result struct {
		URL   string `json:"url"`
		Level string `json:"level"`
		Type  string `json:"type"`
		Rate  int    `json:"sr"`
		Bits  int    `json:"bits"`
	}
	if err := probeJSON(ctx, http.MethodGet, "/ncm/song/url?"+query.Encode(), session.Token, nil, &result); err != nil {
		return probeSource{}, fmt.Errorf("音源解析失败：%w", err)
	}
	address, err := validateSource(result.URL)
	if err != nil {
		return probeSource{}, err
	}
	format := strings.ToUpper(result.Type)
	switch format {
	case "MP3", "FLAC", "AAC", "M4A":
	default:
		format = "格式未知"
	}
	details := format
	if result.Level == "matched" {
		details = "匹配音源 · " + details
	}
	if result.Rate > 0 {
		details += fmt.Sprintf(" · 音源 %.1f kHz", float64(result.Rate)/1000)
	}
	if result.Bits > 0 {
		details += fmt.Sprintf(" · %d bit", result.Bits)
	}
	return probeSource{address, fmt.Sprintf("测试歌曲 %d", id), details}, nil
}

func probeJSON(ctx context.Context, method, endpoint, token string, body []byte, result any) error {
	req, err := http.NewRequestWithContext(ctx, method, officialAPI+endpoint, bytes.NewReader(body))
	if err != nil {
		return errors.New("无法构建 API 请求")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := probeClient.Do(req)
	if err != nil {
		return errors.New("网络不可用或请求超时")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if result == nil {
		return nil
	}
	const maxResponse = 64 << 10
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse || json.Unmarshal(data, result) != nil {
		return errors.New("无法读取 API 响应")
	}
	return nil
}
