package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

type cloudPost struct {
	ID, LikeCount, CommentCount int64
	Author                      cloudUser
	Content                     string
	LikedByMe, CanDelete        bool
}

type cloudAnnouncement struct {
	ID          int64
	Title, Body string
	Pinned      bool
}

type cloudChatMessage struct {
	ID, UserID     int64
	User           cloudUser
	Content, Image string
	Streaming      bool
}

type cloudChatEvent struct {
	Seq     int64
	Type    string
	Payload cloudChatMessage
}

type cloudCommunity struct {
	tab                   string
	posts, replies        []cloudPost
	postOffset, postTotal int
	openPost, deletePost  int64
	postDraft, replyDraft string
	announcements         []cloudAnnouncement
	chat                  []cloudChatMessage
	chatMembers           []cloudUser
	chatDraft             string
	showMembers           bool
	chatCancel            context.CancelFunc
}

func (s *cloudLibrary) loadPosts(more bool) {
	offset := 0
	if more {
		offset = s.community.postOffset
	}
	type result struct {
		Posts []cloudPost
		Total int
	}
	endpoint := fmt.Sprintf("/posts?limit=15&offset=%d", offset)
	requestCloud(s, func(ctx context.Context, api cloudAPI) (result, error) {
		var response result
		err := api.call(ctx, http.MethodGet, endpoint, api.token != "", nil, &response)
		return response, err
	}, func(response result) {
		if !more {
			s.community.posts = nil
		}
		s.community.posts = append(s.community.posts, response.Posts...)
		s.community.postOffset, s.community.postTotal = offset+len(response.Posts), response.Total
	})
}

func (s *cloudLibrary) loadPostReplies(id int64) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudPost, error) {
		var result struct{ Comments []cloudPost }
		err := api.call(ctx, http.MethodGet, "/posts/"+strconv.FormatInt(id, 10)+"/comments", false, nil, &result)
		return result.Comments, err
	}, func(replies []cloudPost) {
		if s.community.openPost != id {
			s.community.replyDraft = ""
		}
		s.community.openPost, s.community.replies = id, replies
	})
}

func (s *cloudLibrary) postText(replyTo int64) {
	draft, endpoint := &s.community.postDraft, "/posts"
	if replyTo > 0 {
		draft, endpoint = &s.community.replyDraft, "/posts/"+strconv.FormatInt(replyTo, 10)+"/comments"
	}
	body := map[string]string{"content": strings.TrimSpace(*draft)}
	s.accountWrite(http.MethodPost, endpoint, true, body, "已发布", func() {
		*draft = ""
		if replyTo > 0 {
			s.loadPostReplies(replyTo)
		} else {
			s.loadPosts(false)
		}
	})
}

func (s *cloudLibrary) likePost(post cloudPost) {
	endpoint := "/posts/" + strconv.FormatInt(post.ID, 10) + "/like"
	requestCloud(s, func(ctx context.Context, api cloudAPI) (int64, error) {
		var result struct{ LikeCount int64 }
		err := api.call(ctx, http.MethodPost, endpoint, true, map[string]bool{"on": !post.LikedByMe}, &result)
		return result.LikeCount, err
	}, func(count int64) {
		for i := range s.community.posts {
			if s.community.posts[i].ID == post.ID {
				s.community.posts[i].LikeCount, s.community.posts[i].LikedByMe = count, !post.LikedByMe
			}
		}
	})
}

func (s *cloudLibrary) loadAnnouncements() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudAnnouncement, error) {
		var result struct{ Items []cloudAnnouncement }
		err := api.call(ctx, http.MethodGet, "/announcements?limit=30", false, nil, &result)
		return result.Items, err
	}, func(items []cloudAnnouncement) { s.community.announcements = items })
}

func (a cloudAPI) chatMessages(ctx context.Context, before int64) ([]cloudChatMessage, error) {
	var result struct{ Messages []cloudChatMessage }
	endpoint := fmt.Sprintf("/chat/messages?limit=30&before=%d", before)
	err := a.call(ctx, http.MethodGet, endpoint, false, nil, &result)
	return result.Messages, err
}

func (s *cloudLibrary) loadOlderChat() {
	if len(s.community.chat) == 0 {
		return
	}
	before := s.community.chat[0].ID
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudChatMessage, error) {
		return api.chatMessages(ctx, before)
	}, func(items []cloudChatMessage) {
		s.community.chat = append(items, s.community.chat...)
		if len(items) == 0 {
			s.notice = "没有更早的消息"
		}
	})
}

