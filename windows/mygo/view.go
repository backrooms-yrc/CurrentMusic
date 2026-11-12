package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
	"github.com/oneo-me/onevra/source/components"
)

const (
	followTheme = "跟随系统"
	lightTheme  = "浅色"
	darkTheme   = "深色"
)

const (
	libraryPage = iota
	playlistPage
	settingsPage
	cloudLikesPage
	cloudPlaylistsPage
	cloudPlaylistPage
	demoPage
	cloudRecentPage
	cloudDiscoverPage
	cloudRoomsPage
	cloudRoomPage
	cloudCommunityPage
	dockWidth  = 1080
	barHeight  = 82
	shellInset = 8
	shellGap   = 8
	queueWidth = 274
)

type trackMetadata struct {
	title, artist, album string
	length               int64
}

var demoTracks = []trackMetadata{
	{"潮汐线", "白岛", "潮汐线", 236000},
	{"海面来信", "南岸电台", "沿岸通信", 201000},
	{"等天光浮现", "白岛", "拂晓时分", 259000},
	{"风吹向远方", "流声", "夜间航行", 193000},
}

type demoPlaylist struct {
	name   string
	tracks []int
}

type prototype struct {
	page, track, selected, playlist    int
	player, queue, lyrics, playing     bool
	search, appearance, quality        string
	volume, scrub                      float64
	position, duration                 int64
	seeking, seekable, active          bool
	highContrast, volumeOpen           bool
	title, artist, notice              string
	source, username, password, songID string
	searchFocus, queueFocus            ui.Handle
	queueFocusPending                  bool
	upNext, history                    []int
	playlists                          []demoPlaylist
	lastTick                           time.Time
	lyricScroll                        ui.ScrollState
	lastLyric                          int
	followLyrics                       bool
	toggle, previous, next             func()
	fullScreen                         func(toggle bool) bool
	seek                               func(int64)
	setVolume                          func(float64)
	openSource                         func(string)
	resolve                            func(songID, username, password, quality string)
	probeQueue                         func() []string
	exitProbe                          func() bool
	cloud                              *cloudLibrary
	cloudTrack                         bool
	demoStarted                        bool
	playQueue                          playQueue
	queueLoading                       bool
	playCloud                          func(cloudSong, []cloudSong)
	enqueueCloud                       func(cloudSong, bool)
	openQueued                         func(int)
	queueChanged                       func()
	playIntent                         func() bool
	changeQuality                      func(string)
	cloudLyrics                        []timedLine
	albumArt                           ui.ImageSource
	albumTint                          ui.Color
	lyricStatus, audioSpec             string
	desktopSettings                    func(*ui.Context)
	desktopRedraw                      func()
}

func newPrototype() *prototype {
	return &prototype{
		appearance: followTheme, quality: "自动", volume: 0.7,
		selected: -1, lastLyric: -1, followLyrics: true, lyrics: true,
		position: 21500, duration: demoTracks[0].length, seekable: true,
		upNext:    []int{1, 2, 3},
		playQueue: playQueue{index: -1},
		playlists: []demoPlaylist{
			{"潮汐选集", []int{0, 1}},
			{"夜间航行", []int{3}},
		},
	}
}

func brandTheme(dark bool) *ui.Theme {
	t := ui.LightTheme()
	t.Background, t.Surface = ui.Hex("#EBEFEC"), ui.Hex("#FBFCFA")
	t.SurfaceHover, t.SurfacePressed = ui.Hex("#E6ECE8"), ui.Hex("#D8E5DF")
	t.Text, t.TextMuted = ui.Hex("#172622"), ui.Hex("#526660")
	t.Accent, t.AccentText = ui.Hex("#006961"), ui.Hex("#FFFFFF")
	t.Border = ui.Hex("#D6E1DB")
	if dark {
		t = ui.DarkTheme()
		t.Background, t.Surface = ui.Hex("#111817"), ui.Hex("#1B2422")
		t.SurfaceHover, t.SurfacePressed = ui.Hex("#263631"), ui.Hex("#304740")
		t.Text, t.TextMuted = ui.Hex("#EDF5F0"), ui.Hex("#A9BBB3")
		t.Accent, t.AccentText = ui.Hex("#7AE3D1"), ui.Hex("#073731")
		t.Border = ui.Hex("#394A44")
	}
	t.AccentHover = mix(t.Accent, t.Text, .12)
	t.AccentPressed = mix(t.Accent, t.Text, .22)
	t.Focus, t.FocusRingWidth = t.Accent, 2
	t.Font, t.FontSize, t.Radius = "Segoe UI, Microsoft YaHei UI", 14, 8
	return t
}

