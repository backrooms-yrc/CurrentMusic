package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type cloudRoom struct {
	ID, OwnerID, ArchivedAt                                   int64
	Name, Code                                                string
	IsPublic, FreeMode, NeedApproval, JoinLocked, HasPassword bool
}

type roomMember struct {
	UserID         int64
	Nickname, Role string
}

type roomBan struct {
	UserID           int64
	Nickname, Reason string
}

type roomQueueItem struct {
	ID, NcmID, Duration, RequestedBy int64
	Name, Artists, Requester, Status string
}

type roomTimeline struct {
	TrackRevision, BasePosition, BaseAt, ServerNow int64
	TrackMeta                                      *cloudSong
	Playing                                        bool
	Stream                                         *struct {
		URL, Level string
		ExpireAt   int64
	}
}

func (t roomTimeline) position(now int64) int64 {
	position := max(0, t.BasePosition)
	if t.Playing {
		position += max(0, now-t.BaseAt)
	}
	if t.TrackMeta != nil && t.TrackMeta.Duration > 0 {
		position = min(position, t.TrackMeta.Duration)
	}
	return position
}

type roomSnapshot struct {
	Room                  cloudRoom
	Role                  string
	Members               []roomMember
	Queue                 []roomQueueItem
	Timeline              *roomTimeline
	LatestSeq, ServerTime int64
}

func (r roomSnapshot) controller() bool {
	return r.Role == "owner" || r.Role == "admin"
}

type roomForm struct {
	Name         string `json:"name"`
	Password     string `json:"password,omitempty"`
	IsPublic     bool   `json:"isPublic"`
	FreeMode     bool   `json:"freeMode"`
	NeedApproval bool   `json:"needApproval"`
	JoinLocked   bool   `json:"joinLocked"`
}

type cloudRooms struct {
	list                          []cloudRoom
	total, offset                 int
	scope, query, code, password  string
	detail                        roomSnapshot
	liveID, timelineSeq           int64
	clockOffset                   int64
	cancel                        context.CancelFunc
	form                          roomForm
	bans                          []roomBan
	editing, creating, removePass bool
	showBans                      bool
	confirm                       string
	connection                    string
}

func roomPath(id int64) string { return "/rooms/" + strconv.FormatInt(id, 10) }

func (s *cloudLibrary) loadRooms(scope string, more bool) {
	offset := 0
	query := strings.TrimSpace(s.rooms.query)
	if more {
		offset = s.rooms.offset
	}
	type listing struct {
		Rooms []cloudRoom
		Total int
	}
	q := url.Values{"scope": {scope}, "query": {query}, "offset": {strconv.Itoa(offset)}, "limit": {"20"}}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (listing, error) {
		var result listing
		err := api.call(ctx, http.MethodGet, "/rooms?"+q.Encode(), true, nil, &result)
		return result, err
	}, func(result listing) {
		if !more {
			s.rooms.list = nil
		}
		s.rooms.scope, s.rooms.total, s.rooms.offset = scope, result.Total, offset+len(result.Rooms)
		s.rooms.list = append(s.rooms.list, result.Rooms...)
	})
}

func (a cloudAPI) roomSnapshot(ctx context.Context, id int64) (roomSnapshot, error) {
	var result roomSnapshot
	err := a.call(ctx, http.MethodGet, roomPath(id), true, nil, &result)
	return result, err
}

func (s *cloudLibrary) openRoom(id int64, lookup string, ready func()) {
	if s.rooms.liveID > 0 && (id != s.rooms.liveID || lookup != "") {
		s.notice = "请先退出当前房间"
		return
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (roomSnapshot, error) {
		if lookup != "" {
			var result roomSnapshot
			err := api.call(ctx, http.MethodGet, "/rooms/search?code="+url.QueryEscape(lookup), true, nil, &result)
			if err != nil {
				return result, err
			}
			id = result.Room.ID
		}
		return api.roomSnapshot(ctx, id)
	}, func(snapshot roomSnapshot) {
		s.rooms.detail, s.rooms.password, s.rooms.confirm = snapshot, "", ""
		s.rooms.editing, s.rooms.removePass, s.rooms.showBans = false, false, false
		ready()
	})
}

