"""落雪音乐（LX Music）自定义音源端点与脚本回归。

两层验证：

1. 端点行为（临时库）：无/坏令牌 401、有效令牌返回内嵌令牌的 JS、
   下线令牌后立即失效、认证入口限速 429；
2. 脚本语义（Node 22）：在模拟的 ``globalThis.lx`` 环境里加载生成的脚本，
   断言 musicUrl 的档位映射与 Bearer 头、错误透传、lyric 的 LRC 转换，
   以及不支持源/动作的拒绝路径。

    python3 -m unittest backend.tests.test_lx_source -v
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cm_db  # noqa: E402
import cm_lx  # noqa: E402
import cm_server  # noqa: E402

import test_password_reset as harness  # noqa: E402
from unittest import mock  # noqa: E402

NODE_BIN = shutil.which("node")

# Node 侧最小 LX 沙箱：录制 request 调用，按 URL 前缀回放预设响应。
# 两种协议模式都覆盖：官方 v2（handler 返回 Promise、resp.body 已被沙箱
# JSON.parse 成对象）与老式 callback（body 为字符串）。
_NODE_HARNESS = r"""
'use strict';
const fs = require('fs');
const script = fs.readFileSync(process.argv[2], 'utf8');

const requests = [];
let inited = null;
let requestHandler = null;

function reply(body, statusCode, raw) {
  return (url, options, cb) => {
    const payload = raw ? body : JSON.stringify(body);   // raw=官方沙箱：body 已是对象
    setTimeout(() => cb(null, { statusCode, headers: {}, body: payload }), 0);
  };
}

const responders = [];
function onGet(prefix, fn) { responders.push({ prefix, fn }); }

// 由驱动脚本注入的用例预设（第二个参数：JSON 字符串）
const fixtures = JSON.parse(process.argv[3]);

globalThis.lx = {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  request(url, options, cb) {
    requests.push({ url, options });
    for (const r of responders) {
      if (url.startsWith(r.prefix)) return r.fn(url, options, cb);
    }
    throw new Error('no responder for ' + url);
  },
  on(name, fn) { if (name === 'request') requestHandler = fn; },
  send(name, info) { if (name === 'inited') inited = info; },
};

eval(script);

// 重复 eval 安全性：部分客户端会在复用上下文里重新载入脚本，
// 顶层 const 重复声明会直接抛错并被判为「音源解析失败」。
let reevalOk = true;
let reevalError = null;
try { eval(script) } catch (e) { reevalOk = false; reevalError = String(e && e.message || e) }

function fire(payload, mode) {
  if (mode === 'callback') {
    return new Promise((resolve) => {
      let settled = false;
      payload.callback = (err, data) => {
        if (settled) return;
        settled = true;
        resolve({ protocol: 'callback', err: err ? String(err && err.message || err) : null, data });
      };
      const ret = requestHandler(payload);
      if (ret && typeof ret.catch === 'function') ret.catch(() => {});
    });
  }
  // 官方 v2：handler 的返回值必须 thenable（沙箱直接对它 .then()）
  const ret = requestHandler(payload);
  if (!ret || typeof ret.then !== 'function') return Promise.resolve({ protocol: 'bad-return' });
  return ret.then(
    (data) => ({ protocol: 'promise', err: null, data }),
    (err) => ({ protocol: 'promise', err: String(err && err.message || err) }));
}

(async () => {
  const out = { inited, requests, cases: [], reevalOk, reevalError };  for (const c of fixtures) {
    responders.length = 0;
    if (c.replyPrefix) onGet(c.replyPrefix, reply(c.replyBody, c.replyStatus, c.rawBody));
    const res = await fire({ source: c.source, action: c.action, info: c.info }, c.mode || 'v2');
    res.name = c.name;
    out.cases.push(res);
  }
  console.log(JSON.stringify(out));
})();
"""

# 复刻官方 preload 的 init/request 契约（lx-music-desktop v2 preload.js）：
#   - handleInit 按 supportQualitys/supportActions 白名单过滤；
#   - handleRequest 直接对 handler 返回值 .then()，并校验 musicUrl 是
#     ≤2048 字符的 http(s) 字符串、lyric 的字段类型与长度上限；
#   - request 回调的 body 已被沙箱 JSON.parse。
_OFFICIAL_CONTRACT_HARNESS = r"""
'use strict';
const fs = require('fs');
const script = fs.readFileSync(process.argv[2], 'utf8');

