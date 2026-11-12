package main

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/egoist/mygo/ui"
)

func (a *prototype) cloudBindingSettings(c *ui.Context) {
	s, p := a.cloud, &a.cloud.binding
	settingsSection(c, "网易云音乐", "", accountIcon, func() {
		if !p.visible {
			if labelButton(c, "管理网易云绑定", 128, false).Disabled(s.busy).Clicked() {
				p.visible = true
				s.loadBinding()
			}
			return
		}
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "刷新状态", 92, false).Disabled(s.busy).Clicked() {
				s.loadBinding()
			}
			if labelButton(c, "关闭绑定管理", 112, false).Disabled(s.busy).Clicked() {
				s.stopBindingQR()
				s.binding = cloudBindingPanel{}
			}
		})
		if !p.visible {
			return
		}
		if p.loaded {
			binding := p.state
			switch {
			case !binding.Bound:
				ui.Text(c, "尚未绑定网易云账号").Wrap()
			case binding.Valid == nil:
				ui.Text(c, "已绑定 · 上游状态暂不可用").Wrap()
			case *binding.Valid:
				ui.Text(c, "已绑定 · "+binding.Profile.Nickname).Wrap()
			default:
				ui.Text(c, "网易云会话已失效，请续期或重新绑定").Wrap()
			}
			if binding.Bound {
				ui.Row(c).Gap(6).Children(func() {
					if labelButton(c, "同步歌单", 92, false).Disabled(s.busy || p.qr != nil).Clicked() {
						s.bindingWrite(http.MethodPost, "/ncmbind/sync", struct{}{}, "网易云歌单同步已完成", s.refreshAccountLibrary)
					}
					if labelButton(c, "续期会话", 92, false).Disabled(s.busy || p.qr != nil).Clicked() {
						s.bindingWrite(http.MethodPost, "/ncmbind/refresh", struct{}{}, "已请求续期", s.loadBinding)
					}
					if labelButton(c, "解绑", 62, false).Disabled(s.busy || p.qr != nil).Clicked() {
						p.confirm = true
					}
				})
				if p.confirm {
					ui.Text(c, "解除当前网易云账号绑定？已同步的歌单保留为快照。").Wrap()
					ui.Row(c).Gap(6).Children(func() {
						if labelButton(c, "确认解绑", 92, true).Disabled(s.busy).Clicked() {
							p.confirm = false
							s.bindingWrite(http.MethodDelete, "/ncmbind", nil, "已解除网易云绑定", s.loadBinding)
						}
						if labelButton(c, "取消", 62, false).Clicked() {
							p.confirm = false
						}
					})
				}
			}
		}
		if p.qr != nil {
			ui.Image(c, p.qr).Size(184, 184).Label("网易云登录二维码")
			if labelButton(c, "取消扫码", 92, false).Clicked() {
				s.stopBindingQR()
			}
		} else if labelButton(c, "生成绑定二维码", 130, true).Disabled(s.busy).Clicked() {
			s.startBindingQR()
		}
		if p.qrNotice != "" {
			ui.Text(c, p.qrNotice).Wrap()
		}
		settingsInput(c.Key("country"), &p.country, "国际区号", "默认 +86")
		settingsInput(c.Key("phone"), &p.phone, "网易云手机号", "网易云手机号")
		settingsInput(c.Key("captcha"), &p.captcha, "网易云验证码", "验证码").Password()
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "发送网易云验证码", 142, false).Disabled(s.busy || strings.TrimSpace(p.phone) == "").Clicked() {
				s.sendBindingPhoneCode(false)
			}
			if labelButton(c, "绑定手机号", 104, false).Disabled(s.busy || strings.TrimSpace(p.phone) == "" || strings.TrimSpace(p.captcha) == "").Clicked() {
				s.sendBindingPhoneCode(true)
			}
		})
	})
}

func (a *prototype) cloudAccountPicker(c *ui.Context) {
	s := a.cloud
	accounts := s.prefs.KnownAccounts[s.api.base]
	if s.user.ID == 0 && len(accounts) == 0 {
		return
	}
	labelButton(c, "切换账号", 92, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
		for _, account := range accounts {
			name := account.Username
			if name == "" {
				name = fmt.Sprintf("账号 %d", account.ID)
			}
			if m.Item(name).Disabled(account.ID == s.user.ID).Chosen() {
				s.switchAccount(account.ID)
			}
		}
		if s.user.ID > 0 && m.Item("添加另一个账号").Chosen() {
			s.switchAccount(0)
		}
	})
}

