package main

import (
	"syscall"
	"unsafe"
)

var (
	instanceKernel   = syscall.NewLazyDLL("kernel32.dll")
	createInstance   = instanceKernel.NewProc("CreateMutexW")
	createActivation = instanceKernel.NewProc("CreateEventW")
	signalActivation = instanceKernel.NewProc("SetEvent")
	waitActivation   = instanceKernel.NewProc("WaitForSingleObject")
	instanceUser32   = syscall.NewLazyDLL("user32.dll")
	findWindow       = instanceUser32.NewProc("FindWindowW")
	windowProcess    = instanceUser32.NewProc("GetWindowThreadProcessId")
	allowForeground  = instanceUser32.NewProc("AllowSetForegroundWindow")
)

type desktopInstance struct {
	mutex, activation uintptr
	stop, done        chan struct{}
}

func openDesktopInstance() (*desktopInstance, error) {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return nil, err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	sid, err := user.User.Sid.String()
	if err != nil {
		return nil, err
	}
	return claimDesktopInstance(`Local\CurrentMusic.Windows.`+sid, grantMainWindowForeground)
}

// The event exists before the mutex, so a second launch can signal even while
// the first process is still creating its window. Neither object survives a crash.
func claimDesktopInstance(name string, beforeActivate func()) (*desktopInstance, error) {
	eventName, err := syscall.UTF16PtrFromString(name + ".activate")
	if err != nil {
		return nil, err
	}
	mutexName, err := syscall.UTF16PtrFromString(name + ".instance")
	if err != nil {
		return nil, err
	}
	event, _, eventErr := createActivation.Call(0, 0, 0, uintptr(unsafe.Pointer(eventName)))
	if event == 0 {
		return nil, eventErr
	}
	mutex, _, mutexErr := createInstance.Call(0, 0, uintptr(unsafe.Pointer(mutexName)))
	if mutex == 0 {
		syscall.CloseHandle(syscall.Handle(event))
		return nil, mutexErr
	}
	if mutexErr == syscall.ERROR_ALREADY_EXISTS {
		defer syscall.CloseHandle(syscall.Handle(mutex))
		defer syscall.CloseHandle(syscall.Handle(event))
		if beforeActivate != nil {
			beforeActivate()
		}
		if ok, _, err := signalActivation.Call(event); ok == 0 {
			return nil, err
		}
		return nil, nil
	}
	return &desktopInstance{mutex: mutex, activation: event}, nil
}

func grantMainWindowForeground() {
	class, _ := syscall.UTF16PtrFromString("MyGoWindow")
	title, _ := syscall.UTF16PtrFromString(mainWindowTitle)
	hwnd, _, _ := findWindow.Call(uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return
	}
	var pid uint32
	windowProcess.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != 0 {
		allowForeground.Call(uintptr(pid))
	}
}

func (i *desktopInstance) watch(activate func()) {
	i.stop, i.done = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(i.done)
		for {
			status, _, _ := waitActivation.Call(i.activation, 0xffffffff)
			if status != 0 {
				return
			}
			select {
			case <-i.stop:
				return
			default:
				activate()
			}
		}
	}()
}

func (i *desktopInstance) close() {
	if i.done != nil {
		close(i.stop)
		signalActivation.Call(i.activation)
		<-i.done
	}
	syscall.CloseHandle(syscall.Handle(i.activation))
	syscall.CloseHandle(syscall.Handle(i.mutex))
}
