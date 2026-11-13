package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image/png"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"
)

type cloudBinding struct {
	Bound   bool
	Valid   *bool
	Profile struct {
		Nickname string
		UID      driveNumber
	}
	LastSyncCount int
}

type cloudBindingPanel struct {
	visible, loaded, confirm bool
	state                    cloudBinding
	phone, country, captcha  string
	qr                       ui.ImageSource
	qrNotice                 string
	cancelQR                 context.CancelFunc
}

func (s *cloudLibrary) loadBinding() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudBinding, error) {
		var result cloudBinding
		err := api.call(ctx, http.MethodGet, "/ncmbind/session", true, nil, &result)
		return result, err
	}, func(result cloudBinding) {
		if s.drive.uid > 0 && (!result.Bound || s.drive.uid != result.Profile.UID) {
			s.drive = cloudDriveState{}
		}
		s.binding.state, s.binding.loaded = result, true
	})
}

func decodeBindingQR(raw string) (ui.ImageSource, error) {
	encoded, ok := strings.CutPrefix(raw, "data:image/png;base64,")
	if !ok || len(encoded) > 512<<10 {
		return nil, errors.New("服务器返回了无效的二维码")
	}
	pixels, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("二维码解码失败")
	}
	config, err := png.DecodeConfig(bytes.NewReader(pixels))
	if err != nil || config.Width <= 0 || config.Height <= 0 || config.Width > 1024 || config.Height > 1024 {
		return nil, errors.New("二维码尺寸无效")
	}
	return ui.DecodeBitmap(pixels)
}

func (s *cloudLibrary) startBindingQR() {
	s.stopBindingQR()
	type qrTicket struct {
		key     string
		picture ui.ImageSource
	}
	requestCloud(s, func(ctx context.Context, api cloudAPI) (qrTicket, error) {
		var ticket struct{ Key string }
		if err := api.call(ctx, http.MethodPost, "/ncmbind/qr/key", true, struct{}{}, &ticket); err != nil {
			return qrTicket{}, err
		}
		if ticket.Key == "" || len(ticket.Key) > 512 {
			return qrTicket{}, errors.New("服务器未签发扫码凭据")
		}
		var image struct{ QRImg string }
		if err := api.call(ctx, http.MethodGet, "/ncmbind/qr/img?key="+url.QueryEscape(ticket.Key), true, nil, &image); err != nil {
			return qrTicket{}, err
		}
		picture, err := decodeBindingQR(image.QRImg)
		return qrTicket{ticket.Key, picture}, err
	}, func(ticket qrTicket) {
		s.binding.qr, s.binding.qrNotice = ticket.picture, "等待网易云扫码"
		s.pollBindingQR(ticket.key)
	})
}

func (s *cloudLibrary) stopBindingQR() {
	if s.binding.cancelQR != nil {
		s.binding.cancelQR()
	}
	s.binding.cancelQR, s.binding.qr, s.binding.qrNotice = nil, nil, ""
}

func (s *cloudLibrary) pollBindingQR(key string) {
	pollCtx, cancel := context.WithCancel(s.scope)
	s.binding.cancelQR = cancel
	api, dispatch := s.api, s.dispatch
	go func() {
		ticker := time.NewTicker(2500 * time.Millisecond)
		defer ticker.Stop()
		expiry := time.NewTimer(3 * time.Minute)
		defer expiry.Stop()
		for {
			select {
			case <-pollCtx.Done():
				return
			case <-expiry.C:
				dispatch(func() {
					if pollCtx.Err() == nil {
						s.stopBindingQR()
						s.binding.qrNotice = "二维码已过期，请重新生成"
					}
				})
				return
			case <-ticker.C:
				var result struct{ Code int }
				callCtx, finish := context.WithTimeout(pollCtx, 8*time.Second)
				err := api.call(callCtx, http.MethodGet, "/ncmbind/qr/check?key="+url.QueryEscape(key), true, nil, &result)
				finish()
				dispatch(func() {
					if pollCtx.Err() != nil {
						return
					}
					switch {
					case err != nil:
						s.binding.qrNotice = "扫码状态暂不可用，正在重试"
					case result.Code == 801:
						s.binding.qrNotice = "等待网易云扫码"
					case result.Code == 802:
						s.binding.qrNotice = "请在手机上确认"
					case result.Code == 803:
						s.stopBindingQR()
						s.drive = cloudDriveState{}
						s.binding.qrNotice = "已完成网易云绑定"
						s.loadBinding()
					default:
						s.stopBindingQR()
						s.binding.qrNotice = "二维码已失效，请重新生成"
					}
				})
				if err == nil && result.Code != 801 && result.Code != 802 {
					return
				}
			}
		}
	}()
}

func (s *cloudLibrary) sendBindingPhoneCode(bind bool) {
	p := &s.binding
	body := map[string]string{"phone": strings.TrimSpace(p.phone), "ctcode": strings.TrimSpace(p.country)}
	if bind {
		s.stopBindingQR()
		body["captcha"], p.captcha = strings.TrimSpace(p.captcha), ""
		s.bindingWrite(http.MethodPost, "/ncmbind/phone/login", body, "已完成网易云绑定", s.loadBinding)
		return
	}
	s.bindingWrite(http.MethodPost, "/ncmbind/phone/code", body, "网易云验证码已发送", nil)
}

func (s *cloudLibrary) bindingWrite(method, endpoint string, body any, notice string, done func()) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		err := api.call(ctx, method, endpoint, true, body, nil)
		return struct{}{}, api.bindingError(ctx, err)
	}, func(struct{}) {
		if endpoint == "/ncmbind/phone/login" || endpoint == "/ncmbind" && method == http.MethodDelete {
			s.drive = cloudDriveState{}
		}
		if done != nil {
			done()
		}
		s.notice = notice
	})
}

func (a cloudAPI) bindingError(ctx context.Context, err error) error {
	var status cloudAPIError
	if !errors.As(err, &status) || status.status != http.StatusUnauthorized {
		return err
	}
	if current := a.call(ctx, http.MethodGet, "/auth/me", true, nil, nil); current != nil {
		return current
	}
	return errors.New("网易云会话已失效，请重新绑定")
}

func (s *cloudLibrary) toggleNcmLike(song cloudSong) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (bool, error) {
		var list struct{ IDs []int64 }
		if err := api.call(ctx, http.MethodGet, "/ncmbind/likelist", true, nil, &list); err != nil {
			return false, api.bindingError(ctx, err)
		}
		var result struct{ Liked bool }
		body := struct {
			cloudSong
			Like bool `json:"like"`
		}{song, !slices.Contains(list.IDs, song.ID)}
		err := api.call(ctx, http.MethodPost, "/ncmbind/like/"+strconv.FormatInt(song.ID, 10), true, body, &result)
		return result.Liked, api.bindingError(ctx, err)
	}, func(liked bool) {
		s.refreshAccountLibrary()
		s.notice = "已添加网易云红心"
		if !liked {
			s.notice = "已取消网易云红心"
		}
	})
}
