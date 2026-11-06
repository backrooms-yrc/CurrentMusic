// 听歌房 API、实时信令和音频同步。
import { call, auth, settings } from './api.js';

// ---------- API 封装（统一走 api.js 的 call：App 内原生桥 / 浏览器 fetch） ----------
const R = (method, path) => (body) => call(method, path, { body, auth: true });

export const roomApi = {
  create: (opt) => R('POST', '/rooms')(opt),
  list: (scope, query = '', offset = 0) =>
    call('GET', `/rooms?scope=${scope}&query=${encodeURIComponent(query)}&limit=20&offset=${offset}`, { auth: true }),
  findByCode: (code) => call('GET', `/rooms/search?code=${encodeURIComponent(code)}`, { auth: true }),
  detail: (id) => call('GET', `/rooms/${id}`, { auth: true }),
  join: (id, password) => R('POST', `/rooms/${id}/join`)({ password }),
  leave: (id) => R('POST', `/rooms/${id}/leave`)({}),
  close: (id) => R('POST', `/rooms/${id}/close`)({}),
  reopen: (id) => R('POST', `/rooms/${id}/reopen`)({}),
  delete: (id) => R('DELETE', `/rooms/${id}`)(),
  bans: (id) => R('GET', `/rooms/${id}/bans`)(),
  unban: (id, userId) => R('DELETE', `/rooms/${id}/bans/${userId}`)(),
  kick: (id, userId, ban = false) => R('POST', `/rooms/${id}/kick`)({ userId, ban }),
  transfer: (id, userId) => R('POST', `/rooms/${id}/transfer`)({ userId }),
  setAdmin: (id, userId, on) => R('POST', `/rooms/${id}/admins`)({ userId, on }),
  settings: (id, fields) => R('POST', `/rooms/${id}/settings`)(fields),
  play: (id) => R('POST', `/rooms/${id}/play`)({}),
  pause: (id) => R('POST', `/rooms/${id}/pause`)({}),
  seek: (id, position) => R('POST', `/rooms/${id}/seek`)({ position }),
  next: (id, trackRevision) => R('POST', `/rooms/${id}/next`)({ trackRevision }),
  prev: (id, trackRevision) => R('POST', `/rooms/${id}/prev`)({ trackRevision }),
  reorder: (id, qid, index) => R('POST', `/rooms/${id}/queue/reorder`)({ qid, index }),
  queueAdd: (id, meta) => R('POST', `/rooms/${id}/queue`)({ meta }),
  approve: (id, qid) => R('POST', `/rooms/${id}/queue/${qid}/approve`)({}),
  reject: (id, qid) => R('POST', `/rooms/${id}/queue/${qid}/reject`)({}),
  removeItem: (id, qid) => call('DELETE', `/rooms/${id}/queue/${qid}`, { body: {}, auth: true }),
  renewStream: (id) => R('POST', `/rooms/${id}/stream/renew`)({}),
  syncTime: (id) => R('POST', `/rooms/${id}/sync`)({}),
  heartbeat: (id) => R('POST', `/rooms/${id}/heartbeat`)({}),
};

const TERMINAL = [401, 403, 404, 409];

