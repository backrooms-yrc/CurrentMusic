package main

import (
	"bytes"
	"encoding/json"
	"image/color"
	"image/png"
	"os"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

type desktopPreferences struct {
	Lyrics       bool `json:"lyrics"`
	Locked       bool `json:"locked"`
	ClickThrough bool `json:"clickThrough"`
}

type desktopIntegration struct {
	app        *validationApp
	tray       *mygo.Tray
	menu       *mygo.Menu
	lyrics     *mygo.Window
	path       string
	settings   desktopPreferences
	locked     bool // Windows session lock, independent of the overlay lock.
	sleeping   bool
	quitting   bool
	lyricsItem *mygo.MenuItem
	lockItem   *mygo.MenuItem
	inputItem  *mygo.MenuItem
}

func (a *validationApp) installDesktop(path string) {
	d := &desktopIntegration{app: a, path: path}
	if data, err := os.ReadFile(path); err == nil {
		var prefs desktopPreferences
		if json.Unmarshal(data, &prefs) == nil {
			d.settings = prefs
		}
	}
	a.desktop, a.desktopSettings = d, d.viewSettings
	a.desktopRedraw = a.redrawDesktopLyrics
	d.createTray()
	a.window.OnClose(func(e *mygo.CloseEvent) {
		if d.quitting {
			return
		}
		e.PreventDefault()
		if d.tray != nil {
			a.window.Hide()
		} else {
			mygo.App.Quit()
		}
	})
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { d.quitting = true })
	mygo.Power.OnLockScreen(func() { d.locked = true; d.syncLyricsWindow() })
	mygo.Power.OnUnlockScreen(func() { d.locked = false; d.syncLyricsWindow() })
	mygo.Power.OnSuspend(func() {
		d.sleeping = true
		d.syncLyricsWindow()
		a.clock.playing = false
		a.saveListening(false)
	})
	mygo.Power.OnResume(func() {
		d.sleeping = false
		d.syncLyricsWindow()
		a.refreshAfterDesktopChange()
	})
	mygo.Screen.OnDisplaysChanged(func() { d.keepLyricsOnScreen() })
	d.syncLyricsWindow()
}

func (a *validationApp) redrawDesktopLyrics() {
	if a.desktop != nil {
		a.desktop.redrawLyrics()
	}
}

func (a *validationApp) restoreMainWindow() {
	if a.desktop != nil && a.desktop.quitting {
		return
	}
	if a.window.IsMinimized() {
		a.window.Restore()
	}
	if !a.window.IsVisible() {
		a.window.Show()
	}
	a.window.Focus()
}

func (d *desktopIntegration) createTray() {
	var pngData bytes.Buffer
	if err := png.Encode(&pngData, brandIcon.Image(32, 32, color.NRGBA{R: 20, G: 138, B: 124, A: 255})); err != nil {
		return
	}
	item := func(label string, act func()) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) {
			d.app.window.Update(act)
		}}
	}
	d.lyricsItem = item("显示桌面歌词", func() { d.setLyrics(!d.settings.Lyrics) })
	d.lockItem = item("锁定歌词位置", func() { d.setLocked(!d.settings.Locked) })
	d.inputItem = item("歌词点击穿透", func() { d.setClickThrough(!d.settings.ClickThrough) })
	for _, check := range []*mygo.MenuItem{d.lyricsItem, d.lockItem, d.inputItem} {
		check.Type = mygo.MenuItemCheckbox
	}
	d.menu = mygo.NewMenu([]*mygo.MenuItem{
		item("显示 CurrentMusic", d.app.restoreMainWindow), mygo.Separator(),
		item("上一首", func() { d.app.changeTrack(-1) }), item("播放 / 暂停", d.app.togglePlayback),
		item("下一首", func() { d.app.changeTrack(1) }), mygo.Separator(),
		d.lyricsItem, d.lockItem, d.inputItem, mygo.Separator(),
		{Label: "退出 CurrentMusic", Click: func(*mygo.MenuItem, *mygo.Window) { mygo.App.Quit() }},
	})
	tray, err := mygo.NewTray(mygo.TrayOptions{
		ID: "CurrentMusic.Windows", ToolTip: "CurrentMusic", Icon: pngData.Bytes(), Menu: d.menu,
	})
	if err != nil {
		d.app.notice = "无法创建 CurrentMusic 托盘图标"
		return
	}
	d.tray = tray
	tray.OnClick(d.app.restoreMainWindow)
	d.syncMenu()
}