const ALL_SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg', 'local'];
const SUPPORT_QUALITYS = {
  kw: ['128k', '320k', 'flac', 'flac24bit'],
  kg: ['128k', '320k', 'flac', 'flac24bit'],
  tx: ['128k', '320k', 'flac', 'flac24bit'],
  wy: ['128k', '320k', 'flac', 'flac24bit'],
  mg: ['128k', '320k', 'flac', 'flac24bit'],
  local: [],
};
const SUPPORT_ACTIONS = {
  kw: ['musicUrl'], kg: ['musicUrl'], tx: ['musicUrl'], wy: ['musicUrl'],
  mg: ['musicUrl'], local: ['musicUrl', 'lyric', 'pic'],
};

let initResult = null, initError = null, requestHandler = null;

function verifyLyricInfo(info) {
  if (typeof info != 'object' || typeof info.lyric != 'string') throw new Error('failed');
  if (info.lyric.length > 51200) throw new Error('failed');
  return {
    lyric: info.lyric,
    tlyric: (typeof info.tlyric == 'string' && info.tlyric.length < 5120) ? info.tlyric : null,
    rlyric: (typeof info.rlyric == 'string' && info.rlyric.length < 5120) ? info.rlyric : null,
    lxlyric: (typeof info.lxlyric == 'string' && info.lxlyric.length < 8192) ? info.lxlyric : null,
  };
}

function handleInit(info) {
  if (!info) { initError = 'Missing required parameter init info'; return; }
  const sourceInfo = { sources: {} };
  try {
    for (const source of ALL_SOURCES) {
      const userSource = info.sources[source];
      if (!userSource || userSource.type !== 'music') continue;
      sourceInfo.sources[source] = {
        type: 'music',
        actions: SUPPORT_ACTIONS[source].filter(a => userSource.actions.includes(a)),
        qualitys: SUPPORT_QUALITYS[source].filter(q => userSource.qualitys.includes(q)),
      };
    }
  } catch (e) { initError = e.message; return; }
  initResult = sourceInfo;
}

function handleRequest(data) {
  if (!requestHandler) throw new Error('Request event is not defined');
  return requestHandler({ source: data.source, action: data.action, info: data.info }).then(response => {
    switch (data.action) {
      case 'musicUrl':
        if (typeof response != 'string' || response.length > 2048 || !/^https?:/.test(response)) throw new Error('failed');
        return { type: data.info.type, url: response };
      case 'lyric':
        return verifyLyricInfo(response);
      default:
        throw new Error('unexpected action');
    }
  });
}

globalThis.lx = {
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  request(url, { method = 'get', timeout, headers }, callback) {
    setTimeout(() => {
      // 官方沙箱：body 自动 JSON.parse
      callback(null, { statusCode: 200, headers: {}, body: {
        url: 'https://m804.music.126.net/official.mp3',
        level: 'exhigh',
        lines: [{ t: 1000, txt: '官方契约', trans: '', roma: '' }],
      } });
    }, 0);
  },
  send(eventName, data) { if (eventName === 'inited') handleInit(data); },
  on(eventName, handler) { if (eventName === 'request') requestHandler = handler; },
};

eval(script);