func (a *prototype) cloudGuestAccount(c *ui.Context) {
	s, p := a.cloud, &a.cloud.account
	register := p.mode == "register"
	if labelButton(c, "返回登录", 92, false).Disabled(s.busy).Clicked() {
		s.account = cloudAccountPanel{}
		return
	}
	if register {
		heading(c, "注册账号", 17)
		settingsInput(c.Key("username"), &p.username, "用户名", "用户名")
		settingsInput(c.Key("password"), &p.password, "密码", "6 至 64 位").Password()
		if ui.Checkbox(c.Key("phone"), &p.phone, "使用短信注册").Disabled(s.busy).Changed() {
			p.contact, p.code = "", ""
		}
	} else {
		heading(c, "找回密码", 17)
	}
	label := "邮箱"
	if register && p.phone {
		label = "手机号"
	}
	settingsInput(c.Key("contact"), &p.contact, label, label)
	a.cloudAccountCode(c.Key("code"), strings.TrimSpace(p.contact) == "")
	if register {
		ui.Checkbox(c.Key("consent"), &p.consent, "我同意 CurrentMusic 用户协议和隐私政策")
		if labelButton(c, "创建账号", 96, true).Disabled(s.busy || !p.consent || p.username == "" || p.password == "" || p.code == "" || p.contact == "").Clicked() {
			s.registerAccount()
		}
	} else {
		settingsInput(c.Key("new-password"), &p.nextPassword, "新密码", "新密码").Password()
		if labelButton(c, "重置密码", 96, true).Disabled(s.busy || p.nextPassword == "" || p.code == "" || p.contact == "").Clicked() {
			s.saveAccountForm()
		}
	}
}

func (a *prototype) cloudAccountCode(c *ui.Context, unavailable bool) {
	s := a.cloud
	ui.Row(c).Gap(6).Children(func() {
		settingsInput(c.Key("input"), &s.account.code, "验证码", "验证码").Password().Grow(1)
		if labelButton(c.Key("send"), "发送验证码", 106, false).Disabled(s.busy || unavailable).Clicked() {
			s.accountCode()
		}
	})
}

func (a *prototype) cloudAccountSettings(c *ui.Context) {
	s := a.cloud
	ui.Text(c, s.user.Username).Wrap()
	ui.Row(c).Gap(6).Children(func() {
		a.cloudAccountPicker(c.Key("accounts"))
		labelButton(c, "账号管理", 92, false).Disabled(s.busy).Menu(func(m *ui.Menu) {
			for _, entry := range []struct{ key, label string }{
				{"profile", "编辑资料"}, {"password", "修改密码"}, {"email", "绑定邮箱"},
				{"devices", "登录设备"}, {"factors", "两步验证与密保"}, {"grants", "授权管理"}, {"passkeys", "通行密钥"},
			} {
				if !m.Item(entry.label).Chosen() {
					continue
				}
				s.account = cloudAccountPanel{mode: entry.key}
				switch entry.key {
				case "profile":
					s.account.username, s.account.contact = s.user.Nickname, s.user.Bio
				case "devices":
					s.loadDevices()
				case "factors":
					s.loadFactors()
				case "grants":
					s.loadGrants()
				case "passkeys":
					s.loadPasskeys()
				}
			}
		})
		if labelButton(c, "退出登录", 92, false).Disabled(s.busy).Clicked() {
			s.logout()
		}
	})
	p := &s.account
	if p.mode == "" {
		return
	}
	if labelButton(c, "关闭管理", 92, false).Disabled(s.busy).Clicked() {
		s.account = cloudAccountPanel{}
		return
	}
	switch p.mode {
	case "profile":
		heading(c, "编辑资料", 17)
		settingsInput(c.Key("nickname"), &p.username, "昵称", "昵称")
		settingsInput(c.Key("bio"), &p.contact, "签名", "个人签名")
		if labelButton(c, "保存资料", 92, true).Disabled(s.busy || strings.TrimSpace(p.username) == "").Clicked() {
			s.saveAccountForm()
		}
	case "password":
		heading(c, "修改密码", 17)
		if ui.Checkbox(c.Key("email-mode"), &p.emailChange, "使用绑定邮箱验证").Disabled(s.busy).Changed() {
			p.password, p.code = "", ""
		}
		if p.emailChange {
			a.cloudAccountCode(c.Key("code"), false)
		} else {
			settingsInput(c.Key("old-password"), &p.password, "当前密码", "当前密码").Password()
		}
		settingsInput(c.Key("new-password"), &p.nextPassword, "新密码", "新密码").Password()
		missing := p.nextPassword == "" || p.emailChange && p.code == "" || !p.emailChange && p.password == ""
		if labelButton(c, "修改密码", 92, true).Disabled(s.busy || missing).Clicked() {
			s.saveAccountForm()
		}
	case "email":
		heading(c, "绑定邮箱", 17)
		settingsInput(c.Key("new-email"), &p.contact, "邮箱", "新的邮箱地址")
		a.cloudAccountCode(c.Key("code"), strings.TrimSpace(p.contact) == "")
		if labelButton(c, "绑定邮箱", 92, true).Disabled(s.busy || p.contact == "" || p.code == "").Clicked() {
			s.saveAccountForm()
		}
	case "devices":
		a.cloudDeviceSettings(c.Key("devices"))
	case "factors":
		a.cloudFactorSettings(c.Key("factors"))
	case "grants":
		a.cloudGrantSettings(c.Key("grants"))
	case "passkeys":
		a.cloudPasskeySettings(c.Key("passkeys"))
	}
}

