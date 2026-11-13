package main

import (
	"context"
	"fmt"
	"net/http"
	"strconv"

	"github.com/egoist/mygo/ui"
)

type cloudSongInfo struct {
	songID int64
	mode   string
	data   cloudSongInfoData
}

type cloudSongInfoData struct {
	ID        int64
	Qualities []struct {
		Label, Level string
		BR, SR       int
		Size         int64
		Variants     []struct {
			ImmerseType string
			BR, SR      int
			Size        int64
		}
	}
	Segments []struct{ StartMS, EndMS int64 }
	Songs    []cloudSong
	Sections []struct {
		Name, Desc string
		Fields     [][2]string
	}
}

func (s *cloudLibrary) loadSongInfo(id int64, mode string) {
	if s.busy {
		return
	}
	s.songInfo = cloudSongInfo{songID: id, mode: mode}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudSongInfoData, error) {
		var result cloudSongInfoData
		err := api.call(ctx, http.MethodGet, "/song/"+mode+"?id="+strconv.FormatInt(id, 10), false, nil, &result)
		return result, err
	}, func(result cloudSongInfoData) {
		if s.songInfo.songID == id && s.songInfo.mode == mode {
			s.songInfo.data = result
		}
	})
}

func (a *prototype) currentCloudTrackID() int64 {
	if a.cloud != nil && a.cloud.rooms.liveID > 0 {
		if timeline := a.cloud.rooms.detail.Timeline; timeline != nil && timeline.TrackMeta != nil {
			return timeline.TrackMeta.ID
		}
		return 0
	}
	q := &a.playQueue
	if a.active && a.cloudTrack && q.index >= 0 && q.index < len(q.songs) {
		return q.songs[q.index].ID
	}
	return 0
}

func (a *prototype) cloudSongInfoPage(c *ui.Context) {
	s, info := a.cloud, a.cloud.songInfo
	ui.Scroll(c).Grow(1).MinHeight(0).Children(func() {
		ui.Column(c).Gap(8).Padding(8).Children(func() {
			switch info.mode {
			case "qualities":
				heading(c, "音源规格", 19)
				for _, quality := range info.data.Qualities {
					name := quality.Label
					if name == "" {
						name = quality.Level
					}
					ui.Text(c, fmt.Sprintf("%s · %d kbps · %.1f kHz · %.1f MB", name, quality.BR/1000, float64(quality.SR)/1000, float64(quality.Size)/1e6)).Wrap()
					for _, variant := range quality.Variants {
						ui.Text(c, fmt.Sprintf("%s · %d kbps · %.1f kHz", variant.ImmerseType, variant.BR/1000, float64(variant.SR)/1000)).Wrap().TextColor(c.Theme().TextMuted)
					}
				}
			case "chorus":
				heading(c, "副歌段落", 19)
				for i, segment := range info.data.Segments {
					if segment.StartMS < 0 || segment.EndMS <= segment.StartMS || segment.StartMS >= a.duration {
						continue
					}
					label := clockLabel(segment.StartMS) + " – " + clockLabel(min(a.duration, segment.EndMS))
					roomMember := s.rooms.liveID > 0 && !s.rooms.detail.controller()
					if labelButton(c.Key(i), label, 132, false).Disabled(!a.seekable || roomMember).Clicked() {
						a.seekTo(segment.StartMS)
						s.songInfo = cloudSongInfo{}
					}
				}
			case "versions":
				heading(c, "其他版本", 19)
				songs := appendCloudSongs(nil, info.data.Songs)
				for _, song := range songs {
					row := ui.ButtonBase(c.Key(song.ID)).Height(40).Radius(7).Label(song.Name).
						Disabled(s.user.ID == 0 || a.queueLoading || s.rooms.liveID > 0)
					styleControl(row, c.Theme(), false)
					row.Children(func() {
						singleLine(c, song.Name+" · "+song.Artists).PaddingX(8).Grow(1)
					})
					if row.Clicked() && a.playCloud != nil {
						a.playCloud(song, songs)
						s.songInfo = cloudSongInfo{}
					}
				}
			case "wiki":
				heading(c, "歌曲百科", 19)
				for _, section := range info.data.Sections {
					heading(c, section.Name, 15).Wrap()
					for _, field := range section.Fields {
						ui.Text(c, field[0]+" · "+field[1]).Wrap()
					}
					if section.Desc != "" {
						ui.Text(c, section.Desc).Wrap().TextColor(c.Theme().TextMuted)
					}
				}
			}
			if !s.busy && s.notice == "" && len(info.data.Qualities)+len(info.data.Segments)+len(info.data.Songs)+len(info.data.Sections) == 0 {
				ui.Text(c, "暂无资料").TextColor(c.Theme().TextMuted)
			}
			a.cloudStatus(c)
		})
	})
}
