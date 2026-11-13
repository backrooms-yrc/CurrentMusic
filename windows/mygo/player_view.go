package main

import (
	"fmt"

	"github.com/egoist/mygo/ui"
	"github.com/oneo-me/onevra/source/components"
)

type timedLine struct {
	start       int64
	text        string
	words       []int64 // Relative character offsets in the demo.
	tokens      []timedWord
	translation string
	estimated   bool
}

var demoLyrics = []timedLine{
	{start: 0, text: "沿着夜色走到海边", words: []int64{0, 520, 1120, 1770, 2450, 3090, 3710, 4590}},
	{start: 6000, text: "看灯火落进海面", words: []int64{0, 580, 990, 1660, 2590, 3440, 4290}},
	{start: 12000, text: "风把沉默吹向远方", words: []int64{0, 540, 940, 1540, 2420, 3130, 3820, 4530}},
	{start: 18000, text: "我们在潮汐之间", words: []int64{0, 600, 1030, 1700, 2480, 3690, 4590}},
	{start: 24000, text: "等天光慢慢浮现", words: []int64{0, 600, 1080, 1620, 2330, 3230, 4350}},
	{start: 30000, text: "把远处的星留给明天"},
	{start: 36000, text: "海浪轻轻覆盖足迹"},
	{start: 42000, text: "清晨从这里开始"},
}

func (a *prototype) playingPage(c *ui.Context, w, h float32) {
	t := c.Theme()
	wide := w >= 756 && h >= 405
	dense := h < 230
	pad, gap := float32(19), float32(22)
	topPad, bottomPad, headerHeight := float32(9), float32(14), float32(46)
	if dense {
		topPad, bottomPad, headerHeight = 2, 5, 40
	}
	if wide {
		pad, gap = max(30, (w-1020)/2), min(68, w*.058)
	}
	background, base := t.Surface, t.Surface
	if !a.highContrast && (!a.active || a.albumArt != nil) {
		tint := float32(.18)
		if t.Dark {
			tint = .35
		}
		color := coverTints[a.track]
		if a.active {
			color = a.albumTint
		}
		background, base = mix(background, color, tint), mix(base, color, tint*.28)
	}
	page := ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).
		Gradient(background, base, 124).Radius(12).Clip().Padding(topPad, pad, bottomPad)
	trackID := a.currentCloudTrackID()
	infoOpen := trackID > 0 && a.cloud != nil && a.cloud.songInfo.songID == trackID
	page.Children(func() {
		ui.Row(c.Key("player-header")).Height(headerHeight).Role(ui.RoleToolbar).Label("播放页工具栏").AlignItems(ui.Center).Gap(8).Children(func() {
			if iconButton(c, downIcon, "收起播放页", 38, false).Clicked() {
				a.player = false
			}
			ui.Text(c, "正在播放").FontSize(13).Bold()
			if !a.active && !dense {
				components.Badge(c, "演示")
			}
			ui.Spacer(c).Grow(1)
			if trackID > 0 && a.cloud != nil {
				if infoOpen {
					if labelButton(c, "关闭详情", 80, false).Clicked() {
						a.cloud.songInfo = cloudSongInfo{}
					}
				} else {
					iconButton(c, moreIcon, "歌曲详情", 38, false).Disabled(a.cloud.busy).Menu(func(m *ui.Menu) {
						for _, info := range []struct{ label, mode string }{
							{"音源规格", "qualities"}, {"副歌段落", "chorus"}, {"其他版本", "versions"}, {"歌曲百科", "wiki"},
						} {
							if m.Item(info.label).Chosen() {
								a.cloud.loadSongInfo(trackID, info.mode)
							}
						}
					})
				}
			}
			if !wide && !infoOpen {
				if labelButton(c, "封面", 52, !a.lyrics).AccessSelected(!a.lyrics).Clicked() {
					a.lyrics = false
				}
				if labelButton(c, "歌词", 52, a.lyrics).AccessSelected(a.lyrics).Clicked() {
					a.lyrics, a.lastLyric = true, -1
				}
			}
		})
		if infoOpen {
			a.cloudSongInfoPage(c.Key("song-info"))
			return
		}
		top := float32(0)
		if wide {
			top = min(44, max(12, (h-465)/4))
		}
		ui.Row(c.Key("player-content")).Grow(1).MinHeight(0).AlignItems(ui.Stretch).Padding(top, 0, 0).Gap(gap).Children(func() {
			if wide || !a.lyrics {
				artW := w - 2*pad
				if wide {
					artW = min(365, (artW-gap)*.44)
				}
				a.playingCover(c.Key("artwork"), artW, h-headerHeight-top-topPad-bottomPad, wide)
			}
			if wide || a.lyrics {
				a.lyricPanel(c.Key("lyrics"), wide, dense)
			}
		})
	})
}

