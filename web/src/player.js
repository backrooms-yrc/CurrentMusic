// 播放引擎：单例 audio、队列、音质选择（默认自动最高，后端并行探测母带档）、循环/随机、MediaSession。
import { mdui } from './md.js';
import { api, auth, settings } from './api.js';
import { toast, tierLabel } from './ui.js';

const audio = new Audio();
audio.preload = 'auto';

// 调试/测试入口（未挂 DOM 的 audio 实例经此可达）
const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
function emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); }

export const player = {
  queue: [],
  index: -1,
  meta: null,
  urlInfo: null,
  // 播放模式四合一：list 列表循环 | one 单曲循环 | order 顺序播放 | shuffle 随机
  playMode: (() => {
    const m = localStorage.getItem('cm.playMode');
    if (m) return m;
    // 旧版 loop/shuffle 迁移
    if (localStorage.getItem('cm.shuffle') === '1') return 'shuffle';
    return localStorage.getItem('cm.loop') === 'one' ? 'one'
      : localStorage.getItem('cm.loop') === 'none' ? 'order' : 'list';
  })(),
  loading: false,

  playList(songs, startIndex = 0) {
    this.queue = songs.filter(Boolean).slice();
    if (this.playMode === 'shuffle' && startIndex === 0) startIndex = Math.floor(Math.random() * this.queue.length);
    this.playAt(startIndex);
    this.persist();
  },

  async playAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.meta = this.queue[i];
    this.urlInfo = null;
    this.loading = true;
    emit('song');
    emit('state');
    let info;
    try {
      info = await api.songUrl(this.meta.ncm_id, settings.quality);
    } catch (e) {
      this.loading = false;
      toast(`「${this.meta.name}」${e.message || '播放失败'}`);
      emit('song');
      // 自动跳下一首（避免队列卡死）
      if (this.queue.length > 1) setTimeout(() => this.next(true), 800);
      return;
    }
    if (!this.meta || this.queue[this.index] !== this.meta) return; // 已切歌
    this.urlInfo = info;
    this.loading = false;
    audio.src = info.url;
    audio.play().catch(() => toast('点击播放键开始播放'));
    emit('song');
    emit('state');
    this.report();
    this.persist();
    this.updateMediaSession();
  },

  async report() {
    if (!auth.token || !this.meta) return;
    try { await api.recordPlay(this.meta); } catch { /* 静默 */ }
  },

  toggle() {
    if (!this.urlInfo) { if (this.index === -1 && this.queue.length) this.playAt(0); return; }
    if (audio.paused) audio.play(); else audio.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.playMode === 'one' && auto) { audio.currentTime = 0; audio.play(); return; }
    let i = this.index;
    if (this.playMode === 'shuffle') i = Math.floor(Math.random() * this.queue.length);
    else if (i + 1 >= this.queue.length) {
      if (this.playMode === 'order' && auto) { audio.pause(); return; }
      i = 0;
    } else i++;
    this.playAt(i);
  },

  prev() {
    if (!this.queue.length) return;
    if (audio.currentTime > 4) { audio.currentTime = 0; return; }
    const i = this.playMode === 'shuffle'
      ? Math.floor(Math.random() * this.queue.length)
      : (this.index > 0 ? this.index - 1 : this.queue.length - 1);
    this.playAt(i);
  },

  seek(sec) { if (this.urlInfo && isFinite(sec)) audio.currentTime = sec; },

  setPlayMode(mode) {
    this.playMode = mode;
    localStorage.setItem('cm.playMode', mode);
    emit('state');
  },

  async changeQuality(level) {
    settings.quality = level;
    if (!this.meta) return;
    const at = audio.currentTime;
    const wasPlaying = !audio.paused;
    try {
      const info = await api.songUrl(this.meta.ncm_id, level);
      this.urlInfo = info;
      audio.src = info.url;
      audio.currentTime = at;
      if (wasPlaying) audio.play();
      emit('song');
      toast(`音质：${tierLabel(info.level)}`);
    } catch (e) { toast(e.message); }
  },

  persist() {
    try {
      localStorage.setItem('cm.lastq', JSON.stringify({ queue: this.queue.slice(0, 100), index: this.index }));
    } catch { /* 忽略超限 */ }
  },
  restore() {
    try {
      const d = JSON.parse(localStorage.getItem('cm.lastq'));
      if (d && d.queue && d.queue.length) { this.queue = d.queue; this.index = d.index; this.meta = this.queue[this.index] || null; }
    } catch { /* 忽略 */ }
  },

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.meta) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.meta.name,
        artist: this.meta.artists,
        album: this.meta.album,
        artwork: this.meta.pic ? [{ src: this.meta.pic, sizes: '300x300' }] : [],
      });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    } catch { /* 部分内核不支持 */ }
  },

  get audio() { return audio; },
};

audio.addEventListener('ended', () => player.next(true));
audio.addEventListener('timeupdate', () => emit('time'));
audio.addEventListener('play', () => { emit('state'); keepAlive(true); });
audio.addEventListener('pause', () => { emit('state'); keepAlive(false); });
audio.addEventListener('ended', () => keepAlive(false));

// 后台保活：播放中启动前台服务（通知+唤醒锁），暂停/结束即停
function keepAlive(on) {
  try { window.NativeApi && window.NativeApi.keepAlive && window.NativeApi.keepAlive(on); } catch { /* 非 App 环境 */ }
}
audio.addEventListener('error', () => { if (player.urlInfo) { toast('播放出错，尝试下一首'); player.next(true); } });

// 调试/测试入口
window.__cmPlayer = { audio, player };

// MDUI 主色（品牌紫）
if (mdui.setColorScheme) mdui.setColorScheme('#6750A4');
