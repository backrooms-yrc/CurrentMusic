package main

import (
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
)

func driveFileSize(size driveNumber) string {
	switch {
	case size >= 1<<30:
		return fmt.Sprintf("%.2f GiB", float64(size)/(1<<30))
	case size >= 1<<20:
		return fmt.Sprintf("%.1f MiB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%.0f KiB", float64(size)/(1<<10))
	default:
		return size.String() + " B"
	}
}

func (a *prototype) cloudDrivePage(c *ui.Context, compact bool) {
	s, d := a.cloud, &a.cloud.drive
	personal := d.tab == "personal"
	showDrive := func() {
		d.tab = "drive"
		if !d.loaded {
			s.loadDrive(false)
		}
	}
	showPersonal := func() {
		d.tab = "personal"
		s.loadDrivePersonalMedia()
	}
	if !compact {
		sectionHeading(c, "音乐云盘", "", "", false)
	}
	ui.Row(c.Key("tabs")).Gap(6).AlignItems(ui.Center).Children(func() {
		if compact {
			if personal {
				heading(c, "我的电台与音频", 18)
				if labelButton(c, "返回云盘", 92, false).Disabled(s.busy).Clicked() {
					showDrive()
				}
			} else {
				heading(c, "音乐云盘", 18)
				if labelButton(c, "我的电台与音频", 128, false).Disabled(s.busy).Clicked() {
					showPersonal()
				}
			}
		} else {
			if labelButton(c, "云盘曲目", 92, !personal).AccessSelected(!personal).Disabled(s.busy).Clicked() {
				showDrive()
			}
			if labelButton(c, "我的电台与音频", 128, personal).AccessSelected(personal).Disabled(s.busy).Clicked() {
				showPersonal()
			}
		}
		if labelButton(c, "刷新", 62, false).Disabled(s.busy).Clicked() {
			if personal {
				s.loadDrivePersonalMedia()
			} else {
				s.loadDrive(false)
			}
		}
		if labelButton(c, "绑定设置", 92, false).Disabled(s.busy).Clicked() {
			a.page = settingsPage
			s.binding.visible = true
			s.loadBinding()
		}
	})
	a.cloudStatus(c.Key("status"))
	if d.tab == "personal" {
		a.cloudDrivePersonal(c.Key("personal"))
		return
	}
	if !d.loaded {
		if !s.busy {
			ui.Text(c, "云盘需要有效的网易云绑定。").Wrap().TextColor(c.Theme().TextMuted)
		}
		return
	}
	ui.Text(c, fmt.Sprintf("已用 %s / %s · %s 首", driveFileSize(d.used), driveFileSize(d.quota), d.count.String())).TextColor(c.Theme().TextMuted)
	ui.Row(c.Key("uploads")).Gap(6).Children(func() {
		if labelButton(c, "上传音频", 92, true).Disabled(s.busy || s.openAudioFile == nil || d.pending != nil).Clicked() {
			s.uploadDrive(false)
		}
		if labelButton(c, "旧接口上传", 106, false).Disabled(s.busy || s.openAudioFile == nil || d.pending != nil).Clicked() {
			s.uploadDrive(true)
		}
		if labelButton(c, "导入已上传文件", 132, d.action == "import").Disabled(s.busy).Clicked() {
			d.action = "import"
		}
	})
	if d.pending != nil {
		ui.Text(c, "等待入库 · "+d.pending.Filename).Wrap()
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "重试入库", 92, true).Disabled(s.busy).Clicked() {
				s.retryDriveUpload()
			}
			if labelButton(c, "放弃重试", 92, false).Disabled(s.busy).Clicked() {
				d.pending = nil
			}
		})
	}
	if d.action == "import" {
		ui.Column(c.Key("import")).MaxWidth(450).Gap(6).Children(func() {
			settingsInput(c.Key("md5"), &d.importMD5, "文件 MD5", "32 位十六进制摘要")
			settingsInput(c.Key("size"), &d.importSize, "文件大小", "字节数")
			settingsInput(c.Key("name"), &d.importName, "曲名", "云盘显示的名称")
			settingsInput(c.Key("id"), &d.importSongID, "网易云歌曲 ID", "可留空")
			a.cloudDriveConfirm(c, "确认导入", s.importDrive)
		})
	}
	if len(d.tracks) == 0 {
		ui.Text(c, "音乐云盘为空").TextColor(c.Theme().TextMuted)
	}
	ui.Column(c.Key("files")).Gap(3).Children(func() {
		for _, track := range d.tracks {
			a.cloudDriveRow(c.Key(track.key().String()), track)
		}
	})
	if d.hasMore && labelButton(c, "加载更多", 92, false).Disabled(s.busy).Clicked() {
		s.loadDrive(true)
	}
}

