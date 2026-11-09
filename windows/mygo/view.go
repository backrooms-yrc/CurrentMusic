package main

import (
	"fmt"
	"time"

	"github.com/egoist/mygo/ui"
)

const (
	followTheme = "跟随系统"
	lightTheme  = "浅色"
	darkTheme   = "深色"
)

var sections = []string{"首页", "搜索", "音乐库", "设置"}

type demoTrack struct {
	title  string
	artist string
	length int64
	hue    string
}

var demoTracks = []demoTrack{
	{"潮汐线", "白岛", 236000, "#17575A"},
	{"海面来信", "南岸电台", 201000, "#355078"},
	{"等天光浮现", "白岛", 259000, "#7F5B36"},
	{"风吹向远方", "流声", 193000, "#5E5279"},
}

var demoLyrics = []string{
	"沿着夜色走到海边",
	"看灯火落进海面",
	"风把沉默吹向远方",
	"我们在潮汐之间",
	"等天光慢慢浮现",
	"把远处的星留给明天",
	"海浪轻轻覆盖足迹",
}

type prototype struct {
	page, track, lyricRow              int
	player, queue, lyrics, playing     bool
	search, appearance, quality        string
	volume, scrub                      float64
	position, duration                 int64
	seeking, seekable, active          bool
	highContrast, volumeOpen           bool
	title, artist, notice              string
	source, username, password, songID string
	searchFocus                        ui.Handle
	toggle, previous, next             func()
	fullScreen                         func(toggle bool) bool
	seek                               func(int64)
	setVolume                          func(float64)
	openSource                         func(string)
	resolve                            func(songID, username, password, quality string)
}

func newPrototype() *prototype {
	return &prototype{
		appearance: followTheme,
		quality:    "自动",
		volume:     0.7,
		position:   21500,
		duration:   demoTracks[0].length,
		seekable:   true,
	}
}

func brandTheme(dark bool) (*ui.Theme, ui.Color) {
	t := ui.LightTheme()
	raised := ui.Hex("#E6F0F0")
	t.Background, t.Surface = ui.Hex("#F5FAFA"), ui.Hex("#FFFFFF")
	t.Text, t.TextMuted = ui.Hex("#172225"), ui.Hex("#495C60")
	t.Accent, t.AccentText = ui.Hex("#00696E"), ui.Hex("#FFFFFF")
	t.Border, t.Danger = ui.Hex("#657D80"), ui.Hex("#9C2930")
	if dark {
		t = ui.DarkTheme()
		raised = ui.Hex("#1C2B2E")
		t.Background, t.Surface = ui.Hex("#0C1517"), ui.Hex("#131F22")
		t.Text, t.TextMuted = ui.Hex("#EFF7F7"), ui.Hex("#AABFC0")
		t.Accent, t.AccentText = ui.Hex("#64D9D8"), ui.Hex("#003739")
		t.Border, t.Danger = ui.Hex("#71888B"), ui.Hex("#FFB3B6")
	}
	t.SurfaceHover, t.SurfacePressed = raised, raised
	t.AccentHover, t.AccentPressed, t.InactiveAccent = t.Accent, t.Accent, t.Accent
	t.Focus, t.FocusRingWidth = t.Accent, 2
	t.Font, t.FontSize, t.Radius = "Segoe UI Variable, Microsoft YaHei UI", 14, 8
	return t, raised
}