func (a *prototype) view(c *ui.Context) {
	if a.cloud != nil && a.page != cloudCommunityPage {
		a.cloud.stopChat()
	}
	w, h := c.Size()
	t := brandTheme(a.appearance == darkTheme || (a.appearance == followTheme && c.Theme().Dark))
	if a.highContrast {
		t = c.Theme()
	}
	c.SetTheme(t)
	c.SetMenuPresentation(ui.PopoverMenus)
	a.advancePreview(c.Now())
	if a.playing && !a.active {
		c.After(100 * time.Millisecond)
	}
	search := func() {
		a.page, a.player = libraryPage, false
		a.searchFocus.Focus(c)
	}
	closeQueue := func() {
		a.queue = false
		a.queueFocusPending = true
	}
	back := func() {
		switch {
		case a.queue:
			closeQueue()
		case a.fullScreen != nil && a.fullScreen(false):
		case a.player:
			a.player = false
		default:
			a.page, a.search, a.selected = libraryPage, "", -1
		}
	}
	c.OnShortcut(ui.Ctrl, ui.KeyF, search)
	c.OnShortcut(ui.Ctrl, ui.KeySpace, a.togglePlayback)
	c.OnShortcut(ui.Ctrl, ui.KeyLeft, func() { a.changeTrack(-1) })
	c.OnShortcut(ui.Ctrl, ui.KeyRight, func() { a.changeTrack(1) })
	c.OnShortcut(0, ui.KeyEscape, back)
	c.OnShortcut(ui.Alt, ui.KeyLeft, back)
	c.OnShortcut(0, ui.KeyF11, func() {
		if a.fullScreen != nil {
			a.fullScreen(true)
		}
	})

	innerW := max(0, w-2*shellInset)
	bodyH := max(0, h-barHeight-2*shellInset-shellGap)
	docked := a.queue && w >= dockWidth
	bodyW := innerW
	if docked {
		bodyW -= queueWidth + shellGap
	}

	ui.Column(c).Fill().Background(t.Background).Padding(shellInset).Gap(shellGap).Children(func() {
		ui.Row(c.Key("workspace")).Height(bodyH).AlignItems(ui.Stretch).Gap(shellGap).Children(func() {
			if a.player {
				a.playingPage(c.Key("playing"), bodyW, bodyH)
			} else {
				navWidth := a.navigation(c.Key("nav"), bodyW)
				a.browse(c.Key("browse"), bodyW-navWidth-shellGap, bodyH)
			}
			if docked {
				a.queuePanel(c.Key("docked-queue"), queueWidth, bodyH, false, closeQueue)
			} else if a.queue {
				ui.Row(c.Key("queue-drawer")).Absolute().Left(0).Top(0).Right(0).Bottom(0).
					PassThrough().AlignItems(ui.Stretch).Children(func() {
					dismiss := ui.Box(c.Key("queue-backdrop")).Grow(1).Radius(12).Background(ui.RGBA(4, 12, 10, .20))
					if dismiss.Clicked() {
						closeQueue()
					}
					a.queuePanel(c.Key("overlay-queue"), min(312, innerW-40), bodyH, true, closeQueue)
				})
			}
		})
		a.transport(c.Key("transport"), innerW)
	})
	if a.queueFocusPending && !a.queue {
		a.queueFocus.Focus(c)
		a.queueFocusPending = false
	}
}

