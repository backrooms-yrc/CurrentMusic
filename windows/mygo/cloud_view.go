package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (a *prototype) runCloudSearch(query string) {
	if a.page != libraryPage {
		a.cloud.catalogDetail, a.cloud.catalogBack = cloudCatalogDetail{}, nil
	}
	a.page, a.player = libraryPage, false
	a.cloud.searchCatalog(query, a.cloud.searchKind, false, true)
}

func (a *prototype) openCloudPage(page int) {
	a.page, a.player, a.search = page, false, ""
	a.cloud.selected = cloudSong{}
	a.cloud.catalogDetail, a.cloud.catalogBack = cloudCatalogDetail{}, nil
	if page == demoPage && a.cloudIdle() {
		a.demoStarted, a.seekable, a.duration = true, true, demoTracks[a.track].length
	}
	if page == cloudDiscoverPage && a.cloud.explore.section.id == "" {
		a.cloud.loadExplore(cloudExploreSections[0], "", false)
	}
	if page == cloudCommunityPage {
		if a.cloud.community.tab == "" {
			a.cloud.community.tab = "posts"
			a.cloud.loadPosts(false)
		} else if a.cloud.community.tab == "chat" {
			a.cloud.startChat()
		}
	}
	if a.cloud.user.ID == 0 {
		return
	}
	switch page {
	case cloudLikesPage:
		a.cloud.loadLikes()
	case cloudPlaylistsPage:
		a.cloud.playlistName, a.cloud.description = "", ""
		a.cloud.loadPlaylists()
	case cloudRecentPage:
		a.cloud.loadRecent()
	case cloudRoomsPage:
		a.cloud.loadRooms("public", false)
	case cloudDrivePage:
		a.cloud.drive.tab = "drive"
		a.cloud.loadDrive(false)
	}
}

func (a *prototype) cloudNavigation(c *ui.Context, wide bool) {
	pages := []struct {
		title string
		page  int
		icon  *ui.SVG
	}{{"发现音乐", cloudDiscoverPage, searchIcon}, {"一起听", cloudRoomsPage, queueIcon}, {"社区", cloudCommunityPage, accountIcon}, {"我的喜欢", cloudLikesPage, heartIcon}, {"云端歌单", cloudPlaylistsPage, playlistIcon}, {"最近播放", cloudRecentPage, playIcon}, {"音乐云盘", cloudDrivePage, libraryIcon}, {"演示曲库", demoPage, libraryIcon}}
	if !wide {
		navItem(c, playlistIcon, "我的曲库", false, a.page >= cloudLikesPage).Menu(func(m *ui.Menu) {
			for _, item := range pages {
				if m.Item(item.title).Chosen() {
					a.openCloudPage(item.page)
				}
			}
		})
		return
	}
	for _, item := range pages {
		selected := a.page == item.page || item.page == cloudPlaylistsPage && a.page == cloudPlaylistPage ||
			item.page == cloudRoomsPage && a.page == cloudRoomPage
		if navItem(c.Key(item.page), item.icon, item.title, true, selected).Clicked() {
			a.openCloudPage(item.page)
		}
	}
}