func (a *prototype) playingCover(c *ui.Context, w, h float32, wide bool) {
	size := min(w-8, max(80, h-100), 352)
	title, artist := a.metadata()
	art := func() {
		if a.albumArt != nil {
			ui.Image(c, a.albumArt).Size(size, size).Fit(ui.Cover).Radius(12).Clip().AccessHidden(true)
		} else if a.active {
			sourceCover(c, size, 12)
		} else {
			cover(c, a.track, size, 12)
		}
	}
	text := func(fontSize float32) {
		ui.Column(c).MinWidth(0).Gap(4).Children(func() {
			ui.Text(c, title).MinWidth(0).FontSize(fontSize).Bold().Wrap().MaxLines(2).Ellipsis("…").Tooltip(title)
			singleLine(c, artist).FontSize(14).TextColor(c.Theme().TextMuted).Tooltip(artist)
			if a.audioSpec != "" && a.active {
				ui.Text(c, "音源规格 · "+a.audioSpec).FontSize(11).TextColor(c.Theme().TextMuted).Wrap()
			}
		})
	}
	if !wide && h < 250 {
		size = max(64, min(140, h-8))
		ui.Row(c).Width(w).AlignItems(ui.Center).PaddingX(4).Gap(14).Children(func() {
			art()
			ui.Column(c).Grow(1).MinWidth(0).Children(func() { text(22) })
		})
		return
	}
	ui.Scroll(c).Width(w).MinHeight(0).Children(func() {
		ui.Column(c).Padding(5, 4, 8).Gap(14).Children(func() {
			art()
			text(29)
		})
	})
}

func (a *prototype) lyricPanel(c *ui.Context, wide, dense bool) {
	t := c.Theme()
	rowHeight, linePad, textSize := float32(41), float32(7), float32(20)
	if dense {
		rowHeight, linePad, textSize = 33, 2, 17
	}
	lines, active, message := a.lyricFrame()
	ui.Column(c).Grow(1).MinWidth(0).MinHeight(0).Gap(4).Children(func() {
		ui.Row(c.Key("lyric-header")).Height(34).PaddingX(9).AlignItems(ui.Center).Gap(8).Children(func() {
			heading(c, "同步歌词", 13).TextColor(t.TextMuted)
			if active >= 0 && lines[active].estimated && len(lines[active].tokens) > 0 {
				ui.Text(c, "估算逐字").FontSize(11).TextColor(t.TextMuted)
			}
			ui.Spacer(c).Grow(1)
			if !a.followLyrics && labelButton(c, "回到当前行", 95, true).Clicked() {
				a.followLyrics, a.lastLyric = true, -1
			}
		})
		if len(lines) == 0 {
			ui.Text(c, message).TextColor(t.TextMuted)
			return
		}
		reveal := a.followLyrics && a.lastLyric != active
		a.lastLyric = active
		ui.Scroll(c.Key("lines")).Grow(1).MinHeight(0).TrackScroll(&a.lyricScroll).
			HandleInput(func(event ui.InputEvent) bool {
				if event.Kind == ui.InputScroll && event.DY != 0 {
					a.followLyrics = false
				}
				return false
			}).Children(func() {
			ui.Column(c).Gap(4).Padding(2, 4, 9).Children(func() {
				for i, line := range lines {
					row := ui.ButtonBase(c.Key(i)).Justify(ui.Start).AlignItems(ui.Center).
						Padding(linePad, 10).MinHeight(rowHeight).MinWidth(0).Radius(8).Label(line.text)
					styleControl(row, t, i == active)
					row.Children(func() {
						ui.Column(c).Grow(1).MinWidth(0).Gap(3).Children(func() {
							if i == active {
								size := float32(23)
								if wide {
									size = 33
								}
								a.currentLine(c, line, size)
							} else {
								ui.Text(c, line.text).FontSize(textSize).Wrap().TextColor(t.TextMuted).AccessHidden(true)
							}
							if line.translation != "" {
								ui.Text(c, line.translation).FontSize(13).Wrap().TextColor(t.TextMuted)
							}
						})
					})
					if i == active && reveal {
						alignment := ui.ScrollIntoViewOptions{Block: ui.ScrollCenter}
						if dense {
							alignment.Block = ui.ScrollStart
						}
						row.ScrollIntoView(alignment)
					}
					if row.Clicked() {
						a.seekTo(line.start)
						a.followLyrics, a.lastLyric = true, -1
					}
				}
			})
		})
	})
}

