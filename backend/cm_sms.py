"""手机短信验证码：发送与校验（双通道，按环境变量自动选择）。

通道 1 · 自建短信网关（推荐，文案与号码完全自控）
  环境变量（systemd drop-in，不入仓库）：
    CM_SMS_WEBHOOK  网关地址，收到 POST JSON {"phone","code","text","sign"}
    CM_SMS_TOKEN    可选，作为 Authorization: Bearer 附加
    CM_SMS_SIGN     可选，短信签名/落款，默认 CurrentMusic
  验证码由本服务生成并入库，校验时本地比对——不依赖任何第三方。

通道 2 · 网易云短信通道（零配置回退）
  上游 /captcha/sent 发码、/captcha/verify 校验；验证码由网易云生成，短信文案为
  「网易云音乐验证码」。因此：手机号需能接收网易云短信，且同一号码短时间多次
  请求会触发上游风控（503）。服务端仍按「每号码 60s 冷却 + 每日上限」限流。
"""
import json
import logging
import os
import secrets
import urllib.error
import urllib.request

import cm_ncm

log = logging.getLogger("cm")

WEBHOOK = os.environ.get("CM_SMS_WEBHOOK", "").strip()
TOKEN = os.environ.get("CM_SMS_TOKEN", "").strip()
SIGN = os.environ.get("CM_SMS_SIGN", "CurrentMusic").strip() or "CurrentMusic"

WEBHOOK_TIMEOUT = 10.0


def mode():
    """当前通道：webhook（自建网关）| ncm（网易云短信回退）。"""
    return "webhook" if WEBHOOK else "ncm"


def describe():
    """给注册页的手机验证提示语（前端直接展示）。"""
    if mode() == "webhook":
        return f"验证码短信由「{SIGN}」发出，5 分钟内有效，请勿泄露"
    return "验证码经网易云音乐短信通道发出（发送方显示为网易云音乐），请留意短信"


def send(phone, ctcode="86"):
    """发送验证码，返回 (通道, 验证码)：webhook 模式返回本服务生成的码（调用方需入库），
    ncm 模式返回空串（码由网易云生成）。失败抛 RuntimeError / cm_ncm.NcmError。"""
    if mode() == "webhook":
        code = f"{secrets.randbelow(1000000):06d}"
        text = f"【{SIGN}】验证码 {code}，5 分钟内有效，请勿泄露给他人。"
        _post_webhook({"phone": phone, "code": code, "text": text, "sign": SIGN})
        return "webhook", code
    cm_ncm.phone_send_captcha(phone, ctcode)
    return "ncm", ""


def verify(phone, code, stored_code="", m="ncm", ctcode="86"):
    """校验验证码。True=通过；False=码错误/失效；上游风控等异常抛 NcmError。"""
    if m == "webhook":
        return bool(stored_code) and secrets.compare_digest(str(code), str(stored_code))
    return cm_ncm.phone_verify_captcha(phone, code, ctcode)


def _post_webhook(payload):
    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "CurrentMusic/1.0"},
        method="POST",
    )
    if TOKEN:
        req.add_header("Authorization", f"Bearer {TOKEN}")
    try:
        with urllib.request.urlopen(req, timeout=WEBHOOK_TIMEOUT) as resp:
            if resp.status >= 300:
                raise RuntimeError(f"网关返回 {resp.status}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"短信网关返回 {e.code}")
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(f"短信网关不可达：{e}")
    log.info("验证码短信已提交网关 to=%s", _mask(payload.get("phone")))


def _mask(phone):
    s = str(phone)
    return s[:3] + "****" + s[-4:] if len(s) >= 7 else s
