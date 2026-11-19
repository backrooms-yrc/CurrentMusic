package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBrowserPasskeyLoopbackAndPKCE(t *testing.T) {
	type ceremony struct{ state, redirect, challenge string }
	auth := make(chan ceremony, 1)
	code := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/cm/auth/windows/exchange" || r.Header.Get("Authorization") != "" {
			t.Error("unexpected Windows passkey exchange request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		request := <-auth
		hash := sha256.Sum256([]byte(body["codeVerifier"]))
		if body["code"] != code || body["state"] != request.state || body["redirectUri"] != request.redirect ||
			base64.RawURLEncoding.EncodeToString(hash[:]) != request.challenge || body["origin"] != "https://"+r.Host {
			t.Error("Windows exchange did not match the original browser flow")
		}
		_, _ = w.Write([]byte(`{"token":"test-session","user":{"id":23}}`))
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	api := cloudAPI{base: server.URL + "/cm", http: server.Client()}
	result, err := api.browserPasskey(ctx, func(address string) error {
		parsed, err := url.Parse(address)
		if err != nil || !strings.HasPrefix(address, api.base+"/auth/windows/authorize?") {
			return errors.New("unexpected browser URL")
		}
		q := parsed.Query()
		if q.Has("codeVerifier") || q.Has("token") {
			return errors.New("secret leaked to browser URL")
		}
		request := ceremony{q.Get("state"), q.Get("redirectUri"), q.Get("codeChallenge")}
		auth <- request
		for _, state := range []string{"wrong-state", request.state} {
			callback, err := http.NewRequestWithContext(ctx, http.MethodGet,
				request.redirect+"?"+url.Values{"code": {code}, "state": {state}}.Encode(), nil)
			if err != nil {
				return err
			}
			response, err := http.DefaultClient.Do(callback)
			if err != nil {
				return err
			}
			response.Body.Close()
			if state != request.state && response.StatusCode != http.StatusBadRequest ||
				state == request.state && response.StatusCode != http.StatusOK {
				return errors.New("callback did not validate state")
			}
		}
		return nil
	})
	if err != nil || result.User.ID != 23 || result.Token == "" {
		t.Fatalf("browser passkey login failed: %v", err)
	}
}
