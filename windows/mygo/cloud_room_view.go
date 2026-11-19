package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (a *prototype) cloudRoomsPage(c *ui.Context, compact bool) {
	s, r := a.cloud, &a.cloud.rooms
	sectionHeading(c, "一起听", "", "", compact)
	ready := func() { a.page = cloudRoomPage }
	if r.liveID > 0 {
		if labelButton(c, "返回当前房间", 114, true).Clicked() {
			ready()
		}
		return
	}
	if r.creating {
		a.cloudRoomForm(c.Key("create-room"), true)
		return
	}
	ui.Row(c).Gap(6).Children(func() {
		for _, entry := range []struct{ key, label string }{{"public", "公开房间"}, {"mine", "我的房间"}} {
			if labelButton(c.Key(entry.key), entry.label, 92, r.scope == entry.key).Disabled(s.busy).Clicked() {
				s.loadRooms(entry.key, false)
			}
		}
		if labelButton(c, "创建房间", 92, false).Disabled(s.busy).Clicked() {
			r.form, r.creating = roomForm{IsPublic: true, NeedApproval: true}, true
		}
	})
	ui.Row(c).Gap(6).Children(func() {
		settingsInput(c.Key("room-name"), &r.query, "筛选房间", "筛选房间").Grow(1)
		if labelButton(c.Key("filter"), "筛选", 62, false).Disabled(s.busy).Clicked() {
			scope := r.scope
			if scope == "" {
				scope = "public"
			}
			s.loadRooms(scope, false)
		}
	})
	ui.Row(c).Gap(6).Children(func() {
		settingsInput(c.Key("room-code"), &r.code, "六位房间号", "六位房间号").Grow(1)
		code := strings.TrimSpace(r.code)
		if labelButton(c.Key("lookup"), "查找房间", 92, false).
			Disabled(s.busy || len(code) != 6 || strings.Trim(code, "0123456789") != "").Clicked() {
			s.openRoom(0, code, ready)
		}
	})
	for _, room := range r.list {
		name := room.Name + " · " + room.Code
		if room.ArchivedAt > 0 {
			name += " · 已归档"
		}
		row := ui.ButtonBase(c.Key(room.ID)).Height(42).Radius(7).Label(name).Disabled(s.busy)
		styleControl(row, c.Theme(), false)
		row.Children(func() { singleLine(c, name).PaddingX(8).Grow(1) })
		if row.Clicked() {
			s.openRoom(room.ID, "", ready)
		}
	}
	if len(r.list) == 0 && !s.busy {
		ui.Text(c, "暂无房间").TextColor(c.Theme().TextMuted)
	}
	if r.offset < r.total && labelButton(c, "更多房间", 92, false).Disabled(s.busy).Clicked() {
		s.loadRooms(r.scope, true)
	}
}