func (a *prototype) navigation(c *ui.Context, w float32) float32 {
	wide := w >= 830
	width := float32(52)
	if wide {
		width = 196
	}
	t := c.Theme()
	rail := ui.Column(c).Width(width).Role(ui.RoleNavigation).Label("主导航").
		Background(mix(t.Background, t.Text, .022)).Radius(12).Padding(6).Gap(2)
	rail.Children(func() {
		ui.Row(c).Height(48).AlignItems(ui.Center).Gap(9).PaddingX(4).Children(func() {
			ui.Box(c).Size(32, 32).Radius(8).Background(t.Accent).Children(func() {
				ui.Row(c).Fill().AlignItems(ui.Center).Justify(ui.Center).Children(func() {
					drawIcon(c, brandIcon, 19, t.AccentText)
				})
			})
			if wide {
				ui.Column(c).MinWidth(0).Gap(1).Children(func() {
					singleLine(c, "CurrentMusic").FontSize(16).Bold()
					ui.Text(c, "Windows · 2.0").FontSize(11).TextColor(t.TextMuted)
				})
			}
		})
		library := func() {
			if navItem(c.Key("library"), libraryIcon, "曲库", wide, a.page == libraryPage).Clicked() {
				if a.cloud != nil && a.page != libraryPage {
					a.openCloudPage(libraryPage)
				}
				a.page, a.selected, a.search = libraryPage, -1, ""
			}
		}
		settings := func() {
			if navItem(c.Key("settings"), settingsIcon, "设置", wide, a.page == settingsPage).Clicked() {
				a.page = settingsPage
			}
		}
		if wide {
			ui.Scroll(c.Key("groups")).Grow(1).MinHeight(0).Children(func() {
				ui.Column(c).Gap(12).Children(func() {
					components.SidebarSection(c.Key("browse-group"), "浏览", library)
					components.SidebarSection(c.Key("collection-group"), "我的音乐", func() {
						a.collectionNavigation(c, true)
					})
				})
			})
			components.SidebarSection(c.Key("app-group"), "应用", settings)
		} else {
			library()
			a.collectionNavigation(c, false)
			ui.Spacer(c).Grow(1)
			settings()
		}
	})
	return width
}

func (a *prototype) collectionNavigation(c *ui.Context, wide bool) {
	if a.cloud != nil {
		a.cloudNavigation(c.Key("cloud"), wide)
		return
	}
	if wide {
		for i, playlist := range a.playlists {
			if navItem(c.Key(i), playlistIcon, playlist.name, true, a.page == playlistPage && a.playlist == i).Clicked() {
				a.page, a.playlist, a.selected = playlistPage, i, -1
			}
		}
		return
	}
	navItem(c.Key("playlists"), playlistIcon, "我的歌单", false, a.page == playlistPage).Menu(func(m *ui.Menu) {
		for i, playlist := range a.playlists {
			if m.Item(playlist.name).Chosen() {
				a.page, a.playlist, a.selected = playlistPage, i, -1
			}
		}
	})
}

func navItem(c *ui.Context, glyph *ui.SVG, title string, wide, selected bool) ui.Element {
	t := c.Theme()
	e := ui.ButtonBase(c).Height(38).Radius(7).Label(title).Tooltip(title).AccessSelected(selected)
	styleControl(e, t, selected)
	color := t.TextMuted
	if selected {
		color = t.Accent
	}
	e.Children(func() {
		if wide {
			ui.Row(c).Grow(1).MinWidth(0).PaddingX(8).AlignItems(ui.Center).Gap(8).Children(func() {
				mark := ui.Box(c).Size(3, 16).Radius(2).AccessHidden(true)
				if selected {
					mark.Background(t.Accent)
				}
				drawIcon(c, glyph, 17, color)
				label := singleLine(c, title).FontSize(13).AccessHidden(true)
				if selected {
					label.Bold()
				}
			})
		} else {
			drawIcon(c, glyph, 19, color)
		}
	})
	return e
}

func (a *prototype) browse(c *ui.Context, w, h float32) {
	padding := float32(24)
	searchHeight, bodyGap := float32(60), float32(14)
	if w < 700 {
		padding = 16
	}
	if h < 235 {
		searchHeight, bodyGap = 48, 7
	}
	t := c.Theme()
	ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Radius(12).Clip().Background(t.Surface).Children(func() {
		a.searchToolbar(c.Key("search-bar"), searchHeight, padding, w >= 680)
		ui.Scroll(c.Key(a.page)).Grow(1).MinHeight(0).Children(func() {
			ui.Column(c).Padding(6, padding, 22).Gap(bodyGap).Children(func() {
				if a.page == settingsPage {
					sectionHeading(c, "设置", "外观、账号与播放", "", h < 235)
					a.settings(c)
					return
				}
				if a.cloud != nil && a.page != demoPage {
					a.cloudPage(c.Key("cloud-page"), w-2*padding, h < 235)
					return
				}
				a.collection(c.Key("collection"), w-2*padding, h)
			})
		})
	})
}