export function openEventStream(roomId, since, { onEvent, onError, onOpen }) {
  let closed = false;
  let release = () => {};
  let last = since;
  const accept = (event) => {
    if (closed || !Number.isSafeInteger(event.seq)) return;
    if (event.type === 'reset') last = event.seq;
    else if (event.type !== 'close' && event.seq <= last) return;
    else last = Math.max(last, event.seq);
    onEvent(event.type, event);
  };
  const stop = () => { closed = true; release(); };

  const poll = async () => {
    release();
    let connected = false;
    while (!closed) {
      try {
        const d = await call('GET', `/rooms/${roomId}/events?since=${last}&wait=20`, { auth: true });
        if (closed) return;
        if (!connected) onOpen();
        connected = true;
        for (const event of d.events || []) accept(event);
      } catch (e) {
        if (closed) return;
        connected = false;
        onError(e);
        if (TERMINAL.includes(e.status)) return stop();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  };

  const path = `${settings.base}/live/${roomId}/events?since=${last}&sse=1`;
  // WebView 的原生 HTTP 桥支持带 Bearer 的长轮询和非 HTTPS 后端。
  if (!window.NativeApi && typeof ReadableStream !== 'undefined' && typeof AbortController !== 'undefined' && typeof TextDecoder !== 'undefined') {
    const controller = new AbortController();
    release = () => controller.abort();
    (async () => {
      try {
        const response = await fetch(path, {
          headers: { Authorization: 'Bearer ' + auth.token, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!response.ok || !response.body || !/^text\/event-stream/i.test(response.headers.get('Content-Type') || '')) {
          throw new Error('房间实时连接失败');
        }
        if (closed) return;
        onOpen();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!closed) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data:'));
            buffer = buffer.slice(end + 2);
            if (data) accept(JSON.parse(data.slice(5)));
          }
        }
      } catch (e) {
        if (!closed) onError(e);
      }
      if (!closed) poll();
    })();
  } else {
    poll();
  }
  return { close: stop };
}

// ---------- 时钟同步 ----------
export async function estimateClockOffset(roomId, active, samples = 3) {
  const results = [];
  for (let i = 0; i < samples && active(); i++) {
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

// 权威时间轴：起播前保持基准位置，开始后每秒纠正本地播放偏差。
export class RoomSync {
  constructor(audio, onStatus, onBlocked) {
    this.audio = audio;
    this.onStatus = onStatus;
    this.onBlocked = onBlocked;
    this.offset = 0;
    this.timeline = null;
    this.source = '';
    this.timer = 0;
    this.startTimer = 0;
    this.blocked = false;
    this.align = () => { this.seekTo(this.targetPosition()); this.tick(); };
    audio.addEventListener('loadedmetadata', this.align);
  }

  targetPosition() {
    const tl = this.timeline;
    if (!tl) return 0;
    const elapsed = tl.playing ? Math.max(0, Date.now() + this.offset - tl.baseAt) : 0;
    const duration = tl.trackMeta?.duration || Infinity;
    return Math.min(duration, tl.basePosition + elapsed);
  }

  start() { this.timer = setInterval(() => this.tick(), 1000); }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.startTimer);
    this.audio.removeEventListener('loadedmetadata', this.align);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  resume() {
    this.blocked = false;
    this.onBlocked(false);
    this.tick();
  }

  tick() {
    const tl = this.timeline;
    if (!tl) return;
    const a = this.audio;
    const desired = this.targetPosition();
    const duration = tl.trackMeta?.duration || (Number.isFinite(a.duration) ? a.duration * 1000 : 0);
    const active = tl.playing && Date.now() + this.offset >= tl.baseAt && (!duration || desired < duration);
    if (this.source && active && a.paused && !this.blocked && !this.playingRequest) {
      this.playingRequest = true;
      a.play().catch(e => {
        if (e.name === 'NotAllowedError') {
          this.blocked = true;
          this.onBlocked(true);
        }
      }).finally(() => { this.playingRequest = false; });
    } else if (!active && !a.paused) {
      a.pause();
    }

    const drift = a.readyState ? a.currentTime * 1000 - desired : 0;
    const abs = Math.abs(drift);
    if (active && abs >= 300 && abs < 600) {
      a.playbackRate = drift > 0 ? 0.96 : 1.04;
    } else {
      a.playbackRate = 1;
      if (abs >= (active ? 600 : 50)) this.seekTo(desired);
    }
    this.onStatus({ drift: Math.round(drift), position: desired, duration });
  }

  seekTo(ms) {
    if (!this.audio.readyState) return;
    const target = Math.min(ms / 1000, this.audio.duration || Infinity);
    if (Number.isFinite(target)) this.audio.currentTime = target;
  }

  applyTimeline(tl) {
    const changedTrack = tl.trackRevision !== this.timeline?.trackRevision;
    this.timeline = tl;
    const source = tl.stream?.url || '';
    if (source !== this.source) {
      this.source = source;
      if (source) this.audio.src = source;
      else {
        this.audio.removeAttribute('src');
        this.audio.load();
      }
    } else if (changedTrack) {
      this.seekTo(this.targetPosition());
    }
    clearTimeout(this.startTimer);
    const delay = tl.baseAt - (Date.now() + this.offset);
    if (tl.playing && delay > 0) this.startTimer = setTimeout(() => this.tick(), delay);
    this.tick();
  }
}
