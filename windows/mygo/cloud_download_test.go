package main

import (
	"context"
	"crypto/md5"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestMediaDownloadValidatesBeforeReplacingFile(t *testing.T) {
	payload := []byte("audio data fixture")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("download CDN received an account token")
		}
		w.Header().Set("Content-Type", "audio/flac")
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	old := downloadHTTP
	downloadHTTP = server.Client()
	defer func() { downloadHTTP = old }()
	destination := filepath.Join(t.TempDir(), "song.flac")
	if err := os.WriteFile(destination, []byte("existing file"), 0600); err != nil {
		t.Fatal(err)
	}
	source := mediaDownload{URL: server.URL, Size: int64(len(payload) + 1)}
	if err := saveMediaDownload(context.Background(), source, destination); err == nil {
		t.Fatal("download with an incorrect size passed")
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != "existing file" {
		t.Fatal("failed download replaced an existing file")
	}
	source.Size = int64(len(payload))
	source.MD5 = fmt.Sprintf("%x", md5.Sum(payload))
	if err := saveMediaDownload(context.Background(), source, destination); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(destination); err != nil || string(data) != string(payload) {
		t.Fatal("verified file was not saved")
	}
}