func (a *prototype) cloudSettings(c *ui.Context) {
	s := a.cloud
	settingsSection(c.Key("server"), "服务器", "选择镜像线路，或输入完整的 HTTPS API 基址。", serverIcon, func() {
		settingsInput(c.Key("api"), &s.serverInput, "HTTPS API 基址", officialAPI)
		ui.Row(c).Gap(6).Children(func() {
			labelButton(c, "选择线路", 90, false).Menu(func(m *ui.Menu) {
				for _, line := range []struct{ name, base string }{
					{"主站", officialAPI},
					{"CTCEHS 镜像", "https://music.ctcehs.com/cm"},
					{"Geekertao 镜像", "https://currentmusic.geekertao.com/cm"},
					{"Bileizhen 镜像", "https://cm.bileizhen.top/cm"},
				} {
					if m.Item(line.name).Chosen() {
						s.serverInput = line.base
					}
				}
			})
			if labelButton(c, "应用地址", 90, true).Clicked() {
				a.switchCloudServer()
			}
		})
		ui.Text(c, "当前服务器 · "+s.api.base).Wrap().TextColor(c.Theme().TextMuted)
	})
	settingsSection(c.Key("account"), "CurrentMusic 账号", "登录后可播放云端曲目并管理喜欢和歌单。", accountIcon, func() {
		switch {
		case s.user.ID > 0:
			a.cloudAccountSettings(c)
		case s.challenge.ChallengeToken != "":
			label := "验证器代码或恢复码"
			if s.challenge.RequiresSecurityQuestion {
				label = "密保答案"
				ui.Text(c, s.challenge.SecurityQuestion).Wrap()
			}
			settingsInput(c.Key("factor"), &s.code, label, label).Password()
			ui.Row(c).Gap(6).Children(func() {
				if labelButton(c, "完成验证", 92, true).Disabled(s.busy || strings.TrimSpace(s.code) == "").Clicked() {
					s.verify()
				}
				if labelButton(c, "返回登录", 92, false).Disabled(s.busy).Clicked() {
					s.challenge, s.code = cloudLogin{}, ""
				}
			})
		default:
			if s.account.mode == "register" || s.account.mode == "recover" {
				a.cloudGuestAccount(c.Key(s.account.mode))
			} else {
				a.cloudLoginForm(c.Key("login"))
			}
		}
		a.cloudStatus(c)
	})
	if s.user.ID > 0 {
		a.cloudBindingSettings(c.Key("netease"))
	}
}

func (a *prototype) switchCloudServer() {
	if a.cloud.switchServer() {
		a.search, a.queue = "", false
		a.selected = -1
	}
}

func (a *prototype) cloudLoginForm(c *ui.Context) {
	s := a.cloud
	ui.Row(c).Gap(6).Children(func() {
		for i, title := range []string{"密码登录", "邮箱验证码"} {
			email := i == 1
			if labelButton(c, title, 95, email == s.emailLogin).AccessSelected(email == s.emailLogin).Disabled(s.busy).Clicked() && s.emailLogin != email {
				s.emailLogin, s.identity, s.secret, s.code = email, "", "", ""
			}
		}
	})
	identity, field := "用户名", "密码"
	secret := &s.secret
	if s.emailLogin {
		identity, field, secret = "邮箱", "邮箱验证码", &s.code
	}
	settingsInput(c.Key("identity"), &s.identity, identity, identity)
	settingsInput(c.Key(field), secret, field, field).Password()
	if s.cancelPasskey != nil {
		if labelButton(c, "取消通行密钥登录", 138, false).Clicked() {
			s.cancelPasskey()
		}
	} else if s.openBrowser != nil && labelButton(c, "使用通行密钥", 118, false).Disabled(s.busy).Clicked() {
		s.loginPasskey()
	}
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "登录", 90, true).Disabled(s.busy || strings.TrimSpace(s.identity) == "" || *secret == "").Clicked() {
			s.login()
		}
		if s.emailLogin && labelButton(c, "发送验证码", 104, false).Disabled(s.busy || strings.TrimSpace(s.identity) == "").Clicked() {
			s.sendEmailCode()
		}
	})
	if s.prefs.Accounts[s.api.base] > 0 && labelButton(c, "重试恢复会话", 122, false).Disabled(s.busy).Clicked() {
		s.restore()
	}
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "注册账号", 92, false).Disabled(s.busy).Clicked() {
			s.account = cloudAccountPanel{mode: "register"}
		}
		if labelButton(c, "忘记密码", 92, false).Disabled(s.busy).Clicked() {
			s.account = cloudAccountPanel{mode: "recover"}
		}
	})
	a.cloudAccountPicker(c.Key("accounts"))
}

func (a *prototype) cloudStatus(c *ui.Context) {
	if a.cloud.busy {
		ui.Text(c, "正在请求服务器…").TextColor(c.Theme().TextMuted)
	}
	if a.cloud.notice != "" {
		ui.Text(c, a.cloud.notice).Wrap().TextColor(c.Theme().TextMuted)
	}
}