func (a *prototype) cloudDeviceSettings(c *ui.Context) {
	s, p := a.cloud, &a.cloud.account
	heading(c, "登录设备", 17)
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "刷新设备", 92, false).Disabled(s.busy).Clicked() {
			s.loadDevices()
		}
		if len(p.sessions) > 1 && labelButton(c, "退出其他设备", 112, false).Disabled(s.busy).Clicked() {
			p.confirm = "others"
		}
	})
	for _, device := range p.sessions {
		ui.Row(c.Key(device.ID)).Gap(6).AlignItems(ui.Center).Children(func() {
			name := device.Device + " · " + device.Platform
			if device.Current {
				name += " · 当前设备"
			}
			ui.Text(c, name).Wrap().Grow(1)
			if !device.Current && labelButton(c, "撤销", 62, false).Disabled(s.busy).Clicked() {
				p.confirm = device.ID
			}
		})
	}
	if p.confirm != "" {
		a.cloudAccountConfirm(c.Key("confirm"), "撤销所选设备的登录会话？", func() { s.revokeDevice(p.confirm) })
	}
}

func (a *prototype) cloudFactorSettings(c *ui.Context) {
	s, p := a.cloud, &a.cloud.account
	heading(c, "两步验证", 17)
	if p.factors.Enabled {
		ui.Text(c, fmt.Sprintf("已开启 · 剩余 %d 个恢复码", p.factors.RecoveryCodesRemaining)).Wrap()
	}
	if len(p.recoveryCodes) > 0 {
		ui.Text(c, "请妥善保存恢复码 · "+strings.Join(p.recoveryCodes, "  ")).Wrap()
		if labelButton(c, "已保存恢复码", 110, false).Clicked() {
			p.recoveryCodes = nil
		}
	}
	settingsInput(c.Key("password"), &p.password, "当前密码", "当前密码").Password()
	if p.factors.Enabled || p.totpSecret != "" {
		if p.totpSecret != "" {
			ui.Text(c, "在验证器中手动添加密钥 · "+p.totpSecret).Wrap()
		}
		settingsInput(c.Key("factor-code"), &p.code, "验证器代码", "验证器代码").Password()
		label, action := "开启两步验证", "enable"
		if p.factors.Enabled {
			label, action = "关闭两步验证", "disable"
		}
		if labelButton(c, label, 110, false).Disabled(s.busy || p.code == "" || p.factors.Enabled && p.password == "").Clicked() {
			s.updateFactor(action)
		}
	} else if labelButton(c, "设置验证器", 104, false).Disabled(s.busy || p.password == "" || p.factors.SecurityQuestionEnabled).Clicked() {
		s.updateFactor("prepare")
	}
	heading(c, "登录密保", 17)
	if p.factors.SecurityQuestionEnabled {
		ui.Text(c, p.factors.SecurityQuestion).Wrap()
	} else {
		settingsInput(c.Key("question"), &p.question, "密保问题", "密保问题")
	}
	settingsInput(c.Key("answer"), &p.answer, "密保答案", "密保答案").Password()
	label, action := "启用密保", "question-enable"
	if p.factors.SecurityQuestionEnabled {
		label, action = "关闭密保", "question-disable"
	}
	if labelButton(c, label, 92, false).Disabled(s.busy || p.factors.Enabled || p.password == "" || p.answer == "" || !p.factors.SecurityQuestionEnabled && p.question == "").Clicked() {
		s.updateFactor(action)
	}
	if labelButton(c, "刷新安全状态", 112, false).Disabled(s.busy).Clicked() {
		s.loadFactors()
	}
}

