"""落雪音乐（LX Music）自定义音源脚本工厂。

把 CurrentMusic Engine 的取链能力包装成 LX Music 可导入的自定义音源 JS：

- 入口是 ``GET /lx/source.js?token=<个人令牌>``（见 cm_server.route）；
- 返回的脚本头部携带 LX 客户端解析的 ``@name``/``@description``/``@version`` 等注释，
  主体监听 ``globalThis.lx`` 的 ``request`` 事件，用 ``wy`` 源的 ``songmid`` 回连
  Engine 的 ``/ncm/song/url``（musicUrl）与公开的 ``/ncm/lyric``（lyric）；
  支持搜索扩展的宿主可调用 ``search``，复用 Web 的 ``/ncm/search``；
- 直链与脚本内容都内嵌令牌，响应禁止缓存，日志不记录令牌；
  令牌失效时返回提示脚本，用户可重新生成直链。

脚本语法刻意保持 ES2015 级别：LX 各端内置的 JS 运行时（QuickJS / WebView）
对更激进的语法支持不一，兼容面优先。

脚本遵循 lx-music-desktop v2 / lx-music-mobile 的自定义源运行时协议
（对照其 userApi 沙箱实现校准过，v1.0.1）：

- ``request`` 事件的 handler **必须返回 Promise**（官方 handleRequest 直接对
  返回值 ``.then()``，不传 callback）；老式 callback 形态作为兼容路径保留；
- 沙箱的 ``request`` 已对 JSON 响应自动 ``JSON.parse``，``resp.body`` 可能
  已经是对象，也可能是字符串（parse 失败或衍生环境），两种都要处理；
- 官方 ``wy`` 源的动作白名单只有 ``musicUrl``（``lyric``/``pic`` 仅 local 源
  开放，多余的声明会被过滤；个别衍生版甚至严格校验直接判失败），
  因此 ``inited`` 只声明 ``musicUrl``。支持扩展的宿主可以直接调用 ``lyric`` 和 ``search``。
"""
from __future__ import annotations

import json

# 音源脚本自身的版本。LX 客户端靠它判断「检查更新」是否需要拉新脚本。
SOURCE_VERSION = "1.1.0"

# 兜底基址：仅在请求头完全推不出对外域名时使用（正常线上永远走 Host 头）。
DEFAULT_API_BASE = "https://music.20110208.xyz/cm"

# 请求超时（毫秒）。取链需要覆盖官方、匹配验证和旧版官方取址串行执行的情况。
REQUEST_TIMEOUT_MS = 20000
PLAYBACK_TIMEOUT_MS = 36000