func (a *prototype) cloudPage(c *ui.Context, w float32, compact bool) {
	s := a.cloud
	if a.page != libraryPage && a.page != cloudDiscoverPage && a.page != cloudCommunityPage && s.user.ID == 0 {
		sectionHeading(c, "我的曲库", "", "", compact)
		ui.Text(c, "登录后可查看个人曲库与云盘。")
		if labelButton(c, "前往登录", 92, true).Clicked() {
			a.page = settingsPage
		}
		a.cloudStatus(c)
		return
	}
	switch a.page {
	case cloudCommunityPage:
		a.cloudCommunityPage(c, compact)
	case cloudDrivePage:
		a.cloudDrivePage(c, compact)
		return
	case cloudRoomsPage:
		a.cloudRoomsPage(c, compact)
	case cloudRoomPage:
		a.cloudRoomPage(c, compact)
	case cloudDiscoverPage:
		a.cloudExplorePage(c, w, compact)
	case cloudLikesPage:
		ui.Row(c).AlignItems(ui.Center).Gap(10).Children(func() {
			sectionHeading(c, "我的喜欢", "", fmt.Sprintf("%d 首", len(s.likes)), compact)
			ui.Spacer(c).Grow(1)
			if labelButton(c, "刷新喜欢", 80, false).Disabled(s.busy).Clicked() {
				s.loadLikes()
			}
		})
		a.cloudTracks(c.Key("likes"), s.likes, w, compact)
	case cloudPlaylistsPage:
		a.cloudPlaylistIndex(c.Key("playlists"), compact)
	case cloudPlaylistPage:
		a.cloudPlaylistDetail(c.Key("playlist"), w, compact)
	case cloudRecentPage:
		sectionHeading(c, "最近播放", "", fmt.Sprintf("%d 首", len(s.recent)), compact)
		if labelButton(c, "刷新记录", 92, false).Disabled(s.busy).Clicked() {
			s.loadRecent()
		}
		a.cloudTracks(c.Key("recent"), s.recent, w, compact)
	default:
		switch {
		case s.catalogDetail.ID > 0:
			a.cloudCatalogPage(c.Key("catalog-detail"), w, compact)
		case s.keyword == "":
			sectionHeading(c, "曲库", "", "", compact)
			a.cloudSearchTools(c.Key("search-tools"))
			ui.Column(c).MaxWidth(490).Padding(16).Gap(8).Radius(10).Background(c.Theme().Background).Children(func() {
				drawIcon(c, searchIcon, 22, c.Theme().Accent)
				heading(c, "搜索音乐", 17)
				ui.Text(c, "输入歌曲、歌手或专辑，按 Enter 搜索。").Wrap().TextColor(c.Theme().TextMuted)
			})
		default:
			sectionHeading(c, "搜索结果", "“"+s.keyword+"”", "", compact)
			a.cloudSearchTools(c.Key("search-tools"))
			a.cloudSearchKinds(c.Key("search-kinds"), compact)
			if s.searchKind == "song" || s.searchKind == "lyric" || s.searchKind == "match" {
				a.cloudTracks(c.Key("search"), s.results, w, compact)
			}
			if s.searchKind != "song" && s.searchKind != "lyric" {
				a.cloudCatalogRows(c.Key("catalog"), s.catalog)
			}
			if s.hasMore && labelButton(c, "加载更多", 92, false).Disabled(s.busy).Clicked() {
				s.search(s.keyword, true)
			}
		}
	}
	a.cloudStatus(c)
}

func exploreFilters(section cloudExploreSection) []struct{ value, title string } {
	switch section.id {
	case "playlists":
		return []struct{ value, title string }{{"全部", "全部"}, {"华语", "华语"}, {"流行", "流行"}, {"摇滚", "摇滚"}, {"电子", "电子"}, {"日语", "日语"}, {"欧美", "欧美"}}
	case "artists":
		return []struct{ value, title string }{{"-1", "全部"}, {"7", "华语"}, {"96", "欧美"}, {"8", "日本"}, {"16", "韩国"}, {"0", "其他"}}
	case "albums":
		return []struct{ value, title string }{{"ALL", "全部"}, {"ZH", "华语"}, {"EA", "欧美"}, {"JP", "日本"}, {"KR", "韩国"}}
	default:
		return nil
	}
}

