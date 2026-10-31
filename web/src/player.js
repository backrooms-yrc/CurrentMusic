// 播放引擎：单例 audio、队列、音质选择（默认自动最高，后端并行探测母带档）、循环/随机、MediaSession。
import { mdui } from './md.js';
import { api, auth, settings, ncmSongs } from './api.js';
import { toast, tierLabel } from './ui.js';
import { resolveSongUrl } from './songurl.js';   // 三级音源回退（P2）
import { buildEqChain, removeEqChain } from './eq.js';   // 均衡器链（挂进音频图）

// 播放实际请求的档位：开了「音效」（杜比全景声/臻音全景声/沉浸环绕声/高清臻音）时
// 优先用音效档，否则用用户选的音质档。沉浸环绕声的声道类型（c51/ste）作为 immerse 传出。
export function playLevel() {
  const fx = settings.effect;
  if (fx && fx !== 'off') {
    if (fx === 'sky-ste') return { level: 'sky', immerse: 'ste' };
    return { level: fx, immerse: undefined };
  }
  return { level: settings.quality, immerse: undefined };
}
// 曾因漏 import 上线即 ReferenceError 全站无法播放——见 tools/check-js-refs.py

// ---------- 音频元素（可替换） ----------
// 为什么要"可替换"：可视化需要把 <audio> 接入 Web Audio 图，而**一旦接入，
// 元素音频就只走图输出**（不再直出）。若某个音源是跨域"污染"的（无 CORS 头），
// 图输入恒为静音 → 声音会彻底消失。所以遇到这种情况必须**换一个新元素**才能
// 恢复直出，不能只是断开节点。详见下文 loadUrl() 的 CORS 策略。
// 分析器档位（波形模块据此把 byte 还原成 dB 并做倾斜补偿）
const MIN_DB = -110, MAX_DB = -10;

let audio = makeAudio();

// Web Audio 分析器状态：analyser 非空即代表「可视化可用」
let actx = null, analyser = null, srcNode = null, graphEl = null;
let vizDisabled = false;      // 系统级不可用（无 AudioContext / 上下文起不来）→ 本次会话不再尝试
const corsFailHosts = {};     // 不支持 CORS 的**域名**（AI 审查建议：按域名降级，
                              // 换到别的 CDN 域名仍可尝试可视化，不因一次失败永久放弃）

/** 供可视化层读取频谱；不可用时返回 false（调用方据此画静默基线）。 */
export const wave = {
  get ready() { return !!analyser; },
  get bins() { return analyser ? analyser.frequencyBinCount : 1024; },
  get sampleRate() { return analyser ? analyser.context.sampleRate : 48000; },
  get minDb() { return MIN_DB; },
  get maxDb() { return MAX_DB; },
  read(u8) {
    if (!analyser || !actx || actx.state !== 'running') return false;
    try { analyser.getByteFrequencyData(u8); return true; } catch (e) { return false; }
  },
  /** 用户手势后恢复上下文（自动播放策略可能让新建的上下文停在 suspended）。 */
  resume() {
    resumeContext();
  },
};

// 必须在真实手势的同步调用栈里解锁，不能等音源解析/loadedmetadata 后才创建。
// Safari 从后台返回还可能处于 interrupted；保留同一个已解锁上下文供切歌复用。
function resumeContext() {
  try {
    if (actx && (actx.state === 'suspended' || actx.state === 'interrupted')) {
      const pending = actx.resume();
      if (pending && pending.catch) pending.catch(() => {});
    }
  } catch (e) { /* 下次手势重试，播放看门狗负责直出兜底 */ }
}

function unlockAudio(event) {
  if (!event.isTrusted) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!actx || actx.state === 'closed') actx = new AC();
    const ctx = actx;
    // resume() 可能异步完成；此处不创建/替换媒体元素，也不改变播放状态。
    Promise.resolve(ctx.resume()).then(() => {
      if (actx !== ctx || ctx.state !== 'running') return;
      vizDisabled = false;
      if (!graphEl && audio.crossOrigin && audio.readyState >= 1) buildGraph(audio);
      watchGraph();
    }).catch(() => {});
  } catch (e) { /* 不支持 Web Audio 时保留普通播放 */ }
}
['click', 'touchend', 'keydown'].forEach(type => {
  document.addEventListener(type, unlockAudio, { capture: true, passive: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) wave.resume();
});

// 音频图看门狗：**接了图之后声音只从图输出**——上下文一旦不在 running
// （后台挂起、系统回收、自动播放策略），用户就会"歌在放但没声音"。
// 持续巡检：能恢复就恢复，恢复不了就拆图换元素回到直出——宁可没可视化，不能没声音。
let watchTimer = 0, watchStrikes = 0;
function watchGraph() {
  if (watchTimer || !graphEl) return;
  watchStrikes = 0;
  watchTimer = setInterval(() => {
    if (!graphEl) { clearInterval(watchTimer); watchTimer = 0; return; }
    if (audio.paused) { watchStrikes = 0; return; }        // 暂停时上下文挂起属正常
    if (actx && actx.state === 'running') { watchStrikes = 0; return; }
    watchStrikes++;
    resumeContext();
    if (watchStrikes >= 2) {                                // 约 4s 仍未恢复 → 回退直出
      clearInterval(watchTimer); watchTimer = 0;
      fallbackNoViz();
    }
  }, 2000);
}

/** 丢弃一个音频元素：停播 + 清源。监听器都有 el!==audio 守卫，不会误触发换歌。 */
function disposeAudio(old) {
  try { old.pause(); } catch (e) { /* 忽略 */ }
  try { old.removeAttribute('src'); old.src = ''; old.load(); } catch (e) { /* 忽略 */ }
}

function teardownGraph({ keepContext = false } = {}) {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = 0; }
  try { if (srcNode) srcNode.disconnect(); } catch (e) { /* 忽略 */ }
  removeEqChain();                            // 均衡器链随图一起拆
  try { if (analyser) analyser.disconnect(); } catch (e) { /* 忽略 */ }
  try { if (!keepContext && actx && actx.close) actx.close().catch(() => {}); } catch (e) { /* 忽略 */ }
  if (!keepContext) actx = null;
  analyser = srcNode = null;
  graphEl = null;
}

