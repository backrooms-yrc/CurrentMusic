package main

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const driveLegacyLimit = 1400 * 1024

var driveAudioTypes = map[string]string{
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
	".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".ape": "audio/ape",
}

var driveStorageHTTP = &http.Client{Timeout: 10 * time.Minute}

type driveUploadTicket struct {
	SongID, ResourceID driveNumber
	MD5, Filename      string
}

type driveUploadResult struct {
	pending *driveUploadTicket
	err     error
	done    bool
}

type driveContextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r driveContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func (a cloudAPI) uploadDriveFile(ctx context.Context, uid driveNumber, path string, legacy bool, storage *http.Client) (driveUploadResult, error) {
	if _, err := a.driveOwner(ctx, uid); err != nil {
		return driveUploadResult{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return driveUploadResult{}, errors.New("无法打开所选音频文件")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		return driveUploadResult{}, errors.New("请选择非空音频文件")
	}
	name := info.Name()
	ext := strings.ToLower(filepath.Ext(name))
	mime := driveAudioTypes[ext]
	if mime == "" {
		return driveUploadResult{}, errors.New("此音频格式不支持上传")
	}
	reader := driveContextReader{ctx, file}
	if legacy {
		return a.uploadDriveLegacy(ctx, uid, reader, name, ext, mime, info.Size())
	}

	digest := md5.New()
	if size, err := io.Copy(digest, reader); err != nil || size != info.Size() {
		return driveUploadResult{}, errors.New("无法读取完整音频文件")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return driveUploadResult{}, errors.New("无法重新读取音频文件")
	}
	checksum := hex.EncodeToString(digest.Sum(nil))
	var response struct {
		Data struct {
			SongID                 *driveNumber
			ResourceID             driveNumber
			NeedUpload             *bool
			UploadToken, UploadURL string
		}
	}
	query := url.Values{
		"md5": {checksum}, "fileSize": {strconv.FormatInt(info.Size(), 10)}, "filename": {name},
		"bitrate": {"999000"}, "confirm": {"1"},
	}
	if _, err := a.driveOwner(ctx, uid); err != nil {
		return driveUploadResult{}, err
	}
	if err := a.driveCall(ctx, http.MethodPost, "/cloud/upload/token", query, struct{}{}, &response); err != nil {
		return driveUploadResult{}, err
	}
	data := response.Data
	if data.SongID == nil || data.ResourceID <= 0 {
		return driveUploadResult{}, errors.New("网易云未返回有效的入库资料")
	}
	if data.NeedUpload == nil || *data.NeedUpload {
		if err := storeDriveAudio(ctx, storage, data.UploadURL, data.UploadToken, mime, checksum, reader, info.Size()); err != nil {
			return driveUploadResult{}, err
		}
	}
	ticket := driveUploadTicket{*data.SongID, data.ResourceID, checksum, name}
	return a.finishDriveUpload(ctx, uid, ticket), nil
}

func storeDriveAudio(ctx context.Context, storage *http.Client, rawURL, token, mime, checksum string, reader io.Reader, size int64) error {
	// The NetEase locator currently advertises HTTP for this host, which also serves HTTPS.
	if parsed, err := url.Parse(rawURL); err == nil && parsed.Scheme == "http" && parsed.Host == "nosup-jd1.127.net" && parsed.User == nil {
		parsed.Scheme = "https"
		rawURL = parsed.String()
	}
	address, err := validateSource(rawURL)
	if err != nil || token == "" {
		return errors.New("网易云未返回有效的 HTTPS 上传地址，可尝试旧接口")
	}
	digest := md5.New()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address, io.TeeReader(io.LimitReader(reader, size), digest))
	if err != nil {
		return errors.New("无法构建云盘上传请求")
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", mime)
	request.Header.Set("x-nos-token", token)
	client := *storage
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return errors.New("云盘对象上传失败或已取消")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("云盘对象存储返回 HTTP %d", response.StatusCode)
	}
	if hex.EncodeToString(digest.Sum(nil)) != checksum {
		return errors.New("文件在上传期间发生变化，请重新选择")
	}
	return nil
}

