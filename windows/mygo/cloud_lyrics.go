package main

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

type timedWord struct {
	Start int64
	Text  string
}

type lyricResponse struct {
	Instrumental bool
	Lines        []struct {
		Start       int64  `json:"t"`
		Text        string `json:"txt"`
		Translation string `json:"trans"`
		Words       []timedWord
		Offsets     [][]json.RawMessage `json:"w"`
		Estimated   bool                `json:"wSynth"`
	}
}

func (a cloudAPI) lyrics(ctx context.Context, id int64) (lyricResponse, error) {
	var response lyricResponse
	err := a.call(ctx, http.MethodGet, fmt.Sprintf("/ncm/lyric?id=%d", id), false, nil, &response)
	return response, err
}

func (response lyricResponse) timedLines() []timedLine {
	lines := make([]timedLine, 0, len(response.Lines))
	for _, raw := range response.Lines {
		if raw.Start < 0 || strings.TrimSpace(raw.Text) == "" {
			continue
		}
		line := timedLine{start: raw.Start, text: raw.Text, translation: raw.Translation, estimated: raw.Estimated}
		if validLyricWords(raw.Words, line) {
			line.tokens = raw.Words
		} else {
			words := make([]timedWord, 0, len(raw.Offsets))
			for _, pair := range raw.Offsets {
				var word timedWord
				if len(pair) != 2 || json.Unmarshal(pair[0], &word.Start) != nil || json.Unmarshal(pair[1], &word.Text) != nil {
					words = nil
					break
				}
				words = append(words, word)
			}
			if validLyricWords(words, line) {
				line.tokens = words
			}
		}
		lines = append(lines, line)
	}
	slices.SortStableFunc(lines, func(a, b timedLine) int { return cmp.Compare(a.start, b.start) })
	return lines
}

func validLyricWords(words []timedWord, line timedLine) bool {
	previous := line.start - 1
	var text strings.Builder
	for _, word := range words {
		if word.Start <= previous || word.Text == "" {
			return false
		}
		previous = word.Start
		text.WriteString(word.Text)
	}
	return text.String() == line.text
}