/** 建图：**只在确认音源 CORS 干净之后**调用（否则会把声音吞掉）。 */
function buildGraph(el) {
  if (analyser || vizDisabled) return false;
  el = el || audio;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { vizDisabled = true; return false; }
  try {
    if (!actx || actx.state === 'closed') actx = new AC();
    srcNode = actx.createMediaElementSource(el);
    analyser = actx.createAnalyser();
    //  · fftSize 2048 → 频率分辨率更高，柱与柱之间过渡自然
    //  · smoothing 0.72 → FFT 层面的平滑（柱高另有一套快攻击/慢释放包络）
    analyser.fftSize = 2048;
    // 档位：**-110 ~ -10（100dB）**。原先 -85/-25 会把高频段（常见 -90dB 以下）
    // 直接截断成 0，右侧永远是平的、也没法用"频谱倾斜"抬起来。
    analyser.minDecibels = MIN_DB;
    analyser.maxDecibels = MAX_DB;
    analyser.smoothingTimeConstant = 0.72;
    // 均衡器链（src → [EQ] → analyser → destination）：图存在 EQ 才生效；
    // 增益由 eq.js 管理（预设/滑块实时改 .gain，不动图结构）
    const eqChain = buildEqChain(actx);
    if (eqChain) {
      srcNode.connect(eqChain.input);
      eqChain.output.connect(analyser);
    } else {
      srcNode.connect(analyser);
    }
    analyser.connect(actx.destination);      // 必须接回目的地，否则没声音
    graphEl = el;
  } catch (e) {
    teardownGraph();
    vizDisabled = true;
    return false;
  }
  // 上下文若因自动播放策略停在 suspended，图会静音 → 尝试恢复，失败则立刻拆图回退
  if (actx.state !== 'running') {
    resumeContext();
    const ctx = actx;
    setTimeout(() => {
      if (actx === ctx && ctx.state !== 'running' && !el.paused) fallbackNoViz();
    }, 1200);
  }
  return true;
}

/** 可视化不可用时的兜底：拆图重建元素，保住声音（位置与播放态尽量保留）。 */
function fallbackNoViz() {
  if (vizDisabled && !graphEl) return;
  vizDisabled = true;
  const pos = audio.currentTime || 0;
  const wasPlaying = !audio.paused;
  const url = audio.src;
  const cors = audio.crossOrigin;
  teardownGraph();
  disposeAudio(audio);
  const fresh = makeAudio();
  audio = fresh;
  fresh.crossOrigin = cors;                 // 下次真实手势仍可恢复安全音源的频谱
  if (url) {
    fresh.src = url;                       // 新元素直出，不再经过图
    try { if (pos > 0) fresh.currentTime = pos; } catch (e) { /* 元数据未就绪时忽略 */ }
    // 新元素上不会触发 pause，scheduleResume 不会自己跑 → 显式兜底重试
    if (wasPlaying) fresh.play().catch(() => scheduleResume());
  }
  emit('state');      // 通知 UI 重绘（元素换了、可视化已降级）
}

/** 取 URL 的域名（按域名记 CORS 失败）。 */
function hostOf(url) {
  try { return new URL(url, location.href).host; } catch (e) { return ''; }
}

/** 装载音源：带 crossOrigin 尝试（可视化前提），失败由 error 处理器回退。 */
let corsPending = null;         // 待回退重试的 { url, pos, host }（带 CORS 加载失败时用）
function loadUrl(url, pos) {
  corsPending = null;
  const host = hostOf(url);
  const badHost = !!(host && corsFailHosts[host]);   // 该域名已知不支持 CORS
  // 【危险路径防御】已知不支持 CORS 的域名 + 当前元素已挂音频图 → 必须**先换新元素**
  // 再普通加载。否则跨域污染的音源会让音频图输出静音，且**不会触发 error 事件**
  // （context.state 仍是 running，看门狗也发现不了）→ 表现为"歌在放但没声音"，
  // 是最难排查的一类故障。
  if (badHost && graphEl) { teardownGraph({ keepContext: true }); disposeAudio(audio); audio = makeAudio(); }
  if (!vizDisabled && !badHost) {
    audio.crossOrigin = 'anonymous';       // CDN 实测带 access-control-allow-origin: *
    corsPending = { url: url, pos: pos || 0, host: host };
  } else {
    audio.crossOrigin = null;              // 普通播放（该源无可视化）
  }
  audio.src = url;
  if (pos > 0) { try { audio.currentTime = pos; } catch (e) { /* 忽略 */ } }
}

function makeAudio() {
  const a = new Audio();
  a.preload = 'auto';
  bindAudio(a);
  return a;
}

// ---------- 自适应缓冲（v1.28.26 重写） ----------
// v1.28.25 的教训：固定「起播缓冲 20%」对快线是无谓等待、对慢线是攒不够的
// 死等；「缓冲完整才预取」让中等线路的下一首永远冷启动。本版改为一切由
// **实测速率**驱动：
//
//   dlRate = 缓冲增长速度（媒体秒 / 墙秒），每秒采样、EMA 平滑、跨曲记忆。
//   dlRate ≥ 1 线路养得起当前码率，< 1 迟早追尾——攒缓冲救不了它，降档才能。
//
// 由此推导的四条行为：
//   1. 起播只等 6~20s 余量（按 dlRate 取值，硬上限 8s 墙钟）——快线近乎秒开；
//   2. 播放中 dlRate 持续 < 0.95 → **断流之前**主动无缝降档（不再等两次卡顿）；
//   3. dlRate 长期 > 2.2 → 自动回升一档（此前降过的）；
//   4. 预取下一首的触发与配额按 dlRate 定：快线歌中段就绪、慢线自动让路。
const bufMon = {
  ema: 0, warm: false, samples: 0,     // warm=样本够多，ema 可信
  _ahead: -1, _t: 0,
  /** 每秒喂一次「播放头前方余量（秒）」；仅在余量增长时取样（=纯下载进度）。 */
  note(ahead) {
    const now = Date.now();
    if (this._ahead >= 0 && ahead > this._ahead) {
      const dt = (now - this._t) / 1000;
      if (dt > 0.3 && dt < 5) {
        const r = (ahead - this._ahead) / dt;      // 媒体秒/墙秒
        this.ema = this.warm ? this.ema * 0.7 + r * 0.3 : r;
        if (++this.samples >= 3) this.warm = true;
      }
    }
    this._ahead = ahead; this._t = now;
  },
  /** 换线/换档/换歌后重置**本曲**状态；ema 与 warm 保留（跨曲记忆线路质量）。 */
  reset() { this._ahead = -1; },
  rate() { return this.warm ? this.ema : 0; },     // 0 = 还没把握，按乐观处理
};

/** 等到播放头前方攒够 targetS 秒（或超过 maxWaitS 墙钟，带着已有余量开播）。 */
function waitAhead(targetS, maxWaitS) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      let ahead = 0;
      try {
        const b = audio.buffered;
        if (b && b.length) ahead = Math.max(0, b.end(b.length - 1) - (audio.currentTime || 0));
      } catch (e) { /* 忽略 */ }
      if (ahead >= targetS || Date.now() - t0 >= maxWaitS * 1000) { clearInterval(iv); resolve(); }
    }, 200);
  });
}

/** 起播目标余量：没历史 6s（快速出声优先）；快线 6s；中速 12s；慢线 20s。 */
function startTarget() {
  const r = bufMon.rate();
  if (!bufMon.warm || r >= 2) return 6;
  if (r >= 1.2) return 12;
  return 20;
}

