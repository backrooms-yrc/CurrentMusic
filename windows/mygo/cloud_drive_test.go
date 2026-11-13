package main

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCloudDriveUploadContract(t *testing.T) {
	ctx := context.Background()
	audio := []byte("audio fixture for upload")
	checksum := fmt.Sprintf("%x", md5.Sum(audio))
	path := filepath.Join(t.TempDir(), "长歌名.flac")
	if err := os.WriteFile(path, audio, 0600); err != nil {
		t.Fatal(err)
	}
	var stores, completes, destinationHits atomic.Int32
	var fail, deduplicated, redirect atomic.Bool
	var owner atomic.Int32
	owner.Store(42)
	fail.Store(true)
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/objects/file":
			stores.Add(1)
			body, err := io.ReadAll(r.Body)
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" ||
				r.Header.Get("x-nos-token") != "fixture-nos" || r.Header.Get("Content-Type") != "audio/flac" ||
				r.ContentLength != int64(len(audio)) || err != nil || string(body) != string(audio) {
				t.Error("object upload request did not match expected credentials or file contents")
			}
			if redirect.Load() {
				http.Redirect(w, r, "/other-origin", http.StatusTemporaryRedirect)
			}
			return
		case "/other-origin":
			destinationHits.Add(1)
			return
		}
		if r.Header.Get("Authorization") != "Bearer fixture-cm" || r.Header.Get("x-nos-token") != "" {
			t.Error("gateway request used incorrect credentials")
		}
		query := r.URL.Query()
		switch r.URL.Path {
		case "/ncmbind/session":
			fmt.Fprintf(w, `{"bound":true,"valid":true,"profile":{"uid":"%d"}}`, owner.Load())
		case "/ncm/cloud/upload/token":
			if r.Method != http.MethodPost || query.Get("confirm") != "1" || query.Get("filename") != "长歌名.flac" ||
				query.Get("fileSize") != strconv.Itoa(len(audio)) || query.Get("md5") != checksum {
				t.Error("token request did not include the expected file metadata")
			}
			fmt.Fprintf(w, `{"code":200,"data":{"songId":"0","resourceId":"9007199254740993","uploadToken":"fixture-nos","needUpload":%t,"uploadUrl":"https://%s/objects/file"}}`, !deduplicated.Load(), r.Host)
		case "/ncm/cloud/upload/complete":
			completes.Add(1)
			if r.Method != http.MethodPost || query.Get("confirm") != "1" || query.Get("songId") != "0" ||
				query.Get("resourceId") != "9007199254740993" || query.Get("md5") != checksum || query.Get("song") != "长歌名" {
				t.Error("completion request did not preserve the provider's identifiers")
			}
			if fail.Load() {
				fmt.Fprint(w, `{"code":200,"data":{"code":503}}`)
			} else {
				fmt.Fprint(w, `{"code":200,"data":{"code":200}}`)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer tls.Close()
	api := cloudAPI{base: tls.URL, token: "fixture-cm", http: tls.Client()}
	result, err := api.uploadDriveFile(ctx, 42, path, false, tls.Client())
	if err != nil || result.pending == nil || result.err == nil || result.done || stores.Load() != 1 || completes.Load() != 1 {
		t.Fatalf("failed registration did not preserve uploaded file: %v %+v", err, result)
	}
	owner.Store(43)
	if rejected := api.finishDriveUpload(ctx, 42, *result.pending); rejected.err == nil || completes.Load() != 1 {
		t.Fatal("registration retried under a different binding")
	}
	owner.Store(42)
	fail.Store(false)
	if retried := api.finishDriveUpload(ctx, 42, *result.pending); !retried.done || stores.Load() != 1 || completes.Load() != 2 {
		t.Fatalf("registration retry reuploaded or failed: %+v", retried)
	}
	deduplicated.Store(true)
	if skipped, err := api.uploadDriveFile(ctx, 42, path, false, tls.Client()); err != nil || !skipped.done || stores.Load() != 1 || completes.Load() != 3 {
		t.Fatalf("duplicate upload did not skip storage: %v %+v", err, skipped)
	}
	deduplicated.Store(false)
	redirect.Store(true)
	if _, err := api.uploadDriveFile(ctx, 42, path, false, tls.Client()); err == nil || destinationHits.Load() != 0 || completes.Load() != 3 {
		t.Fatal("redirect was followed or an unconfirmed object was registered")
	}
}

func TestCloudDrivePageDecodesProviderIDs(t *testing.T) {
	var page drivePage
	err := json.Unmarshal([]byte(`{"data":[{"songId":"9007199254740993","songName":"云盘歌曲","fileSize":4905}],"count":2,"maxSize":"21474836480","hasMore":true}`), &page)
	if err != nil || len(page.Data) != 1 || page.Data[0].key() != 9007199254740993 || page.Data[0].title() != "云盘歌曲" ||
		page.Data[0].FileSize != 4905 || page.Count != 2 || page.MaxSize != 21474836480 || !page.HasMore {
		t.Fatalf("unexpected cloud drive page: %v %+v", err, page)
	}
}

func TestCloudDriveLegacyUploadContract(t *testing.T) {
	const audio = "small MP3 fixture"
	var uploads atomic.Int32
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ncmbind/session":
			fmt.Fprint(w, `{"bound":true,"valid":true,"profile":{"uid":42}}`)
		case "/ncm/cloud":
			uploads.Add(1)
			var body struct {
				File                  []byte
				Filename, ContentType string
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || string(body.File) != audio || body.Filename != "声音.mp3" ||
				body.ContentType != "audio/mpeg" || r.Method != http.MethodPost || r.URL.Query().Get("confirm") != "1" || r.URL.Query().Get("songName") != "声音" {
				t.Error("legacy upload did not match the gateway file contract")
			}
			fmt.Fprint(w, `{"code":200}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer tls.Close()
	api := cloudAPI{base: tls.URL, token: "fixture-cm", http: tls.Client()}
	ctx := context.Background()
	if _, err := api.uploadDriveLegacy(ctx, 42, strings.NewReader(audio), "声音.mp3", ".mp3", "audio/mpeg", driveLegacyLimit+1); err == nil || uploads.Load() != 0 {
		t.Fatal("oversized upload was not rejected before sending")
	}
	if result, err := api.uploadDriveLegacy(ctx, 42, strings.NewReader(audio), "声音.mp3", ".mp3", "audio/mpeg", int64(len(audio))); err != nil || !result.done || uploads.Load() != 1 {
		t.Fatalf("legacy upload failed: %v %+v", err, result)
	}
}