func (a *prototype) view(c *ui.Context) {
	w, h := c.Size()
	dark := a.appearance == darkTheme || (a.appearance == followTheme && c.Theme().Dark)
	t, raised := brandTheme(dark)
	if a.highContrast {
		t = c.Theme()
		raised = t.Surface
	}
	c.SetTheme(t)
	c.OnShortcut(ui.Ctrl, ui.KeyF, func() {
		a.page, a.player = 1, false
		a.searchFocus.Focus(c)
	})
	c.OnShortcut(ui.Ctrl, ui.KeySpace, a.togglePlayback)
	c.OnShortcut(ui.Ctrl, ui.KeyLeft, func() { a.changeTrack(-1) })
	c.OnShortcut(ui.Ctrl, ui.KeyRight, func() { a.changeTrack(1) })
	c.OnShortcut(0, ui.KeyF11, func() {
		if a.fullScreen != nil {
			a.fullScreen(true)
		}
	})
	back := func() {
		switch {
		case a.queue:
			a.queue = false
		case a.fullScreen != nil && a.fullScreen(false):
			// Escape exits full screen before dismissing the player.
		default:
			a.player, a.page = false, 0
		}
	}
	c.OnShortcut(0, ui.KeyEscape, back)
	c.OnShortcut(ui.Alt, ui.KeyLeft, back)
	ui.Column(c).Fill().Background(t.Background).Children(func() {
		a.toolbar(c.Key("toolbar"), w, back)
		ui.Row(c.Key("workspace")).Height(max(0, h-136)).AlignItems(ui.Stretch).Children(func() {
			if !a.player {
				a.navigation(c.Key("nav"), w, raised)
			}
			if a.player {
				a.playingPage(c.Key("playing"), w, h, raised)
			} else {
				a.browse(c.Key("browse"), raised)
			}
			if a.queue && w >= 1240 {
				a.queuePanel(c.Key("docked-queue"), raised, 336)
			}
		})
		a.transport(c.Key("transport"), w, raised)
	})
	if a.queue && w < 1240 {
		ui.Overlay(c, func() {
			ui.Row(c).Fill().Justify(ui.End).Background(ui.RGBA(0, 0, 0, 0.25)).Padding(48, 0, 88, 0).Children(func() {
				a.queuePanel(c.Key("overlay-queue"), raised, 336)
			})
		})
	}
}

func (a *prototype) toolbar(c *ui.Context, w float32, back func()) {
	ui.Row(c).Height(48).PaddingX(16).Gap(8).AlignItems(ui.Center).Children(func() {
		if button(c, "‹", "返回", 36).Clicked() {
			back()
		}
		if w >= 960 {
			ui.Text(c, "CurrentMusic").FontSize(16).Bold()
		}
		if a.page == 1 && !a.player {
			ui.TextInput(c, &a.search).Placeholder("搜索歌曲、歌手、专辑或歌单").Label("搜索").Grow(1).Bind(&a.searchFocus)
		} else {
			ui.Spacer(c).Grow(1)
			if button(c, "搜索", "搜索", 72).Clicked() {
				a.page, a.player = 1, false
				a.searchFocus.Focus(c)
			}
		}
		if button(c, "账号", "账号与设置", 72).Clicked() {
			a.page, a.player = 3, false
		}
	})
}

func (a *prototype) navigation(c *ui.Context, w float32, raised ui.Color) {
	width := float32(216)
	if w < 960 {
		width = 56
	}
	ui.Column(c).Role(ui.RoleNavigation).Label("主导航").Width(width).Background(c.Theme().Surface).
		Padding(8).Gap(8).Children(func() {
		for i, section := range sections {
			label := section
			if width == 56 {
				label = []string{"⌂", "⌕", "♫", "⚙"}[i]
			}
			item := ui.Button(c.Key(section), label).Label(section).Tooltip(section).Height(40).Radius(8).
				AccessSelected(a.page == i)
			if a.page == i {
				item.Background(raised)
			}
			if item.Clicked() {
				a.page = i
			}
		}
	})
}

func (a *prototype) browse(c *ui.Context, raised ui.Color) {
	ui.Scroll(c).Grow(1).MinWidth(0).MinHeight(0).Children(func() {
		ui.Column(c).Padding(24).Gap(16).Children(func() {
			ui.Text(c, sections[a.page]).Role(ui.RoleHeading).Level(1).FontSize(28).Bold()
			switch a.page {
			case 3:
				a.settings(c, raised)
			case 1:
				ui.Text(c, "单曲　　歌手　　专辑　　歌单").TextColor(c.Theme().TextMuted)
				a.demoList(c, raised)
			default:
				ui.Text(c, "最近播放").Role(ui.RoleHeading).Level(2).FontSize(20).Bold()
				a.demoList(c, raised)
			}
		})
	})
}