// 每秒一次：喂速率监测器。dlRate 只用于**起播余量与预取配额**的 sizing
// （v1.28.28 起自动降级机制已移除：音质档位完全由用户设置决定，线路养
// 不起时依靠换线自愈 + 预缓冲兜底，不再悄悄改档）。
setInterval(() => {
  if (clock() || !audio.currentSrc) return;
  try {
    const b = audio.buffered;
    if (b && b.length) bufMon.note(Math.max(0, b.end(b.length - 1) - (audio.currentTime || 0)));
  } catch (e) { /* 忽略 */ }
}, 1000);

// ---------- 线路优选（v1.28.29）：进站即测、整会话锁定 ----------
// 设计：不再「卡了才换线」。本会话第一次播放（以及第一次遇到另一个边缘族）时，
// 从**用户侧**并行实测各条已验证 CDN 边缘的速度（各拉 256KB，总计约 1MB 出头，
// 每族每会话只测一次），锁定最快的一条；此后会话内所有取流（正播/预取/换档/
// 卡顿重连）都走这条线，刷新页面/重开 App 才重测。
// 为什么在客户端测：服务端只做「哪些入口可换」的字节级验证（alts），**快不快只有
// 用户自己测得准**——服务器在洛杉矶，它的体感与用户无关。
// 为什么按族记忆：两族边缘（m7/m8/m9 与 m701~m804）互不相通，锁定的最优线只对
// 同族对象有效；swapLine 会在「不在已验证候选里」时放弃换线，绝不硬换。
const PROBE_BYTES = 262144;                   // 每条线拉 256KB：够分高下，不偷太多流量
function famOf(h) { return /^m\d\./.test(h) ? 'f2' : /^m\d{3}\./.test(h) ? 'f3' : ''; }
function withHost(url, host) { return url.replace(/^https?:\/\/[^/]+/, 'https://' + host); }
const lineBest = { byFam: {}, probing: {} };  // fam → 最优 host；probing 防同族并发探测
async function probeLines(info) {
  const fam = famOf(info.host || '');
  const cands = [...new Set([info.host, ...(info.hosts || [])])].filter(Boolean);
  if (!fam || cands.length < 2 || lineBest.byFam[fam] || lineBest.probing[fam]) return;
  lineBest.probing[fam] = true;
  try {
    const ranked = await Promise.all(cands.map(async h => {
      const t0 = performance.now();
      try {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(withHost(info.url, h),
          { headers: { Range: `bytes=0-${PROBE_BYTES - 1}` }, signal: ctl.signal, cache: 'no-store' });
        const buf = await r.arrayBuffer();
        clearTimeout(to);
        return { h, ms: buf.byteLength > 0 ? performance.now() - t0 : Infinity };
      } catch (e) { return { h, ms: Infinity }; }
    }));
    ranked.sort((a, b) => a.ms - b.ms);
    if (ranked[0].ms < Infinity) lineBest.byFam[fam] = ranked[0].h;
  } finally { delete lineBest.probing[fam]; }
}
/** 本会话已锁定且对该对象有效的更优线路：返回换线后的 URL，否则 null。 */
function swapLine(info) {
  if (!info || !info.host) return null;
  const best = lineBest.byFam[famOf(info.host)];
  if (!best || best === info.host || !(info.hosts || []).includes(best)) return null;
  return withHost(info.url, best);
}

// ---------- 未登录播放拦截（v1.28.34） ----------
// 音源自 v1.28.33 起仅对注册用户开放。游客点播放时**不能**再走「解析失败 → toast →
// 自动跳下一首」那条烂路径（会连续报错并跳歌），改为弹一次登录提示、原地停住。
// 同一时间只允许一个弹窗（用户可能会连点多个歌曲）。
let loginPromptOpen = false;
export function promptLogin(reason) {
  if (loginPromptOpen) return null;
  loginPromptOpen = true;
  return mdui.dialog({
    headline: '需要登录才能播放',
    body: `<div class="cm-login-req">
        <span class="material-icons-outlined">lock_person</span>
        <div>${reason || '音源仅对注册用户开放。登录后即可播放歌曲，歌单与听歌记录也会自动同步。'}</div>
      </div>`,
    actions: [
      { text: '以后再说' },
      { text: '去登录', onClick: () => { location.hash = '#/user'; } },
    ],
    onClose: () => { loginPromptOpen = false; },
  });
}

// 调试/测试入口（未挂 DOM 的 audio 实例经此可达）
const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
function emit(evt, data) { (listeners[evt] || []).forEach(fn => fn(data)); }
/** 供外部触发一次时间刷新（投屏时本机没有 timeupdate，由投屏侧按帧驱动）。 */
// 页面被隐藏/切走（切后台、锁屏、关闭标签）时立即结账：不依赖 timeupdate 继续触发
document.addEventListener('visibilitychange', () => { if (document.hidden) flushListen(); });

export function tick() {
  accumulateCast();              // 投屏：本机 audio 不前进，按设备播放态用墙钟累计
  maybeFlushListen();
  emit('time');
}
/** 供外部触发一次状态刷新（投屏时设备端播放态变化，需重绘播放键图标）。 */
export function notifyState() { emit('state'); }

// 播放时钟外部接管（DLNA 投屏）：投屏时本机音频暂停，audio.currentTime 不前进，
// 若不接管，进度条与歌词都会停在原地（用户反馈的「歌词不跟随滚动」）。
let clockSource = null;
export function setClockSource(fn) { clockSource = fn; }
const clock = () => (typeof clockSource === 'function' ? clockSource() : null);