func (a *prototype) searchToolbar(c *ui.Context, height, padding float32, showHint bool) {
	t := c.Theme()
	ui.Row(c).Height(height).Role(ui.RoleToolbar).Label("搜索工具栏").PaddingX(padding).AlignItems(ui.Center).Gap(8).Children(func() {
		ui.Row(c.Key("field")).Height(36).Grow(1).MinWidth(0).MaxWidth(432).PaddingX(9).
			AlignItems(ui.Center).Gap(5).Radius(9).Background(t.Background).Children(func() {
			drawIcon(c, searchIcon, 16, t.TextMuted)
			input := ui.TextInput(c.Key("search"), &a.search).Height(34).Grow(1).MinWidth(0).
				Background(t.Background).BorderWidth(0).PaddingX(4).Radius(6).FocusRingOffset(-2).
				Placeholder("搜索歌曲、歌手或专辑").Label("搜索").Bind(&a.searchFocus)
			if a.cloud != nil && a.page != demoPage {
				input.OnTextKey(func(k ui.TextKey) bool {
					if k.Key != ui.KeyEnter || k.Mods != 0 {
						return false
					}
					a.runCloudSearch(k.Text())
					return true
				})
			}
			if input.Changed() {
				if a.page != demoPage {
					a.page = libraryPage
				}
				a.selected = -1
			}
			if a.search != "" {
				if iconButton(c.Key("clear"), closeIcon, "清除搜索", 30, false).Clicked() {
					a.search, a.selected = "", -1
					a.searchFocus.Focus(c)
				}
			} else if showHint {
				ui.Text(c, "Ctrl+F").FontSize(11).TextColor(t.TextMuted)
			}
		})
		if a.cloud != nil && a.page != demoPage && labelButton(c.Key("search-action"), "搜索歌曲", 76, true).
			Disabled(a.cloud.busy || strings.TrimSpace(a.search) == "").Clicked() {
			a.runCloudSearch(a.search)
		}
	})
}

func sectionHeading(c *ui.Context, title, subtitle, count string, compact bool) {
	t := c.Theme()
	size := float32(32)
	if compact {
		size = 23
	}
	ui.Column(c).MinWidth(0).Gap(3).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(8).Children(func() {
			heading(c, title, size).MinWidth(0).MaxLines(1).Ellipsis("…").Tooltip(title)
			if count != "" {
				components.Badge(c, count).Shrink(0)
			}
		})
		if subtitle != "" && !compact {
			ui.Text(c, subtitle).FontSize(13).TextColor(t.TextMuted).Wrap()
		}
	})
}

func (a *prototype) collection(c *ui.Context, w, h float32) {
	t := c.Theme()
	title, description := "曲库", "本地演示曲库"
	items := []int{0, 1, 2, 3}
	switch {
	case a.page == playlistPage:
		title, description = a.playlists[a.playlist].name, "本地歌单"
		items = a.playlists[a.playlist].tracks
	case strings.TrimSpace(a.search) != "":
		title, description = "搜索结果", ""
		query := strings.ToLower(strings.TrimSpace(a.search))
		items = slices.DeleteFunc(items, func(i int) bool {
			track := demoTracks[i]
			return !strings.Contains(strings.ToLower(track.title+" "+track.artist+" "+track.album), query)
		})
	}
	sectionHeading(c, title, description, fmt.Sprintf("%d 首", len(items)), h < 235)
	if title == "曲库" && h >= 465 {
		heading(c, "精选封面", 17)
		a.coverGrid(c.Key("covers"), w)
	}
	if len(items) == 0 {
		ui.Text(c, "没有匹配的曲目").TextColor(t.TextMuted)
		return
	}
	showAlbum := w >= 660
	ui.Row(c).AlignItems(ui.Start).Gap(14).Children(func() {
		ui.Column(c).Grow(1).MinWidth(0).Gap(1).Role(ui.RoleList).Label("曲目").Children(func() {
			if h >= 235 {
				trackColumnLabels(c, showAlbum)
			}
			for _, i := range items {
				a.trackRow(c.Key(i), i, showAlbum)
			}
		})
		if w >= 820 && slices.Contains(items, a.selected) {
			a.trackDetail(c.Key("detail"), a.selected, 208)
		}
	})
	if w < 820 && slices.Contains(items, a.selected) {
		a.trackDetail(c.Key("detail"), a.selected, w)
	}
}