func (a *prototype) cloudExplorePage(c *ui.Context, width float32, compact bool) {
	s := a.cloud
	if s.catalogDetail.ID > 0 {
		a.cloudCatalogPage(c.Key("explore-detail"), width, compact)
		return
	}
	state := s.explore
	sectionHeading(c, "发现音乐", "", "", compact)
	label := state.section.title
	if label == "" {
		label = "选择分类"
	}
	ui.Row(c).Gap(6).Children(func() {
		labelButton(c, label, 112, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			for _, section := range cloudExploreSections {
				if !m.Item(section.title).Chosen() {
					continue
				}
				if section.auth && s.user.ID == 0 {
					a.page = settingsPage
					s.notice = "登录后可查看每日推荐"
					return
				}
				filter := ""
				if filters := exploreFilters(section); len(filters) > 0 {
					filter = filters[0].value
				}
				s.loadExplore(section, filter, false)
			}
		})
		if filters := exploreFilters(state.section); len(filters) > 0 {
			label := "筛选"
			for _, filter := range filters {
				if filter.value == state.filter {
					label = filter.title
				}
			}
			labelButton(c, label, 82, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
				for _, filter := range filters {
					if m.Item(filter.title).Chosen() {
						s.loadExplore(state.section, filter.value, false)
					}
				}
			})
		}
	})
	if len(state.songs) > 0 {
		if labelButton(c, "一键开听", 94, true).Disabled(s.busy || a.queueLoading).Clicked() {
			a.playLibrarySong(state.songs[0])
		}
		a.cloudTracks(c.Key("discovery-tracks"), state.songs, width, compact)
	} else {
		a.cloudCatalogRows(c.Key("discovery-items"), state.items)
	}
	if state.more && labelButton(c, "加载更多", 92, false).Disabled(s.busy).Clicked() {
		s.loadExplore(state.section, state.filter, true)
	}
}

func (a *prototype) cloudSearchKinds(c *ui.Context, compact bool) {
	s := a.cloud
	kinds := []struct{ key, label string }{
		{"song", "单曲"}, {"lyric", "歌词"}, {"album", "专辑"}, {"artist", "歌手"}, {"playlist", "歌单"}, {"match", "匹配"},
	}
	if compact {
		label := "搜索类别"
		for _, kind := range kinds {
			if kind.key == s.searchKind {
				label += " · " + kind.label
			}
		}
		labelButton(c, label, 142, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			for _, kind := range kinds {
				if m.Item(kind.label).Chosen() && kind.key != s.searchKind {
					s.searchCatalog(s.keyword, kind.key, false, false)
				}
			}
		})
		return
	}
	ui.Row(c).Gap(6).Children(func() {
		for _, kind := range kinds {
			selected := kind.key == s.searchKind
			if labelButton(c.Key(kind.key), kind.label, 60, selected).
				AccessSelected(selected).Disabled(s.busy).Clicked() && !selected {
				s.searchCatalog(s.keyword, kind.key, false, false)
			}
		}
	})
}

func (a *prototype) cloudSearchTools(c *ui.Context) {
	s := a.cloud
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "热门搜索", 94, false).Disabled(s.busy).Clicked() {
			s.loadSearchTips("")
		}
		if labelButton(c, "搜索建议", 94, false).Disabled(s.busy || strings.TrimSpace(a.search) == "").Clicked() {
			s.loadSearchTips(a.search)
		}
		if s.user.ID > 0 && labelButton(c, "搜索历史", 94, false).Disabled(s.busy).Clicked() {
			if s.historyOpen {
				s.historyOpen = false
			} else {
				s.editSearchHistory(http.MethodGet, "")
			}
		}
	})
	showTips := s.tipsFor == "" || s.tipsFor == strings.TrimSpace(a.search)
	if showTips && len(s.searchTips) > 0 {
		labelButton(c.Key("tips"), "选择搜索词", 104, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			for _, word := range s.searchTips {
				if m.Item(word).Chosen() {
					a.search = word
					a.runCloudSearch(word)
				}
			}
		})
	}
	if !s.historyOpen {
		return
	}
	if len(s.searchHistory) == 0 {
		ui.Text(c, "暂无搜索历史").TextColor(c.Theme().TextMuted)
		return
	}
	for _, word := range s.searchHistory {
		ui.Row(c.Key(word)).Gap(6).AlignItems(ui.Center).Children(func() {
			if labelButton(c, word, 220, false).Disabled(s.busy).Clicked() {
				a.search = word
				a.runCloudSearch(word)
			}
			if iconButton(c, closeIcon, "删除历史 "+word, 36, false).Disabled(s.busy).Clicked() {
				s.editSearchHistory(http.MethodDelete, word)
			}
		})
	}
	labelButton(c, "清空历史", 92, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
		if m.Item("确认清空搜索历史").Chosen() {
			s.editSearchHistory(http.MethodDelete, "")
		}
	})
}

