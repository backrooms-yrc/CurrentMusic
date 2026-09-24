// 听歌房前端核心：API 封装 + SSE 事件流（原生桥/EventSource/长轮询三通道）+ 时钟同步 + 漂移纠正
import { call, auth, settings } from './api.js';
import { toast } from './ui.js';

// ---------- API 封装（统一走 api.js 的 call：App 内原生桥 / 浏览器 fetch） ----------
const R = (method, path) => (body) => call(method, path, { body, auth: true });

export const roomApi = {
  create: (opt) => R('POST', '/rooms')(opt),
  list: (query = '', limit = 20, offset = 0) =>
    call('GET', `/rooms?query=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`, { auth: true }),
  findByCode: (code) => call('GET', `/rooms/search?code=${encodeURIComponent(code)}`, { auth: true }),
  detail: (id) => call('GET', `/rooms/${id}`, { auth: true }),
  join: (id, password) => R('POST', `/rooms/${id}/join`)({ password }),
  leave: (id) => R('POST', `/rooms/${id}/leave`)({}),
  close: (id) => R('POST', `/rooms/${id}/close`)({}),
  kick: (id, userId, ban = false) => R('POST', `/rooms/${id}/kick`)({ userId, ban }),
  transfer: (id, userId) => R('POST', `/rooms/${id}/transfer`)({ userId }),
  setAdmin: (id, userId, on) => R('POST', `/rooms/${id}/admins`)({ userId, on }),
  settings: (id, fields) => R('POST', `/rooms/${id}/settings`)(fields),
  play: (id, position = 0) => R('POST', `/rooms/${id}/play`)({ position }),
  pause: (id) => R('POST', `/rooms/${id}/pause`)({}),
  seek: (id, position) => R('POST', `/rooms/${id}/seek`)({ position }),
  next: (id) => R('POST', `/rooms/${id}/next`)({}),
  prev: (id) => R('POST', `/rooms/${id}/prev`)({}),
  queueList: (id) => call('GET', `/rooms/${id}/queue`, { auth: true }),
  queueAdd: (id, meta) => R('POST', `/rooms/${id}/queue`)({ meta }),
  approve: (id, qid) => R('POST', `/rooms/${id}/queue/${qid}/approve`)({}),
  reject: (id, qid) => R('POST', `/rooms/${id}/queue/${qid}/reject`)({}),
  removeItem: (id, qid) => call('DELETE', `/rooms/${id}/queue/${qid}`, { body: {}, auth: true }),
  renewStream: (id) => R('POST', `/rooms/${id}/stream/renew`)({}),
  syncTime: (id) => R('POST', `/rooms/${id}/sync`)({}),
  heartbeat: (id) => R('POST', `/rooms/${id}/heartbeat`)({}),
};

// ---------- 事件流（三通道） ----------
/**
 * 打开房间事件流。优先级：
 *  1) App 内原生桥（NativeApi.sseOpen）—— 绕过 WebView 的混合内容/跨域限制
 *  2) 浏览器 EventSource —— 同源/带 CORS 的标准 SSE
 *  3) 长轮询 —— 兜底（2 秒一次，延迟略高）
 */