func (d *desktopIntegration) syncMenu() {
	if d.tray == nil {
		return
	}
	d.lyricsItem.SetChecked(d.settings.Lyrics)
	d.lockItem.SetChecked(d.settings.Locked)
	d.inputItem.SetChecked(d.settings.ClickThrough)
	d.tray.SetMenu(d.menu)
}

func (d *desktopIntegration) save() {
	if d.path != "" && writeLocalJSON(d.path, d.settings) != nil {
		d.app.notice = "无法保存桌面歌词设置"
	}
}

func (d *desktopIntegration) setLyrics(enabled bool) {
	d.settings.Lyrics = enabled
	d.save()
	d.syncMenu()
	d.syncLyricsWindow()
}

func (d *desktopIntegration) setLocked(locked bool) {
	d.settings.Locked = locked
	d.save()
	d.syncMenu()
	d.syncLyricsWindow()
}

func (d *desktopIntegration) setClickThrough(enabled bool) {
	d.settings.ClickThrough = enabled
	d.save()
	d.syncMenu()
	d.syncLyricsWindow()
}

func (d *desktopIntegration) syncLyricsWindow() {
	if d.quitting || d.locked || d.sleeping || !d.settings.Lyrics {
		if d.lyrics != nil {
			d.lyrics.Hide()
		}
		return
	}
	if d.lyrics == nil {
		opts := mygo.WindowOptions{
			Title: "CurrentMusic 桌面歌词", Hidden: true, Frameless: true,
			Width: 620, Height: 128, AlwaysOnTop: true, SkipTaskbar: true,
			DisableResize: true, DisableMaximize: true, DisableFullScreen: true,
			Content: ui.View(d.viewLyrics),
		}
		if d.path != "" {
			opts.StateKey = "desktop-lyrics"
		}
		work := mygo.Screen.PrimaryDisplay().WorkArea
		bounds := desktopLyricsBounds(mygo.Rectangle{}, work)
		opts.X, opts.Y, opts.Width, opts.Height = bounds.X, bounds.Y, bounds.Width, bounds.Height
		d.lyrics = mygo.NewWindow(opts)
		d.lyrics.OnClose(func(e *mygo.CloseEvent) {
			if !d.quitting {
				e.PreventDefault()
				d.setLyrics(false)
				d.app.window.Invalidate()
			}
		})
	}
	d.lyrics.SetMovable(!d.settings.Locked && !d.settings.ClickThrough)
	d.lyrics.SetIgnoreMouseEvents(d.settings.ClickThrough)
	d.keepLyricsOnScreen()
	if !d.lyrics.IsVisible() {
		d.lyrics.ShowInactive()
	}
	d.lyrics.Invalidate()
}

func (d *desktopIntegration) keepLyricsOnScreen() {
	if d.lyrics == nil {
		return
	}
	bounds := d.lyrics.Bounds()
	display := mygo.Screen.DisplayMatching(bounds)
	work := display.WorkArea
	if fixed := desktopLyricsBounds(bounds, work); fixed != bounds {
		d.lyrics.SetBounds(fixed)
	}
}