func (a *prototype) cloudGrantSettings(c *ui.Context) {
	s, p := a.cloud, &a.cloud.account
	heading(c, "授权管理", 17)
	if s.user.PassportUID != "" {
		ui.Text(c, "通行证 ID · "+s.user.PassportUID).Wrap()
	}
	if labelButton(c, "刷新授权", 92, false).Disabled(s.busy).Clicked() {
		s.loadGrants()
	}
	for _, grant := range p.grants {
		ui.Row(c.Key(grant.ID)).Gap(6).AlignItems(ui.Center).Children(func() {
			names := make([]string, 0, len(grant.Scopes))
			for _, scope := range grant.Scopes {
				names = append(names, scope.Label)
			}
			ui.Text(c, grant.App+" · "+strings.Join(names, "、")).Wrap().Grow(1)
			if labelButton(c, "撤销", 62, false).Disabled(s.busy).Clicked() {
				p.confirm = grant.ID
			}
		})
	}
	if p.confirm != "" {
		a.cloudAccountConfirm(c.Key("confirm"), "撤销所选应用的授权？", func() { s.revokeGrant(p.confirm) })
	}
}

func (a *prototype) cloudAccountConfirm(c *ui.Context, message string, confirm func()) {
	s := a.cloud
	ui.Text(c, message).Wrap()
	ui.Row(c).Gap(6).Children(func() {
		if labelButton(c, "确认", 66, true).Disabled(s.busy).Clicked() {
			confirm()
		}
		if labelButton(c, "取消", 66, false).Clicked() {
			s.account.confirm = ""
		}
	})
}

func (a *prototype) cloudPasskeySettings(c *ui.Context) {
	s, p := a.cloud, &a.cloud.account
	heading(c, "通行密钥", 17)
	if labelButton(c, "刷新密钥", 92, false).Disabled(s.busy).Clicked() {
		s.loadPasskeys()
	}
	for _, key := range p.passkeys {
		ui.Row(c.Key(key.ID)).Gap(6).AlignItems(ui.Center).Children(func() {
			ui.Text(c, key.Name+" · "+key.RP).Wrap().Grow(1)
			if labelButton(c, "撤销", 62, false).Disabled(s.busy).Clicked() {
				p.confirm = key.ID
			}
		})
	}
	if p.confirm != "" || s.openBrowser != nil {
		settingsInput(c.Key("password"), &p.password, "当前密码", "当前密码").Password()
		settingsInput(c.Key("factor"), &p.code, "当前二次验证", "如已启用两步验证或密保").Password()
	}
	if p.confirm != "" {
		ui.Row(c).Gap(6).Children(func() {
			if labelButton(c, "确认撤销", 92, true).Disabled(s.busy || p.password == "").Clicked() {
				s.deletePasskey()
			}
			if labelButton(c, "取消", 62, false).Clicked() {
				p.confirm, p.password, p.code = "", "", ""
			}
		})
	} else if s.openBrowser != nil && labelButton(c, "绑定新密钥", 104, true).Disabled(s.busy || p.password == "").Clicked() {
		s.enrollPasskey()
	}
}
