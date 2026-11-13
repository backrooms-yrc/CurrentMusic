package main

import (
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestPrototypeRenders(t *testing.T) {
	out := os.Getenv("CURRENTMUSIC_DESIGN_DIR")
	for _, theme := range []struct{ name, mode string }{{"light", lightTheme}, {"dark", darkTheme}} {
		for _, size := range []struct{ w, h int }{{1200, 760}, {960, 540}, {600, 320}} {
			for _, page := range []string{"library", "player", "queue"} {
				name := fmt.Sprintf("%s-%s-%dx%d", theme.name, page, size.w, size.h)
				t.Run(name, func(t *testing.T) {
					a := newPrototype()
					a.appearance, a.player, a.queue = theme.mode, page == "player", page == "queue"
					image := ui.Render(a.view, size.w, size.h, 1)
					if image.Bounds().Dx() != size.w || image.Bounds().Dy() != size.h {
						t.Fatalf("unexpected render bounds %v", image.Bounds())
					}
					if out == "" {
						return
					}
					if err := os.MkdirAll(out, 0700); err != nil {
						t.Fatal(err)
					}
					f, err := os.Create(filepath.Join(out, name+".png"))
					if err != nil {
						t.Fatal(err)
					}
					defer f.Close()
					if err := png.Encode(f, image); err != nil {
						t.Fatal(err)
					}
				})
			}
		}
	}
}

func TestMediaSourceAcceptsOnlyHTTPS(t *testing.T) {
	const sample = "https://example.test/stream?signature=placeholder"
	if got, err := validateSource(sample); got != sample || err != nil {
		t.Fatalf("HTTPS validation = %q, %v", got, err)
	}
	for _, bad := range []string{
		"http://example.test/a", "file:///C:/a", "https://user@example.test/a",
		"https://example.test/a#b", "https:///a", "https://example.test/a\r\nb",
	} {
		if _, err := validateSource(bad); err == nil {
			t.Errorf("unexpectedly accepted %q", bad)
		}
	}
}

func TestScrubSendsOneSeekOnRelease(t *testing.T) {
	a := newPrototype()
	a.active = true
	var seeks []int64
	a.seek = func(ms int64) { seeks = append(seeks, ms) }
	tester := ui.NewTester(a.view, 600, 320)
	r, ok := tester.Find("播放进度")
	if !ok || r.W < 200 || r.Y < 232 {
		t.Fatalf("playback slider not visible at minimum size: %v", r)
	}
	y := r.Y + r.H/2
	tester.Press(r.X+r.W*0.25, y)
	tester.Move(r.X+r.W*0.70, y)
	if len(seeks) != 0 || !a.seeking {
		t.Fatalf("drag sent a seek before release: %v", seeks)
	}
	tester.Release(r.X+r.W*0.70, y)
	if len(seeks) != 1 || seeks[0] < 155000 || seeks[0] > 175000 {
		t.Fatalf("release should send one seek near 70%%: %v", seeks)
	}
	tester.Press(r.X+r.W*0.25, y)
	tester.Move(r.X+r.W*0.70, y)
	tester.CancelPress()
	if len(seeks) != 1 || a.seeking {
		t.Fatalf("cancel must discard the drag: %v", seeks)
	}
	if err := tester.Click("播放进度"); err != nil {
		t.Fatal(err)
	}
	if len(seeks) != 2 {
		t.Fatalf("click should also seek once: %v", seeks)
	}
}

func TestLibrarySearchPlaybackAndQueue(t *testing.T) {
	a := newPrototype()
	tester := ui.NewTester(a.view, 600, 320)
	click := func(label string) {
		t.Helper()
		if err := tester.Click(label); err != nil {
			t.Fatal(err)
		}
	}
	tester.Key(ui.Ctrl, ui.KeyF)
	if !tester.Focused("搜索") {
		t.Fatal("Ctrl+F did not focus search")
	}
	tester.Type("潮汐")
	if !tester.HasText("搜索结果") {
		t.Fatal("search results are missing")
	}
	click("潮汐线")
	if a.playing || a.selected != 0 {
		t.Fatal("single click should select the track")
	}
	tester.Key(0, ui.KeyEnter)
	if !a.playing {
		t.Fatal("Enter should play the focused track")
	}
	click("暂停")
	if a.playing || !tester.Focused("播放") {
		t.Fatal("play/pause must retain focus when its label changes")
	}
	click("播放")
	click("展开播放页")
	if !a.player || !tester.HasText("歌词") {
		t.Fatal("compact player should open on lyrics")
	}
	click("风把沉默吹向远方")
	if a.position != 12000 {
		t.Fatalf("lyric seek position = %d", a.position)
	}
	if line, ok := tester.Find("风把沉默吹向远方"); ok {
		tester.Scroll(line.X+line.W/2, line.Y+line.H/2, 0, 100)
	}
	if a.followLyrics {
		t.Fatal("manual lyric scrolling must pause automatic following")
	}
	click("回到当前行")
	if !a.followLyrics {
		t.Fatal("return to current line must restore automatic following")
	}
	click("收起播放页")
	if err := tester.RightClick("潮汐线"); err != nil {
		t.Fatal(err)
	}
	if err := tester.ChooseMenuItem("加入队列"); err != nil {
		t.Fatal(err)
	}
	if len(a.upNext) != 4 || a.upNext[3] != 0 {
		t.Fatalf("appended queue = %v", a.upNext)
	}
	click("播放队列")
	if !a.queue || !tester.Focused("关闭队列") {
		t.Fatal("narrow queue must take focus on opening")
	}
	tester.Key(0, ui.KeyEscape)
	if a.queue || !tester.Focused("播放队列") {
		t.Fatal("closing the drawer must restore queue trigger focus")
	}
}

func TestMinimumWindowTransportTargets(t *testing.T) {
	for _, scale := range []float32{1, 1.5, 2} {
		t.Run(fmt.Sprint(scale), func(t *testing.T) {
			a := newPrototype()
			tester := ui.NewTester(a.view, 600, 320)
			tester.SetScale(scale)
			a.title = "这是用于检查标题省略的长曲目名称 CurrentMusic Windows 2.0"
			a.artist = "这是另一个用来检查文本缩放的长名称"
			a.active = true
			tester.Frame()
			for _, label := range []string{"上一首", "播放", "下一首", "音质", "调节音量", "播放队列"} {
				r, ok := tester.Find(label)
				if !ok || r.W < 38 || r.H < 38 || r.X < 0 || r.X+r.W > 600 || r.Y+r.H > 320 {
					t.Errorf("%s hit target = %v, found = %t", label, r, ok)
				}
			}
		})
	}
}

func TestCompactQueueKeepsTransportUsable(t *testing.T) {
	a := newPrototype()
	a.cloud = &cloudLibrary{}
	a.active, a.cloudTrack = true, true
	a.title, a.artist = "一首名字很长的中文歌曲，用来检查在最小窗口里播放栏的文字省略", "测试歌手"
	current := cloudSong{ID: 1, Name: a.title, Artists: a.artist}
	a.playQueue.start(current, []cloudSong{current, {ID: 2, Name: "下一首歌", Artists: a.artist}})
	a.toggle = func() { a.playing = !a.playing }
	var moves int
	a.previous, a.next = func() { moves-- }, func() { moves++ }
	var seek int64
	a.seek = func(ms int64) { seek = ms }
	var volume float64
	a.setVolume = func(value float64) { volume = value }
	a.changeQuality = func(level string) { a.quality = level }
	tester := ui.NewTester(a.view, 584, 281)
	click := func(label string) {
		t.Helper()
		if err := tester.Click(label); err != nil {
			t.Fatal(err)
		}
	}
	click("播放队列")
	if !a.queue || !tester.Focused("关闭队列") {
		t.Fatal("queue must move keyboard focus to the close button")
	}
	click("播放")
	click("下一首")
	if !a.playing || moves != 1 || !a.queue {
		t.Fatal("queue must keep play and next usable")
	}
	click("播放进度")
	if seek <= 0 {
		t.Fatal("queue blocked the timeline")
	}
	click("调节音量")
	if slider, ok := tester.Find("音量"); ok {
		tester.ClickAt(slider.X+slider.W*.25, slider.Y+slider.H*.5)
	} else {
		t.Fatal("volume popover did not open with the queue visible")
	}
	if volume <= 0 || volume >= .6 {
		t.Fatalf("volume callback = %f", volume)
	}
	click("调节音量")
	click("音质")
	if err := tester.ChooseMenuItem("无损"); err != nil {
		t.Fatal(err)
	}
	if a.quality != "无损" || !a.queue {
		t.Fatal("quality menu did not select lossless while the queue was open")
	}
	tester.Key(0, ui.KeyEscape)
	if a.queue || !tester.Focused("播放队列") {
		t.Fatalf("queue close must restore focus to its button (queue open: %t)", a.queue)
	}
}

func TestDockedQueueModeSelectionAndRemoval(t *testing.T) {
	a := newPrototype()
	a.cloud = &cloudLibrary{}
	a.active, a.cloudTrack, a.queue = true, true, true
	songs := []cloudSong{{ID: 1, Name: "上一首歌"}, {ID: 2, Name: "当前歌曲"}, {ID: 3, Name: "下一首歌"}}
	a.playQueue.start(songs[1], songs)
	opened, changes := -1, 0
	a.openQueued = func(index int) { opened = index }
	a.queueChanged = func() { changes++ }
	tester := ui.NewTester(a.view, 1200, 760)
	click := func(label string) {
		t.Helper()
		if err := tester.Click(label); err != nil {
			t.Fatal(err)
		}
	}
	click("播放模式 · 顺序播放")
	if err := tester.ChooseMenuItem("列表循环"); err != nil {
		t.Fatal(err)
	}
	click("播放 下一首歌")
	click("移除 上一首歌")
	if a.playQueue.mode != repeatQueue || opened != 2 || changes != 2 || a.playQueue.index != 0 || len(a.playQueue.songs) != 2 {
		t.Fatalf("unexpected queue after mode, play and remove: %+v, opened %d, changes %d", a.playQueue, opened, changes)
	}
}
