package main

import (
	"context"
	"net/http"
	"slices"
	"strings"
)

type cloudAccountPanel struct {
	mode                              string
	username, contact, password, code string
	nextPassword, question, answer    string
	phone, consent, emailChange       bool
	confirm                           string
	sessions                          []cloudDevice
	factors                           cloudFactors
	totpSecret                        string
	recoveryCodes                     []string
	grants                            []cloudGrant
	passkeys                          []cloudPasskey
}

type cloudDevice struct {
	ID, Device, Platform string
	Current              bool
}

type cloudFactors struct {
	Enabled                 bool
	SecurityQuestionEnabled bool
	SecurityQuestion        string
	RecoveryCodesRemaining  int
}

type cloudGrant struct {
	ID, App string
	Scopes  []struct{ Scope, Label string }
}

func (s *cloudLibrary) rememberAccount(user cloudUser) bool {
	user = cloudUser{ID: user.ID, Username: user.Username, Nickname: user.Nickname}
	base := s.api.base
	accounts := s.prefs.KnownAccounts[base]
	for i, account := range accounts {
		if account.ID == user.ID {
			if account == user {
				return false
			}
			accounts[i] = user
			return true
		}
	}
	s.prefs.KnownAccounts[base] = append(accounts, user)
	return true
}

func (s *cloudLibrary) loadGrants() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudGrant, error) {
		var result struct{ Grants []cloudGrant }
		err := api.call(ctx, http.MethodGet, "/passport/grants", true, nil, &result)
		return result.Grants, err
	}, func(grants []cloudGrant) { s.account.grants = grants })
}

func (s *cloudLibrary) revokeGrant(id string) {
	if len(id) < 4 || len(id) > 64 || strings.Trim(id, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") != "" {
		s.notice = "无效的授权标识"
		return
	}
	s.account.confirm = ""
	s.accountWrite(http.MethodDelete, "/passport/grants/"+id, true, nil, "授权已撤销", s.loadGrants)
}

func (s *cloudLibrary) forgetAccount(base string, id int64) {
	s.prefs.KnownAccounts[base] = slices.DeleteFunc(s.prefs.KnownAccounts[base], func(user cloudUser) bool {
		return user.ID == id
	})
}

func (s *cloudLibrary) switchAccount(id int64) {
	base := s.api.base
	if s.busy || id != 0 && id == s.user.ID {
		return
	}
	if id > 0 && !slices.ContainsFunc(s.prefs.KnownAccounts[base], func(user cloudUser) bool { return user.ID == id }) {
		return
	}
	if s.stopPlayback != nil && !s.stopPlayback() {
		s.notice = "媒体组件正忙，请重试切换账号"
		return
	}
	s.reset(base)
	if id > 0 {
		s.prefs.Accounts[base] = id
		saveErr := s.savePrefs()
		s.restore()
		if saveErr != nil {
			s.addNotice(saveErr.Error())
		}
	}
}

func (s *cloudLibrary) accountCode() {
	panel := s.account
	endpoint := "/auth/email/code"
	authenticated := s.user.ID > 0
	body := map[string]string{"email": strings.ToLower(strings.TrimSpace(panel.contact))}
	switch panel.mode {
	case "register":
		if panel.phone {
			endpoint = "/auth/phone/code"
			body = map[string]string{"phone": strings.TrimSpace(panel.contact)}
		}
	case "recover":
		endpoint = "/auth/password/code"
	case "password":
		endpoint, body = "/profile/password/code", map[string]string{}
	case "email":
		endpoint = "/profile/email/code"
	}
	s.accountWrite(http.MethodPost, endpoint, authenticated, body, "验证码请求已提交，请检查收件箱或短信", nil)
}

func (s *cloudLibrary) registerAccount() {
	p := s.account
	body := map[string]string{
		"username": strings.TrimSpace(p.username), "password": p.password,
		"platform": "windows", "device": "CurrentMusic Windows",
	}
	if p.phone {
		body["phone"], body["phoneCode"] = strings.TrimSpace(p.contact), strings.TrimSpace(p.code)
	} else {
		body["email"], body["emailCode"] = strings.ToLower(strings.TrimSpace(p.contact)), strings.TrimSpace(p.code)
	}
	s.account.password, s.account.code = "", ""
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudLogin, error) {
		return api.loginRequest(ctx, "/auth/register", body)
	}, s.finishLogin)
}