func (a *prototype) coverGrid(c *ui.Context, w float32) {
	const gap = 14
	size := min(154, (w-3*gap)/4)
	ui.Row(c).Gap(gap).Children(func() {
		for i, track := range demoTracks {
			item := ui.ButtonBase(c.Key(i)).Width(size).Radius(9).Label("封面 " + track.title).
				Tooltip(track.title).AccessSelected(a.selected == i)
			item.Children(func() {
				ui.Column(c).Width(size).Gap(5).Children(func() {
					cover(c, i, size, 9)
					singleLine(c, track.title).Bold().AccessHidden(true)
					singleLine(c, track.artist).FontSize(12).TextColor(c.Theme().TextMuted).AccessHidden(true)
				})
			})
			a.trackActions(item, i)
		}
	})
}

func (a *prototype) trackRow(c *ui.Context, i int, showAlbum bool) {
	track := demoTracks[i]
	row := ui.ButtonBase(c).Height(43).Radius(7).Label(track.title).
		Tooltip(track.title + " · " + track.artist).AccessSelected(a.selected == i)
	styleControl(row, c.Theme(), a.selected == i)
	row.Children(func() {
		trackRowContent(c, track, showAlbum, !a.active && a.track == i, func() { cover(c, i, 30, 5) })
	})
	a.trackActions(row, i)
}

func trackColumnLabels(c *ui.Context, showAlbum bool) {
	t := c.Theme()
	ui.Row(c.Key("columns")).Height(26).PaddingX(9).Gap(9).AlignItems(ui.Center).AccessHidden(true).Children(func() {
		ui.Box(c).Width(30).Shrink(0)
		ui.Text(c, "歌曲 / 歌手").FontSize(11).TextColor(t.TextMuted)
		ui.Spacer(c).Grow(1)
		if showAlbum {
			ui.Text(c, "专辑").Width(128).FontSize(11).TextColor(t.TextMuted)
		}
		ui.Text(c, "时长").Width(44).TextAlign(ui.End).FontSize(11).TextColor(t.TextMuted)
	})
}

func trackRowContent(c *ui.Context, track trackMetadata, showAlbum, current bool, artwork func()) {
	t := c.Theme()
	ui.Row(c).Grow(1).MinWidth(0).PaddingX(9).Gap(9).AlignItems(ui.Center).Children(func() {
		artwork()
		ui.Column(c).Grow(1).MinWidth(0).Children(func() {
			name := singleLine(c, track.title).Bold().FontSize(13).AccessHidden(true)
			if current {
				name.TextColor(t.Accent)
			}
			singleLine(c, track.artist).TextColor(t.TextMuted).FontSize(11).AccessHidden(true)
		})
		if showAlbum {
			singleLine(c, track.album).Width(128).TextColor(t.TextMuted).FontSize(12).AccessHidden(true)
		}
		ui.Text(c, clockLabel(track.length)).Width(44).TextAlign(ui.End).FontSize(12).TextColor(t.TextMuted).AccessHidden(true)
	})
}

func (a *prototype) trackActions(row ui.Element, i int) {
	play := func() {
		a.selected = i
		a.selectDemo(i)
	}
	row.HandleInput(func(event ui.InputEvent) bool {
		if event.Kind != ui.InputKeyDown || event.Key != ui.KeyEnter || event.Mods != 0 {
			return false
		}
		if !event.Repeat {
			play()
		}
		return true
	})
	if row.DoubleClicked() {
		play()
	} else if row.Clicked() || row.RightClicked() {
		a.selected = i
	}
	row.ContextMenu(func(m *ui.Menu) { a.trackMenu(m, i) })
}