func (a *prototype) settings(c *ui.Context, raised ui.Color) {
	ui.Column(c).Background(raised).Radius(12).Padding(16).Gap(12).Children(func() {
		ui.Text(c, "外观").FontSize(20).Bold()
		ui.Select(c, &a.appearance, []string{followTheme, lightTheme, darkTheme}).Label("颜色主题")
	})
	ui.Column(c).Background(raised).Radius(12).Padding(16).Gap(8).Children(func() {
		ui.Text(c, "音频验证").FontSize(20).Bold()
		ui.Text(c, "使用 HTTPS Range 测试音源或一次性测试账号。").Wrap().TextColor(c.Theme().TextMuted)
		ui.TextInput(c.Key("source"), &a.source).Password().Placeholder("HTTPS 音源地址").Label("HTTPS 音源地址")
		if ui.Button(c, "打开测试音源").Disabled(a.openSource == nil || a.source == "").Clicked() {
			source := a.source
			a.source = ""
			a.openSource(source)
		}
		ui.TextInput(c.Key("song-id"), &a.songID).Placeholder("CurrentMusic 歌曲 ID").Label("歌曲 ID")
		ui.TextInput(c.Key("username"), &a.username).Placeholder("测试账号用户名").Label("测试账号用户名")
		ui.TextInput(c.Key("password"), &a.password).Password().Placeholder("测试账号密码").Label("测试账号密码")
		if ui.Button(c, "登录测试账号并播放").Disabled(a.resolve == nil || a.songID == "" || a.username == "" || a.password == "").Clicked() {
			password := a.password
			a.password = ""
			a.resolve(a.songID, a.username, password, a.quality)
		}
		if a.notice != "" {
			ui.Text(c, a.notice).Wrap()
		}
	})
}

func (a *prototype) demoList(c *ui.Context, raised ui.Color) {
	for i, track := range demoTracks {
		ui.Row(c.Key(i)).Height(48).Gap(12).PaddingX(8).AlignItems(ui.Center).Background(raised).Radius(8).Children(func() {
			cover(c, track, 36, 8, false)
			ui.Text(c, track.title).Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…").FontSize(16)
			ui.Text(c, track.artist).TextColor(c.Theme().TextMuted)
			if button(c, "▶", "播放 "+track.title, 36).Clicked() {
				a.selectDemo(i)
			}
		})
	}
}

func (a *prototype) playingPage(c *ui.Context, w, h float32, raised ui.Color) {
	sideBySide := w >= 960 && h >= 520
	padding, gap := float32(24), float32(16)
	if !sideBySide {
		padding, gap = 12, 8
	}
	coverSize := min(float32(360), max(float32(200), h-300))
	coverSize = min(coverSize, w*0.36)
	track := demoTracks[a.track]
	background := c.Theme().Background
	if !a.highContrast && !a.active {
		fraction := float32(0.08)
		if c.Theme().Dark {
			fraction = 0.16
		}
		background = mix(background, ui.Hex(track.hue), fraction)
	}
	ui.Scroll(c).Grow(1).MinWidth(0).MinHeight(0).Background(background).Children(func() {
		ui.Column(c).Padding(padding).Gap(gap).Children(func() {
			if !sideBySide {
				ui.Row(c).Gap(8).Children(func() {
					if button(c, "封面", "封面", 72).Clicked() {
						a.lyrics = false
					}
					if button(c, "歌词", "歌词", 72).Clicked() {
						a.lyrics = true
					}
				})
			}
			ui.Row(c).Gap(32).AlignItems(ui.Start).Children(func() {
				if sideBySide || !a.lyrics {
					ui.Column(c).Grow(2).MinWidth(0).Gap(16).Children(func() {
						cover(c, track, coverSize, 20, true)
						title, artist := a.metadata()
						ui.Text(c, title).FontSize(32).Bold().MaxLines(2).Ellipsis("…").Tooltip(title)
						ui.Text(c, artist).FontSize(16).TextColor(c.Theme().TextMuted)
					})
				}
				if sideBySide || a.lyrics {
					a.lyricPanel(c.Key("lyrics"), raised, !sideBySide)
				}
			})
		})
	})
}

func (a *prototype) lyricPanel(c *ui.Context, raised ui.Color, compact bool) {
	padding, gap, activeSize := float32(16), float32(12), float32(32)
	if compact {
		padding, gap, activeSize = 8, 4, 24
	}
	ui.Column(c).Grow(3).MinWidth(0).Padding(padding).Gap(gap).Radius(12).Background(raised).Children(func() {
		ui.Text(c, "逐字歌词").FontSize(20).Bold()
		if a.active {
			ui.Text(c, "测试音源没有关联歌词").TextColor(c.Theme().TextMuted)
			return
		}
		a.lyricRow = min(len(demoLyrics)-1, int(a.position/6000))
		for i, line := range demoLyrics {
			if compact && i < a.lyricRow {
				continue
			}
			row := ui.ButtonBase(c.Key(i)).Label(line).Padding(4).Radius(8)
			row.Children(func() {
				if i == a.lyricRow {
					chars := []rune(line)
					split := min(len(chars), int((a.position%6000)*int64(len(chars))/6000))
					ui.RichText(c,
						ui.Span{Text: string(chars[:split]), Color: c.Theme().Accent},
						ui.Span{Text: string(chars[split:])},
					).FontSize(activeSize).Bold().Wrap().AccessHidden(true)
				} else {
					ui.Text(c, line).FontSize(20).Wrap().TextColor(c.Theme().TextMuted).AccessHidden(true)
				}
			})
			if row.Clicked() {
				a.seekTo(int64(i) * 6000)
			}
		}
	})
}