export function openEventStream(roomId, sinceSeq, handlers) {
  const { onEvent, onError, onOpen } = handlers;
  const base = settings.base;
  // EventSource 不能带 Authorization 头 → token 走查询参数（后端 require_user 已支持）
  const url = `${base}/live/${roomId}/events?since=${sinceSeq}&sse=1&token=${encodeURIComponent(auth.token || '')}`;
  let closed = false;
  let mode = '';

  // 1) 原生桥
  if (window.NativeApi && window.NativeApi.sseOpen) {
    mode = 'native';
    let seq = sinceSeq;
    window.__cmSseEvent = (rid, type, dataStr) => {
      if (closed || String(rid) !== String(roomId)) return;
      let payload = null;
      try { payload = JSON.parse(dataStr); } catch { return; }
      if (payload && payload.seq) seq = payload.seq;
      onEvent && onEvent(type, payload);
    };
    window.__cmSseState = (rid, state, detail) => {
      if (closed || String(rid) !== String(roomId)) return;
      if (state === 'open') onOpen && onOpen();
      else if (state === 'error') { onError && onError(new Error(detail || 'SSE 连接中断')); }
    };
    try {
      window.NativeApi.sseOpen(String(roomId), url, String(auth.token || ''));
    } catch (e) {
      onError && onError(e);
    }
    return {
      mode,
      close() { closed = true; try { window.NativeApi.sseClose(String(roomId)); } catch { /* 忽略 */ } },
    };
  }

  // 2) EventSource
  if (typeof EventSource !== 'undefined') {
    mode = 'sse';
    let es = null;
    try {
      es = new EventSource(url);
    } catch (e) {
      onError && onError(e);
      return { mode: 'none', close() {} };
    }
    es.onopen = () => onOpen && onOpen();
    es.onerror = () => {
      if (closed) return;
      onError && onError(new Error('SSE 断开，正在重连…'));
      // EventSource 自带重连（retry: 3000）
    };
    ['created', 'join', 'leave', 'queue', 'settings', 'play', 'pause', 'next', 'prev', 'seek', 'track', 'role', 'kick', 'transfer', 'close']
      .forEach(t => es.addEventListener(t, ev => {
        let payload = null;
        try { payload = JSON.parse(ev.data); } catch { return; }
        onEvent && onEvent(t, payload);
      }));
    return { mode, close() { closed = true; es.close(); } };
  }

  // 3) 长轮询兜底
  mode = 'poll';
  let last = sinceSeq;
  let stopped = false;
  (async function loop() {
    while (!stopped && !closed) {
      try {
        const d = await call('GET', `/rooms/${roomId}/events?since=${last}&wait=20&token=${encodeURIComponent(auth.token || '')}`, { auth: false });
        (d.events || []).forEach(e => { last = Math.max(last, e.seq); onEvent && onEvent(e.type, e); });
      } catch (e) {
        onError && onError(e);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();
  return { mode, close() { stopped = true; } };
}

// ---------- 时钟同步 ----------
export async function estimateClockOffset(roomId, samples = 5) {
  const results = [];
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    try {
      const d = await roomApi.syncTime(roomId);
      const t1 = Date.now();
      const rtt = t1 - t0;
      results.push({ rtt, offset: d.serverNow - (t0 + rtt / 2) });
    } catch { /* 单次失败忽略 */ }
    if (i < samples - 1) await new Promise(r => setTimeout(r, 180));
  }
  if (!results.length) return { offset: 0, rtt: 0, ok: false };
  results.sort((a, b) => a.rtt - b.rtt);
  const best = results[0];
  return { offset: best.offset, rtt: best.rtt, ok: true };
}

// ---------- 房间同步引擎 ----------
/**
 * 权威时间轴：pos(serverNow) = basePosition + (playing ? serverNow - baseAt : 0)
 * 三级漂移纠正：<300ms 不动 / 300~1200ms 速率微调 / >1200ms 硬 seek
 */
export class RoomSync {
  constructor(audio, roomId) {
    this.audio = audio;
    this.roomId = roomId;
    this.offset = 0;
    this.timeline = null;
    this.timer = 0;
    this.onStatus = null;      // (status) => void，用于 UI 展示偏差
    this._seekLockUntil = 0;
  }

  setTimeline(tl) {
    this.timeline = tl;
  }

  serverNow() { return Date.now() + this.offset; }

  /** 时间轴上的目标播放位置（ms） */
  targetPosition() {
    const tl = this.timeline;
    if (!tl) return 0;
    if (!tl.playing) return tl.basePosition || 0;
    return (tl.basePosition || 0) + Math.max(0, this.serverNow() - (tl.baseAt || 0));
  }

  start() {
    if (this.timer) return;
    this._alignTick = 0;
    this.timer = setInterval(() => {
      this.tick();
      if (++this._alignTick % 2 === 0) this.realign();   // 每 2 秒强制对齐一次
    }, 1000);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = 0;
  }

  tick() {
    const tl = this.timeline;
    const a = this.audio;
    if (!tl || !tl.trackNcmId) return;
    const desired = this.targetPosition();
    const hasSrc = !!a.src;
    if (!hasSrc) return;
    // 播放/暂停状态跟随
    if (tl.playing && a.paused && Date.now() > this._seekLockUntil) {
      a.play().catch(() => { /* 需用户手势，交给 UI 提示 */ });
    } else if (!tl.playing && !a.paused) {
      a.pause();
    }
    if (Number.isNaN(a.duration) || !a.duration) return;
    const cur = a.currentTime * 1000;
    const drift = cur - desired;
    const abs = Math.abs(drift);
    let mode = 'idle';
    if (abs < 300) {
      if (a.playbackRate !== 1) a.playbackRate = 1;
      mode = 'ok';
    } else if (abs < 600) {
      // 微调播放速率（±4%），快速向目标收敛
      a.playbackRate = drift > 0 ? 0.96 : 1.04;
      mode = 'rate';
    } else {
      // 偏差较大：直接对齐（避免速率微调需要几十秒才收敛）
      a.playbackRate = 1;
      this.seekTo(desired);
      mode = 'seek';
    }
    const dur = (tl.trackMeta && tl.trackMeta.duration) || a.duration * 1000;
    this.onStatus && this.onStatus({ drift: Math.round(drift), mode, position: desired, duration: dur });
  }

  seekTo(ms) {
    const a = this.audio;
    try {
      a.currentTime = Math.max(0, ms / 1000);
      this._seekLockUntil = Date.now() + 600;   // 避免 seek 期间被 play() 干扰
    } catch { /* 忽略 */ }
  }

  /** 切歌：换源并对齐位置（元数据就绪后再 seek —— 缓冲期 seek 会丢失，导致持续落后） */
  applyTrack(tl) {
    this.setTimeline(tl);
    const a = this.audio;
    const stream = tl.stream || {};
    if (!stream.url) return;
    const switched = a.dataset.ncmId !== String(tl.trackNcmId) || a.src !== stream.url;
    if (switched) {
      a.dataset.ncmId = String(tl.trackNcmId);
      a.src = stream.url;
      // 关键：媒体元数据/可播放就绪后再对齐，否则 seek 被丢弃
      const align = () => { this.seekTo(this.targetPosition()); };
      a.addEventListener('loadedmetadata', align, { once: true });
      a.addEventListener('canplay', align, { once: true });
    } else {
      this.seekTo(this.targetPosition());
    }
    if (tl.playing) a.play().catch(() => { /* 等用户手势 */ });
  }

  /** 播放中周期性重新对齐（媒体就绪后由 tick 调用；seek 失败会自动重试） */
  realign() {
    const tl = this.timeline;
    if (!tl || !tl.playing) return;
    const a = this.audio;
    if (a.readyState < 2) return;         // 尚未可播，等下一轮
    const drift = a.currentTime * 1000 - this.targetPosition();
    if (Math.abs(drift) > 400) this.seekTo(this.targetPosition());
  }
}
