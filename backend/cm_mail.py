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
from html import escape

log = logging.getLogger("cm")

SMTP_HOST = "smtp.qq.com"
SMTP_PORT = 465
ENGINE_URL = "https://music.20110208.xyz/home/engine/"


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
    title = f"{purpose}验证码"
    expires = f"{ttl_min} 分钟内有效"
    notice = "请勿向他人透露验证码。如果不是你本人发起的操作，可以忽略此邮件。"
    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"CurrentMusic {title}：{code}"
    msg["From"] = formataddr(("CurrentMusic Engine  流声引擎", user), charset="utf-8")
    msg["To"] = to_email
    text = (
        f"你的 CurrentMusic {title}是：{code}\n"
        f"{expires}。{notice}\n\n"
        f"由 流声引擎 强力驱动\n{ENGINE_URL}"
    )
    html = f"""\
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CurrentMusic {escape(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f2f6f2">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f2f6f2">
    <tr><td align="center" style="padding:28px 12px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff"
        style="max-width:520px;border:1px solid #d7e5d9;border-radius:18px;color:#20342a;
          font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
        <tr><td style="padding:28px 24px 24px">
          <p style="margin:0 0 16px;color:#28513e;font-size:16px;line-height:24px;font-weight:700">CurrentMusic</p>
          <h1 style="margin:0 0 8px;font-size:24px;line-height:32px">{escape(title)}</h1>
          <p style="margin:0 0 18px;color:#4e6956;font-size:14px;line-height:22px">请在 CurrentMusic 中输入下方验证码。</p>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td align="center" bgcolor="#f3faee" style="padding:18px 8px;border:1px solid #a6c9ad;border-radius:12px">
              <p style="margin:0 0 6px;color:#28513e;font-family:Consolas,'Courier New',monospace;
                font-size:36px;font-weight:700;line-height:44px;letter-spacing:6px;white-space:nowrap">{escape(str(code))}</p>
              <p style="margin:0;color:#4e6956;font-size:13px;line-height:20px">{escape(expires)}</p>
            </td></tr>
          </table>
          <p style="margin:18px 0 0;color:#4e6956;font-size:13px;line-height:22px">{notice}</p>
        </td></tr>
        <tr><td align="center" style="padding:16px 24px 20px;border-top:1px solid #e2ebe2">
          <a href="{ENGINE_URL}" style="display:inline-block;padding:5px 11px;border:1px solid #a6c9ad;
            border-radius:999px;background-color:#f3faee;box-shadow:0 2px 0 #a6c9ad;color:#4e6956;
            font-size:12px;line-height:18px;text-decoration:none">由 <strong style="color:#28513e">流声引擎</strong> 强力驱动</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>"""
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as s:
        s.login(user, pwd)
        s.sendmail(user, [to_email], msg.as_string())
    log.info("验证码邮件已发送 to=%s", to_email)