func (a *prototype) cloudRoomPage(c *ui.Context, compact bool) {
	s, r := a.cloud, &a.cloud.rooms
	snapshot := r.detail
	room := snapshot.Room
	if labelButton(c, "房间列表", 92, false).Disabled(s.busy).Clicked() {
		a.openCloudPage(cloudRoomsPage)
		return
	}
	sectionHeading(c, room.Name, "房间号 "+room.Code, "", compact)
	if room.ID <= 0 {
		ui.Text(c, "请从列表选择房间")
		return
	}
	if r.connection != "" {
		ui.Text(c, r.connection).TextColor(c.Theme().TextMuted)
	}
	if r.liveID != room.ID {
		if room.ArchivedAt > 0 {
			ui.Text(c, "房间已归档")
			if room.OwnerID == s.user.ID && labelButton(c, "恢复房间", 92, true).Disabled(s.busy).Clicked() {
				s.enterRoom("reopen", func() { a.page = cloudRoomPage })
			}
			if room.OwnerID == s.user.ID {
				a.cloudRoomDelete(c.Key("delete-room"), room.ID)
			}
		} else {
			if room.HasPassword && snapshot.Role == "" {
				settingsInput(c.Key("join-password"), &r.password, "房间密码", "房间密码").Password()
			}
			if labelButton(c, "进入房间", 92, true).Disabled(s.busy).Clicked() {
				s.enterRoom("join", func() { a.page = cloudRoomPage })
			}
		}
		if labelButton(c, "刷新房间", 92, false).Disabled(s.busy).Clicked() {
			s.openRoom(room.ID, "", func() {})
		}
		return
	}
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "退出房间", 92, false).Disabled(s.busy).Clicked() {
			s.roomWrite(http.MethodPost, room.ID, "/leave", nil, func() {
				s.stopRoom("")
				a.openCloudPage(cloudRoomsPage)
			})
		}
		if snapshot.Role == "owner" {
			labelButton(c, "管理房间", 92, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
				if m.Item("修改房间设置").Chosen() {
					r.form = roomForm{Name: room.Name, IsPublic: room.IsPublic, FreeMode: room.FreeMode, NeedApproval: room.NeedApproval, JoinLocked: room.JoinLocked}
					r.editing, r.removePass = true, false
				}
				if m.Item("查看封禁").Chosen() {
					s.loadRoomBans()
				}
				if m.Item("归档房间").Chosen() {
					r.confirm = "archive"
				}
				if m.Item("删除房间").Chosen() {
					r.confirm = "delete"
				}
			})
		}
	})
	if r.confirm == "archive" {
		a.cloudRoomConfirm(c.Key("archive-confirm"), "归档此房间并停止同步播放？", func() {
			s.roomWrite(http.MethodPost, room.ID, "/close", nil, func() {
				s.stopRoom("房间已归档")
				s.openRoom(room.ID, "", func() {})
			})
		})
	}
	if r.confirm == "delete" {
		a.cloudRoomDelete(c.Key("delete-room"), room.ID)
	}
	if r.editing {
		a.cloudRoomForm(c.Key("edit-room"), false)
	}
	if r.showBans && snapshot.Role == "owner" {
		heading(c, "房间封禁", 17)
		for _, ban := range r.bans {
			ui.Row(c.Key(ban.UserID)).Gap(6).AlignItems(ui.Center).Children(func() {
				ui.Text(c, ban.Nickname+" · "+ban.Reason).Grow(1).Wrap()
				if labelButton(c, "解除封禁", 88, false).Disabled(s.busy).Clicked() {
					s.roomWrite(http.MethodDelete, room.ID, "/bans/"+strconv.FormatInt(ban.UserID, 10), nil, s.loadRoomBans)
				}
			})
		}
		if len(r.bans) == 0 {
			ui.Text(c, "暂无封禁")
		}
		if labelButton(c, "关闭名单", 88, false).Clicked() {
			r.showBans = false
		}
	}
	if snapshot.Timeline != nil && snapshot.Timeline.TrackMeta != nil {
		track := snapshot.Timeline.TrackMeta
		ui.Text(c, track.Name+" · "+track.Artists).Wrap().Bold()
	}
	if snapshot.controller() {
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "上一首", 72, false).Disabled(s.busy).Clicked() {
				s.roomTransport("prev", 0)
			}
			if snapshot.Timeline != nil && snapshot.Timeline.TrackMeta != nil {
				label, action := "播放", "play"
				if snapshot.Timeline.Playing {
					label, action = "暂停", "pause"
				}
				if labelButton(c, label, 62, true).Disabled(s.busy).Clicked() {
					s.roomTransport(action, 0)
				}
			}
			if labelButton(c, "下一首", 72, false).Disabled(s.busy).Clicked() {
				s.roomTransport("next", 0)
			}
		})
	}
	heading(c, "房间队列", 17)
	if labelButton(c, "搜索点歌", 92, false).Disabled(s.busy).Clicked() {
		a.openCloudPage(libraryPage)
		a.searchFocus.Focus(c)
	}
	if len(snapshot.Queue) == 0 {
		ui.Text(c, "暂无点歌").TextColor(c.Theme().TextMuted)
	}
	queued := 0
	for _, item := range snapshot.Queue {
		if item.Status == "queued" {
			queued++
		}
	}
	position := 0
	for _, item := range snapshot.Queue {
		a.cloudRoomQueueRow(c.Key(item.ID), snapshot, item, position, queued)
		if item.Status == "queued" {
			position++
		}
	}
	heading(c, "在线成员", 17)
	for _, member := range snapshot.Members {
		a.cloudRoomMember(c.Key(member.UserID), snapshot, member)
	}
}

func (a *prototype) cloudRoomForm(c *ui.Context, create bool) {
	s, r := a.cloud, &a.cloud.rooms
	f := &r.form
	settingsInput(c.Key("name"), &f.Name, "房间名", "房间名")
	settingsInput(c.Key("password"), &f.Password, "房间密码", "留空可保留原密码").Password()
	ui.Checkbox(c.Key("public"), &f.IsPublic, "公开房间")
	ui.Checkbox(c.Key("free"), &f.FreeMode, "自由点歌")
	ui.Checkbox(c.Key("approval"), &f.NeedApproval, "点歌需审核")
	ui.Checkbox(c.Key("locked"), &f.JoinLocked, "锁定新成员")
	if !create && r.detail.Room.HasPassword {
		ui.Checkbox(c.Key("remove-password"), &r.removePass, "移除房间密码")
	}
	ui.Row(c).Gap(6).Children(func() {
		label := "保存设置"
		if create {
			label = "创建房间"
		}
		if labelButton(c, label, 92, true).Disabled(s.busy || strings.TrimSpace(f.Name) == "").Clicked() {
			if create {
				s.enterRoom("create", func() { a.page = cloudRoomPage })
			} else {
				body := map[string]any{"name": f.Name, "isPublic": f.IsPublic, "freeMode": f.FreeMode, "needApproval": f.NeedApproval, "joinLocked": f.JoinLocked}
				if r.removePass || f.Password != "" {
					body["password"] = f.Password
					if r.removePass {
						body["password"] = ""
					}
				}
				s.roomWrite(http.MethodPost, r.detail.Room.ID, "/settings", body, func() { r.editing = false })
				f.Password = ""
			}
		}
		if labelButton(c, "取消", 62, false).Disabled(s.busy).Clicked() {
			r.creating, r.editing, r.removePass, f.Password = false, false, false, ""
		}
	})
}

