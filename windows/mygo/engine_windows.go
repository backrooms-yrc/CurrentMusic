package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

type mediaState uint32

const (
	mediaEmpty mediaState = iota
	mediaOpening
	mediaBuffering
	mediaPlaying
	mediaPaused
	mediaFailed
)

const (
	eventOpened = 1 << iota
	eventSeeked
	eventEnded
	eventOutputChanged
)

// Keep in sync with cm_media_snapshot in media/bridge.h.
type mediaSnapshot struct {
	Generation uint64
	PositionMS int64
	DurationMS int64
	State      mediaState
	CanSeek    uint32
	Events     uint32
	Error      int32
}

type mediaUpdate struct {
	mediaSnapshot
	SeekID uint64
	At     time.Time
}

type mediaAction uint8

const (
	openMedia mediaAction = iota
	playMedia
	pauseMedia
	seekMedia
	setVolume
	closeMedia
)

type mediaCommand struct {
	action     mediaAction
	generation uint64
	source     string
	value      int64
	seekID     uint64
}

type mediaEngine struct {
	commands chan mediaCommand
	stop     chan struct{}
	done     chan struct{}
}

// Resolve against the application directory and System32 only. Keep the DLL
// loaded until process exit because a WinRT delegate may still be returning.
func loadMediaDLL() (*syscall.DLL, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	path := filepath.Join(filepath.Dir(exe), "CurrentMusic.Media.dll")
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	kernel := syscall.NewLazyDLL("kernel32.dll")
	load := kernel.NewProc("LoadLibraryExW")
	const dllLoadDirAndSystem32 = 0x0100 | 0x0800
	handle, _, callErr := load.Call(uintptr(unsafe.Pointer(name)), 0, dllLoadDirAndSystem32)
	if handle == 0 {
		return nil, callErr
	}
	return &syscall.DLL{Name: path, Handle: syscall.Handle(handle)}, nil
}