func (a cloudAPI) finishDriveUpload(ctx context.Context, uid driveNumber, ticket driveUploadTicket) driveUploadResult {
	if _, err := a.driveOwner(ctx, uid); err != nil {
		return driveUploadResult{pending: &ticket, err: err}
	}
	query := url.Values{
		"songId": {ticket.SongID.String()}, "resourceId": {ticket.ResourceID.String()}, "md5": {ticket.MD5},
		"filename": {ticket.Filename}, "song": {strings.TrimSuffix(ticket.Filename, filepath.Ext(ticket.Filename))}, "confirm": {"1"},
	}
	var response struct{ Data struct{ Code int } }
	err := a.driveCall(ctx, http.MethodPost, "/cloud/upload/complete", query, struct{}{}, &response)
	if err == nil && response.Data.Code != 0 && response.Data.Code != 200 {
		err = fmt.Errorf("网易云未确认入库，业务状态 %d", response.Data.Code)
	}
	if err != nil {
		return driveUploadResult{pending: &ticket, err: err}
	}
	return driveUploadResult{done: true}
}

func (a cloudAPI) uploadDriveLegacy(ctx context.Context, uid driveNumber, reader io.Reader, name, ext, mime string, size int64) (driveUploadResult, error) {
	switch ext {
	case ".mp3", ".aac", ".m4a", ".wav":
	default:
		return driveUploadResult{}, errors.New("旧接口仅支持 MP3、AAC、M4A 和 WAV")
	}
	if size > driveLegacyLimit {
		return driveUploadResult{}, errors.New("旧接口最多接受 1400 KiB，请使用云盘上传")
	}
	data, err := io.ReadAll(io.LimitReader(reader, driveLegacyLimit+1))
	if err != nil || int64(len(data)) != size {
		return driveUploadResult{}, errors.New("无法读取完整音频文件")
	}
	if _, err := a.driveOwner(ctx, uid); err != nil {
		return driveUploadResult{}, err
	}
	query := url.Values{"songName": {strings.TrimSuffix(name, filepath.Ext(name))}, "confirm": {"1"}}
	body := struct {
		File        []byte `json:"file"`
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
	}{data, name, mime}
	err = a.driveCall(ctx, http.MethodPost, "/cloud", query, body, nil)
	return driveUploadResult{done: err == nil}, err
}

func (s *cloudLibrary) uploadDrive(legacy bool) {
	choose, uid := s.openAudioFile, s.drive.uid
	if choose == nil || uid <= 0 || s.drive.pending != nil {
		return
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (driveUploadResult, error) {
		path, err := choose(legacy)
		if path == "" || err != nil {
			return driveUploadResult{}, err
		}
		return api.uploadDriveFile(ctx, uid, path, legacy, driveStorageHTTP)
	}, s.applyDriveUpload)
}

func (s *cloudLibrary) retryDriveUpload() {
	if s.drive.pending == nil {
		return
	}
	uid, ticket := s.drive.uid, *s.drive.pending
	requestCloud(s, func(ctx context.Context, api cloudAPI) (driveUploadResult, error) {
		return api.finishDriveUpload(ctx, uid, ticket), nil
	}, s.applyDriveUpload)
}

func (s *cloudLibrary) applyDriveUpload(result driveUploadResult) {
	s.drive.pending = result.pending
	if result.err != nil {
		s.notice = "文件已上传，入库未确认。" + result.err.Error()
	}
	if result.done {
		s.loadDrive(false)
		s.notice = "已上传到音乐云盘"
	}
}

func (s *cloudLibrary) importDrive() {
	d := &s.drive
	checksum := strings.ToLower(strings.TrimSpace(d.importMD5))
	bytes, md5Err := hex.DecodeString(checksum)
	size, sizeErr := strconv.ParseInt(strings.TrimSpace(d.importSize), 10, 64)
	idText := strings.TrimSpace(d.importSongID)
	if idText == "" {
		idText = "-2"
	}
	id, idErr := strconv.ParseInt(idText, 10, 64)
	name := strings.TrimSpace(d.importName)
	if md5Err != nil || len(bytes) != md5.Size || sizeErr != nil || size <= 0 || idErr != nil || id <= 0 && id != -2 || name == "" {
		s.notice = "请输入 32 位 MD5、文件字节数、曲名，以及可选的歌曲 ID"
		return
	}
	query := url.Values{
		"md5": {checksum}, "fileSize": {strconv.FormatInt(size, 10)}, "id": {strconv.FormatInt(id, 10)},
		"bitrate": {"999000"}, "fileType": {"mp3"}, "song": {name}, "confirm": {"1"},
	}
	s.writeDrive(d.uid, "/cloud/import", query, "已提交云盘导入")
}