// 高解析度档位提示：192kHz/24bit 母带、96kHz、多声道全景声对**设备解码与重采样**
// 要求高，部分机型会出现杂音（用户反馈的"爆音"多为此类）。每个会话提示一次，
// 不反复打扰；规格来自服务端解析的文件头（sr/bits/ch），拿不到就不提示。
let hiresWarned = false;
function warnHiRes(info) {
  if (hiresWarned || !info) return;
  const sr = info.sr || 0, ch = info.ch || 0;
  if (sr <= 48000 && ch <= 2) return;            // 常规档位：不打扰
  hiresWarned = true;
  const spec = [
    sr ? (sr % 1000 === 0 ? (sr / 1000) + 'kHz' : (sr / 1000).toFixed(1) + 'kHz') : '',
    info.bits ? info.bits + 'bit' : '',
    ch > 2 ? ch + '声道' : '',
  ].filter(Boolean).join('/');
  const name = tierLabel(info.level) || '该音质';
  setTimeout(() => {
    toast(`${name}${spec ? '（' + spec + '）' : ''}对设备要求较高，若出现杂音可在音质中切到「无损 FLAC」`);
  }, 1500);
}

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

  // ---------- 心动模式（/playmode/intelligence/list）----------
  // 与上面「播放模式四合一」正交：那四个管**队列怎么轮**，这个管**队列怎么续**。
  // 开启后，队列快见底时自动以当前曲目为种子取一批续播追加到队尾，实现持续智能播放。
  // 下一首预取：提前解析地址并按网络情况预拉（见 _prefetchNext）
  _prefetch: null,
  _prefetchBusy: false,

  /** 已缓冲到的百分比（进度条据此画出缓冲区间）。 */
  bufferPct() { updateBufPct(); return bufPct; },
  /** 是否正在卡顿（UI 显示"缓冲中"）。 */
  get stalling() { return stallNotified; },

  /**
   * 提前解析下一首的播放地址，并按网络情况用隐藏 audio 预拉**有限的一段**。
   * 省流模式与 2G/3G 下直接跳过——宁可慢一点，也不偷跑用户流量。
   * 无论是否预拉成功，"地址已解析"本身就省掉了切歌时的一次往返。
   *
   * 两条硬约束（v1.28.24 起，"节点选对了还卡"的教训）：
   * 1) 预取限量按实测速率定（v1.28.26）：快线约 90s 音频/45s 墙钟，其余 45s/25s
   *    ——即便不抢带宽也绝不允许无上限下载（母带近 200MB）；
   * 2) 取消即停：换目标 / 切歌消费时必须显式 dispose 旧元素——丢引用
   *    **不会**停止后台下载，孤儿下载与正播抢带宽正是卡顿元凶之一。
   */
  async _prefetchNext() {
    if (!this.queue.length || this._prefetchBusy) return;
    const nx = this.queue[this.index + 1] || this.queue[0];
    if (!nx || !nx.ncm_id) return;
    if (this._prefetch && String(this._prefetch.id) === String(nx.ncm_id)) return;
    try {
      const c = navigator.connection || navigator.mozConnection || {};
      if (c.saveData) return;
      if (c.effectiveType && /(^|-)2g$|(^|-)3g$/.test(c.effectiveType)) return;
    } catch { /* 忽略 */ }
    this._prefetchBusy = true;
    try {
      const _pl = effectiveLevel();
      let info;
      try {
        info = await resolveSongUrl(nx, _pl.level, _pl.immerse);
      } catch (e) {
        if (_pl.level !== settings.quality) {
          toast('该音效当前不可用，已回退普通音质');
          info = await resolveSongUrl(nx, settings.quality);
        } else throw e;
      }
      // 期间可能已切歌或又预取了别的：过期结果直接丢弃
      const still = this.queue[this.index + 1] || this.queue[0];
      if (!still || String(still.ncm_id) !== String(nx.ncm_id)) return;
      this._discardPrefetch();               // 换目标：旧元素的下载立即停
      const el = new Audio();
      el.preload = 'auto';
      el.muted = true;                       // 不发声（也不接 Web Audio 图）
      try { el.src = info.url; el.load(); } catch { /* 忽略 */ }
      // 限量按实测速率：快线（dlRate≥2.5）给 90s/45s，其余 45s/25s。
      // 已缓冲的字节留在浏览器媒体缓存里，主元素播同一 URL 仍可复用。
      const fast = bufMon.warm && bufMon.rate() >= 2.5;
      const capAudio = fast ? 90 : 45, capWall = fast ? 45 : 25;
      const stop = () => {
        clearInterval(iv); clearTimeout(hardStop);
        disposeAudio(el);
        if (player._prefetch && player._prefetch.el === el) player._prefetch.el = null;
      };
      const iv = setInterval(() => {
        try {
          if (el.buffered && el.buffered.length && el.buffered.end(el.buffered.length - 1) >= capAudio) stop();
        } catch (e) { /* 忽略 */ }
      }, 2000);
      const hardStop = setTimeout(stop, capWall * 1000);
      // 线路优选：预取也走锁定的最优线（warm 的字节要能被正播复用，必须同一条线）
      const swapPf = swapLine(info);
      if (swapPf) info.url = swapPf;
      this._prefetch = { id: nx.ncm_id, url: info.url, type: info.type, level: info.level,
                         host: info.host, hosts: info.hosts, el };
    } catch { /* 预取失败不影响正常播放 */ }
    finally { this._prefetchBusy = false; }
  },

  /** 终止预取元素的后台下载（保留已解析的地址与已缓冲字节，只停网络抓取）。 */
  _discardPrefetch() {
    const pf = this._prefetch;
    if (pf && pf.el) { disposeAudio(pf.el); pf.el = null; }
  },

  heartMode: localStorage.getItem('cm.heart') === '1',
  _heartBusy: false,
  _heartMiss: 0,          // 连续取不到新曲目的次数（上游异常时不无脑续）
  _heartErr: '',

  setHeartMode(on) {
    this.heartMode = !!on;
    try { localStorage.setItem('cm.heart', this.heartMode ? '1' : '0'); } catch { /* 忽略 */ }
    if (this.heartMode) { this._heartMiss = 0; this._heartErr = ''; }
    emit('state');
    return this.heartMode;
  },
  toggleHeartMode() { return this.setHeartMode(!this.heartMode); },

  _heartPidCache: null,

  /**
   * 心动模式要的「上游歌单 id」：**只支持「我喜欢的音乐」（specialType=5）**。
   * 实测：pid 留空 → 400 参数错误；传普通自建歌单 → 400 不支持该歌单类型；
   * 传我喜欢 → 200 并返回一个 150 首的池子（其中约一半 recommended=true）。
   * 故这里先解析出本人「我喜欢的音乐」的歌单 id 并缓存。
   */
  async _heartPid() {
    if (this._heartPidCache) return this._heartPidCache;
    const st = await api.bindStatus();                 // 项目专用入口（T3 那条不泛化转发）
    const uid = ((st || {}).profile || {}).uid;
    if (!uid) throw new Error('需要先绑定网易云账号');
    const d = await api.ncm('/user/playlist', { uid, limit: 200 });
    const liked = (d.playlist || []).find(x => x && !x.subscribed && Number(x.specialType) === 5);
    if (!liked) throw new Error('没找到「我喜欢的音乐」（心动模式只支持这个歌单类型）');
    this._heartPidCache = liked.id;
    return liked.id;
  },

  /**
   * 取一批心动推荐（已剔除队内已有曲目）。公开：播客页要展示同一份列表，
   * 复用这里才能避免「pid 解析」与「songInfo 解包」两处各错一遍。
   */
  async heartList(seedId, count = 10) {
    const pid = await this._heartPid();
    const d = await api.ncm('/playmode/intelligence/list', { id: seedId, sid: seedId, pid, count });
    // 上游返回的是 { alg, id, recommended, songInfo } 包装：歌曲本体在 songInfo 里，
    // 直接对 data 调 ncmSongs 会全部映射成空（原实现取不到数据的第二个原因）。
    const raw = (d.data || []).map(x => (x && x.songInfo) ? x.songInfo : x);
    const have = new Set(this.queue.map(x => x && String(x.ncm_id)));
    return ncmSongs(raw).filter(x => x && x.ncm_id && !have.has(String(x.ncm_id))).slice(0, count);
  },

  /** 心动模式：以 seed（默认当前曲目）为种子续一批到队尾，返回新增条数。 */
  async heartExtend(seed) {
    if (this._heartBusy) return 0;
    const id = ((seed || this.meta) || {}).ncm_id;
    if (!id) return 0;
    this._heartBusy = true;
    try {
      const fresh = await this.heartList(id);
      if (!fresh.length) { this._heartMiss++; this._heartErr = '上游没有返回新的续播推荐'; return 0; }
      this.queue.push(...fresh);
      this._heartMiss = 0; this._heartErr = '';
      this.persist();
      emit('song');                      // 播放列表与角标刷新
      toast(`心动模式：续上 ${fresh.length} 首`);
      return fresh.length;
    } catch (e) {
      this._heartMiss++;
      this._heartErr = (e && e.message) || '取续播推荐失败';
      return 0;
    } finally { this._heartBusy = false; }
  },

  /** 队列快见底就提前续（异步补齐，不阻塞切歌）。 */
  _heartEnsure() {
    if (!this.heartMode || this._heartBusy) return;
    if (this._heartMiss >= 3) return;                 // 连续失败：停手，不给上游刷请求
    if (this.queue.length - this.index > 3) return;   // 还够听
    this.heartExtend(this.meta);
  },

  /** 以某首歌为种子开播心动模式（歌曲详情页 / 发现页 / 私人 FM 都走这里）。 */
  async startHeart(seed) {
    if (!seed || !seed.ncm_id) { toast('这首没有可用的网易云曲目 ID'); return false; }
    this.setHeartMode(true);
    this._heartMiss = 0; this._heartErr = '';
    let fresh = [];
    try {
      fresh = await this.heartList(seed.ncm_id, 12);
    } catch (e) {
      toast((e && e.message) || '心动模式取歌失败');
      this.playList([seed], 0);
      return false;
    }
    const rest = fresh.filter(x => String(x.ncm_id) !== String(seed.ncm_id));
    this.playList([seed, ...rest], 0);
    toast(rest.length ? `心动模式：已开播 ${rest.length + 1} 首，播完自动续` : '心动模式：暂时没取到续播，先播这首');
    return true;
  },

  playList(songs, startIndex = 0) {
    this.queue = songs.filter(Boolean).slice();
    if (this.playMode === 'shuffle' && startIndex === 0) startIndex = Math.floor(Math.random() * this.queue.length);
    this.playAt(startIndex);
    this.persist();
  },

  async playAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    if (!auth.token) {                     // 游客：弹登录提示，不解析音源
      this.loading = false;
      this.wantPlaying = false;
      emit('state');
      promptLogin();
      return;
    }
    flushListen();                 // 上一首结账（此刻 meta 还是旧的那首）
    lastTickT = -1;                // 新歌重置基准，避免把两首之间的间隔算进去
    this.index = i;
    this.meta = this.queue[i];
    this.urlInfo = null;
    // 切到别的歌：预取元素的下载立即停（若预取目标恰好是本首，留着给消费处复用）
    if (this._prefetch && String(this._prefetch.id) !== String(this.meta.ncm_id)) this._discardPrefetch();
    this.loading = true;
    emit('song');
    emit('state');
    if (clock()) {
      // 投屏中：声音由设备输出。这里只更新队列/元数据与界面，
      // 既不取本机播放地址也不本地播放（否则手机会与电视同时出声）。
      this.loading = false;
      this.report();
      this.persist();
      this.updateMediaSession();
      this._heartEnsure();          // 投屏中同样要续队列
      return;
    }
    let info;
    try {
      const pf = this._prefetch;
      if (pf && String(pf.id) === String(this.meta.ncm_id) && pf.url) {
        info = { url: pf.url, type: pf.type || 'mp3', level: pf.level || 'auto',
                 host: pf.host, hosts: pf.hosts };
        // 用完即弃：已缓冲字节留在媒体缓存供主元素复用，下载立即终止
        this._discardPrefetch();
        this._prefetch = null;
      } else {
        const _pl2 = effectiveLevel();
        try {
          info = await resolveSongUrl(this.meta, _pl2.level, _pl2.immerse);
        } catch (e) {
          if (_pl2.level !== settings.quality) {
            toast('该音效当前不可用，已回退普通音质');
            info = await resolveSongUrl(this.meta, settings.quality);
          } else throw e;
        }
      }
    } catch (e) {
      this.loading = false;
      if (e && e.status === 401) {         // 登录失效/未登录：提示登录，不当作播放失败跳歌
        this.wantPlaying = false;
        emit('song');
        emit('state');
        // token 已被统一登出流程清掉时，失效弹窗由主入口负责，这里不重复弹
        if (auth.token) promptLogin('登录已失效，请重新登录后再播放。');
        return;
      }
      toast(`「${this.meta.name}」${e.message || '播放失败'}`);
      emit('song');
      // 解析失败与 audio error 是两条失败路径，都要计入熔断
      // （否则整队解析失败时仍会「失败→换下一首→再失败」无限循环）
      errStreak++;
      const cap = Math.min(3, Math.max(1, this.queue.length));
      if (errStreak >= cap) {
        errStreak = 0;
        this.wantPlaying = false;
        return;
      }
      // 自动跳下一首（避免队列卡死）
      if (this.queue.length > 1) setTimeout(() => this.next(true), 800);
      return;
    }
    if (!this.meta || this.queue[this.index] !== this.meta) return; // 已切歌
    this.urlInfo = info;
    this.loading = false;
    warnHiRes(info);               // 192kHz/多声道档位：提示设备兼容性
    // 线路优选：本会话首次遇到该族 → 后台实测（与起播缓冲并行，不添延迟）；
    // 已锁定（第 2 首起）→ 直接装载到最优线
    if (info.host) probeLines(info);
    const better = swapLine(info);
    if (better) info.url = better;
    loadUrl(info.url, 0);          // 优先 CORS 干净加载（可视化前提），失败自动回退
    this.wantPlaying = true;
    // 起播前攒少量余量（按实测速率 6~20s，硬上限 8s）——快速出声优先
    emit('stalling', true);
    const cur = info;
    waitAhead(startTarget(), 8).then(async () => {
      if (this.urlInfo !== cur) return;      // 已切歌：别动新歌的缓冲中状态
      const swap2 = swapLine(cur);           // 预缓冲期间探测完成：起播前就换到最优线
      if (swap2) {
        cur.url = swap2;
        loadUrl(swap2, 0);
        await waitAhead(startTarget(), 8);
        if (this.urlInfo !== cur) return;
      }
      emit('stalling', false);
      if (this.wantPlaying) audio.play().catch(() => toast('点击播放键开始播放'));
    });
    emit('song');
    emit('state');
    this._scrobbled = null;
    this.report();
    this.persist();
    this.updateMediaSession();
    this._heartEnsure();            // 队列快见底就提前续（心动模式）
  },

  async report() {
    if (!auth.token || !this.meta) return;
    try { await api.recordPlay(this.meta); } catch { /* 静默 */ }
    // 听歌打卡（/scrobble）延后到「听够一半或 30 秒」再发，避免只点一下就污染网易云历史
    this._scrobblePending = { id: this.meta.ncm_id, at: Date.now() };
  },

  /** 听歌打卡：达到阈值后每首只报一次；未绑定网易云时静默跳过（401）。
   *  优先用新版 /scrobble/v1（字段更全，能带上歌曲名/歌手/码率），失败回退旧版。 */
  async scrobble() {
    const pend = this._scrobblePending;
    if (!pend || !auth.token) return;
    if (this._scrobbled === pend.id) return;
    const m = this.meta || {};
    const sec = Math.floor(this.position() / 1000);
    const src = (this.queue && this.queue[this.index] && this.queue[this.index].source_pl_id) || 0;
    try {
      await api.ncm('/scrobble/v1', {
        id: pend.id, sourceid: src || 0, time: sec, source: 'list',
        name: m.name || '', artist: m.artists || '',
        bitrate: 320000, level: 'exhigh', total: Math.floor((m.duration || 0) / 1000),
        confirm: 1,
      });
      this._scrobbled = pend.id;
    } catch {
      try {
        await api.ncm('/scrobble', { id: pend.id, sourceid: src || 0, time: sec, confirm: 1 });
        this._scrobbled = pend.id;
      } catch { /* 未绑定/风控：不打扰用户 */ }
    }
    // 播放状态上报（网易云「一起听」链路；失败无副作用）
    try {
      if (!this._relaySession) {
        this._relaySession = Array.from({ length: 12 },
          () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 36)]).join('');
      }
      await api.ncm('/relay/play/state/submit', {
        id: pend.id, sessionId: this._relaySession, progress: sec, playMode: 'list_loop', type: 'song', confirm: 1,
      });
    } catch { /* 忽略 */ }
  },

  // wantPlaying：我们「期望」的播放状态。系统打断（音频焦点被抢、锁屏瞬断、车机接管）
  // 会触发 pause，若不自动恢复就表现为「锁屏播放突然暂停」。
  wantPlaying: false,

  play() {
    if (!auth.token && !this.urlInfo) { promptLogin(); return; }
    if (!this.urlInfo) {
      // urlInfo 不持久化：重启后 restore() 只恢复了队列与元数据。
      // 此时按播放应当对**当前曲目**重新解析——原先只在 index === -1 时
      // 才 playAt(0)，index 有效时直接 return，表现为
      // 「退出软件重进后点迷你条/播放键没有任何反应」。
      if (this.index >= 0 && this.meta) this.playAt(this.index);
      else if (this.index === -1 && this.queue.length) this.playAt(0);
      return;
    }
    this.wantPlaying = true;
    audio.play().catch(() => { /* 交由 paused 兜底重试 */ });
  },

  pause() {
    this.wantPlaying = false;
    audio.pause();
  },

  toggle() {
    if (this.audio.paused) this.play(); else this.pause();
  },

  next(auto = false) {
    if (!this.queue.length) return;
    if (this.playMode === 'one' && auto) {
      if (clock()) { this.playAt(this.index); return; }   // 投屏中：重投同一首（不本地播放）
      audio.currentTime = 0; audio.play(); return;
    }
    let i = this.index;
    if (this.playMode === 'shuffle') i = Math.floor(Math.random() * this.queue.length);
    else if (i + 1 >= this.queue.length) {
      if (this.playMode === 'order' && auto) { this.pause(); stopPlayback(); return; }
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

  /** 当前播放位置（毫秒）：投屏时取设备上报值，否则取本机音频。 */
  posMs() {
    const c = clock();
    return c ? c.posMs : (this.audio.currentTime || 0) * 1000;
  },

  /** 当前曲目总长（毫秒）。 */
  durMs() {
    const c = clock();
    if (c && c.durMs > 0) return c.durMs;
    return (isFinite(this.audio.duration) && this.audio.duration > 0)
      ? this.audio.duration * 1000 : (this.meta && this.meta.duration) || 0;
  },

  /** 是否正在播放（投屏时以设备状态为准，否则看本机音频）。 */
  isPlaying() {
    const c = clock();
    return c ? c.playing : !this.audio.paused;
  },

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
      const info = await resolveSongUrl(this.meta, level);
      const betterQ = swapLine(info);        // 换档也落在锁定的最优线上
      if (betterQ) info.url = betterQ;
      this.urlInfo = info;
      loadUrl(info.url, at);       // 换档保留播放位置
      if (wasPlaying) {            // 换档同样先攒少量余量再续播
        emit('stalling', true);
        const cur = info;
        waitAhead(8, 6).then(() => {
          if (this.urlInfo !== cur) return;
          emit('stalling', false);
          audio.play().catch(() => {});
        });
      }
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
    if (!this.meta) return;
    const b = window.NativeApi;
    // App 内：走原生 MediaSession（通知栏常驻媒体信息 + 蓝牙 AVRCP 曲目/进度）
    if (b && b.mediaMeta) {
      try {
        // 时长单位是毫秒：meta.duration 来自 NCM 的 dt（本就为 ms），不可再乘 1000
        // （曾错乘一次 → 蓝牙/车机把 9 分 36 秒的歌显示成 160 小时）；
        // 优先用 <audio> 实测时长（更准，且能纠正元数据缺失/偏差）
        const durMs = Math.round(isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : (this.meta.duration || 0));
        b.mediaMeta(this.meta.name || '', this.meta.artists || '', this.meta.album || '',
          durMs, this.meta.pic || '');
        b.mediaState(!audio.paused, Math.round(audio.currentTime * 1000));
        return;
      } catch { /* 桥异常时回退浏览器 MediaSession */ }
    }
    if (!('mediaSession' in navigator)) return;
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

  /** 原生 MediaSession 播放态同步（通知按钮态/蓝牙进度）。App 外静默。 */
  pushMediaState() {
    const b = window.NativeApi;
    if (b && b.mediaState) {
      try { b.mediaState(!audio.paused, Math.round(audio.currentTime * 1000)); } catch { /* 忽略 */ }
    }
  },

  get audio() { return audio; },
};

// ---------- 实际收听时长（给「听歌时长」统计用）----------
// 旧口径是"开始播放就把整首时长记进去"：跳歌按整首计（虚高），同一首重播只留最后一条
// 记录（虚低），跟真实收听无关。现在只统计**真的在播**的时间：
//   · timeupdate 按 currentTime 的前进量累加；暂停、拖动、后台挂起都不计
//   · 每 30s 冲一次增量；切歌 / 暂停 / 播放结束 / 页面隐藏时补冲，避免丢时长
//   · 投屏时本机 audio 不前进，改由 tick()（投屏侧驱动）按设备播放态用墙钟累计
let listenedMs = 0;          // 待上报的毫秒增量
let lastTickT = -1;          // 上次 timeupdate 的 currentTime（秒）
let lastFlushAt = 0;
let lastCastAt = 0;

function accumulateLocal(el) {
  if (el.paused || el.seeking) { lastTickT = el.currentTime; return; }
  const t = el.currentTime;
  if (lastTickT >= 0 && t > lastTickT) {
    const d = (t - lastTickT) * 1000;
    // 单次跳变过大（后台被挂起后恢复、时钟抖动）不计，否则会凭空多出时长
    if (d > 0 && d <= 3000) listenedMs += d;
  }
  lastTickT = t;
}

function accumulateCast() {
  const c = clock();
  const now = Date.now();
  if (c && c.playing) {
    const d = now - lastCastAt;
    if (lastCastAt && d > 0 && d <= 5000) listenedMs += d;
  }
  lastCastAt = now;
}

/** 把增量上报给后端；失败则留着下次一起报（不丢时长）。不足 1s 不值得发。 */
async function flushListen() {
  const id = player.meta && player.meta.ncm_id;
  const ms = Math.round(listenedMs);
  if (!id || ms < 1000 || !auth.token) return;
  listenedMs = 0;
  try { await api.addListenMs(id, ms); } catch { listenedMs += ms; }
}

/** 30s 一次的节流冲（本地以 timeupdate 驱动、投屏以 tick 驱动，都不需要定时器）。 */
function maybeFlushListen() {
  const now = Date.now();
  if (!lastFlushAt) { lastFlushAt = now; return; }
  if (now - lastFlushAt >= 30000) { lastFlushAt = now; flushListen(); }
}

// ---------- 播放抗卡顿（缓冲可视化 / 卡顿自愈 / 下一首预取）----------
// 网络抖动是移动端最主要的"听着听着顿一下"来源。这里做三件事：
//   ① 把浏览器真实缓冲到的位置暴露给 UI（进度条上画出已缓冲区间）；
//   ② 卡住不动超过 6s 就**用新地址在原位置续播**（签名地址失效/连接半死都能救回来），
//      而不是直接跳下一首；
//   ③ 提前解析下一首的播放地址并按网络情况悄悄预拉，切歌时省掉一次往返。
let bufPct = 0;              // 已缓冲到的百分比（相对总时长）
let stallTimer = 0;
let lastPos = 0;
let recovering = false;
let stallNotified = false;

// ---------- 实际请求档位 ----------
// v1.28.28：自动降级机制已按站长要求移除（旧设计见 git 历史：同一首歌第二次
// 卡顿起逐级降档 + 断流前主动降档 + 好转回升）。现在档位完全由用户设置决定，
// 弱线时依靠换线自愈 + 预缓冲兜底，绝不悄悄改用户的音质。
/** 实际请求档位 = 用户设置的档位（自动/手动皆原样）。 */
function effectiveLevel() {
  return playLevel();
}

function updateBufPct() {
  try {
    const d = audio.duration;
    if (!d || !isFinite(d) || !audio.buffered || !audio.buffered.length) { bufPct = 0; return; }
    const t = audio.currentTime;
    let end = 0;
    // 优先取「包含当前播放位置」的那段缓冲的末端：多段 Range 时这才是用户理解的"缓存到哪"
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= t + .25 && t <= audio.buffered.end(i) + .25) end = audio.buffered.end(i);
    }
    if (!end) end = audio.buffered.end(audio.buffered.length - 1);
    bufPct = Math.max(0, Math.min(100, (end / d) * 100));
  } catch { bufPct = 0; }
}

