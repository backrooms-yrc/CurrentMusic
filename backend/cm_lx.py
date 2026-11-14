"""落雪音乐（LX Music）自定义音源脚本工厂。

把 CurrentMusic Engine 的取链能力包装成 LX Music 可导入的自定义音源 JS：

- 入口是 ``GET /lx/source.js?token=<个人令牌>``（见 cm_server.route）；
- 返回的脚本头部携带 LX 客户端解析的 ``@name``/``@description``/``@version`` 等注释，
  主体监听 ``globalThis.lx`` 的 ``request`` 事件，用 ``wy`` 源的 ``songmid`` 回连
  Engine 的 ``/ncm/song/url``（musicUrl）与公开的 ``/ncm/lyric``（lyric）；
- 直链与脚本内容都内嵌个人令牌，等同于登录会话，绝不落缓存、不写日志；
  令牌失效（退出登录 / 下线设备 / 改密）后拉取即 401，用户重新生成即可。

脚本语法刻意保持 ES2015 级别：LX 各端内置的 JS 运行时（QuickJS / WebView）
对更激进的语法支持不一，兼容面优先。
"""
from __future__ import annotations

import json

# 音源脚本自身的版本。LX 客户端靠它判断「检查更新」是否需要拉新脚本。
SOURCE_VERSION = "1.0.0"

# 兜底基址：仅在请求头完全推不出对外域名时使用（正常线上永远走 Host 头）。
DEFAULT_API_BASE = "https://music.20110208.xyz/cm"

# 请求超时（毫秒）。取链的灰色匹配慢路径上限约 20s，客户端侧再留一点余量。
REQUEST_TIMEOUT_MS = 20000