func (a *prototype) lyricFrame() ([]timedLine, int, string) {
	lines, message := demoLyrics, "等待歌词…"
	switch {
	case a.active && a.cloudTrack:
		lines, message = a.cloudLyrics, a.lyricStatus
	case a.active:
		lines, message = nil, "此测试音源暂无歌词"
	case a.cloudIdle():
		lines, message = nil, "等待播放…"
	case a.track != 0:
		lines, message = nil, "此演示曲目暂无歌词"
	}
	active := -1
	for i, line := range lines {
		if line.start > a.position {
			break
		}
		active = i
	}
	if len(lines) > 0 && active < 0 {
		message = "等待歌词…"
	}
	return lines, active, message
}

func (a *prototype) currentLine(c *ui.Context, line timedLine, size float32) ui.Element {
	t := c.Theme()
	if len(line.tokens) > 0 {
		split := 0
		for _, word := range line.tokens {
			if word.Start > a.position {
				break
			}
			split += len(word.Text)
		}
		return ui.RichText(c, ui.Span{Text: line.text[:split], Color: t.Accent}, ui.Span{Text: line.text[split:], Color: t.Text}).
			FontSize(size).Bold().Wrap().AccessHidden(true)
	}
	if len(line.words) == 0 {
		return ui.Text(c, line.text).FontSize(size).Bold().Wrap().AccessHidden(true)
	}
	split := 0
	for _, offset := range line.words {
		if line.start+offset > a.position {
			break
		}
		split++
	}
	chars := []rune(line.text)
	split = min(split, len(chars))
	return ui.RichText(c,
		ui.Span{Text: string(chars[:split]), Color: t.Accent},
		ui.Span{Text: string(chars[split:]), Color: t.Text},
	).FontSize(size).Bold().Wrap().AccessHidden(true)
}

func (a *prototype) queuePanel(c *ui.Context, width, height float32, drawer bool, close func()) {
	t := c.Theme()
	padding, gap, rowGap := float32(13), float32(9), float32(7)
	if height < 230 {
		padding, gap, rowGap = 5, 5, 4
	}
	ui.Column(c).Width(width).MinHeight(0).Padding(padding, 11).Gap(gap).Radius(12).
		Background(t.Surface).Label("队列面板").
		Children(func() {
			ui.Row(c).AlignItems(ui.Center).Children(func() {
				heading(c, "播放队列", 18).Grow(1)
				button := iconButton(c.Key("close"), closeIcon, "关闭队列", 38, false)
				if drawer {
					button.AutoFocus()
				}
				if button.Clicked() {
					close()
				}
			})
			if a.cloud != nil && (!a.active && !a.demoStarted || a.cloudTrack) {
				a.cloudQueuePanel(c.Key("cloud-queue"), height < 230)
				return
			}
			ui.Scroll(c.Key("queue-scroll")).Grow(1).MinHeight(0).Children(func() {
				ui.Column(c).Gap(rowGap).Children(func() {
					if a.cloudIdle() {
						ui.Text(c, "队列为空").TextColor(t.TextMuted)
						return
					}
					title, artist := a.metadata()
					ui.Text(c, "正在播放").FontSize(12).Bold().TextColor(t.Accent)
					a.queueRow(c.Key("current"), title, artist, a.track, nil)
					if a.active {
						subtitle := "测试音源"
						if a.cloudTrack {
							subtitle = "曲目"
						}
						if a.probeQueue != nil {
							for i, title := range a.probeQueue() {
								a.queueRow(c.Key(i), title, subtitle, 0, nil)
							}
						}
						return
					}
					ui.Text(c, fmt.Sprintf("接下来 · %d 首", len(a.upNext))).FontSize(12).TextColor(t.TextMuted)
					for slot, i := range a.upNext {
						track := demoTracks[i]
						a.queueRow(c.Key(slot), track.title, track.artist, i, func() {
							a.upNext = append(a.upNext[:slot], a.upNext[slot+1:]...)
							a.selectDemo(i)
						})
					}
				})
			})
		})
}