_SCRIPT_TEMPLATE = r"""
/*!
 * @name CurrentMusic 流声引擎
 * @description 流声引擎网易云音源，支持曲库搜索扩展和灰色曲目匹配。
 * @version __SOURCE_VERSION__
 * @author Rcst20
 * @homepage https://music.20110208.xyz/home/engine/
 *
 * 直链内嵌个人令牌，请勿分享；失效时到 CurrentMusic 设置页重新生成。
 */

// IIFE：客户端可能在复用上下文里重复 eval，顶层声明会重复定义；也避免污染全局。
;(function () {
'use strict'

var lx = globalThis.lx
if (!lx || !lx.EVENT_NAMES) return
var EVENT_NAMES = lx.EVENT_NAMES
var request = lx.request

const API_BASE = __API_BASE__
const TOKEN = __TOKEN__
const REQUEST_TIMEOUT = __REQUEST_TIMEOUT_MS__
const PLAYBACK_TIMEOUT = __PLAYBACK_TIMEOUT_MS__
const UA = 'CurrentMusic-LX/__SOURCE_VERSION__ (lx-music custom source)'

// 部分精简 JS 运行时（QuickJS 等）没有 setTimeout；没有超时计时也要能跑，
// 只依赖 request() 自带的 timeout 选项。
const setTimer = typeof setTimeout === 'function'
  ? (fn, ms) => setTimeout(fn, ms) : () => 0
const clearTimer = typeof clearTimeout === 'function'
  ? (t) => { if (t) clearTimeout(t) } : () => {}

// 音质取值必须是客户端认识的档位：官方四档 + CurrentMusicX 的
// 128k/320k/flac/flac24bit/hires/atmos/master（标准/极高/无损/24bit/
// Hi-Res/高清臻音/超清母带）。jymaster 是 Engine 内部档位名，不能声明。
const QUALITY_LEVELS = {
  '128k': 'standard',
  '320k': 'exhigh',
  'flac': 'lossless',
  'flac24bit': 'hires',     // 24bit（Engine 无独立 24bit 档，用 hires 承载）
  'hires': 'hires',         // Hi-Res
  'atmos': 'jyeffect',      // 高清臻音
  'master': 'jymaster',     // 超清母带
  '192k': 'exhigh',         // 部分客户端的历史档位名
  'ape': 'lossless',
  'wav': 'lossless',
}
const qualitys = ['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master']

function httpGet(url, needAuth, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg) } }
    const timer = setTimer(() => finish(reject, new Error('请求 CurrentMusic 超时')), timeout)
    const headers = { Accept: 'application/json', 'User-Agent': UA }
    if (needAuth) headers.Authorization = 'Bearer ' + TOKEN
    try {
      request(url, { method: 'GET', headers: headers, timeout: timeout }, (err, resp) => {
        if (done) return
        clearTimer(timer)
        if (err) return finish(reject, err)
        // 官方沙箱已对 JSON 响应自动解析，resp.body 可能是对象；衍生环境可能是字符串。
        let data = resp.body
        if (typeof data === 'string') {
          try { data = JSON.parse(data) } catch (e) { data = null }
        }
        if (resp.statusCode === 401) {
          return finish(reject, new Error('CurrentMusic 登录已失效：请到网页端「设置 → 落雪音乐音源」重新生成直链'))
        }
        if (resp.statusCode === 429) return finish(reject, new Error('请求过于频繁，请稍后再试'))
        if (resp.statusCode >= 400) {
          const msg = (data && data.error) ? data.error : ('请求失败（HTTP ' + resp.statusCode + '）')
          return finish(reject, new Error(msg))
        }
        if (!data || typeof data !== 'object') return finish(reject, new Error('响应解析失败（HTTP ' + resp.statusCode + '）'))
        finish(resolve, data)
      })
    } catch (err) {
      clearTimer(timer)
      finish(reject, err)
    }
  })
}

function musicUrl(musicInfo, quality) {
  const id = musicInfo && musicInfo.songmid
  if (!id) return Promise.reject(new Error('缺少网易云歌曲 ID'))
  const level = QUALITY_LEVELS[quality]
  // cn=1：让 Engine 用固定国内 RealIP 取址（更快命中国内 CDN 边缘，
  // 灰色曲目也不会因为 Cloudflare 边缘 IP 被判成地区不可用）。
  const url = API_BASE + '/ncm/song/url?id=' + encodeURIComponent(id)
    + '&level=' + level + '&cn=1'
  // matched 和 legacy 也是可播放的结果。官方 LX 宿主要求只返回 URL 字符串。
  return httpGet(url, true, PLAYBACK_TIMEOUT).then((d) => {
    if (typeof d.url !== 'string' || !/^https?:\/\//i.test(d.url)) {
      throw new Error(d.error || '该音质档位无可用地址')
    }
    return d.url
  })
}

function search(info) {
  const keywords = info && typeof info.keywords === 'string' ? info.keywords.trim() : ''
  if (!keywords) return Promise.reject(new Error('缺少搜索关键词'))
  const url = API_BASE + '/ncm/search?type=song&keywords=' + encodeURIComponent(keywords)
    + '&offset=' + encodeURIComponent(info.offset || 0) + '&limit=' + encodeURIComponent(info.limit || 30)
  return httpGet(url, false).then((d) => {
    const upstream = d.songs || []
    const catalog = d.catalogSongs || []
    const seen = new Set()
    const songs = catalog.concat(upstream).filter((song) => {
      const id = String(song.ncm_id)
      if (!/^[1-9]\d*$/.test(id) || seen.has(id)) return false
      seen.add(id)
      return true
    })
    return { songs, upstreamCount: upstream.length, totals: d.totals, hasMore: d.hasMore }
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

// 官方 v2 运行时对 request handler 的返回值直接 .then()（不传 callback），
// 所以必须返回 Promise；老式 callback 客户端同时兼容。
var handler = function (payload) {
  var source = payload.source, action = payload.action, info = payload.info, callback = payload.callback
  var cb = typeof callback === 'function' ? callback : null
  let work
  switch (action) {
    case 'musicUrl':
      if (source !== 'wy') {
        work = Promise.reject(new Error('CurrentMusic 音源目前仅支持网易云（wy）音源'))
      } else if (!info || !Object.prototype.hasOwnProperty.call(QUALITY_LEVELS, info.type)) {
        work = Promise.reject(new Error('不支持的音质：' + (info && info.type)))
      } else {
        work = musicUrl(info.musicInfo, info.type)
      }
      break
    case 'lyric':
    case 'search':
      // 官方 wy 白名单只有 musicUrl，扩展动作由支持它们的宿主直接调用。
      if (source !== 'wy') {
        work = Promise.reject(new Error('CurrentMusic 音源目前仅支持网易云（wy）音源'))
      } else {
        work = action === 'search' ? search(info) : lyric(info && info.musicInfo)
      }
      break
    default:
      work = Promise.reject(new Error('不支持的操作：' + action))
  }
  if (cb) {
    work.then(function (data) { cb(null, data) }, function (err) { cb(err || new Error('请求失败')) })
    work.catch(function () {})   // 已交给 callback，防未处理 rejection 告警
  }
  return work
}

// 初始化全程兜底：注册失败也不影响 inited 发出，避免客户端判为「初始化失败」。
try { lx.on(EVENT_NAMES.request, handler) } catch (e) {}

try {
  lx.send(EVENT_NAMES.inited, {
    status: true,
    openDevTools: false,
    sources: {
      wy: {
        name: 'CurrentMusic 流声引擎',
        type: 'music',
        actions: ['musicUrl'],
        qualitys: qualitys,
      },
    },
  })
} catch (e) {}
})()
""".lstrip("\n")


