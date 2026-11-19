package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (a *prototype) cloudCommunityPage(c *ui.Context, compact bool) {
	s, state := a.cloud, &a.cloud.community
	sectionHeading(c, "社区", "", "", compact)
	ui.Row(c).Gap(6).Children(func() {
		for _, tab := range []struct{ key, title string }{{"posts", "动态"}, {"chat", "聊天室"}, {"news", "公告"}} {
			if labelButton(c.Key(tab.key), tab.title, 78, state.tab == tab.key).AccessSelected(state.tab == tab.key).Disabled(s.busy).Clicked() {
				s.stopChat()
				state.tab = tab.key
				switch tab.key {
				case "posts":
					s.loadPosts(false)
				case "chat":
					s.startChat()
				case "news":
					s.loadAnnouncements()
				}
			}
		}
	})
	switch state.tab {
	case "chat":
		a.cloudChatPage(c.Key("chat"))
	case "news":
		for _, item := range state.announcements {
			ui.Column(c.Key(item.ID)).Gap(5).Padding(10).Radius(7).Background(c.Theme().Background).Children(func() {
				title := item.Title
				if item.Pinned {
					title = "置顶 · " + title
				}
				heading(c, title, 16).Wrap()
				ui.Text(c, item.Body).Wrap()
			})
		}
		if len(state.announcements) == 0 && !s.busy {
			ui.Text(c, "暂无公告").TextColor(c.Theme().TextMuted)
		}
	default:
		a.cloudPostsPage(c.Key("posts"))
	}
}

func (a *prototype) cloudPostsPage(c *ui.Context) {
	s, state := a.cloud, &a.cloud.community
	if s.user.ID > 0 {
		ui.TextArea(c.Key("compose"), &state.postDraft).Label("动态正文").Placeholder("写一条动态").MinHeight(62)
		if labelButton(c, "发布动态", 92, true).Disabled(s.busy || strings.TrimSpace(state.postDraft) == "").Clicked() {
			s.postText(0)
		}
	}
	if len(state.posts) == 0 && !s.busy {
		ui.Text(c, "暂无动态").TextColor(c.Theme().TextMuted)
	}
	for _, post := range state.posts {
		ui.Column(c.Key(post.ID)).Gap(7).Padding(11).Radius(7).Background(c.Theme().Background).Children(func() {
			heading(c, post.Author.Nickname, 15).Wrap()
			ui.Text(c, post.Content).Wrap()
			ui.Row(c).Gap(6).Children(func() {
				like := "点赞"
				if post.LikedByMe {
					like = "取消赞"
				}
				if labelButton(c, fmt.Sprintf("%s %d", like, post.LikeCount), 92, post.LikedByMe).
					Disabled(s.busy || s.user.ID == 0).Clicked() {
					s.likePost(post)
				}
				if labelButton(c, fmt.Sprintf("回复 %d", post.CommentCount), 82, state.openPost == post.ID).
					Disabled(s.busy).Clicked() {
					if state.openPost == post.ID {
						state.openPost, state.replyDraft = 0, ""
					} else {
						s.loadPostReplies(post.ID)
					}
				}
				if post.CanDelete && labelButton(c, "删除", 62, false).Disabled(s.busy).Clicked() {
					state.deletePost = post.ID
				}
			})
			if state.deletePost == post.ID {
				ui.Row(c).Gap(6).Children(func() {
					if labelButton(c, "确认删除", 92, true).Disabled(s.busy).Clicked() {
						s.accountWrite(http.MethodDelete, "/posts/"+strconv.FormatInt(post.ID, 10), true, nil, "动态已删除", func() {
							state.deletePost = 0
							s.loadPosts(false)
						})
					}
					if labelButton(c, "取消", 62, false).Clicked() {
						state.deletePost = 0
					}
				})
			}
			if state.openPost == post.ID {
				a.cloudPostReplies(c.Key("replies"), post.ID)
			}
		})
	}
	if state.postOffset < state.postTotal && labelButton(c, "更多动态", 92, false).Disabled(s.busy).Clicked() {
		s.loadPosts(true)
	}
}

func (a *prototype) cloudPostReplies(c *ui.Context, postID int64) {
	s, state := a.cloud, &a.cloud.community
	for _, reply := range state.replies {
		ui.Row(c.Key(reply.ID)).Gap(6).AlignItems(ui.Start).Children(func() {
			ui.Text(c, reply.Author.Nickname+" · "+reply.Content).Grow(1).Wrap()
			if s.user.ID > 0 && reply.Author.ID == s.user.ID {
				iconButton(c, closeIcon, "删除回复", 34, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
					if m.Item("确认删除回复").Chosen() {
						endpoint := "/posts/comments/" + strconv.FormatInt(reply.ID, 10)
						s.accountWrite(http.MethodDelete, endpoint, true, nil, "回复已删除", func() { s.loadPostReplies(postID) })
					}
				})
			}
		})
	}
	if s.user.ID > 0 {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			settingsInput(c.Key("reply"), &state.replyDraft, "回复内容", "写回复").Grow(1)
			if labelButton(c, "回复", 66, true).Disabled(s.busy || strings.TrimSpace(state.replyDraft) == "").Clicked() {
				s.postText(postID)
			}
		})
	}
}

func (a *prototype) cloudChatPage(c *ui.Context) {
	s, state := a.cloud, &a.cloud.community
	if s.user.ID > 0 {
		ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
			settingsInput(c.Key("message"), &state.chatDraft, "聊天室消息", "输入消息").Grow(1)
			if labelButton(c, "发送", 66, true).Disabled(s.busy || strings.TrimSpace(state.chatDraft) == "").Clicked() {
				s.sendChat()
			}
		})
	}
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "最近成员", 92, false).Disabled(s.busy).Clicked() {
			if state.showMembers {
				state.showMembers = false
			} else {
				s.loadChatMembers()
			}
		}
		if len(state.chat) > 0 && labelButton(c, "更早消息", 92, false).Disabled(s.busy).Clicked() {
			s.loadOlderChat()
		}
	})
	if state.showMembers {
		names := make([]string, 0, len(state.chatMembers))
		for _, member := range state.chatMembers {
			names = append(names, member.Nickname)
		}
		ui.Text(c, strings.Join(names, "、")).Wrap().TextColor(c.Theme().TextMuted)
	}
	if len(state.chat) == 0 {
		ui.Text(c, "暂无消息").TextColor(c.Theme().TextMuted)
	}
	for i := len(state.chat) - 1; i >= 0; i-- {
		message := state.chat[i]
		ui.Column(c.Key(message.ID)).Gap(3).Padding(9).Radius(7).Background(c.Theme().Background).Children(func() {
			ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
				heading(c, message.User.Nickname, 14).Grow(1).Wrap()
				if s.user.ID > 0 && message.UserID == s.user.ID {
					iconButton(c, closeIcon, "删除消息", 34, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
						if m.Item("确认删除消息").Chosen() {
							endpoint := "/chat/messages/" + strconv.FormatInt(message.ID, 10)
							s.accountWrite(http.MethodDelete, endpoint, true, nil, "消息已删除", func() {
								s.applyChatEvent(cloudChatEvent{Type: "delete", Payload: message})
							})
						}
					})
				}
			})
			ui.Text(c, message.Content).Wrap()
			if message.Streaming {
				ui.Text(c, "正在回复…").TextColor(c.Theme().TextMuted)
			}
			if message.Image != "" {
				ui.Text(c, "含图片").TextColor(c.Theme().TextMuted)
			}
		})
	}
}