func desktopLyricsBounds(bounds, work mygo.Rectangle) mygo.Rectangle {
	if work.Width <= 0 || work.Height <= 0 {
		return mygo.Rectangle{Width: 620, Height: 128}
	}
	w, h := min(620, work.Width), min(128, work.Height)
	if bounds.Width == 0 || bounds.Height == 0 || bounds.X+bounds.Width <= work.X || bounds.X >= work.X+work.Width ||
		bounds.Y+bounds.Height <= work.Y || bounds.Y >= work.Y+work.Height {
		return mygo.Rectangle{X: work.X + (work.Width-w)/2, Y: work.Y + max(0, work.Height-h-24), Width: w, Height: h}
	}
	return mygo.Rectangle{
		X: min(max(bounds.X, work.X), work.X+work.Width-w),
		Y: min(max(bounds.Y, work.Y), work.Y+work.Height-h), Width: w, Height: h,
	}
}

func (d *desktopIntegration) redrawLyrics() {
	if d.lyrics != nil && d.settings.Lyrics && !d.sleeping && !d.locked && !d.quitting {
		d.lyrics.Invalidate()
	}
}

func (d *desktopIntegration) viewSettings(c *ui.Context) {
	settingsSection(c, "桌面集成", "关闭主窗口后可从托盘恢复。点击穿透时可从这里或托盘重新启用歌词窗口的鼠标操作。", queueIcon, func() {
		lyrics, locked, clickThrough := d.settings.Lyrics, d.settings.Locked, d.settings.ClickThrough
		if ui.Checkbox(c.Key("show"), &lyrics, "显示桌面歌词").Changed() {
			d.setLyrics(lyrics)
		}
		if ui.Checkbox(c.Key("locked"), &locked, "锁定歌词位置").Changed() {
			d.setLocked(locked)
		}
		if ui.Checkbox(c.Key("click-through"), &clickThrough, "歌词点击穿透").Changed() {
			d.setClickThrough(clickThrough)
		}
		if labelButton(c.Key("quit"), "退出 CurrentMusic", 148, false).Clicked() {
			mygo.App.Quit()
		}
	})
}

func (d *desktopIntegration) viewLyrics(c *ui.Context) {
	a := d.app.prototype
	if !a.highContrast {
		c.SetTheme(brandTheme(a.appearance == darkTheme || a.appearance == followTheme && c.Theme().Dark))
	}
	t := c.Theme()
	lines, index, message := a.lyricFrame()
	ui.Column(c).Fill().Background(t.Surface).Padding(5, 14, 8).Gap(4).Children(func() {
		ui.Row(c.Key("header")).Height(30).AlignItems(ui.Center).Gap(5).Children(func() {
			title, _ := a.metadata()
			header := ui.Row(c).Grow(1).MinWidth(0).FillHeight().AlignItems(ui.Center)
			if !d.settings.Locked && !d.settings.ClickThrough {
				header.DragWindow()
			}
			header.Children(func() { singleLine(c, title).FontSize(12).TextColor(t.TextMuted) })
			if !d.settings.ClickThrough {
				label := "锁定"
				if d.settings.Locked {
					label = "解锁"
				}
				lock := ui.ButtonBase(c.Key("lock")).Label(label+"歌词位置").Size(48, 28).Radius(6)
				styleControl(lock, t, d.settings.Locked)
				lock.Children(func() { ui.Text(c, label).FontSize(12).AccessHidden(true) })
				if lock.Clicked() {
					d.setLocked(!d.settings.Locked)
					d.app.window.Invalidate()
				}
				if iconButton(c.Key("close"), closeIcon, "关闭桌面歌词", 28, false).Clicked() {
					d.setLyrics(false)
					d.app.window.Invalidate()
				}
			}
		})
		if index < 0 {
			ui.Text(c, message).FontSize(16).TextColor(t.TextMuted)
			return
		}
		line := lines[index]
		ui.Column(c.Key("line")).MinWidth(0).Gap(3).Label(line.text).Children(func() {
			a.currentLine(c, line, 25).MaxLines(2).Ellipsis("…")
			if line.translation != "" {
				singleLine(c, line.translation).FontSize(12).TextColor(t.TextMuted)
			} else if index+1 < len(lines) {
				singleLine(c, lines[index+1].text).FontSize(12).TextColor(t.TextMuted)
			}
		})
	})
}
