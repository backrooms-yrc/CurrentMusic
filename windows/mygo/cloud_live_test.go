package main

import (
	"os"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"
)

func TestLiveCloudSearchCategories(t *testing.T) {
	base := os.Getenv("CURRENTMUSIC_PARITY_PUBLIC_API")
	if base == "" {
		t.Skip("set CURRENTMUSIC_PARITY_PUBLIC_API for read-only public gateway checks")
	}
	base, err := normalizeAPIBase(base)
	if err != nil {
		t.Fatal(err)
	}
	callbacks := make(chan func(), 4)
	a := newPrototype()
	a.cloud = newCloudLibrary("", nil, func(fn func()) { callbacks <- fn })
	defer a.cloud.cancel()
	a.cloud.api = cloudAPI{base: base, http: cloudHTTP}
	tester := ui.NewTester(a.view, 1200, 760)
	waitForResult := func() {
		t.Helper()
		select {
		case apply := <-callbacks:
			apply()
			tester.Frame()
			if a.cloud.notice != "" {
				t.Fatal(a.cloud.notice)
			}
		case <-time.After(35 * time.Second):
			t.Fatal("public gateway did not respond")
		}
	}
	click := func(label string) {
		t.Helper()
		if err := tester.Click(label); err != nil {
			t.Fatal(err)
		}
	}
	tester.Key(ui.Ctrl, ui.KeyF)
	tester.Type("春日影")
	tester.Key(0, ui.KeyEnter)
	waitForResult()
	if len(a.cloud.results) == 0 {
		t.Fatal("live song search returned no tracks")
	}
	t.Logf("live song results: %d", len(a.cloud.results))
	click("歌词")
	waitForResult()
	if a.cloud.searchKind != "lyric" || len(a.cloud.results) == 0 {
		t.Fatal("lyrics tab did not load live song results")
	}
	t.Logf("live lyric results: %d", len(a.cloud.results))
	click("专辑")
	waitForResult()
	if a.cloud.searchKind != "album" || len(a.cloud.catalog) == 0 {
		t.Fatal("album tab did not load live catalog items")
	}
	album := a.cloud.catalog[0]
	click(album.Name)
	waitForResult()
	if a.cloud.catalogDetail.ID != album.ID || len(a.cloud.catalogDetail.Songs) == 0 {
		t.Fatal("live album did not open with its song list")
	}
	t.Logf("live album %d opened with %d tracks", album.ID, len(a.cloud.catalogDetail.Songs))
}
