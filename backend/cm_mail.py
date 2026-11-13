"""邮件发送（QQ 邮箱 SMTP SSL，python 标准库 smtplib）。

凭据经环境变量 CM_SMTP_USER / CM_SMTP_PASS 注入（systemd unit），
仓库内不落任何密钥。
"""
import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

log = logging.getLogger("cm")

SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465


def _cfg():
    user = os.environ.get("CM_SMTP_USER", "")
    pwd = os.environ.get("CM_SMTP_PASS", "")
    if not user or not pwd:
        return None, None
    return user, pwd


def smtp_ready():
    u, p = _cfg()
    return bool(u and p)


def send_code_email(to_email, code, ttl_min=5, purpose="注册"):
    user, pwd = _cfg()
    if not user or not pwd:
        raise RuntimeError("SMTP 未配置")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"CurrentMusic {purpose}验证码：{code}"
    msg["From"] = formataddr(("CurrentMusic Engine  流声引擎", user), charset="utf-8")
    msg["To"] = to_email
    text = f"你的 CurrentMusic {purpose}验证码是：{code}\n{ttl_min} 分钟内有效。若非本人操作请忽略本邮件。"
    html = f"""\
<div style="max-width:420px;margin:0 auto;padding:28px 24px;font-family:system-ui,'PingFang SC',sans-serif;
 color:#1d1b20;background:#f7f2fa;border-radius:16px">
  <div style="font-size:18px;font-weight:700;margin-bottom:4px">CurrentMusic</div>
  <div style="font-size:13px;color:#49454f;margin-bottom:20px">{purpose}邮箱验证</div>
  <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;margin-bottom:16px">
    <div style="font-size:13px;color:#49454f;margin-bottom:10px">你的{purpose}验证码是</div>
    <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#6750a4">{code}</div>
    <div style="font-size:12px;color:#79747e;margin-top:12px">{ttl_min} 分钟内有效 · 请勿泄露给他人</div>
  </div>
  <div style="font-size:11px;color:#79747e;line-height:1.7">若非本人操作，请忽略本邮件，你的账号不会受影响。</div>
</div>"""
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.login(user, pwd)
        s.sendmail(user, [to_email], msg.as_string())
    log.info("验证码邮件已发送 to=%s", to_email)