func (a *prototype) cloudDriveRow(c *ui.Context, track driveTrack) {
	s, d := a.cloud, &a.cloud.drive
	selected := d.selected.key() == track.key()
	ui.Row(c).MinHeight(42).PaddingX(8).Radius(7).Background(c.Theme().Background).Gap(8).AlignItems(ui.Center).Children(func() {
		ui.Column(c).Grow(1).MinWidth(0).Gap(2).Children(func() {
			singleLine(c, track.title()).Bold()
			metadata := driveFileSize(track.FileSize)
			if track.Artist != "" {
				metadata = track.Artist + " · " + metadata
			}
			singleLine(c, metadata).TextColor(c.Theme().TextMuted)
		})
		labelButton(c, "操作", 64, selected).Label(track.title() + " · 云盘操作").Disabled(s.busy).Menu(func(m *ui.Menu) {
			if m.Item("查看详情").Chosen() {
				s.readDriveTrack(track, "detail")
			}
			if m.Item("查看歌词").Chosen() {
				s.readDriveTrack(track, "lyrics")
			}
			if m.Item("纠正匹配").Chosen() {
				d.selected, d.action, d.matchID = track, "match", ""
			}
			if m.Item("下载到本机").Disabled(s.saveFile == nil).Chosen() {
				s.downloadDriveTrack(track)
			}
			if m.Item("从云盘删除").Chosen() {
				d.selected, d.action = track, "delete"
			}
		})
	})
	if !selected {
		return
	}
	switch d.action {
	case "detail":
		ui.Text(c, strings.Join([]string{d.detail.title(), d.detail.Artist, d.detail.Album, driveFileSize(d.detail.FileSize)}, "  ·  ")).Wrap()
	case "lyrics":
		lyric := d.lyrics
		if lyric == "" {
			lyric = "网易云未提供这首歌的云盘歌词"
		}
		ui.Text(c, lyric).Wrap()
	case "match":
		settingsInput(c.Key("match-id"), &d.matchID, "正确的网易云歌曲 ID", "例如 347230")
		a.cloudDriveConfirm(c, "确认匹配", s.changeDriveTrack)
	case "delete":
		ui.Text(c, "从云盘删除「"+track.title()+"」？").Wrap()
		a.cloudDriveConfirm(c, "确认删除", s.changeDriveTrack)
	}
}

func (a *prototype) cloudDriveConfirm(c *ui.Context, label string, action func()) {
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, label, 92, true).Disabled(a.cloud.busy).Clicked() {
			action()
		}
		if labelButton(c, "取消", 62, false).Disabled(a.cloud.busy).Clicked() {
			a.cloud.drive.action = ""
		}
	})
}

func (a *prototype) cloudDrivePersonal(c *ui.Context) {
	media := a.cloud.drive.media
	if !media.loaded {
		return
	}
	heading(c, "我的电台", 17)
	if len(media.Radios) == 0 && media.radioErr == "" {
		ui.Text(c, "还没有电台").TextColor(c.Theme().TextMuted)
	}
	for _, radio := range media.Radios {
		ui.Text(c, fmt.Sprintf("%s · %d 期", radio.Name, radio.ProgramCount)).Wrap()
	}
	if media.radioErr != "" {
		ui.Text(c, media.radioErr).Wrap()
	}
	heading(c, "我的音频", 17)
	if len(media.Audio) == 0 && media.audioErr == "" {
		ui.Text(c, "还没有音频").TextColor(c.Theme().TextMuted)
	}
	for _, audio := range media.Audio {
		title := audio.Name
		if title == "" {
			title = audio.Title
		}
		if audio.Artist != "" {
			title += " · " + audio.Artist
		}
		ui.Text(c, title).Wrap()
	}
	if media.audioErr != "" {
		ui.Text(c, media.audioErr).Wrap()
	}
}