func (s *cloudLibrary) enterRoom(action string, ready func()) {
	id, password, form := s.rooms.detail.Room.ID, s.rooms.password, s.rooms.form
	s.rooms.password, s.rooms.form.Password = "", ""
	if s.rooms.liveID != 0 && (action == "create" || s.rooms.liveID != id) {
		s.notice = "请先退出当前房间"
		return
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (roomSnapshot, error) {
		var confirmed roomSnapshot
		if action == "create" {
			if err := api.call(ctx, http.MethodPost, "/rooms", true, form, &confirmed); err != nil {
				return roomSnapshot{}, err
			}
			id = confirmed.Room.ID
		} else {
			if err := api.call(ctx, http.MethodPost, roomPath(id)+"/"+action, true, map[string]string{"password": password}, &confirmed); err != nil {
				return roomSnapshot{}, err
			}
		}
		if id <= 0 {
			return roomSnapshot{}, errors.New("服务器未返回有效房间")
		}
		snapshot, err := api.roomSnapshot(ctx, id)
		if err != nil && confirmed.Room.ID == id {
			return confirmed, nil
		}
		return snapshot, err
	}, func(snapshot roomSnapshot) {
		s.rooms.creating = false
		if snapshot.Role == "" {
			s.rooms.detail = snapshot
			s.notice = "房间已更新，请刷新成员状态"
			ready()
			return
		}
		s.watchRoom(snapshot)
		ready()
	})
}

func (s *cloudLibrary) roomWrite(method string, id int64, action string, body any, done func()) {
	if body == nil && method == http.MethodPost {
		body = struct{}{}
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		return struct{}{}, api.call(ctx, method, roomPath(id)+action, true, body, nil)
	}, func(struct{}) {
		if done != nil {
			done()
		}
	})
}

func (s *cloudLibrary) loadRoomBans() {
	id := s.rooms.liveID
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]roomBan, error) {
		var result struct{ Bans []roomBan }
		err := api.call(ctx, http.MethodGet, roomPath(id)+"/bans", true, nil, &result)
		return result.Bans, err
	}, func(bans []roomBan) {
		s.rooms.bans, s.rooms.showBans = bans, true
	})
}

func (s *cloudLibrary) roomTransport(action string, position int64) {
	r := &s.rooms
	if r.liveID <= 0 || r.detail.Room.ID != r.liveID || (!r.detail.controller() && action != "stream/renew") {
		return
	}
	body := map[string]int64{}
	id := r.liveID
	if action == "seek" {
		body["position"] = position
	}
	if (action == "next" || action == "prev") && r.detail.Timeline != nil {
		body["trackRevision"] = r.detail.Timeline.TrackRevision
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct {
		Timeline *roomTimeline
		Seq      int64
	}, error) {
		var result struct {
			Timeline *roomTimeline
			Seq      int64
		}
		err := api.call(ctx, http.MethodPost, roomPath(id)+"/"+action, true, body, &result)
		return result, err
	}, func(result struct {
		Timeline *roomTimeline
		Seq      int64
	}) {
		s.acceptRoomTimeline(result.Seq, result.Timeline)
	})
}

func (s *cloudLibrary) watchRoom(snapshot roomSnapshot) {
	s.stopRoom("")
	ctx, cancel := context.WithCancel(s.scope)
	s.rooms.liveID, s.rooms.cancel = snapshot.Room.ID, cancel
	s.rooms.detail, s.rooms.connection = snapshot, "已连接"
	if snapshot.ServerTime > 0 {
		s.rooms.clockOffset = snapshot.ServerTime - time.Now().UnixMilli()
	}
	s.acceptRoomTimeline(snapshot.LatestSeq, snapshot.Timeline)
	api, dispatch, id := s.api, s.dispatch, snapshot.Room.ID
	go s.syncRoomClock(ctx, api, id, dispatch)
	go func() {
		since := snapshot.LatestSeq
		consume := func(event roomEvent) error {
			if event.Type == "close" {
				if event.Seq < since {
					return nil
				}
				dispatch(func() {
					if ctx.Err() == nil {
						s.stopRoom("房间连接已结束")
					}
				})
				return errRoomClosed
			}
			if event.Type != "reset" && event.Seq <= since {
				return nil
			}
			if event.Payload.Timeline != nil && event.Type != "reset" && event.Seq == since+1 {
				since = event.Seq
				dispatch(func() {
					if ctx.Err() == nil {
						s.rooms.connection = "已连接"
						s.acceptRoomTimeline(event.Seq, event.Payload.Timeline)
					}
				})
				return nil
			}
			result, err := api.roomSnapshot(ctx, id)
			if err != nil {
				return err
			}
			since = result.LatestSeq
			dispatch(func() {
				if ctx.Err() == nil {
					if result.Role == "" {
						s.stopRoom("房间连接已结束")
					} else {
						if result.LatestSeq < s.rooms.timelineSeq {
							result.Timeline = s.rooms.detail.Timeline
						}
						s.rooms.detail, s.rooms.connection = result, "已连接"
						if result.ServerTime > 0 {
							s.rooms.clockOffset = result.ServerTime - time.Now().UnixMilli()
						}
						s.acceptRoomTimeline(result.LatestSeq, result.Timeline)
					}
				}
			})
			if result.Role == "" {
				return errRoomClosed
			}
			return nil
		}
		for ctx.Err() == nil {
			err := api.roomEventsSSE(ctx, id, since, consume)
			if ctx.Err() != nil || errors.Is(err, errRoomClosed) {
				return
			}
			dispatch(func() {
				if ctx.Err() == nil {
					s.rooms.connection = "正在重新连接"
				}
			})
			var batch struct{ Events []roomEvent }
			endpoint := fmt.Sprintf("%s/events?since=%d&wait=20", roomPath(id), since)
			if err := api.call(ctx, http.MethodGet, endpoint, true, nil, &batch); err == nil {
				dispatch(func() {
					if ctx.Err() == nil {
						s.rooms.connection = "已连接"
					}
				})
				for _, event := range batch.Events {
					if err := consume(event); errors.Is(err, errRoomClosed) {
						return
					} else if err != nil {
						break
					}
				}
			} else if terminalRoomError(err) {
				dispatch(func() {
					if ctx.Err() == nil {
						s.stopRoom("已失去房间访问权限")
					}
				})
				return
			} else {
				select {
				case <-ctx.Done():
					return
				case <-time.After(2 * time.Second):
				}
			}
		}
	}()
}