func (a *prototype) cloudCatalogRows(c *ui.Context, items []cloudCatalogItem) {
	if len(items) == 0 && !a.cloud.busy {
		ui.Text(c, "暂无结果").TextColor(c.Theme().TextMuted)
	}
	for _, item := range items {
		key := item.Kind + ":" + strconv.FormatInt(item.ID, 10)
		row := ui.ButtonBase(c.Key(key)).Height(42).Radius(7).Label(item.Name).Tooltip(item.Name).Disabled(a.cloud.busy)
		styleControl(row, c.Theme(), false)
		row.Children(func() {
			ui.Row(c).Grow(1).MinWidth(0).PaddingX(8).Gap(10).AlignItems(ui.Center).Children(func() {
				drawIcon(c, libraryIcon, 20, c.Theme().Accent)
				singleLine(c, item.Name).Grow(1).AccessHidden(true)
			})
		})
		if row.Clicked() {
			a.cloud.openCatalog(item)
		}
	}
}

func (a *prototype) cloudCatalogPage(c *ui.Context, width float32, compact bool) {
	s := a.cloud
	item := s.catalogDetail
	if labelButton(c, "返回", 70, false).Disabled(s.busy).Clicked() {
		var previous cloudCatalogDetail
		if len(s.catalogBack) > 0 {
			previous = s.catalogBack[len(s.catalogBack)-1]
			s.catalogBack = s.catalogBack[:len(s.catalogBack)-1]
		}
		s.catalogDetail, s.selected = previous, cloudSong{}
		return
	}
	subtitle := strings.Trim(strings.Join([]string{item.Artist, item.Creator, item.Alias}, " "), " ")
	sectionHeading(c, item.Name, subtitle, "", compact)
	if item.Description != "" {
		ui.Text(c, item.Description).Wrap().TextColor(c.Theme().TextMuted)
	}
	a.cloudTracks(c.Key("catalog-songs"), item.Songs, width, compact)
	if item.More && labelButton(c, "更多曲目", 92, false).Disabled(s.busy).Clicked() {
		s.loadMoreCatalog(false)
	}
	if len(item.Albums) > 0 {
		heading(c, "专辑", 17)
		a.cloudCatalogRows(c.Key("artist-albums"), item.Albums)
	}
	if item.AlbumsMore && labelButton(c, "更多专辑", 92, false).Disabled(s.busy).Clicked() {
		s.loadMoreCatalog(true)
	}
}

func (a *prototype) cloudPlaylistIndex(c *ui.Context, compact bool) {
	s := a.cloud
	sectionHeading(c, "云端歌单", "在你的设备间同步", fmt.Sprintf("%d 个", len(s.playlists)), compact)
	for _, item := range s.playlists {
		row := ui.ButtonBase(c.Key(item.ID)).Height(43).Radius(7).Label(item.Name).Tooltip(item.Name).Disabled(s.busy)
		styleControl(row, c.Theme(), false)
		row.Children(func() {
			ui.Row(c).Grow(1).MinWidth(0).PaddingX(8).AlignItems(ui.Center).Gap(10).Children(func() {
				drawIcon(c, playlistIcon, 20, c.Theme().Accent)
				singleLine(c, item.Name).Grow(1).Bold().AccessHidden(true)
				ui.Text(c, fmt.Sprintf("%d 首", item.TrackCount)).TextColor(c.Theme().TextMuted).AccessHidden(true)
			})
		})
		if row.Clicked() {
			s.loadPlaylist(item, func() {
				if a.page == cloudPlaylistsPage {
					a.page = cloudPlaylistPage
				}
			})
		}
	}
	settingsSection(c.Key("create"), "创建歌单", "", playlistIcon, func() {
		a.cloudPlaylistFields(c.Key("new"))
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "创建歌单", 92, true).Disabled(s.busy || strings.TrimSpace(s.playlistName) == "").Clicked() {
				s.changePlaylist(http.MethodPost, cloudPlaylist{}, strings.TrimSpace(s.playlistName), s.description, func() {
					s.playlistName, s.description = "", ""
				})
			}
			if labelButton(c, "刷新列表", 92, false).Disabled(s.busy).Clicked() {
				s.loadPlaylists()
			}
		})
	})
}