func startMediaEngine(publish func(mediaUpdate), report func(error)) *mediaEngine {
	e := &mediaEngine{
		commands: make(chan mediaCommand, 32),
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
	go e.run(publish, report)
	return e
}

func (e *mediaEngine) send(command mediaCommand) bool {
	select {
	case <-e.done:
		return false
	default:
	}
	select {
	case e.commands <- command:
		return true
	default:
		return false
	}
}

func (e *mediaEngine) run(publish func(mediaUpdate), report func(error)) {
	defer close(e.done)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	dll, err := loadMediaDLL()
	if err != nil {
		report(fmt.Errorf("无法加载媒体组件，请检查安装和 Windows 媒体功能"))
		return
	}
	names := []string{"open", "play", "pause", "seek", "volume", "close", "create", "destroy", "poll"}
	procs := make([]*syscall.Proc, len(names))
	for i, name := range names {
		procs[i], err = dll.FindProc("cm_media_" + name)
		if err != nil {
			report(fmt.Errorf("媒体组件版本不匹配"))
			return
		}
	}
	const create, destroy, poll = 6, 7, 8
	var handle uintptr
	if err := callMedia(procs[create], uintptr(unsafe.Pointer(&handle))); err != nil {
		report(err)
		return
	}
	defer procs[destroy].Call(handle)

	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	var last mediaSnapshot
	var generation uint64
	var pending mediaCommand
	var inFlight uint64
	var seekDeadline, nextSeek time.Time
	const seekSettle = 750 * time.Millisecond
	execute := func(cmd mediaCommand) error {
		if err := runMediaCommand(procs[cmd.action], handle, cmd); err != nil {
			report(fmt.Errorf("媒体命令 %s：%w", names[cmd.action], err))
			return err
		}
		return nil
	}
	sendPending := func(now time.Time) {
		if pending.seekID == 0 || inFlight != 0 || now.Before(nextSeek) {
			return
		}
		cmd := pending
		pending = mediaCommand{}
		if execute(cmd) == nil {
			inFlight, seekDeadline = cmd.seekID, now.Add(8*time.Second)
		}
	}
	for {
		select {
		case <-e.stop:
			return
		case cmd := <-e.commands:
			if cmd.action == openMedia || cmd.action == closeMedia {
				generation = cmd.generation
				pending, inFlight = mediaCommand{}, 0
				seekDeadline, nextSeek = time.Time{}, time.Time{}
			}
			if cmd.generation != generation && cmd.action != setVolume {
				continue
			}
			if cmd.action == seekMedia {
				if inFlight != 0 && seekDeadline.IsZero() {
					report(fmt.Errorf("上一请求未完成，请重新打开音源后定位"))
					continue
				}
				pending = cmd
				sendPending(time.Now())
			} else if err := execute(cmd); err != nil && cmd.action == openMedia {
				code, ok := err.(mediaError)
				if !ok {
					code = -2147467259 // E_FAIL
				}
				publish(mediaUpdate{mediaSnapshot: mediaSnapshot{Generation: generation, State: mediaFailed, Error: int32(code)}, At: time.Now()})
			}
		case <-tick.C:
			now := time.Now()
			var current mediaSnapshot
			pollErr := callMedia(procs[poll], handle, uintptr(unsafe.Pointer(&current)))
			if pollErr != nil {
				current = mediaSnapshot{Generation: generation, State: mediaFailed, Error: int32(pollErr.(mediaError))}
			}
			if current.Generation == generation && current.Events&eventOpened != 0 {
				// MediaOpened can arrive while the FLAC stream is still settling.
				nextSeek = now.Add(seekSettle)
			}
			var acknowledged uint64
			if current.Events&eventSeeked != 0 && inFlight != 0 {
				acknowledged, inFlight = inFlight, 0
				seekDeadline = time.Time{}
				// MediaPlayer can abort a second FLAC seek while its first
				// stream transition is settling after SeekCompleted.
				nextSeek = now.Add(seekSettle)
			}
			if current.State == mediaFailed {
				pending, inFlight = mediaCommand{}, 0
				seekDeadline = time.Time{}
			}
			if !seekDeadline.IsZero() && !now.Before(seekDeadline) {
				pending, seekDeadline = mediaCommand{}, time.Time{}
				report(fmt.Errorf("定位超时，请重新打开音源后定位"))
			}
			if current != last {
				if pollErr != nil {
					report(fmt.Errorf("读取播放状态：%w", pollErr))
				}
				publish(mediaUpdate{mediaSnapshot: current, SeekID: acknowledged, At: now})
				current.Events = 0
				last = current
			}
			sendPending(now)
		}
	}
}

func runMediaCommand(proc *syscall.Proc, handle uintptr, cmd mediaCommand) error {
	switch cmd.action {
	case openMedia:
		source, err := syscall.UTF16PtrFromString(cmd.source)
		if err != nil {
			return fmt.Errorf("音源地址无效")
		}
		err = callMedia(proc, handle, uintptr(unsafe.Pointer(source)), uintptr(cmd.generation))
		runtime.KeepAlive(source)
		return err
	case seekMedia, setVolume:
		return callMedia(proc, handle, uintptr(cmd.value))
	default:
		return callMedia(proc, handle)
	}
}

type mediaError int32

func (e mediaError) Error() string {
	code := uint32(e)
	if e.outputUnavailable() {
		return fmt.Sprintf("Windows 音频输出不可用（0x%08X）", code)
	}
	return fmt.Sprintf("Windows 媒体错误 0x%08X", code)
}

func (e mediaError) outputUnavailable() bool {
	switch uint32(e) {
	case 0xC00D36FA, 0xC00D4E84, 0xC00D4E86, 0x88890004: // MF and WASAPI endpoint errors.
		return true
	default:
		return false
	}
}

//go:uintptrescapes
func callMedia(proc *syscall.Proc, args ...uintptr) error {
	result, _, _ := proc.Call(args...)
	if code := int32(result); code < 0 {
		return mediaError(code)
	}
	return nil
}