func (s *cloudLibrary) acceptRoomTimeline(seq int64, timeline *roomTimeline) {
	if timeline == nil || seq < s.rooms.timelineSeq {
		return
	}
	s.rooms.timelineSeq = seq
	s.rooms.detail.Timeline = timeline
	if s.roomTimelineChanged != nil {
		s.roomTimelineChanged(timeline, s.rooms.clockOffset)
	}
}

func (s *cloudLibrary) syncRoomClock(ctx context.Context, api cloudAPI, id int64, dispatch func(func())) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		var result struct{ ServerNow int64 }
		started := time.Now()
		if api.call(ctx, http.MethodPost, roomPath(id)+"/sync", true, struct{}{}, &result) != nil || result.ServerNow <= 0 {
			continue
		}
		offset := result.ServerNow - started.Add(time.Since(started)/2).UnixMilli()
		dispatch(func() {
			if ctx.Err() != nil {
				return
			}
			s.rooms.clockOffset = offset
			timeline := s.rooms.detail.Timeline
			if timeline == nil {
				return
			}
			if s.roomTimelineChanged != nil {
				s.roomTimelineChanged(timeline, offset)
			}
			if timeline.Stream != nil && timeline.Stream.ExpireAt > 0 &&
				timeline.Stream.ExpireAt-(time.Now().UnixMilli()+offset) < 45000 {
				s.roomTransport("stream/renew", 0)
			}
		})
	}
}

func (s *cloudLibrary) stopRoom(message string) {
	if s.rooms.cancel != nil {
		s.rooms.cancel()
	}
	wasLive := s.rooms.liveID > 0
	s.rooms.cancel, s.rooms.liveID, s.rooms.timelineSeq = nil, 0, 0
	s.rooms.detail.Role, s.rooms.detail.Timeline = "", nil
	s.rooms.connection = message
	if wasLive && s.roomTimelineChanged != nil {
		s.roomTimelineChanged(nil, 0)
	}
}

type roomEvent struct {
	Seq     int64
	Type    string
	Payload struct{ Timeline *roomTimeline }
}

var errRoomClosed = errors.New("room closed")

func terminalRoomError(err error) bool {
	var status cloudAPIError
	return errors.As(err, &status) && (status.status == 401 || status.status == 403 || status.status == 404)
}

func (a cloudAPI) roomEventsSSE(ctx context.Context, id, since int64, consume func(roomEvent) error) error {
	endpoint := fmt.Sprintf("%s/events?sse=1&since=%d", roomPath(id), since)
	return a.serverEvents(ctx, endpoint, since, true, func(data []byte) error {
		var event roomEvent
		if err := json.Unmarshal(data, &event); err != nil {
			return err
		}
		return consume(event)
	})
}

func (a cloudAPI) serverEvents(ctx context.Context, endpoint string, since int64, auth bool, consume func([]byte) error) error {
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	const idleLimit = 25 * time.Second
	idle := time.AfterFunc(idleLimit, cancel)
	defer idle.Stop()
	request, err := http.NewRequestWithContext(streamCtx, http.MethodGet, a.base+endpoint, nil)
	if err != nil {
		return err
	}
	if auth {
		request.Header.Set("Authorization", "Bearer "+a.token)
	}
	request.Header.Set("Accept", "text/event-stream")
	request.Header.Set("Last-Event-ID", strconv.FormatInt(since, 10))
	client := http.Client{Transport: a.http.Transport, CheckRedirect: a.http.CheckRedirect}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		return fmt.Errorf("event stream returned HTTP %d", response.StatusCode)
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 512<<10)
	var data string
	for scanner.Scan() {
		idle.Reset(idleLimit)
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "data:"):
			data = strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		case line == "" && data != "":
			payload := []byte(data)
			data = ""
			if err := consume(payload); err != nil {
				return err
			}
		}
	}
	return scanner.Err()
}