func (a *prototype) trackMenu(m *ui.Menu, i int) {
	if m.Item("下一首播放").Chosen() {
		a.upNext = append([]int{i}, a.upNext...)
	}
	if m.Item("加入队列").Chosen() {
		a.upNext = append(a.upNext, i)
	}
	m.Submenu("加入歌单", func(sub *ui.Menu) {
		for j, p := range a.playlists {
			if sub.Item(p.name).Disabled(slices.Contains(p.tracks, i)).Chosen() {
				a.playlists[j].tracks = append(p.tracks, i)
			}
		}
	})
}

func (a *prototype) trackDetail(c *ui.Context, i int, w float32) {
	t, track := c.Theme(), demoTracks[i]
	ui.Column(c).Width(w).Padding(13).Gap(6).Radius(10).Background(t.Background).Children(func() {
		ui.Text(c, "曲目详情").FontSize(12).TextColor(t.TextMuted)
		singleLine(c, track.title).Bold().FontSize(17)
		singleLine(c, track.artist+" · "+track.album).FontSize(12).TextColor(t.TextMuted)
		ui.Row(c).Gap(4).Children(func() {
			if labelButton(c, "播放曲目", 85, true).Clicked() {
				a.selectDemo(i)
			}
			iconButton(c, moreIcon, "更多曲目操作", 38, false).
				Menu(func(m *ui.Menu) { a.trackMenu(m, i) })
		})
	})
}

func (a *prototype) advancePreview(now time.Time) {
	last := a.lastTick
	a.lastTick = now
	if !a.active && a.playing && !a.seeking && !last.IsZero() {
		a.position += max(0, now.Sub(last).Milliseconds())
		if a.position >= a.duration {
			if len(a.upNext) > 0 {
				a.changeTrack(1)
			} else {
				a.position, a.playing = a.duration, false
			}
		}
	}
}

func (a *prototype) togglePlayback() {
	if a.toggle != nil && (a.active || !a.demoStarted && len(a.playQueue.songs) > 0) {
		a.toggle()
		return
	}
	if a.cloudIdle() {
		return
	}
	if a.position >= a.duration {
		a.position = 0
	}
	a.playing = !a.playing
}

func (a *prototype) changeTrack(delta int) {
	if a.active || !a.demoStarted && len(a.playQueue.songs) > 0 {
		if delta < 0 && a.previous != nil {
			a.previous()
		}
		if delta > 0 && a.next != nil {
			a.next()
		}
		return
	}
	if a.cloudIdle() {
		return
	}
	if delta > 0 && len(a.upNext) != 0 {
		next := a.upNext[0]
		a.upNext = a.upNext[1:]
		a.selectDemo(next)
	} else if delta < 0 && len(a.history) != 0 {
		prev := a.history[len(a.history)-1]
		a.history = a.history[:len(a.history)-1]
		a.upNext = append([]int{a.track}, a.upNext...)
		a.startDemo(prev)
	} else if delta < 0 {
		a.seekTo(0)
	}
}

func (a *prototype) selectDemo(i int) {
	if a.exitProbe != nil && !a.exitProbe() {
		return
	}
	if a.active {
		return
	}
	if a.track != i {
		a.history = append(a.history, a.track)
	}
	a.startDemo(i)
}

func (a *prototype) startDemo(i int) {
	a.track, a.position, a.duration = i, 0, demoTracks[i].length
	a.demoStarted, a.seekable = true, true
	a.playing, a.lastLyric, a.followLyrics = true, -1, true
}

func heading(c *ui.Context, text string, size float32) ui.Element {
	return ui.Text(c, text).Role(ui.RoleHeading).FontSize(size).Bold()
}

func singleLine(c *ui.Context, text string) ui.Element {
	return ui.Text(c, text).MinWidth(0).MaxLines(1).Ellipsis("…")
}

func styleControl(e ui.Element, t *ui.Theme, selected bool) {
	e.FocusRingOffset(-2)
	switch {
	case e.Pressed():
		e.Background(t.SurfacePressed)
	case selected:
		e.Background(mix(t.SurfaceHover, t.Accent, .10))
	case e.Hovered():
		e.Background(t.SurfaceHover)
	}
}

