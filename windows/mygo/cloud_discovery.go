package main

import (
	"context"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
)

type cloudExploreSection struct {
	id, title, endpoint, kind string
	auth, paged               bool
}

var cloudExploreSections = []cloudExploreSection{
	{"recommend", "推荐歌单", "/ncm/personalized", "playlist", false, false},
	{"daily", "每日推荐", "/daily", "", true, false},
	{"charts", "排行榜", "/ncm/toplist", "playlist", false, false},
	{"playlists", "歌单广场", "/ncm/top/playlist", "playlist", false, true},
	{"artists", "歌手分类", "/ncm/artist/list", "artist", false, true},
	{"albums", "新碟", "/ncm/album/new", "album", false, true},
}

type cloudExploreState struct {
	section cloudExploreSection
	filter  string
	items   []cloudCatalogItem
	songs   []cloudSong
	offset  int
	more    bool
}

func (s *cloudLibrary) loadExplore(section cloudExploreSection, filter string, more bool) {
	type entry struct {
		ID   int64
		Name string
	}
	type response struct {
		Daily, ForYou                            []cloudSong
		List, Result, Playlists, Artists, Albums []entry
		More                                     bool
		Total                                    int
	}
	offset := 0
	if more {
		offset = s.explore.offset
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (response, error) {
		endpoint := section.endpoint
		q := url.Values{}
		if section.id == "recommend" || section.paged {
			q.Set("limit", strconv.Itoa(cloudSearchLimit))
			q.Set("offset", strconv.Itoa(offset))
		}
		switch section.id {
		case "playlists":
			q.Set("cat", filter)
			q.Set("order", "hot")
		case "artists":
			q.Set("type", "-1")
			q.Set("area", filter)
		case "albums":
			q.Set("area", filter)
		}
		if len(q) > 0 {
			endpoint += "?" + q.Encode()
		}
		var result response
		err := api.call(ctx, http.MethodGet, endpoint, section.auth, nil, &result)
		return result, err
	}, func(result response) {
		if !more {
			s.explore = cloudExploreState{section: section, filter: filter}
			s.catalogDetail, s.catalogBack, s.selected = cloudCatalogDetail{}, nil, cloudSong{}
		}
		rawItems := slices.Concat(result.List, result.Result, result.Playlists, result.Artists, result.Albums)
		items := make([]cloudCatalogItem, 0, len(rawItems))
		for _, item := range rawItems {
			items = append(items, cloudCatalogItem{ID: item.ID, Name: item.Name})
		}
		s.explore.items = appendCatalog(s.explore.items, items, section.kind)
		s.explore.songs = appendCloudSongs(s.explore.songs, slices.Concat(result.Daily, result.ForYou))
		s.explore.offset = offset + len(rawItems)
		s.explore.more = section.paged && len(rawItems) > 0 && (result.More || result.Total > s.explore.offset)
	})
}

func (a cloudAPI) searchHistory(ctx context.Context, method string, body any) ([]string, error) {
	var result struct{ History []string }
	err := a.call(ctx, method, "/search/history", true, body, &result)
	return result.History, err
}

func (s *cloudLibrary) editSearchHistory(method, keyword string) {
	var body any
	if method == http.MethodDelete {
		fields := map[string]string{}
		if keyword != "" {
			fields["keyword"] = keyword
		}
		body = fields
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]string, error) {
		return api.searchHistory(ctx, method, body)
	}, func(history []string) { s.searchHistory, s.historyOpen = history, true })
}

func (s *cloudLibrary) loadSearchTips(query string) {
	query = strings.TrimSpace(query)
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]string, error) {
		words := make([]string, 0, 12)
		add := func(word string) {
			word = strings.TrimSpace(word)
			if word != "" && len(words) < 12 && !slices.Contains(words, word) {
				words = append(words, word)
			}
		}
		if query != "" {
			var response struct {
				Result struct{ AllMatch []struct{ Keyword string } }
			}
			q := url.Values{"keywords": {query}, "type": {"mobile"}}
			if err := api.call(ctx, http.MethodGet, "/ncm/search/suggest?"+q.Encode(), false, nil, &response); err != nil {
				return nil, err
			}
			for _, item := range response.Result.AllMatch {
				add(item.Keyword)
			}
			return words, nil
		}
		var suggestion struct {
			Data struct{ RealKeyword, ShowKeyword string }
		}
		if api.call(ctx, http.MethodGet, "/ncm/search/default", false, nil, &suggestion) == nil {
			if suggestion.Data.RealKeyword != "" {
				add(suggestion.Data.RealKeyword)
			} else {
				add(suggestion.Data.ShowKeyword)
			}
		}
		var hot struct{ Data []struct{ SearchWord string } }
		if err := api.call(ctx, http.MethodGet, "/ncm/search/hot/detail", false, nil, &hot); err != nil {
			return nil, err
		}
		for _, item := range hot.Data {
			add(item.SearchWord)
		}
		return words, nil
	}, func(words []string) { s.searchTips, s.tipsFor = words, query })
}

func (s *cloudLibrary) loadRecent() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudSong, error) {
		var result cloudSongs
		err := api.call(ctx, http.MethodGet, "/plays/recent?limit=50", true, nil, &result)
		return result.Songs, err
	}, func(songs []cloudSong) { s.recent = appendCloudSongs(nil, songs) })
}