func (a *prototype) cloudPlaylistFields(c *ui.Context) {
	settingsInput(c.Key("name"), &a.cloud.playlistName, "歌单名", "歌单名")
	settingsInput(c.Key("description"), &a.cloud.description, "歌单描述", "描述")
}

func (a *prototype) cloudPlaylistDetail(c *ui.Context, w float32, compact bool) {
	s := a.cloud
	item := s.playlist
	if labelButton(c, "返回歌单", 94, false).Clicked() {
		a.openCloudPage(cloudPlaylistsPage)
		return
	}
	sectionHeading(c, item.Name, item.Description, fmt.Sprintf("%d 首", item.TrackCount), compact)
	a.cloudTracks(c.Key("tracks"), item.Tracks, w, compact)
	if !item.editableBy(s.user.ID) {
		ui.Text(c, "网易云同步歌单 · 只读").TextColor(c.Theme().TextMuted)
		return
	}
	settingsSection(c.Key("edit-card"), "编辑歌单", "", playlistIcon, func() {
		a.cloudPlaylistFields(c.Key("edit"))
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "保存更改", 92, true).Disabled(s.busy || strings.TrimSpace(s.playlistName) == "").Clicked() {
				s.changePlaylist(http.MethodPut, item, strings.TrimSpace(s.playlistName), s.description, func() {
					s.playlistName, s.description = s.playlist.Name, s.playlist.Description
				})
			}
			if s.confirmDelete {
				if labelButton(c, "确认删除", 92, false).Disabled(s.busy).Clicked() {
					s.changePlaylist(http.MethodDelete, item, "", "", func() { a.page = cloudPlaylistsPage })
				}
				if labelButton(c, "取消", 64, false).Clicked() {
					s.confirmDelete = false
				}
			} else if labelButton(c, "删除歌单", 92, false).Disabled(s.busy).Clicked() {
				s.confirmDelete = true
			}
		})
	})
}

func (a *prototype) cloudTracks(c *ui.Context, tracks []cloudSong, width float32, compact bool) {
	s := a.cloud
	if len(tracks) == 0 && !s.busy {
		ui.Text(c, "暂无曲目").TextColor(c.Theme().TextMuted)
		return
	}
	wide := width >= 820
	showAlbum := width >= 640
	ui.Row(c).AlignItems(ui.Start).Gap(14).Children(func() {
		ui.Column(c).Grow(1).MinWidth(0).Gap(1).Role(ui.RoleList).Label("曲目").Children(func() {
			if !compact {
				trackColumnLabels(c, showAlbum)
			}
			for _, song := range tracks {
				a.cloudTrackRow(c.Key(song.ID), song, showAlbum)
				if !wide && s.selected.ID == song.ID {
					a.cloudSongDetail(c.Key("inline-detail"), s.selected)
				}
			}
		})
		if wide && s.selected.ID > 0 {
			ui.Column(c.Key("detail")).Width(224).Children(func() {
				a.cloudSongDetail(c, s.selected)
			})
		}
	})
}

func (a *prototype) cloudTrackRow(c *ui.Context, song cloudSong, showAlbum bool) {
	s, t := a.cloud, c.Theme()
	row := ui.ButtonBase(c).Height(43).Radius(7).Label(song.Name).Tooltip(song.Name + " · " + song.Artists).
		AccessSelected(s.selected.ID == song.ID)
	styleControl(row, t, s.selected.ID == song.ID)
	row.Children(func() {
		q := a.playQueue
		current := a.cloudTrack && q.index >= 0 && q.index < len(q.songs) && q.songs[q.index].ID == song.ID
		trackRowContent(c, trackMetadata{song.Name, song.Artists, song.Album, song.Duration}, showAlbum, current, func() {
			if current && a.albumArt != nil {
				ui.Image(c, a.albumArt).Size(30, 30).Fit(ui.Cover).Radius(5).Clip().AccessHidden(true)
			} else {
				sourceCover(c, 30, 5)
			}
		})
	})
	play := func() { s.selected = song; a.playLibrarySong(song) }
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
		s.selected = song
	}
	row.ContextMenu(func(m *ui.Menu) { a.cloudTrackMenu(m, song) })
}