func (a *prototype) queuePanel(c *ui.Context, raised ui.Color, width float32) {
	ui.Column(c).Width(width).Background(c.Theme().Surface).Padding(16).Gap(12).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			ui.Text(c, "播放队列").FontSize(20).Bold().Grow(1)
			if button(c, "×", "关闭队列", 36).Clicked() {
				a.queue = false
			}
		})
		title, _ := a.metadata()
		ui.Text(c, "正在播放 · "+title).Wrap().TextColor(c.Theme().Accent)
		ui.Text(c, "接下来").TextColor(c.Theme().TextMuted)
		if a.active {
			ui.Text(c, "验证队列保留最近打开的两个测试音源。").Wrap()
			return
		}
		ui.Scroll(c).Grow(1).Children(func() { a.demoList(c.Key("queue-list"), raised) })
	})
}

func (a *prototype) transport(c *ui.Context, w float32, raised ui.Color) {
	ui.Column(c).Height(88).Padding(4, 16, 8).Gap(4).Background(c.Theme().Surface).Children(func() {
		ui.Row(c.Key("time")).Height(28).AlignItems(ui.Center).Gap(8).Children(func() {
			shown := a.position
			if a.seeking {
				shown = int64(a.scrub)
			}
			ui.Text(c, clockLabel(shown)).Width(44).FontSize(12)
			a.progress(c.Key("progress"), raised)
			ui.Text(c, clockLabel(a.duration)).Width(44).TextAlign(ui.End).FontSize(12)
		})
		ui.Row(c.Key("buttons")).Height(44).AlignItems(ui.Center).Gap(8).Children(func() {
			title, artist := a.metadata()
			open := ui.ButtonBase(c.Key("expand")).Label("正在播放 " + title).Tooltip(title).Height(44).Grow(1).MinWidth(0).Justify(ui.Start)
			open.Children(func() {
				ui.Row(c).AlignItems(ui.Center).Gap(8).Children(func() {
					cover(c, demoTracks[a.track], 36, 8, false)
					ui.Column(c).Grow(1).MinWidth(0).Children(func() {
						ui.Text(c, title).MaxLines(1).Ellipsis("…").Bold()
						ui.Text(c, artist).MaxLines(1).Ellipsis("…").TextColor(c.Theme().TextMuted).FontSize(12)
					})
				})
			})
			if open.Clicked() {
				a.player = !a.player
			}
			if button(c, "⏮", "上一首", 36).Clicked() {
				a.changeTrack(-1)
			}
			play, label := "▶", "播放"
			if a.playing {
				play, label = "Ⅱ", "暂停"
			}
			if button(c, play, label, 44).Height(44).Background(c.Theme().Accent).TextColor(c.Theme().AccentText).Clicked() {
				a.togglePlayback()
			}
			if button(c, "⏭", "下一首", 36).Clicked() {
				a.changeTrack(1)
			}
			ui.Select(c, &a.quality, []string{"自动", "标准", "极高", "无损"}).Label("音质").Width(92).MinWidth(0)
			if w >= 720 {
				a.volumeControl(c, 96)
			} else {
				anchor := button(c, "♪", "音量", 36)
				if anchor.Clicked() {
					a.volumeOpen = !a.volumeOpen
				}
				ui.Popover(c, anchor, &a.volumeOpen, func() { a.volumeControl(c, 144) })
			}
			if button(c, "≡", "播放队列", 36).Clicked() {
				a.queue = !a.queue
			}
		})
	})
}

func (a *prototype) volumeControl(c *ui.Context, width float32) {
	slider := ui.Slider(c.Key("volume"), &a.volume, 0, 1).Width(width).Label("音量")
	if slider.Changed() && a.setVolume != nil {
		a.setVolume(a.volume)
	}
}

