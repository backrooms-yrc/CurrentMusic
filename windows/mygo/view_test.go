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
			name := fmt.Sprintf("%s-%dx%d", theme.name, size.w, size.h)
			t.Run(name, func(t *testing.T) {
				a := newPrototype()
				a.appearance, a.player, a.lyrics = theme.mode, true, true
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