/** 卡顿看门狗：只在"想播却在等待"时武装，位置一前进就解除。 */
function armStallWatch() {
  clearTimeout(stallTimer);
  lastPos = audio.currentTime || 0;
  stallTimer = setTimeout(() => {
    stallTimer = 0;
    if (!player.wantPlaying || audio.paused) return;
    if (Math.abs((audio.currentTime || 0) - lastPos) < .3) recoverStalled();
  }, 6000);
}
function clearStallWatch() {
  if (stallTimer) { clearTimeout(stallTimer); stallTimer = 0; }
  if (stallNotified) { stallNotified = false; emit('stalling', false); }
}

/** 卡顿自愈：重新解析地址并在**原位置**续播（比"卡住就跳下一首"体面得多）。 */
async function recoverStalled() {
  if (recovering || !player.meta) return;
  recovering = true;
  if (!stallNotified) { stallNotified = true; emit('stalling', true); }
  // 先把「这条 CDN 线卡了」报给服务端：它据此在换线时避开这条线
  // （fire-and-forget，失败也绝不影响自愈本身）。
  const stalledHost = (player.urlInfo && player.urlInfo.host) || '';
  if (stalledHost) {
    try {
      api.songFeedback({
        id: player.meta.ncm_id, host: stalledHost, event: 'stall',
        level: (player.urlInfo && player.urlInfo.level) || '', playedMs: Math.round((audio.currentTime || 0) * 1000),
      }).catch(() => {});
    } catch { /* 忽略 */ }
  }
  try {
    const at = audio.currentTime || 0;
    const _pl3 = playLevel();
    // refresh:1 = 让服务端**换一条 CDN 线**（毫秒级；旧行为是返回缓存里同一条坏地址，
    // 于是每 6 秒重试一次同一条线，用户看到的就是"一直卡"）。档位保持用户所选不变。
    // refresh 重拿地址：已锁定线路时带 host 在**同一条最优线**上重连（新签名/新连接，
    // 不让服务端轮换到别的线）；未锁定（刚进站还没测完）时由服务端换线兜底
    const pin = lineBest.byFam[famOf(((player.urlInfo || {}).host) || '')] || '';
    const info = await resolveSongUrl(player.meta, _pl3.level, _pl3.immerse,
                                      pin ? { refresh: true, host: pin } : { refresh: true });
    const betterR = swapLine(info);
    if (betterR) info.url = betterR;
    player.urlInfo = info;
    loadUrl(info.url, at);
    if (player.wantPlaying) {
      // 续播前攒少量余量（刚追尾卡过，但别再让用户等半分钟）
      // （recover 持有 stallNotified，等待期间 UI 一直显示「缓冲中」）
      await waitAhead(8, 6);
      if (player.wantPlaying && player.urlInfo === info) audio.play().catch(() => {});
    }
    toast('网络波动，已切换线路并在原位置续播');
  } catch { /* 自愈失败：交给上层失败计数与跳曲逻辑 */ }
  finally {
    recovering = false;
    if (stallNotified) { stallNotified = false; emit('stalling', false); }
  }
}

