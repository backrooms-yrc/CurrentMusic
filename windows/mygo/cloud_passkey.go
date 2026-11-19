package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"net/url"
	"time"
)

const passkeyCallback = "/currentmusic/auth"

func (s *cloudLibrary) loginPasskey() {
	if s.busy || s.openBrowser == nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.scope, 5*time.Minute)
	s.cancelPasskey = cancel
	open, dispatch := s.openBrowser, s.dispatch
	scope := s.scope
	requestCloud(s, func(_ context.Context, api cloudAPI) (cloudLogin, error) {
		defer cancel()
		result, err := api.browserPasskey(ctx, open)
		dispatch(func() {
			if scope.Err() == nil {
				s.cancelPasskey = nil
			}
		})
		return result, err
	}, s.finishLogin)
}

func (a cloudAPI) browserPasskey(ctx context.Context, open func(string) error) (cloudLogin, error) {
	issuer, err := url.Parse(a.base)
	if err != nil || issuer.Scheme != "https" || issuer.Host == "" {
		return cloudLogin{}, errors.New("通行密钥要求有效的 HTTPS API 基址")
	}
	var random [64]byte
	rand.Read(random[:])
	state := base64.RawURLEncoding.EncodeToString(random[:32])
	verifier := base64.RawURLEncoding.EncodeToString(random[32:])
	clear(random[:])
	hash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return cloudLogin{}, errors.New("无法打开本地授权回调端口")
	}
	defer listener.Close()
	host := listener.Addr().String()
	redirect := "http://" + host + passkeyCallback
	result := make(chan string, 1)
	serveError := make(chan error, 1)
	server := &http.Server{
		ReadHeaderTimeout: 3 * time.Second,
		WriteTimeout:      3 * time.Second,
		MaxHeaderBytes:    4096,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			if r.Method != http.MethodGet || r.Host != host || r.URL.Path != passkeyCallback {
				http.NotFound(w, r)
				return
			}
			query := r.URL.Query()
			code := query.Get("code")
			decoded, err := base64.RawURLEncoding.Strict().DecodeString(code)
			if len(query["code"]) != 1 || len(query["state"]) != 1 || err != nil || len(decoded) != 32 ||
				subtle.ConstantTimeCompare([]byte(query.Get("state")), []byte(state)) != 1 {
				http.Error(w, "无效的授权回调", http.StatusBadRequest)
				return
			}
			_, _ = w.Write([]byte("已收到授权。请返回 CurrentMusic 查看登录结果。"))
			if flush, ok := w.(http.Flusher); ok {
				flush.Flush()
			}
			select {
			case result <- code:
			default:
			}
		}),
	}
	defer server.Close()
	go func() { serveError <- server.Serve(listener) }()
	q := url.Values{"redirectUri": {redirect}, "state": {state}, "codeChallenge": {challenge}}
	if err := open(a.base + "/auth/windows/authorize?" + q.Encode()); err != nil {
		return cloudLogin{}, err
	}
	select {
	case code := <-result:
		return a.loginRequest(ctx, "/auth/windows/exchange", map[string]string{
			"origin": issuer.Scheme + "://" + issuer.Host, "code": code, "state": state,
			"redirectUri": redirect, "codeVerifier": verifier,
		})
	case <-serveError:
		return cloudLogin{}, errors.New("本地授权回调已关闭")
	case <-ctx.Done():
		return cloudLogin{}, errors.New("通行密钥登录已取消或超时")
	}
}

type cloudPasskey struct {
	ID, RP, Name string
}

func (s *cloudLibrary) loadPasskeys() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudPasskey, error) {
		var result struct{ Keys []cloudPasskey }
		err := api.call(ctx, http.MethodGet, "/auth/passkeys", true, nil, &result)
		return result.Keys, err
	}, func(keys []cloudPasskey) { s.account.passkeys = keys })
}

func (s *cloudLibrary) deletePasskey() {
	panel := &s.account
	body := map[string]string{"id": panel.confirm, "password": panel.password, "factor": panel.code}
	panel.confirm, panel.password, panel.code = "", "", ""
	s.accountWrite(http.MethodPost, "/auth/passkeys/delete", true, body, "通行密钥已撤销", s.loadPasskeys)
}

func (s *cloudLibrary) enrollPasskey() {
	if s.openBrowser == nil {
		return
	}
	open := s.openBrowser
	panel := &s.account
	password, factor := panel.password, panel.code
	panel.password, panel.code = "", ""
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		issuer, err := url.Parse(api.base)
		if err != nil || issuer.Scheme != "https" || issuer.Host == "" {
			return struct{}{}, errors.New("通行密钥要求有效的 HTTPS API 基址")
		}
		var result struct{ Ticket string }
		body := map[string]string{"origin": issuer.Scheme + "://" + issuer.Host, "password": password, "factor": factor}
		if err := api.call(ctx, http.MethodPost, "/auth/windows/enroll/request", true, body, &result); err != nil {
			return struct{}{}, err
		}
		data, err := base64.RawURLEncoding.Strict().DecodeString(result.Ticket)
		if err != nil || len(data) != 32 {
			return struct{}{}, errors.New("服务器未签发有效的绑定凭据")
		}
		return struct{}{}, open(api.base + "/auth/windows/enroll#" + result.Ticket)
	}, func(struct{}) { s.notice = "请在浏览器完成绑定，然后刷新密钥列表" })
}
