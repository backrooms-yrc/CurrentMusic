package main

import (
	"bytes"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

func TestMain(m *testing.M) {
	if os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR") == "" {
		os.Exit(m.Run())
	}
	mygo.App.SetName("CurrentMusic native acceptance")
	mygo.App.OnWindowAllClosed(func() {})
	code := 1
	mygo.App.WhenReady(func() {
		go func() {
			code = m.Run()
			mygo.App.Quit()
		}()
	})
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(code)
}

func TestCaptureNativePreview(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("set CURRENTMUSIC_NATIVE_CAPTURE_DIR to capture a native window")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	for _, theme := range []struct{ name, mode string }{{"light", lightTheme}, {"dark", darkTheme}} {
		for _, page := range []string{"library", "player", "queue"} {
			name := theme.name + "-" + page
			t.Run(name, func(t *testing.T) {
				a := newPrototype()
				a.appearance, a.player, a.queue = theme.mode, page == "player", page == "queue"
				captureNativeView(t, a, filepath.Join(out, name+"-minimum-client.png"), minWindowWidth, minWindowHeight)
			})
		}
	}
}

func TestCaptureCloudPreview(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("set CURRENTMUSIC_NATIVE_CAPTURE_DIR to capture a native window")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	a := newPrototype()
	a.cloud = newCloudLibrary("", nil, func(func()) {})
	a.position, a.duration, a.seekable = 0, 0, false
	defer a.cloud.cancel()
	a.appearance, a.page = lightTheme, settingsPage
	captureNativeView(t, a, filepath.Join(out, "account.png"), 1200, 760)

	a.appearance, a.page = darkTheme, libraryPage
	a.search, a.cloud.keyword, a.cloud.hasMore = "潮汐", "潮汐", true
	a.cloud.results = []cloudSong{
		{ID: 1, Name: "潮汐线", Artists: "白岛", Album: "沿岸通信", Duration: 236000},
		{ID: 2, Name: "晚风的来信", Artists: "南岸电台", Album: "夜间航行", Duration: 197000},
	}
	a.cloud.selected = a.cloud.results[0]
	captureNativeView(t, a, filepath.Join(out, "search.png"), 1200, 760)
	captureNativeView(t, a, filepath.Join(out, "search-minimum.png"), minWindowWidth, minWindowHeight)

	a.page = cloudPlaylistsPage
	a.cloud.user = cloudUser{ID: 1, Username: "fixture"}
	a.cloud.playlists = []cloudPlaylist{{ID: 1, UserID: 1, Name: "沿岸选集", TrackCount: 2}}
	captureNativeView(t, a, filepath.Join(out, "playlists.png"), 1200, 760)
}

func TestCapturePlaybackPreview(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("set CURRENTMUSIC_NATIVE_CAPTURE_DIR to capture a native window")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	a := newPrototype()
	a.cloud = &cloudLibrary{}
	a.appearance, a.active, a.cloudTrack, a.player = darkTheme, true, true, true
	a.title, a.artist, a.audioSpec = "潮汐线", "白岛", "FLAC · 44.1 kHz · 16 bit"
	a.albumArt, a.albumTint = coverArt[0], coverTints[0]
	a.position, a.duration = 7500, 64_000
	a.cloudLyrics = []timedLine{
		{start: 1000, text: "沿着夜色走到海边"},
		{start: 6000, text: "看灯火落进海面", tokens: []timedWord{{6000, "看"}, {6500, "灯火"}, {7600, "落进"}, {8700, "海面"}}},
		{start: 12000, text: "风把沉默吹向远方"},
		{start: 18000, text: "我们在潮汐之间"},
	}
	current := cloudSong{ID: 1, Name: a.title, Artists: a.artist}
	a.playQueue.start(current, []cloudSong{current, {ID: 2, Name: "晚风的来信", Artists: "南岸电台"}})
	a.playQueue.mode = repeatQueue
	captureNativeView(t, a, filepath.Join(out, "playback-lyrics.png"), 1200, 760)
	a.appearance, a.queue = lightTheme, true
	captureNativeView(t, a, filepath.Join(out, "playback-queue.png"), 1200, 760)
	captureNativeView(t, a, filepath.Join(out, "playback-queue-minimum.png"), minWindowWidth, minWindowHeight)
}