// ---------- 音频元素事件（集中绑定；元素被 CORS 回退重建时重新绑定）----------
let lastMediaPushSec = -1;
let resumeTimer = 0, resumeTries = 0;
let errStreak = 0;

function bindAudio(el) {
  el.addEventListener('ended', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
  flushListen();
  player.next(true);
});
  el.addEventListener('timeupdate', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
    emit('time');
    accumulateLocal(el);
    maybeFlushListen();
    updateBufPct();
    if (stallNotified) { stallNotified = false; emit('stalling', false); }   // 位置前进了 = 卡顿结束
    if (stallTimer) clearStallWatch();
    // 余量充足才预取下一首（v1.28.26）：要求前方余量 ≥ min(45s, 剩余时长 30%)。
    // 快线歌中段就绪、慢线（余量攒不起来）自动让路——不抢带宽从阈值自然导出。
    if (el.buffered && el.buffered.length && el.duration && isFinite(el.duration)) {
      const ahead = el.buffered.end(el.buffered.length - 1) - el.currentTime;
      const remain = el.duration - el.currentTime;
      if (el.currentTime > 10 && ahead >= Math.min(45, remain * 0.3)) player._prefetchNext();
    }
    // 蓝牙/通知进度：每 5s 同步一次（AVRCP 由系统按 playbackState 自推进度，无需逐帧）
    const sec = Math.floor(el.currentTime);
    if (!el.seeking && sec !== lastMediaPushSec && sec % 5 === 0) {
      lastMediaPushSec = sec;
      player.pushMediaState();
      // 打卡阈值：听过 30s，或已过曲目一半
      const half = isFinite(el.duration) && el.duration > 0 ? el.duration / 2 : Infinity;
      if (sec >= 30 || sec >= half) player.scrobble();
    }
  });
  el.addEventListener('waiting', () => {
    if (el !== audio) return;
    // 缓冲等待：先让 UI 说话（"缓冲中"），6s 还没动静才自愈
    if (!stallNotified) { stallNotified = true; emit('stalling', true); }
    armStallWatch();
  });
  el.addEventListener('stalled', () => {
    if (el !== audio) return;
    armStallWatch();                   // 上游断流：同样交给看门狗
  });
  el.addEventListener('canplay', () => {
    if (el !== audio) return;
    clearStallWatch();
  });
  el.addEventListener('progress', () => {
    if (el !== audio) return;
    updateBufPct();
    emit('buffer');                    // 让进度条重画已缓冲区间
  });
  el.addEventListener('play', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
    wave.resume();                     // 用户手势后恢复音频上下文
    watchGraph();                      // 后台/系统挂起上下文时兜底（否则会没声音）
    player.wantPlaying = true;
    clearTimeout(resumeTimer); resumeTries = 0;
    errStreak = 0;                     // 真正开始播放了：连续失败计数清零
    emit('state'); keepAlive(true); player.pushMediaState();
  });
  el.addEventListener('pause', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
    flushListen();                     // 暂停即结账：暂停期间的时间本来就不该计入
    emit('state'); player.pushMediaState();
    // 注意：暂停不改保活状态——锁屏/系统音频焦点抖动会触发 pause，
    // 此时若释放唤醒锁+停前台服务，进程可能在息屏下被冻结，出现「突然暂停且不再恢复」。
    if (player.wantPlaying && !player.audio.ended) scheduleResume();
  });
  el.addEventListener('seeked', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
  player.pushMediaState();
});
  el.addEventListener('loadedmetadata', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
    // 带 crossOrigin 能走到 loadedmetadata = 该音源 CORS 干净 → 可安全建图
    if (el.crossOrigin && graphEl !== el && !vizDisabled) {
      if (buildGraph(el)) { wave.resume(); corsPending = null; }
    }
    if (isFinite(el.duration) && el.duration > 0) player.updateMediaSession();
  });
  el.addEventListener('error', () => {
  if (el !== audio) return;      // 已丢弃的旧元素：事件一律忽略
    // ① CORS 回退：带 crossOrigin 加载失败（该音源无 CORS 头）→
    // 去掉 crossOrigin 重试一次，**保证有声音**，可视化降级为静默基线。
    // 必须换新元素：图一旦建立，元素音频只走图输出，仅断开节点无法恢复直出。
  if (corsPending && el === audio) {
      const pend = corsPending; corsPending = null;
      // 只记这个**域名**（下次同域名直接普通播放），不做全会话降级——
      // 换到别的 CDN 域名仍可继续尝试可视化
      if (pend.host) corsFailHosts[pend.host] = 1;
      teardownGraph({ keepContext: true });
      disposeAudio(el);
      const fresh = makeAudio();
      audio = fresh;
      fresh.crossOrigin = null;
      fresh.src = pend.url;
      if (pend.pos > 0) { try { fresh.currentTime = pend.pos; } catch (e) { /* 忽略 */ } }
      if (player.wantPlaying) fresh.play().catch(() => scheduleResume());
      return;                       // 不计入连续失败熔断
    }
    if (!player.urlInfo) return;
    errStreak++;
    const cap = Math.min(3, Math.max(1, player.queue.length));
    if (errStreak >= cap) {
      errStreak = 0;
      player.wantPlaying = false;
      toast('连续播放失败，已停止（请检查网络后重试）');
      return;
    }
    toast('播放出错，尝试下一首');
    player.next(true);
  });
}