func (a *prototype) cloudQueuePanel(c *ui.Context, compact bool) {
	q, t := &a.playQueue, c.Theme()
	ui.Row(c.Key("mode-bar")).AlignItems(ui.Center).Gap(7).Children(func() {
		mode := ui.ButtonBase(c.Key("mode")).Size(108, 33).Radius(7).Label("播放模式 · " + playModeNames[q.mode]).Disabled(a.queueLoading)
		styleControl(mode, t, true)
		mode.Children(func() {
			ui.Row(c).Gap(4).AlignItems(ui.Center).Children(func() {
				ui.Text(c, playModeNames[q.mode]).FontSize(12).AccessHidden(true)
				drawIcon(c, downIcon, 12, t.TextMuted)
			})
		})
		mode.Menu(func(m *ui.Menu) {
			for index, name := range playModeNames {
				if m.Item(name).Chosen() && q.mode != playMode(index) {
					q.mode = playMode(index)
					if q.mode == shuffleQueue {
						q.shuffleRemaining()
					}
					if a.queueChanged != nil {
						a.queueChanged()
					}
				}
			}
		})
		if len(q.songs) > 0 {
			ui.Spacer(c).Grow(1)
			ui.Text(c, fmt.Sprintf("%d 首", len(q.songs))).FontSize(11).TextColor(t.TextMuted)
		}
	})
	ui.Scroll(c.Key("songs")).Grow(1).MinHeight(0).Children(func() {
		if len(q.songs) == 0 {
			ui.Text(c, "队列为空").TextColor(t.TextMuted)
			return
		}
		ui.Column(c).Gap(4).Role(ui.RoleList).Label("队列曲目").Children(func() {
			remove := -1
			section := func(label string, first, last int) {
				if first == last {
					return
				}
				if !compact {
					heading(c, label, 11).Padding(4, 7, 2).TextColor(t.TextMuted)
				}
				for i := first; i < last; i++ {
					if a.cloudQueueRow(c.Key(i), i, compact) {
						remove = i
					}
				}
			}
			if q.index >= 0 {
				section("正在播放", q.index, q.index+1)
			}
			section("接下来", q.index+1, len(q.songs))
			section("前面的曲目", 0, max(0, q.index))
			if remove >= 0 {
				q.remove(remove)
				if a.queueChanged != nil {
					a.queueChanged()
				}
			}
		})
	})
}