func TestCaptureCloudDrivePreview(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("set CURRENTMUSIC_NATIVE_CAPTURE_DIR to capture a native window")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	a := newPrototype()
	a.cloud = &cloudLibrary{user: cloudUser{ID: 1}, openAudioFile: func(bool) (string, error) { return "", nil }}
	a.page, a.appearance = cloudDrivePage, darkTheme
	a.position, a.duration, a.seekable = 0, 0, false
	a.cloud.drive = cloudDriveState{
		uid: 1, loaded: true, count: 2, used: 18525948, quota: 20 << 30,
		tracks: []driveTrack{
			{SongID: 1, SongName: "沿着夜色走到海边，等潮汐把一封没有寄出的长信带回岸上", Artist: "白岛", FileSize: 14680064},
			{SongID: 2, SongName: "海面来信", Artist: "南岸电台", FileSize: 3845884},
		},
	}
	captureNativeView(t, a, filepath.Join(out, "cloud-drive-dark.png"), 1200, 760)
	a.appearance = lightTheme
	captureNativeView(t, a, filepath.Join(out, "cloud-drive-light-minimum.png"), minWindowWidth, minWindowHeight)
}

func TestCaptureUIRefresh(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_NATIVE_CAPTURE_DIR")
	if out == "" {
		t.Skip("set CURRENTMUSIC_NATIVE_CAPTURE_DIR to capture a native window")
	}
	if err := os.MkdirAll(out, 0700); err != nil {
		t.Fatal(err)
	}
	a := newPrototype()
	a.cloud = newCloudLibrary("", nil, func(func()) {})
	defer a.cloud.cancel()
	a.cloud.user = cloudUser{ID: 1, Username: "fixture"}
	a.page, a.demoStarted = demoPage, true
	for _, theme := range []struct{ name, mode string }{{"light", lightTheme}, {"dark", darkTheme}} {
		a.appearance = theme.mode
		captureNativeView(t, a, filepath.Join(out, "library-"+theme.name+".png"), 1200, 760)
	}
	a.active, a.cloudTrack, a.player, a.playing = true, true, true, true
	a.albumArt, a.albumTint = coverArt[0], coverTints[0]
	a.title, a.artist, a.audioSpec = "潮汐线", "白岛", "FLAC · 44.1 kHz · 16 bit"
	a.cloudLyrics = demoLyrics
	songs := []cloudSong{
		{ID: 1, Name: "上一次的海风", Artists: "流声"},
		{ID: 2, Name: a.title, Artists: a.artist},
		{ID: 3, Name: "海面来信", Artists: "南岸电台"},
		{ID: 4, Name: "等天光浮现以后，再把那一封没有寄出去的来信读完", Artists: "白岛"},
	}
	a.playQueue.start(songs[1], songs)
	for _, theme := range []struct{ name, mode string }{{"light", lightTheme}, {"dark", darkTheme}} {
		a.appearance, a.queue, a.lastLyric = theme.mode, false, -1
		captureNativeView(t, a, filepath.Join(out, "playing-"+theme.name+".png"), 1200, 760)
		a.queue, a.lastLyric = true, -1
		captureNativeView(t, a, filepath.Join(out, "queue-"+theme.name+".png"), 1200, 760)
	}
	a.title, a.lastLyric, a.queue = songs[3].Name, -1, false
	a.playQueue.songs[a.playQueue.index].Name = a.title
	captureNativeView(t, a, filepath.Join(out, "playing-minimum.png"), minWindowWidth, minWindowHeight)
	a.queue, a.lastLyric = true, -1
	captureNativeView(t, a, filepath.Join(out, "queue-minimum.png"), minWindowWidth, minWindowHeight)
}

func captureNativeView(t *testing.T, a *prototype, path string, width, height int) {
	t.Helper()
	window := mygo.NewWindow(mygo.WindowOptions{
		Title: "CurrentMusic 2.0 · 验收", Hidden: true,
		Width: width, Height: height, MinWidth: minWindowWidth, MinHeight: minWindowHeight,
		Content: ui.View(a.view),
	})
	defer window.Destroy()
	content := window.ContentBounds()
	data, err := window.CapturePage()
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("native client %dx%d DIP, capture %dx%d px", content.Width, content.Height, config.Width, config.Height)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
}