// 时长此时才实测可得：重推一次元数据，蓝牙/车机拿到准确曲长（避免用估计值或被旧值卡住）

// 意外暂停自动恢复：系统抢焦点/锁屏瞬断后重新起播（最多 3 次，间隔递增）
function scheduleResume() {
  if (resumeTries >= 3) return;
  resumeTries++;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    if (player.wantPlaying && player.audio.paused && player.urlInfo) {
      player.audio.play().catch(() => scheduleResume());
    }
  }, 600 * resumeTries);
}

// 后台保活：有正在播放的曲目就保持前台服务（含暂停态——便于锁屏随时恢复），
// 仅在队列播完/清空/主动停止时释放
function keepAlive(on) {
  try { window.NativeApi && window.NativeApi.keepAlive && window.NativeApi.keepAlive(on); } catch { /* 非 App 环境 */ }
}

/** 真正停止播放（队列播完且不循环 / 清空队列）：释放前台服务与唤醒锁。 */
export function stopPlayback() {
  player.wantPlaying = false;
  clearTimeout(resumeTimer);
  keepAlive(false);
}
// 连续播放失败熔断：error 会 next() 换下一首，但若整队都解析失败
// （上游风控/断网）会无限循环「解析→失败→换下一首」刷爆接口与提示。
// 超过 3 次（或绕完整个队列）即停下并说明原因。

// 调试/测试入口
window.__cmPlayer = { get audio() { return audio; }, player, wave };

// MDUI 主色（品牌紫）
if (mdui.setColorScheme) mdui.setColorScheme('#6750A4');