func (s *cloudLibrary) saveAccountForm() {
	p := s.account
	s.account.password, s.account.nextPassword, s.account.code = "", "", ""
	email, code := strings.ToLower(strings.TrimSpace(p.contact)), strings.TrimSpace(p.code)
	switch p.mode {
	case "recover":
		body := map[string]string{"email": email, "code": code, "newPassword": p.nextPassword}
		s.accountWrite(http.MethodPost, "/auth/password/reset", false, body, "密码已重置，请重新登录", func() {
			s.account = cloudAccountPanel{}
		})
	case "password":
		body := map[string]string{"newPassword": p.nextPassword}
		if p.emailChange {
			body["emailCode"] = code
		} else {
			body["oldPassword"] = p.password
		}
		s.accountWrite(http.MethodPut, "/profile/password", true, body, "密码已更新", nil)
	case "email":
		body := map[string]string{"email": email, "code": code}
		s.accountWrite(http.MethodPut, "/profile/email", true, body, "邮箱已绑定", nil)
	case "profile":
		body := map[string]string{"nickname": strings.TrimSpace(p.username), "bio": p.contact}
		requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudUser, error) {
			var user cloudUser
			if err := api.call(ctx, http.MethodPut, "/profile", true, body, nil); err != nil {
				return user, err
			}
			err := api.call(ctx, http.MethodGet, "/auth/me", true, nil, &user)
			return user, err
		}, func(user cloudUser) {
			s.user = user
			s.rememberAccount(user)
			s.notice = "资料已保存"
			if err := s.savePrefs(); err != nil {
				s.addNotice(err.Error())
			}
		})
	}
}

func (s *cloudLibrary) accountWrite(method, endpoint string, auth bool, body any, notice string, done func()) {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (struct{}, error) {
		return struct{}{}, api.call(ctx, method, endpoint, auth, body, nil)
	}, func(struct{}) {
		if done != nil {
			done()
		}
		s.notice = notice
	})
}

func (s *cloudLibrary) loadDevices() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) ([]cloudDevice, error) {
		var result struct{ Sessions []cloudDevice }
		err := api.call(ctx, http.MethodGet, "/auth/sessions", true, nil, &result)
		return result.Sessions, err
	}, func(devices []cloudDevice) { s.account.sessions = devices })
}

func (s *cloudLibrary) revokeDevice(id string) {
	if id != "others" {
		if len(id) < 8 || len(id) > 64 || strings.Trim(id, "0123456789abcdef") != "" {
			s.notice = "无效的会话标识"
			return
		}
	}
	s.account.confirm = ""
	s.accountWrite(http.MethodDelete, "/auth/sessions/"+id, true, nil, "会话已撤销", s.loadDevices)
}

func (s *cloudLibrary) loadFactors() {
	requestCloud(s, func(ctx context.Context, api cloudAPI) (cloudFactors, error) {
		var result cloudFactors
		err := api.call(ctx, http.MethodGet, "/auth/2fa/status", true, nil, &result)
		return result, err
	}, func(result cloudFactors) { s.account.factors = result })
}

func (s *cloudLibrary) updateFactor(action string) {
	p := s.account
	s.account.password, s.account.answer, s.account.code = "", "", ""
	switch action {
	case "prepare":
		requestCloud(s, func(ctx context.Context, api cloudAPI) (string, error) {
			var result struct{ Secret string }
			err := api.call(ctx, http.MethodPost, "/auth/2fa/setup", true, map[string]string{"password": p.password}, &result)
			return result.Secret, err
		}, func(secret string) { s.account.totpSecret = secret })
	case "enable":
		requestCloud(s, func(ctx context.Context, api cloudAPI) ([]string, error) {
			var result struct{ RecoveryCodes []string }
			err := api.call(ctx, http.MethodPost, "/auth/2fa/enable", true, map[string]string{"code": strings.TrimSpace(p.code)}, &result)
			return result.RecoveryCodes, err
		}, func(codes []string) {
			s.account.totpSecret, s.account.recoveryCodes = "", codes
			s.loadFactors()
		})
	case "disable":
		body := map[string]string{"password": p.password, "code": strings.TrimSpace(p.code)}
		s.accountWrite(http.MethodPost, "/auth/2fa/disable", true, body, "两步验证已关闭", s.loadFactors)
	case "question-enable":
		body := map[string]string{"password": p.password, "question": p.question, "answer": p.answer}
		s.accountWrite(http.MethodPost, "/auth/security-question", true, body, "密保已启用", s.loadFactors)
	case "question-disable":
		body := map[string]string{"password": p.password, "answer": p.answer}
		s.accountWrite(http.MethodDelete, "/auth/security-question", true, body, "密保已关闭", s.loadFactors)
	}
}