func (a *prototype) cloudSongDetail(c *ui.Context, song cloudSong) {
	s, t := a.cloud, c.Theme()
	ui.Column(c).Background(t.Background).Radius(9).Padding(12).Gap(7).Children(func() {
		heading(c, song.Name, 17).Wrap().MaxLines(2).Ellipsis("…").Tooltip(song.Name)
		ui.Text(c, song.Artists+" · "+song.Album+" · "+clockLabel(song.Duration)).Wrap().TextColor(t.TextMuted)
		if song.Lyric != "" {
			ui.Text(c, song.Lyric).Wrap().TextColor(t.TextMuted)
		}
		ui.Row(c).Gap(5).Children(func() {
			if labelButton(c, "播放", 48, true).Clicked() {
				a.playLibrarySong(song)
			}
			if labelButton(c, "查询详情", 74, false).Disabled(s.busy).Clicked() {
				s.detail(song)
			}
			iconButton(c, moreIcon, "曲目操作", 38, false).Menu(func(m *ui.Menu) { a.cloudTrackMenu(m, song) })
		})
	})
}

func (a *prototype) playLibrarySong(song cloudSong) {
	s := a.cloud
	if s.user.ID == 0 {
		s.notice = "请先登录 CurrentMusic"
		return
	}
	if a.playCloud == nil {
		return
	}
	list := s.results
	switch a.page {
	case libraryPage:
		if s.catalogDetail.ID > 0 {
			list = s.catalogDetail.Songs
		}
	case cloudLikesPage:
		list = s.likes
	case cloudPlaylistPage:
		list = s.playlist.Tracks
	case cloudRecentPage:
		list = s.recent
	case cloudDiscoverPage:
		list = s.explore.songs
		if s.catalogDetail.ID > 0 {
			list = s.catalogDetail.Songs
		}
	}
	a.playCloud(song, list)
}

func (a *prototype) cloudTrackMenu(m *ui.Menu, song cloudSong) {
	s := a.cloud
	if m.Item("查询歌曲详情").Disabled(s.busy).Chosen() {
		s.selected = song
		s.detail(song)
	}
	if s.copyText != nil && m.Item("复制歌曲链接").Chosen() {
		s.copySongLink(song.ID)
	}
	if s.user.ID == 0 {
		if m.Item("前往登录").Chosen() {
			a.page = settingsPage
		}
		return
	}
	if a.enqueueCloud != nil && m.Item("下一首播放").Disabled(a.queueLoading).Chosen() {
		a.enqueueCloud(song, true)
	}
	if a.enqueueCloud != nil && m.Item("加入队列").Disabled(a.queueLoading).Chosen() {
		a.enqueueCloud(song, false)
	}
	if s.saveFile != nil && m.Item("下载歌曲").Disabled(s.busy).Chosen() {
		s.downloadSong(song, a.quality)
	}
	label := "加入我的喜欢"
	if s.liked(song.ID) {
		label = "取消喜欢"
	}
	if m.Item(label).Disabled(s.busy).Chosen() {
		s.toggleLike(song)
	}
	if m.Item("切换网易云红心").Disabled(s.busy).Chosen() {
		s.toggleNcmLike(song)
	}
	if s.rooms.liveID > 0 && m.Item("点歌到房间").Disabled(s.busy).Chosen() {
		s.roomWrite(http.MethodPost, s.rooms.liveID, "/queue", map[string]cloudSong{"meta": song}, func() {
			s.notice = "房间点歌已提交"
		})
	}
	if len(s.playlists) > 0 {
		m.Submenu("加入云端歌单", func(sub *ui.Menu) {
			for _, item := range s.playlists {
				if sub.Item(item.Name).Disabled(s.busy || !item.editableBy(s.user.ID)).Chosen() {
					s.changePlaylistTrack(http.MethodPost, item, song)
				}
			}
		})
	}
	if a.page == cloudPlaylistPage && s.playlist.editableBy(s.user.ID) && m.Item("移出当前歌单").Disabled(s.busy).Chosen() {
		s.changePlaylistTrack(http.MethodDelete, s.playlist, song)
	}
}