func (a *prototype) cloudQueueRow(c *ui.Context, i int, compact bool) bool {
	q, t := &a.playQueue, c.Theme()
	song, current := q.songs[i], i == q.index
	remove := false
	ui.Row(c).AlignItems(ui.Center).Gap(3).Children(func() {
		height := float32(42)
		if compact {
			height = 38
		}
		item := ui.ButtonBase(c.Key("play")).Height(height).Grow(1).MinWidth(0).Radius(7).
			Label("播放 " + song.Name).Tooltip(song.Name).AccessSelected(current)
		styleControl(item, t, current)
		item.Children(func() {
			ui.Row(c).Grow(1).MinWidth(0).PaddingX(7).AlignItems(ui.Center).Gap(7).Children(func() {
				if current && a.albumArt != nil {
					ui.Image(c, a.albumArt).Size(27, 27).Fit(ui.Cover).Radius(5).Clip().AccessHidden(true)
				} else {
					sourceCover(c, 27, 5)
				}
				ui.Column(c).Grow(1).MinWidth(0).Children(func() {
					name := singleLine(c, song.Name).FontSize(13).Bold().AccessHidden(true)
					if current {
						name.TextColor(t.Accent)
					}
					singleLine(c, song.Artists).FontSize(11).TextColor(t.TextMuted).AccessHidden(true)
				})
			})
		})
		if item.Clicked() && a.openQueued != nil {
			a.openQueued(i)
		}
		if !current {
			remove = iconButton(c.Key("remove"), closeIcon, "移除 "+song.Name, 32, false).Disabled(a.queueLoading).Clicked()
		}
	})
	return remove
}

func (a *prototype) queueRow(c *ui.Context, title, artist string, i int, play func()) {
	t := c.Theme()
	content := func() {
		ui.Row(c).Grow(1).MinWidth(0).Gap(9).AlignItems(ui.Center).PaddingX(5).Children(func() {
			if a.active {
				sourceCover(c, 35, 6)
			} else {
				cover(c, i, 35, 6)
			}
			ui.Column(c).Grow(1).MinWidth(0).Children(func() {
				singleLine(c, title).Bold()
				singleLine(c, artist).TextColor(t.TextMuted).FontSize(12)
			})
		})
	}
	if play == nil {
		ui.Row(c).Height(46).Radius(8).Background(t.SurfaceHover).Children(content)
		return
	}
	item := ui.ButtonBase(c).Height(46).Radius(8).Label("播放 " + title).Tooltip(title)
	styleControl(item, t, false)
	item.Children(content)
	if item.Clicked() {
		play()
	}
}

func (a *prototype) transport(c *ui.Context, w float32) {
	t := c.Theme()
	wide := w >= 850
	ui.Column(c).Height(barHeight).Role(ui.RoleToolbar).Label("播放栏").Radius(12).Background(t.Surface).Padding(3, 10, 3).Children(func() {
		if wide {
			flank := min(260, w*.29)
			ui.Row(c).Grow(1).AlignItems(ui.Center).Justify(ui.SpaceBetween).Gap(10).Children(func() {
				a.nowPlayingButton(c.Key("expand"), flank)
				ui.Column(c).Grow(1).MinWidth(0).MaxWidth(470).Children(func() {
					a.transportButtons(c.Key("controls"))
					a.timeline(c.Key("timeline"))
				})
				a.transportExtras(c.Key("extras"), flank, true)
			})
		} else {
			ui.Row(c).Height(48).AlignItems(ui.Center).Gap(4).Children(func() {
				flank := (w - 20 - 144 - 8) / 2
				a.nowPlayingButton(c.Key("expand"), flank)
				ui.Box(c).Width(144).Children(func() { a.transportButtons(c.Key("controls")) })
				a.transportExtras(c.Key("extras"), flank, false)
			})
			a.timeline(c.Key("timeline"))
		}
	})
}

func (a *prototype) nowPlayingButton(c *ui.Context, w float32) {
	t := c.Theme()
	title, artist := a.metadata()
	label := "展开播放页"
	if a.player {
		label = "收起播放页"
	}
	open := ui.ButtonBase(c).Label(label).Tooltip(title+" · "+artist).Size(w, 48).
		Radius(8).AccessSelected(a.player).Disabled(a.cloudIdle())
	styleControl(open, t, a.player)
	open.Children(func() {
		ui.Row(c).Grow(1).MinWidth(0).AlignItems(ui.Center).Gap(8).PaddingX(5).Children(func() {
			if a.albumArt != nil {
				ui.Image(c, a.albumArt).Size(40, 40).Radius(7).Clip().AccessHidden(true)
			} else if a.active || a.cloudIdle() {
				sourceCover(c, 40, 7)
			} else {
				cover(c, a.track, 40, 7)
			}
			ui.Column(c).Grow(1).MinWidth(0).Children(func() {
				singleLine(c, title).Bold().FontSize(13).AccessHidden(true)
				singleLine(c, artist).FontSize(12).TextColor(t.TextMuted).AccessHidden(true)
			})
		})
	})
	if open.Clicked() {
		a.player, a.lastLyric = !a.player, -1
	}
}