func (s *cloudLibrary) startChat() {
	s.stopChat()
	ctx, cancel := context.WithCancel(s.scope)
	s.community.chatCancel = cancel
	api, dispatch := s.api, s.dispatch
	go func() {
		var since int64
		reload := func() error {
			var cursor struct{ LatestSeq int64 }
			if err := api.call(ctx, http.MethodGet, "/chat/live", false, nil, &cursor); err != nil {
				return err
			}
			items, err := api.chatMessages(ctx, 0)
			if err != nil {
				return err
			}
			since = cursor.LatestSeq
			dispatch(func() {
				if ctx.Err() == nil {
					s.community.chat = items
				}
			})
			return nil
		}
		apply := func(event cloudChatEvent) error {
			if event.Seq <= since {
				return nil
			}
			if event.Seq > since+1 {
				return reload()
			}
			since = event.Seq
			dispatch(func() {
				if ctx.Err() == nil {
					s.applyChatEvent(event)
				}
			})
			return nil
		}
		for ctx.Err() == nil {
			if err := reload(); err == nil {
				break
			}
			dispatch(func() {
				if ctx.Err() == nil {
					s.notice = "聊天室连接失败，正在重试"
				}
			})
			select {
			case <-ctx.Done():
				return
			case <-time.After(3 * time.Second):
			}
		}
		for ctx.Err() == nil {
			endpoint := fmt.Sprintf("/live/chat?sse=1&since=%d", since)
			_ = api.serverEvents(ctx, endpoint, since, false, func(data []byte) error {
				var event cloudChatEvent
				if err := json.Unmarshal(data, &event); err != nil {
					return err
				}
				return apply(event)
			})
			for range 4 {
				select {
				case <-ctx.Done():
					return
				case <-time.After(3 * time.Second):
				}
				var batch struct {
					Events    []cloudChatEvent
					LatestSeq int64
				}
				if err := api.call(ctx, http.MethodGet, fmt.Sprintf("/chat/live?since=%d", since), false, nil, &batch); err != nil {
					continue
				}
				if batch.LatestSeq < since {
					_ = reload()
					continue
				}
				for _, event := range batch.Events {
					if err := apply(event); err != nil {
						break
					}
				}
			}
		}
	}()
}

func (s *cloudLibrary) stopChat() {
	if s.community.chatCancel != nil {
		s.community.chatCancel()
		s.community.chatCancel = nil
	}
}

func (s *cloudLibrary) applyChatEvent(event cloudChatEvent) {
	items := s.community.chat
	message := event.Payload
	index := slices.IndexFunc(items, func(existing cloudChatMessage) bool { return existing.ID == message.ID })
	switch event.Type {
	case "message":
		if index < 0 && message.ID > 0 {
			s.community.chat = append(items, message)
			if len(s.community.chat) > 300 {
				s.community.chat = slices.Clone(s.community.chat[len(s.community.chat)-300:])
			}
		}
	case "edit":
		if index >= 0 {
			items[index].Content, items[index].Streaming = message.Content, message.Streaming
		}
	case "delete":
		if index >= 0 {
			s.community.chat = slices.Delete(items, index, index+1)
		}
	}
}

func (s *cloudLibrary) sendChat() {
	draft := strings.TrimSpace(s.community.chatDraft)
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudChatMessage, error) {
		var result cloudChatMessage
		if len([]rune(draft)) > 500 {
			return result, errors.New("聊天室消息最多 500 字")
		}
		err := api.call(ctx, http.MethodPost, "/chat/messages", true, map[string]string{"content": draft}, &result)
		return result, err
	}, func(message cloudChatMessage) {
		s.applyChatEvent(cloudChatEvent{Type: "message", Payload: message})
		if strings.TrimSpace(s.community.chatDraft) == draft {
			s.community.chatDraft = ""
		}
	})
}

func (s *cloudLibrary) loadChatMembers() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudUser, error) {
		var result struct{ Members []cloudUser }
		err := api.call(ctx, http.MethodGet, "/chat/members", false, nil, &result)
		return result.Members, err
	}, func(items []cloudUser) { s.community.chatMembers, s.community.showMembers = items, true })
}
