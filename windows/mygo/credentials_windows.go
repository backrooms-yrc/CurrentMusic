package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

type windowsCredentials struct{}

var (
	credentialDLL = syscall.NewLazyDLL("advapi32.dll")
	credWrite     = credentialDLL.NewProc("CredWriteW")
	credRead      = credentialDLL.NewProc("CredReadW")
	credDelete    = credentialDLL.NewProc("CredDeleteW")
	credFree      = credentialDLL.NewProc("CredFree")
)

const genericCredential = 1
const localMachineCredential = 2
const credentialNotFound = syscall.Errno(1168)

type winCredential struct {
	flags, kind     uint32
	target, comment *uint16
	lastWritten     syscall.Filetime
	size            uint32
	blob            *byte
	persist, count  uint32
	attributes      unsafe.Pointer
	alias, username *uint16
}

func credentialTarget(base string, id int64) *uint16 {
	target, _ := syscall.UTF16PtrFromString(fmt.Sprintf("CurrentMusic.MyGo/v2/%x/%d", sha256.Sum256([]byte(base)), id))
	return target
}

func (windowsCredentials) save(base string, id int64, token string) error {
	if !validSessionToken(token) || id <= 0 {
		return errors.New("会话数据无效")
	}
	data := []byte(token)
	defer clear(data)
	credential := winCredential{
		kind: genericCredential, target: credentialTarget(base, id),
		size: uint32(len(data)), blob: &data[0], persist: localMachineCredential,
	}
	ok, _, err := credWrite.Call(uintptr(unsafe.Pointer(&credential)), 0)
	runtime.KeepAlive(credential)
	if ok == 0 {
		return fmt.Errorf("Windows 凭据保存失败（%v）", err)
	}
	return nil
}

func (windowsCredentials) load(base string, id int64) (string, error) {
	var credential *winCredential
	ok, _, err := credRead.Call(uintptr(unsafe.Pointer(credentialTarget(base, id))), genericCredential, 0, uintptr(unsafe.Pointer(&credential)))
	if ok == 0 {
		if err == credentialNotFound {
			return "", nil
		}
		return "", fmt.Errorf("Windows 凭据读取失败（%v）", err)
	}
	defer credFree.Call(uintptr(unsafe.Pointer(credential)))
	if credential == nil || credential.blob == nil || credential.size == 0 || credential.size > 2560 {
		return "", errors.New("Windows 凭据内容无效")
	}
	blob := unsafe.Slice(credential.blob, int(credential.size))
	token := string(blob)
	clear(blob)
	if !validSessionToken(token) {
		return "", errors.New("Windows 凭据内容无效")
	}
	return token, nil
}

func (windowsCredentials) remove(base string, id int64) error {
	ok, _, err := credDelete.Call(uintptr(unsafe.Pointer(credentialTarget(base, id))), genericCredential, 0)
	if ok == 0 && err != credentialNotFound {
		return fmt.Errorf("Windows 凭据删除失败（%v）", err)
	}
	return nil
}