func labelButton(c *ui.Context, label string, width float32, selected bool) ui.Element {
	e := ui.ButtonBase(c.Key(label)).Label(label).Size(width, 38).Radius(8)
	styleControl(e, c.Theme(), selected)
	e.Children(func() { ui.Text(c, label).FontSize(13).AccessHidden(true) })
	return e
}

func iconButton(c *ui.Context, glyph *ui.SVG, label string, size float32, primary bool) ui.Element {
	t := c.Theme()
	e := ui.ButtonBase(c).Size(size, size).Radius(9).Label(label).Tooltip(label)
	color := t.Text
	if primary {
		color = t.AccentText
		e.Radius(size / 2).Background(t.Accent).FocusRingColor(t.AccentText).FocusRingOffset(-3)
		if e.Hovered() {
			e.Background(t.AccentHover)
		}
		if e.Pressed() {
			e.Background(t.AccentPressed)
		}
	} else {
		styleControl(e, t, false)
	}
	e.Children(func() { drawIcon(c, glyph, 19, color) })
	return e
}

func settingsSection(c *ui.Context, title, description string, glyph *ui.SVG, content func()) {
	t := c.Theme()
	ui.Column(c).MaxWidth(720).MinWidth(0).Background(t.Background).Radius(10).Padding(14).Gap(10).Children(func() {
		ui.Row(c).AlignItems(ui.Center).Gap(9).Children(func() {
			drawIcon(c, glyph, 18, t.Accent)
			heading(c, title, 17)
		})
		if description != "" {
			ui.Text(c, description).FontSize(12).Wrap().TextColor(t.TextMuted)
		}
		content()
	})
}

func settingsInput(c *ui.Context, value *string, label, placeholder string) ui.Element {
	t := c.Theme()
	return ui.TextInput(c, value).Label(label).Placeholder(placeholder).Height(36).
		MinWidth(0).Radius(7).Background(t.Surface).BorderColor(t.Border).FocusRingOffset(-2)
}

func (a *prototype) settings(c *ui.Context) {
	settingsSection(c.Key("appearance"), "外观", "选择桌面客户端的颜色主题。", settingsIcon, func() {
		ui.Row(c).AlignItems(ui.Center).Gap(12).Children(func() {
			ui.Text(c, "颜色主题").FontSize(13)
			ui.Spacer(c).Grow(1)
			if ui.Select(c, &a.appearance, []string{followTheme, lightTheme, darkTheme}).Label("颜色主题").Width(136).Changed() && a.desktopRedraw != nil {
				a.desktopRedraw()
			}
		})
	})
	if a.desktopSettings != nil {
		a.desktopSettings(c.Key("desktop"))
	}
	if a.cloud != nil {
		a.cloudSettings(c.Key("cloud-settings"))
	}
	settingsSection(c.Key("audio"), "音频验证", "Windows 共享模式播放。可打开 HTTPS Range 测试音源，或用独立测试账号解析歌曲。", volumeIcon, func() {
		settingsInput(c.Key("source"), &a.source, "HTTPS 音源地址", "HTTPS 音源地址").Password()
		if labelButton(c, "打开测试音源", 112, false).Disabled(a.openSource == nil || a.source == "").Clicked() {
			source := a.source
			a.source = ""
			a.openSource(source)
		}
		settingsInput(c.Key("song-id"), &a.songID, "歌曲 ID", "CurrentMusic 歌曲 ID")
		settingsInput(c.Key("username"), &a.username, "测试账号用户名", "测试账号用户名")
		settingsInput(c.Key("password"), &a.password, "测试账号密码", "测试账号密码").Password()
		if labelButton(c, "登录测试账号并播放", 140, true).Disabled(a.resolve == nil || a.songID == "" || a.username == "" || a.password == "").Clicked() {
			password := a.password
			a.password = ""
			a.resolve(a.songID, a.username, password, a.quality)
		}
		if a.notice != "" {
			ui.Text(c, a.notice).Wrap()
		}
	})
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
	if a.cloudIdle() {
		return "尚未播放", "在曲库选择一首歌"
	}
	t := demoTracks[a.track]
	return t.title, t.artist
}

func (a *prototype) cloudIdle() bool {
	return a.cloud != nil && !a.active && !a.demoStarted
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