func (a *prototype) cloudRoomQueueRow(c *ui.Context, snapshot roomSnapshot, item roomQueueItem, position, count int) {
	s := a.cloud
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		status := map[string]string{"pending": "待审核", "queued": "待播放", "playing": "正在播放", "played": "已播放"}
		ui.Text(c, item.Name+" · "+status[item.Status]).Grow(1).Wrap()
		canRemove := item.Status != "playing" && (snapshot.controller() || item.RequestedBy == s.user.ID)
		if !snapshot.controller() && !canRemove {
			return
		}
		iconButton(c, moreIcon, "队列操作 "+item.Name, 36, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			path := "/queue/" + strconv.FormatInt(item.ID, 10)
			if snapshot.controller() && item.Status == "pending" {
				if m.Item("通过").Chosen() {
					s.roomWrite(http.MethodPost, snapshot.Room.ID, path+"/approve", nil, nil)
				}
				if m.Item("驳回").Chosen() {
					s.roomWrite(http.MethodPost, snapshot.Room.ID, path+"/reject", nil, nil)
				}
			}
			if snapshot.controller() && item.Status == "queued" {
				for _, change := range []struct {
					label string
					index int
				}{{"上移", position - 1}, {"下移", position + 1}} {
					if m.Item(change.label).Disabled(change.index < 0 || change.index >= count).Chosen() {
						body := map[string]int64{"qid": item.ID, "index": int64(change.index)}
						s.roomWrite(http.MethodPost, snapshot.Room.ID, "/queue/reorder", body, nil)
					}
				}
			}
			if canRemove && m.Item("移除条目").Chosen() {
				s.roomWrite(http.MethodDelete, snapshot.Room.ID, path, nil, nil)
			}
		})
	})
}

func (a *prototype) cloudRoomMember(c *ui.Context, snapshot roomSnapshot, member roomMember) {
	s := a.cloud
	ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
		label := map[string]string{"owner": "房主", "admin": "管理员", "member": "成员"}
		ui.Text(c, member.Nickname+" · "+label[member.Role]).Wrap().Grow(1)
		if !snapshot.controller() || member.UserID == s.user.ID || member.Role == "owner" {
			return
		}
		iconButton(c, moreIcon, "成员操作 "+member.Nickname, 36, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			if snapshot.Role == "owner" {
				promote, title := member.Role != "admin", "设为管理员"
				if !promote {
					title = "取消管理员"
				}
				if m.Item(title).Chosen() {
					s.roomWrite(http.MethodPost, snapshot.Room.ID, "/admins", map[string]any{"userId": member.UserID, "on": promote}, nil)
				}
				if m.Item("转让房主").Chosen() {
					s.rooms.confirm = fmt.Sprintf("transfer:%d", member.UserID)
				}
			}
			if snapshot.Role == "owner" || member.Role != "admin" {
				if m.Item("移出房间").Chosen() {
					s.roomWrite(http.MethodPost, snapshot.Room.ID, "/kick", map[string]any{"userId": member.UserID}, nil)
				}
				if m.Item("移出并封禁").Chosen() {
					s.roomWrite(http.MethodPost, snapshot.Room.ID, "/kick", map[string]any{"userId": member.UserID, "ban": true}, nil)
				}
			}
		})
	})
	if s.rooms.confirm == fmt.Sprintf("transfer:%d", member.UserID) {
		a.cloudRoomConfirm(c.Key("confirm-transfer"), "转让房主给 "+member.Nickname+"？", func() {
			s.roomWrite(http.MethodPost, snapshot.Room.ID, "/transfer", map[string]int64{"userId": member.UserID}, nil)
		})
	}
}

func (a *prototype) cloudRoomDelete(c *ui.Context, id int64) {
	s := a.cloud
	if s.rooms.confirm != "delete" {
		if labelButton(c, "删除房间", 92, false).Disabled(s.busy).Clicked() {
			s.rooms.confirm = "delete"
		}
		return
	}
	a.cloudRoomConfirm(c.Key("delete-confirm"), "永久删除此房间及其队列？", func() {
		s.roomWrite(http.MethodDelete, id, "", nil, func() {
			s.stopRoom("")
			a.openCloudPage(cloudRoomsPage)
		})
	})
}

func (a *prototype) cloudRoomConfirm(c *ui.Context, message string, action func()) {
	s := a.cloud
	ui.Text(c, message).Wrap()
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "确认", 66, true).Disabled(s.busy).Clicked() {
			s.rooms.confirm = ""
			action()
		}
		if labelButton(c, "取消", 66, false).Clicked() {
			s.rooms.confirm = ""
		}
	})
}
