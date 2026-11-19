package main

import (
	"math/rand/v2"
	"slices"
)

type playMode int

const (
	playInOrder playMode = iota
	repeatQueue
	repeatSong
	shuffleQueue
)

var playModeNames = [...]string{"顺序播放", "列表循环", "单曲循环", "随机播放"}

type playQueue struct {
	songs []cloudSong
	index int
	mode  playMode
}

func (q *playQueue) start(song cloudSong, list []cloudSong) {
	q.songs = slices.Clone(list)
	q.index = slices.IndexFunc(q.songs, func(item cloudSong) bool { return item.ID == song.ID })
	if q.index < 0 {
		q.songs, q.index = []cloudSong{song}, 0
	} else {
		q.songs[q.index] = song
	}
	if q.mode == shuffleQueue {
		copy(q.songs[1:q.index+1], q.songs[:q.index])
		q.songs[0], q.index = song, 0
		q.shuffleRemaining()
	}
}

func (q *playQueue) shuffleRemaining() {
	songs := q.songs[q.index+1:]
	rand.Shuffle(len(songs), func(i, j int) { songs[i], songs[j] = songs[j], songs[i] })
}

func (q *playQueue) enqueue(song cloudSong, next bool) {
	index := len(q.songs)
	if next {
		index = q.index + 1
	}
	q.songs = slices.Insert(q.songs, index, song)
}

func (q *playQueue) clear() {
	q.songs, q.index = nil, -1
}

func (q *playQueue) neighbor(delta int, ended bool) int {
	if len(q.songs) == 0 {
		return -1
	}
	if ended && q.mode == repeatSong {
		return q.index
	}
	next := q.index + delta
	if next >= 0 && next < len(q.songs) {
		return next
	}
	if q.index >= 0 && (q.mode == repeatQueue || q.mode == shuffleQueue) {
		return (next + len(q.songs)) % len(q.songs)
	}
	return -1
}

func (q *playQueue) remove(index int) {
	if index == q.index {
		return
	}
	q.songs = slices.Delete(q.songs, index, index+1)
	if index < q.index {
		q.index--
	}
}
