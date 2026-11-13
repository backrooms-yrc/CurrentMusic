package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const savedQueueLimit = 100

type savedQueue struct {
	Songs []cloudSong `json:"songs"`
	Index int         `json:"index"`
	Mode  playMode    `json:"mode"`
}

func queueSettingsPath(dir, base string, user int64) string {
	if dir == "" || base == "" || user <= 0 {
		return ""
	}
	digest := sha256.Sum256([]byte(base))
	return filepath.Join(dir, fmt.Sprintf("queue-%x-%d.json", digest[:16], user))
}

func (q *playQueue) save(path string) error {
	if path == "" {
		return nil
	}
	first := max(0, q.index-savedQueueLimit+1)
	last := min(len(q.songs), first+savedQueueLimit)
	index := q.index
	if index >= 0 {
		index -= first
	}
	return writeLocalJSON(path, savedQueue{Songs: q.songs[first:last], Index: index, Mode: q.mode})
}

func restoreQueue(path string) playQueue {
	empty := playQueue{index: -1}
	if path == "" {
		return empty
	}
	file, err := os.Open(path)
	if err != nil {
		return empty
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	var state savedQueue
	if err != nil || json.Unmarshal(data, &state) != nil || len(state.Songs) > savedQueueLimit ||
		state.Index < -1 || state.Index >= len(state.Songs) || state.Mode < playInOrder || state.Mode > shuffleQueue {
		return empty
	}
	for _, song := range state.Songs {
		if song.ID <= 0 || song.Name == "" {
			return empty
		}
	}
	return playQueue{songs: state.Songs, index: state.Index, mode: state.Mode}
}