func (a *prototype) transportButtons(c *ui.Context) {
	ui.Row(c).Height(47).AlignItems(ui.Center).Justify(ui.Center).Gap(4).Children(func() {
		idle := a.cloudIdle() && len(a.playQueue.songs) == 0
		if iconButton(c.Key("previous"), prevIcon, "上一首", 38, false).Disabled(a.cloudIdle()).Clicked() {
			a.changeTrack(-1)
		}
		icon, label := playIcon, "播放"
		if a.playing || a.playIntent != nil && a.playIntent() {
			icon, label = pauseIcon, "暂停"
		}
		if iconButton(c.Key("toggle"), icon, label, 42, true).Disabled(idle).Clicked() {
			a.togglePlayback()
		}
		if iconButton(c.Key("next"), nextIcon, "下一首", 38, false).Disabled(idle).Clicked() {
			a.changeTrack(1)
		}
	})
}

func (a *prototype) timeline(c *ui.Context) {
	t := c.Theme()
	ui.Row(c).Height(25).AlignItems(ui.Center).Gap(1).Children(func() {
		shown := a.position
		if a.seeking {
			shown = int64(a.scrub)
		}
		ui.Text(c, clockLabel(shown)).Width(42).TextAlign(ui.End).FontSize(12).TextColor(t.TextMuted)
		a.progress(c.Key("progress"), t.SurfacePressed)
		ui.Text(c, clockLabel(a.duration)).Width(42).FontSize(12).TextColor(t.TextMuted)
	})
}

func (a *prototype) transportExtras(c *ui.Context, w float32, wide bool) {
	t := c.Theme()
	ui.Row(c).Width(w).AlignItems(ui.Center).Justify(ui.End).Gap(5).Children(func() {
		quality := ui.ButtonBase(c.Key("quality")).Label("音质").Tooltip("音质 · "+a.quality).
			Size(60, 38).Radius(7).Background(t.Background)
		styleControl(quality, t, false)
		quality.Children(func() {
			ui.Row(c).AlignItems(ui.Center).Gap(3).Children(func() {
				ui.Text(c, a.quality).FontSize(12).Bold().AccessHidden(true)
				drawIcon(c, downIcon, 12, t.TextMuted)
			})
		})
		quality.Menu(func(m *ui.Menu) {
			for _, level := range []string{"自动", "标准", "极高", "无损"} {
				if m.Item(level).Chosen() {
					if a.changeQuality != nil {
						a.changeQuality(level)
					} else {
						a.quality = level
					}
				}
			}
		})
		if wide && w >= 235 {
			drawIcon(c, volumeIcon, 17, t.TextMuted)
			a.volumeControl(c.Key("inline-volume"), 64)
		} else {
			volume := iconButton(c.Key("volume"), volumeIcon, "调节音量", 40, false).AccessSelected(a.volumeOpen)
			if volume.Clicked() {
				a.volumeOpen = !a.volumeOpen
			}
			ui.Popover(c, volume, &a.volumeOpen, func() {
				ui.Column(c).Padding(8, 12).Gap(2).Children(func() {
					ui.Text(c, fmt.Sprintf("音量 · %d%%", int(a.volume*100+.5))).FontSize(12).TextColor(t.TextMuted)
					a.volumeControl(c, 144)
				})
			})
		}
		queue := iconButton(c.Key("queue"), queueIcon, "播放队列", 40, false).Bind(&a.queueFocus).AccessSelected(a.queue)
		styleControl(queue, t, a.queue)
		if queue.Clicked() {
			a.queue = !a.queue
		}
	})
}

func (a *prototype) volumeControl(c *ui.Context, width float32) {
	slider := ui.Slider(c.Key("volume"), &a.volume, 0, 1).Width(width).Label("音量")
	if slider.Changed() && a.setVolume != nil {
		a.setVolume(a.volume)
	}
}