(async () => {
  const url = await handleRequest({ source: 'wy', action: 'musicUrl',
    info: { type: '320k', musicInfo: { songmid: '186016' } } });
  const lyric = await handleRequest({ source: 'wy', action: 'lyric',
    info: { type: '320k', musicInfo: { songmid: '186016' } } });
  console.log(JSON.stringify({ initResult, initError, url, lyric }));
})().catch(e => { console.log(JSON.stringify({ fatal: String(e && e.message || e) })); });
"""


class LxSourceTests(unittest.TestCase):
    call = harness.TestPasswordReset.call
    make_user = harness.TestPasswordReset.make_user
    _cleanup = harness.TestPasswordReset._cleanup

    def setUp(self):
        harness.TestPasswordReset.setUp(self)
        self.uid = self.make_user()
        self.token = cm_db.issue_token(self.uid, "LX 设备", "lx")

    def fetch(self, path, **kwargs):
        return self.call("GET", path, **kwargs)

    def raw_body(self, path, headers=None):
        """route() 直跑：拿原始（非 JSON）响应体与状态。"""
        h = harness._Handler("GET", path, ip="10.0.0.9")
        h.headers.update(headers or {})
        try:
            cm_server.route(h, "GET")
        except cm_server.ApiError as e:
            return e.code, json.dumps({"error": e.msg}, ensure_ascii=False)
        return h.status, h.wfile.getvalue().decode("utf-8")

    # ---------- 端点行为 ----------

    def test_missing_token_rejected(self):
        status, body = self.raw_body("/lx/source.js")
        self.assertEqual(status, 401)
        self.assertIn("缺少 token", body)

    def test_invalid_token_gets_expired_script(self):
        # 客户端只显示 HTTP 码，裸 401 用户无从判断；改为下发合法提示脚本
        status, script = self.raw_body("/lx/source.js?token=not-a-real-token")
        self.assertEqual(status, 200)
        self.assertIn("直链已失效", script)
        self.assertIn("设置 → 服务器 → 落雪音乐音源", script)
        self.assertIn("sources: {}", script)          # 不声明可用源，避免错误播放
        self.assertNotIn("not-a-real-token", script)  # 绝不回显无效令牌

    def test_valid_token_returns_script(self):
        status, script = self.raw_body(f"/lx/source.js?token={self.token}")
        self.assertEqual(status, 200)
        # LX 客户端解析的头部字段必须齐备
        for field in ("@name", "@description", "@version", "@author"):
            self.assertIn(field, script)
        self.assertIn("'wy'", script)                       # 仅声明 wy 源
        self.assertIn(json.dumps(self.token), script)       # 内嵌个人令牌
        self.assertIn(json.dumps(cm_lx.DEFAULT_API_BASE), script)  # 无 Host 头 → 兜底域名
        self.assertIn("/ncm/song/url", script)
        self.assertIn("/ncm/lyric", script)

    def test_revoked_token_gets_expired_script(self):
        cm_db.revoke_token(self.uid, self.token)
        status, script = self.raw_body(f"/lx/source.js?token={self.token}")
        self.assertEqual(status, 200)
        self.assertIn("直链已失效", script)

    def test_auth_rate_limit(self):
        for i in range(30):                                  # 30/min 上限用满
            self.raw_body(f"/lx/source.js?token={self.token}", )
        status, body = self.raw_body(f"/lx/source.js?token={self.token}")
        self.assertEqual(status, 429)
        self.assertIn("频繁", body)

    # ---------- 脚本生成 ----------

    def test_build_source_script_escapes_and_substitutes(self):
        script = cm_lx.build_source_script("https://example.org/cm", "tok'en\"\\x")
        self.assertIn('"tok\'en\\"\\\\x"', script)
        self.assertIn("https://example.org/cm", script)
        self.assertIn(cm_lx.SOURCE_VERSION, script)
        self.assertNotIn("__API_BASE__", script)
        self.assertNotIn("__TOKEN__", script)

    def test_api_base_for_headers(self):
        class H:
            def __init__(self, headers):
                self.headers = headers
        self.assertEqual(cm_lx.api_base_for(H({"Host": "music.20110208.xyz",
                                               "X-Forwarded-Proto": "https"})),
                         "https://music.20110208.xyz/cm")
        self.assertEqual(cm_lx.api_base_for(H({"Host": "music.ctcehs.com"})),
                         "https://music.ctcehs.com/cm")
        self.assertEqual(cm_lx.api_base_for(H({"Host": "127.0.0.1:8901"})),
                         "http://127.0.0.1:8901/cm")
        # 多级代理逗号串只取第一段
        self.assertEqual(cm_lx.api_base_for(H({"X-Forwarded-Host": "a.example, b.example",
                                               "X-Forwarded-Proto": "https, http"})),
                         "https://a.example/cm")

    # ---------- 脚本语义（Node 模拟 LX 环境） ----------
    @unittest.skipUnless(NODE_BIN, "需要 Node 运行时")
    def test_official_preload_contract(self):
        """直接复刻官方 preload 的 init/request 校验，确保脚本被官方客户端接受。"""
        script = cm_lx.build_source_script("https://engine.example/cm", "tok-lx-123")
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "lx-source.js")
            harness_path = os.path.join(tmp, "official.cjs")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script)
            with open(harness_path, "w", encoding="utf-8") as f:
                f.write(_OFFICIAL_CONTRACT_HARNESS)
            proc = subprocess.run([NODE_BIN, harness_path, script_path],
                                  capture_output=True, text=True, timeout=60, cwd=tmp)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertNotIn("fatal", out, out.get("fatal"))
        self.assertIsNone(out["initError"])           # init 不能失败
        wy = out["initResult"]["sources"]["wy"]       # 官方白名单过滤后仍存在
        self.assertEqual(wy["type"], "music")
        self.assertEqual(wy["actions"], ["musicUrl"])  # 官方 wy 只接受 musicUrl
        self.assertEqual(wy["qualitys"], ["128k", "320k", "flac", "flac24bit"])
        # handleRequest 的 .then() 链路与官方字段校验均应通过
        self.assertEqual(out["url"]["url"], "https://m804.music.126.net/official.mp3")
        self.assertEqual(out["url"]["type"], "320k")
        self.assertIn("[00:01.00]官方契约", out["lyric"]["lyric"])

    @unittest.skipUnless(NODE_BIN, "需要 Node 运行时")
    def test_script_semantics_in_lx_sandbox(self):
        script = cm_lx.build_source_script("https://engine.example/cm", "tok-lx-123")
        # mode=v2 模拟官方 lx-music-desktop/mobile 沙箱：handler 返回 Promise、
        # resp.body 已被沙箱 JSON.parse 成对象（rawBody=True）；
        # mode=callback 模拟老式/衍生运行时：传入 callback、body 为字符串。
        cases = [
            # musicUrl：四档映射到 Engine level，带 Bearer
            dict(name="128k", mode="v2", rawBody=True, source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "128k"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"url": "https://m804.music.126.net/a.mp3", "level": "standard"},
                 replyStatus=200),
            dict(name="320k", mode="v2", rawBody=True, source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "320k"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"url": "https://m804.music.126.net/b.mp3", "level": "exhigh"},
                 replyStatus=200),
            dict(name="flac24bit", mode="v2", rawBody=True, source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "flac24bit"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"url": "https://m804.music.126.net/c.flac", "level": "jymaster"},
                 replyStatus=200),
            # 老式 callback 运行时（body 为字符串）也要能解析
            dict(name="legacy_callback", mode="callback", source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "320k"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"url": "https://m804.music.126.net/d.mp3", "level": "exhigh"},
                 replyStatus=200),
            # 401 → 引导用户重新生成直链
            dict(name="expired", mode="v2", rawBody=True, source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "320k"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"error": "未登录"}, replyStatus=401),
            # 502 错误透传
            dict(name="match_failed", mode="v2", rawBody=True, source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "999"}, "type": "flac"},
                 replyPrefix="https://engine.example/cm/ncm/song/url",
                 replyBody={"error": "官方音源未取得可用地址", "code": "playback_match_failed"},
                 replyStatus=502),
            # lyric：归一化 lines → LRC（官方 wy 白名单不含 lyric，但协议仍响应）
            dict(name="lyric", mode="v2", rawBody=True, source="wy", action="lyric",
                 info={"musicInfo": {"songmid": "186001"}},
                 replyPrefix="https://engine.example/cm/ncm/lyric",
                 replyBody={"lines": [
                     {"t": 1000, "txt": "测试歌词", "trans": "test line", "roma": "ce shi"},
                     {"t": 61500, "txt": "第二行", "trans": "", "roma": ""},
                 ]},
                 replyStatus=200),
            # 非 wy 源 / 未知动作 / 未知音质 → 明确报错
            dict(name="tx_rejected", mode="v2", source="tx", action="musicUrl",
                 info={"musicInfo": {"songmid": "x"}, "type": "320k"}),
            dict(name="pic_rejected", mode="v2", source="wy", action="pic",
                 info={"musicInfo": {"songmid": "186001"}}),
            dict(name="bad_quality", mode="v2", source="wy", action="musicUrl",
                 info={"musicInfo": {"songmid": "186001"}, "type": "192k"}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "lx-source.js")
            harness_path = os.path.join(tmp, "harness.cjs")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script)
            with open(harness_path, "w", encoding="utf-8") as f:
                f.write(_NODE_HARNESS)
            proc = subprocess.run(
                [NODE_BIN, harness_path, script_path, json.dumps(cases, ensure_ascii=False)],
                capture_output=True, text=True, timeout=60, cwd=tmp)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            out = json.loads(proc.stdout.strip().splitlines()[-1])

        # inited 事件声明：仅 wy，四档音质；动作只声明 musicUrl
        # （官方 wy 白名单如此，多余声明会被过滤或被衍生版严格校验拒绝）
        self.assertTrue(out["reevalOk"], out["reevalError"])   # 重复 eval 必须不抛错
        self.assertTrue(out["inited"]["status"])
        self.assertEqual(out["inited"]["sources"]["wy"]["type"], "music")
        self.assertEqual(out["inited"]["sources"]["wy"]["actions"], ["musicUrl"])
        self.assertEqual(out["inited"]["sources"]["wy"]["qualitys"],
                         ["128k", "320k", "flac", "flac24bit"])

        by_name = {c["name"]: c for c in out["cases"]}
        # 官方 v2 模式：handler 在所有分支都必须返回 thenable（沙箱直接 .then()）
        for c in out["cases"]:
            if c["name"] == "legacy_callback":
                self.assertEqual(c["protocol"], "callback")
            else:
                self.assertEqual(c["protocol"], "promise", c["name"])
        # 请求 URL / 鉴权头断言（三个 v2 成功/失败用例 + 一个 callback 用例各发一次）
        song_calls = [r for r in out["requests"] if "/ncm/song/url" in r["url"]]
        self.assertEqual(len(song_calls), 6)
        by_level = {r["url"].split("level=")[1] for r in song_calls if "level=" in r["url"]}
        self.assertEqual(by_level, {"standard", "exhigh", "lossless", "jymaster"})
        for r in song_calls:
            self.assertEqual(r["options"]["headers"]["Authorization"], "Bearer tok-lx-123")
        self.assertEqual(sum("id=186001" in r["url"] for r in song_calls), 5)
        self.assertEqual(sum("id=999" in r["url"] for r in song_calls), 1)
        lyric_calls = [r for r in out["requests"] if "/ncm/lyric" in r["url"]]
        self.assertEqual(len(lyric_calls), 1)
        self.assertNotIn("Authorization", lyric_calls[0]["options"]["headers"])   # 公开接口不带令牌

        # musicUrl 成功路径（v2：body 已是对象；callback：body 是字符串）
        self.assertEqual(by_name["128k"]["err"], None)
        self.assertEqual(by_name["128k"]["data"], "https://m804.music.126.net/a.mp3")
        self.assertEqual(by_name["320k"]["data"], "https://m804.music.126.net/b.mp3")
        self.assertEqual(by_name["flac24bit"]["data"], "https://m804.music.126.net/c.flac")
        self.assertEqual(by_name["legacy_callback"]["err"], None)
        self.assertEqual(by_name["legacy_callback"]["data"], "https://m804.music.126.net/d.mp3")
        # 失败路径
        self.assertIn("登录已失效", by_name["expired"]["err"])
        self.assertIn("未取得可用地址", by_name["match_failed"]["err"])
        # lyric LRC
        lyric = by_name["lyric"]["data"]
        self.assertIn("[00:01.00]测试歌词", lyric["lyric"])
        self.assertIn("[01:01.50]第二行", lyric["lyric"])
        self.assertEqual(lyric["tlyric"], "[00:01.00]test line")
        self.assertEqual(lyric["rlyric"], "[00:01.00]ce shi")
        # 拒绝路径
        self.assertIn("仅支持网易云", by_name["tx_rejected"]["err"])
        self.assertIn("不支持的操作", by_name["pic_rejected"]["err"])
        self.assertIn("不支持的音质", by_name["bad_quality"]["err"])


class LxDedicatedTokenTests(unittest.TestCase):
    """音源专用令牌（clx_）：签发/轮换/撤销的生命周期与最小权限范围。"""

    def setUp(self):
        harness.TestPasswordReset.setUp(self)
        patch = mock.patch.object(cm_server.cm_region, "note")
        patch.start()
        self.addCleanup(patch.stop)
        self.uid = self.make_user()
        self.session = cm_db.issue_token(self.uid, "Web 设备", "web")

    # ---------- 数据层 ----------

    def test_db_issue_get_revoke(self):
        self.assertIsNone(cm_db.lx_token_get(self.uid))
        token = cm_db.lx_token_issue(self.uid)
        self.assertTrue(token.startswith("clx_"))
        row = cm_db.lx_token_get(self.uid)
        self.assertEqual(row["last_seen"], 0)
        # 哈希口径：库里绝无明文
        import hashlib
        with cm_db.connect() as conn:
            th = conn.execute("SELECT token_hash FROM lx_tokens WHERE user_id=?", (self.uid,)).fetchone()[0]
        self.assertEqual(th, hashlib.sha256(token.encode()).hexdigest())
        # 重复签发即轮换：单令牌模型整行替换
        token2 = cm_db.lx_token_issue(self.uid)
        self.assertNotEqual(token, token2)
        self.assertIsNone(cm_db.lx_token_user(token))       # 旧令牌立即失效
        self.assertIsNotNone(cm_db.lx_token_user(token2))
        cm_db.lx_token_revoke(self.uid)
        self.assertIsNone(cm_db.lx_token_get(self.uid))
        self.assertIsNone(cm_db.lx_token_user(token2))

    def test_db_user_lookup_rejects_sessions_and_disabled(self):
        # 非专用令牌（如登录会话）不走 lx_tokens 这条链
        self.assertIsNone(cm_db.lx_token_user(self.session))
        token = cm_db.lx_token_issue(self.uid)
        self.assertIsNotNone(cm_db.lx_token_user(token))
        # 禁用账号即时失效
        with cm_db.connect() as conn:
            conn.execute("UPDATE users SET disabled=1 WHERE id=?", (self.uid,))
        self.assertIsNone(cm_db.lx_token_user(token))

    # ---------- 管理 API ----------

    def test_management_lifecycle(self):
        st, d = self.call("GET", "/lx/token", token=self.session)
        self.assertEqual((st, d["enabled"]), (200, False))

        st, d = self.call("POST", "/lx/token", token=self.session)
        self.assertEqual(st, 200)
        self.assertTrue(d["created"])
        self.assertIn("clx_", d["token"])
        self.assertIn(d["token"], d["sourceUrl"])
        first = d["token"]

        # 重复生成幂等：只回状态，不再返回明文
        st, d = self.call("POST", "/lx/token", token=self.session)
        self.assertEqual((st, d["created"]), (200, False))
        self.assertNotIn("token", d)

        # 专用令牌不能管理自身（须登录会话）
        self.assertEqual(self.call("GET", "/lx/token", token=first)[0], 401)
        self.assertEqual(self.call("POST", "/lx/token/rotate", {"confirm": 1}, token=first)[0], 401)

        # 轮换需要 confirm；成功后旧直链立即失效、新直链可用
        self.assertEqual(self.call("POST", "/lx/token/rotate", {}, token=self.session)[0], 400)
        st, d = self.call("POST", "/lx/token/rotate", {"confirm": 1}, token=self.session)
        self.assertEqual(st, 200)
        self.assertTrue(d["rotated"])
        second = d["token"]
        self.assertNotEqual(first, second)
        status, old_script = self.raw_source(first)
        self.assertEqual(status, 200)
        self.assertIn("直链已失效", old_script)     # 旧直链：提示脚本，不含旧令牌
        self.assertNotIn(json.dumps(first), old_script)
        status, script = self.raw_source(second)
        self.assertEqual(status, 200)
        self.assertIn(json.dumps(second), script)

        # 状态含使用痕迹
        st, d = self.call("GET", "/lx/token", token=self.session)
        self.assertEqual((st, d["enabled"]), (200, True))
        self.assertGreaterEqual(d["lastSeen"], 0)

        # 撤销需要 confirm；撤销后直链返回失效提示脚本、状态回到未启用
        self.assertEqual(self.call("DELETE", "/lx/token", {}, token=self.session)[0], 400)
        st, d = self.call("DELETE", "/lx/token", {"confirm": 1}, token=self.session)
        self.assertEqual((st, d["enabled"]), (200, False))
        status, revoked_script = self.raw_source(second)
        self.assertEqual(status, 200)
        self.assertIn("直链已失效", revoked_script)
        self.assertEqual(self.call("GET", "/lx/token", token=self.session)[1]["enabled"], False)

    def test_management_requires_session(self):
        self.assertEqual(self.call("GET", "/lx/token")[0], 401)   # 未登录

    # ---------- 权限范围 ----------

    def test_dedicated_token_scope_limited(self):
        clx = cm_db.lx_token_issue(self.uid)
        # 取链端点接受专用令牌（上游解析 mock 掉，只验证鉴权层）
        with mock.patch.object(cm_server, "resolve_play_url",
                               return_value={"url": "https://m804.music.126.net/a.mp3", "level": "exhigh"}):
            st, d = self.call("GET", "/ncm/song/url?id=186016&level=exhigh", token=clx)
            self.assertEqual(st, 200)
            self.assertEqual(d["url"], "https://m804.music.126.net/a.mp3")
        # 登录会话照常可用（兼容旧直链）
        with mock.patch.object(cm_server, "resolve_play_url",
                               return_value={"url": "https://m804.music.126.net/b.mp3", "level": "exhigh"}):
            st, _ = self.call("GET", "/ncm/song/url?id=186016&level=exhigh", token=self.session)
            self.assertEqual(st, 200)
        # 专用令牌访问其它任何端点一律 401
        for method, path, body in (("GET", "/auth/me", None),
                                   ("GET", "/auth/sessions", None),
                                   ("GET", "/plays/recent", None)):
            with self.subTest(path=path):
                self.assertEqual(self.call(method, path, body, token=clx)[0], 401)

    def raw_source(self, token):
        return self.raw_body(f"/lx/source.js?token={token}")

    call = harness.TestPasswordReset.call
    make_user = harness.TestPasswordReset.make_user
    _cleanup = harness.TestPasswordReset._cleanup
    raw_body = LxSourceTests.raw_body


if __name__ == "__main__":
    unittest.main()