_SCRIPT_TEMPLATE = r"""
/*!
 * @name CurrentMusic 流声引擎
 * @description CurrentMusic Engine 官方落雪音乐音源：注册用户级取链、自动音质、灰色曲目匹配与逐字歌词。
 * @version __SOURCE_VERSION__
 * @author Rcst20
 * @homepage https://music.20110208.xyz/home/engine/
 *
 * 本直链内嵌你的 CurrentMusic 个人令牌，请勿分享给他人；
 * 提示「登录已失效」时，请到 CurrentMusic 网页端「设置 → 落雪音乐音源」重新生成直链并更新。
 */

const { EVENT_NAMES, request } = globalThis.lx

const API_BASE = __API_BASE__
const TOKEN = __TOKEN__
const REQUEST_TIMEOUT = __REQUEST_TIMEOUT_MS__
const UA = 'CurrentMusic-LX/__SOURCE_VERSION__ (lx-music custom source)'

// LX 音质档 → Engine /ncm/song/url 的 level（Engine 不支持 192k，故不声明）。
const QUALITY_LEVELS = {
  '128k': 'standard',
  '320k': 'exhigh',
  'flac': 'lossless',
  'flac24bit': 'jymaster',
}
const qualitys = ['128k', '320k', 'flac', 'flac24bit']

function httpGet(url, needAuth) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg) } }
    const timer = setTimeout(() => finish(reject, new Error('请求 CurrentMusic 超时')), REQUEST_TIMEOUT)
    const headers = { Accept: 'application/json', 'User-Agent': UA }
    if (needAuth) headers.Authorization = 'Bearer ' + TOKEN
    let settled = false
    try {
      request(url, { method: 'GET', headers: headers, timeout: REQUEST_TIMEOUT }, (err, resp) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) return finish(reject, err)
        let data = null
        let parseOk = true
        try { data = JSON.parse(resp.body) } catch (e) { parseOk = false }
        if (resp.statusCode === 401) {
          return finish(reject, new Error('CurrentMusic 登录已失效：请到网页端「设置 → 落雪音乐音源」重新生成直链'))
        }
        if (resp.statusCode === 429) return finish(reject, new Error('请求过于频繁，请稍后再试'))
        if (resp.statusCode >= 400) {
          const msg = (parseOk && data && data.error) ? data.error : ('请求失败（HTTP ' + resp.statusCode + '）')
          return finish(reject, new Error(msg))
        }
        if (!parseOk) return finish(reject, new Error('响应解析失败（HTTP ' + resp.statusCode + '）'))
        finish(resolve, data)
      })
    } catch (err) {
      clearTimeout(timer)
      finish(reject, err)
    }
  })
}

function musicUrl(musicInfo, quality) {
  const id = musicInfo && musicInfo.songmid
  if (!id) return Promise.reject(new Error('缺少网易云歌曲 ID'))
  const level = QUALITY_LEVELS[quality]
  const url = API_BASE + '/ncm/song/url?id=' + encodeURIComponent(id) + '&level=' + level
  return httpGet(url, true).then((d) => {
    const playUrl = d && d.url
    if (!playUrl) throw new Error((d && d.error) || '该音质档位无可用地址')
    return playUrl
  })
}

function fmtTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0
  const total = Math.floor(ms)
  const m = Math.floor(total / 60000)
  const s = Math.floor((total % 60000) / 1000)
  const cs = Math.floor((total % 1000) / 10)
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs
}

// Engine 归一化歌词（lines: [{t, txt, trans, roma}]，t 为毫秒）→ LRC 文本。
function toLrc(lines, field) {
  const out = []
  for (const line of lines || []) {
    const text = ((line && line[field]) || '').trim()
    if (text) out.push('[' + fmtTime(line.t) + ']' + text)
  }
  return out.join('\n')
}

function lyric(musicInfo) {
  const id = musicInfo && musicInfo.songmid
  if (!id) return Promise.reject(new Error('缺少网易云歌曲 ID'))
  return httpGet(API_BASE + '/ncm/lyric?id=' + encodeURIComponent(id), false).then((d) => {
    if (!d || !Array.isArray(d.lines) || !d.lines.length) throw new Error('暂无歌词')
    return {
      lyric: toLrc(d.lines, 'txt'),
      tlyric: toLrc(d.lines, 'trans'),
      rlyric: toLrc(d.lines, 'roma'),
      lxlyric: '',
    }
  })
}

globalThis.lx.on(EVENT_NAMES.request, ({ source, action, info, callback }) => {
  const cb = typeof callback === 'function' ? callback : function () {}
  if (source !== 'wy') return cb(new Error('CurrentMusic 音源目前仅支持网易云（wy）音源'))
  let work
  switch (action) {
    case 'musicUrl':
      if (!info || qualitys.indexOf(info.type) < 0) {
        return cb(new Error('不支持的音质：' + (info && info.type)))
      }
      work = musicUrl(info.musicInfo, info.type)
      break
    case 'lyric':
      work = lyric(info.musicInfo)
      break
    default:
      return cb(new Error('不支持的操作：' + action))
  }
  work.then((data) => cb(null, data), (err) => cb(err || new Error('请求失败')))
})

globalThis.lx.send(EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {
    wy: {
      name: 'CurrentMusic 流声引擎',
      type: 'music',
      actions: ['musicUrl', 'lyric'],
      qualitys: qualitys,
    },
  },
})
""".lstrip("\n")


def build_source_script(api_base: str, token: str) -> str:
    """生成内嵌个人令牌的音源脚本。``api_base`` 形如 ``https://host/cm``。"""
    return (_SCRIPT_TEMPLATE
            .replace("__SOURCE_VERSION__", SOURCE_VERSION)
            .replace("__API_BASE__", json.dumps(api_base))
            .replace("__TOKEN__", json.dumps(token))
            .replace("__REQUEST_TIMEOUT_MS__", str(int(REQUEST_TIMEOUT_MS))))


def api_base_for(handler) -> str:
    """按请求的对外域名推导 API 基址（脚本用它从用户设备回连 Engine）。

    nginx 已设置 ``Host`` 与 ``X-Forwarded-Proto``（见 deploy/nginx.conf.example）；
    两者都拿不到时回退到默认域名。本机直连后端（无这些头）时生成
    ``http://127.0.0.1:port/cm``，便于本机核验。
    """
    host = (handler.headers.get("X-Forwarded-Host") or handler.headers.get("Host") or "").split(",")[0].strip()
    proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    if not host:
        return DEFAULT_API_BASE
    if not proto:
        proto = "https" if not host.startswith(("localhost", "127.")) else "http"
    return f"{proto}://{host}/cm"