def build_source_script(api_base: str, token: str) -> str:
    """生成内嵌个人令牌的音源脚本。``api_base`` 形如 ``https://host/cm``。"""
    return (_SCRIPT_TEMPLATE
            .replace("__SOURCE_VERSION__", SOURCE_VERSION)
            .replace("__API_BASE__", json.dumps(api_base))
            .replace("__TOKEN__", json.dumps(token))
            .replace("__REQUEST_TIMEOUT_MS__", str(REQUEST_TIMEOUT_MS))
            .replace("__PLAYBACK_TIMEOUT_MS__", str(PLAYBACK_TIMEOUT_MS)))


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


# 令牌失效时下发的提示脚本：客户端只显示 HTTP 状态码、不显示响应体，
# 裸 401 只会变成「下载音源失败（HTTP 401）」；而如果给它一段合法脚本，
# 源列表里会直接显示下面这段说明，用户能立刻知道该怎么做。
# 该脚本不声明任何可用音源（sources 为空），因此不会产生错误播放尝试。
_EXPIRED_TEMPLATE = r"""
/*!
 * @name CurrentMusic 流声引擎（直链已失效）
 * @description ⚠ 直链已失效：请打开 CurrentMusic 网页端「设置 → 服务器 → 落雪音乐音源」重新复制直链，再到本页「从链接导入」覆盖。令牌被轮换、撤销或原登录会话已退出都会导致失效。
 * @version __SOURCE_VERSION__
 * @author Rcst20
 */
;(function () {
'use strict'
var lx = globalThis.lx
lx.on(lx.EVENT_NAMES.request, function () {
  return Promise.reject(new Error('音源直链已失效，请到 CurrentMusic 设置页重新获取'))
})
lx.send(lx.EVENT_NAMES.inited, {
  status: true,
  openDevTools: false,
  sources: {},
})
})()
""".lstrip("\n")


def build_expired_script() -> str:
    """令牌失效时下发的提示脚本（不含任何令牌，可安全公开返回）。"""
    return _EXPIRED_TEMPLATE.replace("__SOURCE_VERSION__", SOURCE_VERSION)