func (a *prototype) progress(c *ui.Context, raised ui.Color) {
	if !a.seeking {
		a.scrub = float64(a.position)
	}
	duration := max(1, float64(a.duration))
	slider := ui.SliderBase(c, &a.scrub, 0, duration).Grow(1).Height(28).PaddingX(8).
		Step(5000).Label("播放进度").Disabled(!a.seekable || a.duration <= 0)
	slider.Draw(func(p *ui.Painter, r ui.Rect) {
		width := max(0, r.W-16)
		progress := float32(min(1, max(0, a.scrub/duration))) * width
		y := r.Y + r.H/2
		p.Fill(ui.Rect{X: r.X + 8, Y: y - 2, W: width, H: 4}, raised, 2)
		p.Fill(ui.Rect{X: r.X + 8, Y: y - 2, W: progress, H: 4}, c.Theme().Accent, 2)
		p.Fill(ui.Rect{X: r.X + 3 + progress, Y: y - 5, W: 10, H: 10}, c.Theme().Accent, 5)
	})
	clicked := slider.Clicked()
	_, _, dragEnded := slider.DragEnded()
	if b, held := slider.PressedButton(); held && b == 0 {
		a.seeking = true
	} else if a.seeking {
		a.seeking = false
		if clicked || dragEnded {
			a.seekTo(int64(a.scrub))
		}
	} else if slider.Changed() {
		a.seekTo(int64(a.scrub))
	}
}

func (a *prototype) seekTo(ms int64) {
	if !a.seekable || a.duration <= 0 {
		return
	}
	ms = max(0, min(ms, a.duration))
	if a.active && a.seek != nil {
		a.seek(ms)
	} else {
		a.position = ms
	}
}

func (a *prototype) metadata() (string, string) {
	if a.active {
		return a.title, a.artist
	}
	t := demoTracks[a.track]
	return t.title, t.artist
}

func (a *prototype) togglePlayback() {
	if a.active && a.toggle != nil {
		a.toggle()
	} else {
		a.playing = !a.playing
	}
}

func (a *prototype) changeTrack(delta int) {
	if a.active {
		if delta < 0 && a.previous != nil {
			a.previous()
		} else if delta > 0 && a.next != nil {
			a.next()
		}
		return
	}
	a.selectDemo((a.track + delta + len(demoTracks)) % len(demoTracks))
}

func (a *prototype) selectDemo(i int) {
	if a.active {
		return
	}
	a.track, a.position, a.duration = i, 0, demoTracks[i].length
}

func button(c *ui.Context, glyph, label string, width float32) ui.Element {
	return ui.Button(c.Key(label), glyph).Label(label).Tooltip(label).Size(width, 36).Radius(8)
}

func cover(c *ui.Context, track demoTrack, size, radius float32, large bool) {
	ui.Box(c).Size(size, size).Radius(radius).Clip().Draw(func(p *ui.Painter, r ui.Rect) {
		p.Fill(r, ui.Hex(track.hue), radius)
		p.Fill(ui.Rect{X: r.X + r.W*0.61, Y: r.Y + r.H*0.17, W: r.W * 0.24, H: r.W * 0.24}, ui.Hex("#ECDBA2"), r.W*0.12)
		for i := range 5 {
			y := r.Y + r.H*(0.58+0.05*float32(i))
			p.Fill(ui.Rect{X: r.X + r.W*0.09, Y: y, W: r.W * 0.82, H: max(1, r.H*0.012)}, ui.Hex("#80B7A4"), 2)
		}
	}).Children(func() {
		if large {
			ui.Column(c).Fill().Justify(ui.End).Padding(16).Children(func() {
				ui.Text(c, "CURRENTMUSIC / 01").FontSize(14).Bold().TextColor(ui.Hex("#ECDBA2"))
			})
		}
	})
}

func mix(a, b ui.Color, fraction float32) ui.Color {
	channel := func(base, tint uint8) uint8 { return uint8(float32(base)*(1-fraction) + float32(tint)*fraction + 0.5) }
	return ui.RGB(channel(a.R, b.R), channel(a.G, b.G), channel(a.B, b.B))
}

func clockLabel(ms int64) string {
	d := time.Duration(max(ms, 0)) * time.Millisecond
	if d >= time.Hour {
		return fmt.Sprintf("%d:%02d:%02d", int(d/time.Hour), int(d/time.Minute)%60, int(d/time.Second)%60)
	}
	return fmt.Sprintf("%d:%02d", int(d/time.Minute), int(d/time.Second)%60)
}
