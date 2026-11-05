// 播放器 UI：底部迷你条 + 全屏播放页（封面/歌词/进度/音质/点赞/收藏/加入歌单）。
import { mdui } from './md.js';
import { createWaveform, WAVE_STYLE } from './waveform.js';
import { waveStyle, waveTilt } from './customize.js';
import { api, auth, settings } from './api.js';
import { esc, toast, fmtDur, fmtCount, tierLabel, QUALITY_TIERS, getStatus, ensureStatus, isNcmLiked, ensureLikeState, toggleLikeDefault, dismissToasts, avatarHTML, skelComments, coverColors, defaultLyricSizeKey, getColorSchemeKey, applyColorScheme } from './ui.js';
import { player, wave, on } from './player.js';
import { openShare } from './share.js';
import { castIconHTML, openCastDialog } from './cast.js';
import { openAskAI, ensureAiBot } from './ask-ai.js';
import { createMiniProgress, createPlayerProgress } from './playback-progress.js';

// Apple 风媒体图标（仿 SF Symbols：play.fill / pause.fill / backward.end.fill / forward.end.fill）。
// 特征是**实心 + 圆角、无外圈**；Material 的 play_circle/pause_circle 自带圆圈，
// 换成 play_arrow/pause 虽无圈但棱角生硬，故直接用 SVG 画出圆角。
// stroke+linejoin:round 把三角形的角变圆（Apple 的标志性细节），fill=currentColor 随文字色。
const AM_ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 5.1v13.8L19.2 12z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.4" y="5" width="3.7" height="14" rx="1.5"/><rect x="13.9" y="5" width="3.7" height="14" rx="1.5"/></svg>',
  prev: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5" y="5" width="2.1" height="14" rx="1.05" stroke="none"/><path d="M19 5.6v12.8L9.6 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="16.9" y="5" width="2.1" height="14" rx="1.05" stroke="none"/><path d="M5 5.6v12.8L14.4 12z"/></svg>',
};
/** 播放键内容：加载中仍用 Material 的沙漏（瞬态提示，不属于走带图标集） */
function amPlayIcon() {
  return player.loading
    ? '<span class="material-icons-outlined">hourglass_empty</span>'
    : (player.isPlaying() ? AM_ICON.pause : AM_ICON.play);
}


// ---------- 网易云评论表情：方括号码 → emoji ----------
// NCM 客户端表情在接口里是纯文本码（如 [爱心]/[呲牙]），网页端直接显示会看到
// 原始方括号。这里映射为语义等价的通用 emoji（选用 Chrome58 即可渲染的早期码位）。

const overlay = () => document.getElementById('playerOverlay');

// 主题「翱翔鸟Music」= 移植自独立项目 soaringbird-music 的 Apple Music 风格皮肤。
// 所有该主题的样式都限定在 html[data-ui-preset="soaringbird"] 之下，其余皮肤不受影响。
const isSoaringBirdTheme = () =>
  document.documentElement.getAttribute('data-ui-preset') === 'soaringbird';
// 翱翔鸟Music 用 lp-* 结构，其余皮肤沿用 pl-*；查询时统一走这两个选择器。
const lyricLineSel = () => (isSoaringBirdTheme() ? '.lp-lyric' : '.pl-lyric-line');
const lyricTokenSel = () => (isSoaringBirdTheme() ? '.lp-tk' : '.ch');
let closeTimer = 0;
let lpScrollRaf = 0;
let soarScrollRaf = 0;
let soarRolling = false;     // 歌词正在做换行滚动：此期间不写逐字进度
let soarScrollY = 0;         // 歌词轨道的当前位移（px，正值向上）
let lpScrollAnim = null;     // 换行滚动的 WAAPI 动画（可中断续接）
let lpAnimMeta = null;       // { start, target } —— 不依赖 getComputedStyle 取当前位置
let soarManualTimer = 0;     // 手动滑动后取消模糊的计时器

// Apple 风格的小图标（shuffle / repeat / translate / 汉堡菜单）
const SB_ICON = {
  shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h3.4l3.4 4.4M13.4 7H17M3 17h3.4l7.2-9.4M17 7l2.6 0M17 17h3M20 5.6 22.6 8l-2.6 2.4M20 15.6 22.6 18l-2.6 2.4"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V8.5A3.5 3.5 0 0 1 7.5 5H18"/><path d="m15.6 2.6 2.8 2.4-2.8 2.4"/><path d="M20 14v1.5A3.5 3.5 0 0 1 16.5 19H6"/><path d="m8.4 21.4-2.8-2.4 2.8-2.4"/></svg>',
  translate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h7M8 4v1.5M10.4 5.5c-.6 3-2.6 6-5.9 8"/><path d="M5 9.6c1.6 2.6 3.6 4.1 6 4.9"/><path d="M13.4 20l3-8 3 8M14.4 17.4h4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 3.6 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.6l-5.1 2.7.97-5.68L3.75 9.6l5.7-.83z"/></svg>',
  starFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="m12 3.6 2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.6l-5.1 2.7.97-5.68L3.75 9.6l5.7-.83z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3l4-3.2v11.4l-4-3.2H4z"/><path d="M14.4 9.2a4 4 0 0 1 0 5.6M16.8 7a7.2 7.2 0 0 1 0 10"/></svg>',
};

function sbPlayIcon() {
  return player.loading
    ? '<span class="play-loading" aria-hidden="true"></span>'
    : (player.isPlaying() ? AM_ICON.pause : AM_ICON.play);
}

// 音量：CurrentMusic 默认跟随系统；这里把滑块映射到单例 audio，
// 记住上次值，并在换歌（audio 元素被替换）后重新应用。
function savedVolume() {
  const v = Number(localStorage.getItem('cm.volume'));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
}
function applyVolume() {
  const a = player.audio;
  if (!a) return;
  try { a.volume = savedVolume(); } catch { /* iOS 只读 */ }
}
on('song', applyVolume);

// 播放页波形：由**真实音频频谱**驱动（见 waveform.js），占位只有一张 canvas。
// 之前这里是一组固定高度的柱子 + CSS 呼吸动画 —— 那与音乐无关，只是看起来在动；
// 现在只有拿到真实频谱才画起伏，拿不到就画静默基线（不假装有律动）。
let waveCtl = null;          // 当前播放页的波形控制器（关闭时销毁）
function waveformHTML() {
  return `<div class="pl-waveform" id="plWaveform" aria-hidden="true"><canvas id="plWaveCanvas"></canvas></div>`;
}

// ---------- 迷你条 ----------

let miniProgress = null, miniMeta = null, fullProgress = null;
function renderMini() {
  const el = document.getElementById('mini');
  const sb = isSoaringBirdTheme();
  if (!player.meta) {
    if (miniProgress) miniProgress.destroy();
    miniProgress = miniMeta = null;
    // 翱翔鸟Music 桌面端：参考项目的播放条在未播放时也常驻（LCD 位置显示占位），
    // 这样底部的胶囊不会「时有时无」。移动端仍沿用原行为（无歌曲不占高度）。
    if (sb && window.innerWidth >= 900) {
      el.style.display = '';
      el.innerHTML = `
        <div class="cm-mini-inner sb-pb is-empty">
          <div class="sb-pb__controls">
            <button type="button" class="sb-pb__ctrl sb-pb__ctrl--side" disabled aria-label="随机播放">${SB_ICON.shuffle}</button>
            <button type="button" class="sb-pb__ctrl" disabled aria-label="上一首">${AM_ICON.prev}</button>
            <button type="button" class="sb-pb__ctrl sb-pb__ctrl--play" disabled aria-label="播放">${AM_ICON.play}</button>
            <button type="button" class="sb-pb__ctrl" disabled aria-label="下一首">${AM_ICON.next}</button>
            <button type="button" class="sb-pb__ctrl sb-pb__ctrl--side" disabled aria-label="单曲循环">${SB_ICON.repeat}</button>
          </div>
          <div class="sb-pb__lcd sb-pb__lcd--empty">
            <img class="sb-pb__logo" src="brand-icon.png?v=sage1" alt="">
          </div>
          <div class="sb-pb__actions">
            <button type="button" class="sb-pb__act" disabled aria-label="歌词"><span class="material-icons-outlined">lyrics</span></button>
            <button type="button" class="sb-pb__act" disabled aria-label="展开全屏"><span class="material-icons-outlined">keyboard_arrow_up</span></button>
            <div class="sb-pb__volume">${SB_ICON.speaker}<input type="range" min="0" max="1" step="0.01" value="${savedVolume()}" disabled aria-label="音量"></div>
          </div>
        </div>`;
      return;
    }
    el.innerHTML = ''; el.style.display = 'none'; return;
  }
  el.style.display = '';
  const m = player.meta;
  const sub = `${m.artists || ''}${player.urlInfo ? ' · ' + tierLabel(player.urlInfo.level) : player.loading ? ' · 解析音质中…' : ''}`;
  // 播放/暂停和音质变化只更新内容，保留进度及正在操作的原生滑块。
  if (miniMeta === m && miniProgress) {
    const playBtn = el.querySelector('#miniPlay');
    if (sb) {
      if (playBtn) playBtn.innerHTML = sbPlayIcon();
      const shuffle = el.querySelector('#miniShuffle');
      const repeat = el.querySelector('#miniRepeat');
      if (shuffle) shuffle.classList.toggle('is-on', player.playMode === 'shuffle');
      if (repeat) repeat.classList.toggle('is-on', player.playMode === 'one');
    } else if (playBtn) {
      playBtn.querySelector('.material-icons-outlined').textContent = player.isPlaying() ? 'pause_circle' : 'play_circle';
    }
    el.querySelector('.cm-mini-name').textContent = m.name || '';
    el.querySelector('.cm-mini-sub').textContent = sub;
    miniProgress.update();
    return;
  }
  if (miniProgress) miniProgress.destroy();
  miniMeta = m;
  if (sb) {
    el.innerHTML = `
      <div class="cm-mini-inner sb-pb">
        <div class="sb-pb__controls">
          <button type="button" class="sb-pb__ctrl sb-pb__ctrl--side${player.playMode === 'shuffle' ? ' is-on' : ''}" id="miniShuffle" aria-label="随机播放">${SB_ICON.shuffle}</button>
          <button type="button" class="sb-pb__ctrl" id="miniPrev" aria-label="上一首">${AM_ICON.prev}</button>
          <button type="button" class="sb-pb__ctrl sb-pb__ctrl--play" id="miniPlay" aria-label="播放/暂停">${sbPlayIcon()}</button>
          <button type="button" class="sb-pb__ctrl" id="miniNext" aria-label="下一首">${AM_ICON.next}</button>
          <button type="button" class="sb-pb__ctrl sb-pb__ctrl--side${player.playMode === 'one' ? ' is-on' : ''}" id="miniRepeat" aria-label="单曲循环">${SB_ICON.repeat}</button>
        </div>
        <div class="sb-pb__lcd">
          <button type="button" class="sb-pb__art" id="miniArt" aria-label="展开全屏播放">
            ${m.pic ? `<img src="${esc(m.pic)}" alt="">` : '<span class="material-icons-outlined">music_note</span>'}
          </button>
          <button type="button" class="sb-pb__meta" id="miniMetaBtn">
            <span class="cm-mini-name">${esc(m.name)}</span>
            <span class="cm-mini-sub">${esc(sub)}</span>
          </button>
          <div class="cm-mini-prog"></div>
        </div>
        <div class="sb-pb__actions">
          <button type="button" class="sb-pb__act" id="miniLyrics" aria-label="歌词"><span class="material-icons-outlined">lyrics</span></button>
          <button type="button" class="sb-pb__act" id="miniExpand" aria-label="展开全屏"><span class="material-icons-outlined">keyboard_arrow_up</span></button>
          <div class="sb-pb__volume">${SB_ICON.speaker}<input type="range" id="miniVolume" min="0" max="1" step="0.01" value="${savedVolume()}" aria-label="音量"></div>
        </div>
      </div>`;
    miniProgress = createMiniProgress(el.querySelector('.sb-pb__lcd .cm-mini-prog'), player);
    el.querySelector('#miniShuffle').onclick = e => {
      e.stopPropagation();
      player.setPlayMode(player.playMode === 'shuffle' ? 'order' : 'shuffle');
    };
    el.querySelector('#miniPrev').onclick = e => { e.stopPropagation(); player.prev(); };
    el.querySelector('#miniPlay').onclick = e => { e.stopPropagation(); player.toggle(); };
    el.querySelector('#miniNext').onclick = e => { e.stopPropagation(); player.next(); };
    el.querySelector('#miniRepeat').onclick = e => {
      e.stopPropagation();
      player.setPlayMode(player.playMode === 'one' ? 'order' : 'one');
    };
    const vol = el.querySelector('#miniVolume');
    vol.oninput = () => {
      localStorage.setItem('cm.volume', vol.value);
      const a = player.audio;
      if (a) { try { a.volume = Number(vol.value); } catch { /* iOS 只读 */ } }
    };
    ['#miniArt', '#miniMetaBtn', '#miniLyrics', '#miniExpand'].forEach(sel => {
      const btn = el.querySelector(sel);
      if (btn) btn.onclick = () => openFull();
    });
    return;
  }
  el.innerHTML = `
    <div class="cm-mini-prog"></div>
    <div class="cm-mini-inner">
      ${m.pic ? `<img src="${esc(m.pic)}">` : `<div class="cm-mini-ph"><span class="material-icons-outlined">music_note</span></div>`}
      <div class="cm-mini-text">
        <div class="cm-mini-name">${esc(m.name)}</div>
        <div class="cm-mini-sub">${esc(sub)}</div>
      </div>
      <span class="cm-mini-btn" id="miniPlay"><span class="material-icons-outlined">${player.isPlaying() ? 'pause_circle' : 'play_circle'}</span></span>
      <span class="cm-mini-btn" id="miniNext"><span class="material-icons-outlined">skip_next</span></span>
    </div>`;
  miniProgress = createMiniProgress(el.querySelector('.cm-mini-prog'), player);
  el.querySelector('#miniPlay').onclick = e => { e.stopPropagation(); player.toggle(); };
  el.querySelector('#miniNext').onclick = e => { e.stopPropagation(); player.next(); };
  el.querySelector('.cm-mini-inner').onclick = () => openFull();
}

on('song', renderMini);

on('time', () => {
  // 进度线紧贴迷你播放条上缘。位置/总长一律走 player.posMs()/durMs()：
  // 投屏时它们来自设备上报，直接读 audio 会永远是 0（进度条与歌词卡住）。
  if (miniProgress) miniProgress.update();
  if (fullProgress) fullProgress.update();
  updateSbRemaining();
  syncLyric();
});

/** 翱翔鸟Music 的右侧时间是「剩余」：-0:00（参考 Apple Music）。 */
function updateSbRemaining() {
  if (!isSoaringBirdTheme()) return;
  const el = document.getElementById('plDur');
  if (!el) return;
  const dur = player.durMs();
  const rem = Number.isFinite(dur) && dur > 0 ? Math.max(0, dur - player.posMs()) : 0;
  const txt = '-' + fmtDur(rem);
  if (el.textContent !== txt) el.textContent = txt;
}

// ---------- 全屏播放页 ----------

let lyricLines = [];
let lyricLoadedFor = null;

async function loadLyric() {
  const m = player.meta;
  if (!m) return;
  // 关键：不清空旧歌词——让旧内容在 fetch 期间保持可见（消除"突然消失又出现"的空窗）。
  // 新数据到达后才一次性替换并重置行号。
  const oldLines = lyricLines;
  lyricLoadedFor = m.ncm_id;
  pushDesktopLyric(-1, true);
  try {
    const d = await api.lyric(m.ncm_id);
    if (!player.meta || player.meta.ncm_id !== m.ncm_id) return;
    lyricLines = (d.lines || []).filter(l => l.txt);
  } catch {
    lyricLoadedFor = m.ncm_id + ':err';
    lyricLines = [];            // 仅在获取失败时清空
  }
  if (lyricLines !== oldLines) {
    curLyricIdx = -1;           // 行集变了，重置行号以触发首次滚动
    karaokeSpans = null;
  }
  renderLyric();
  syncLyric();
}

const PLAY_MODES = [
  { key: 'list', icon: 'repeat', label: '列表循环' },
  { key: 'one', icon: 'repeat_one', label: '单曲循环' },
  { key: 'order', icon: 'trending_flat', label: '顺序播放' },
  { key: 'shuffle', icon: 'shuffle', label: '随机播放' },
];

// ---------- 歌词多语言模式 ----------

const LYRIC_MODES = [
  { key: 'bi', label: '双语' },          // 原文 + 翻译
  { key: 'orig', label: '原文' },
  { key: 'trans', label: '翻译' },
  { key: 'roma', label: '罗马音' },
  { key: 'orig-roma', label: '原文+罗马' },
];
let lyricMode = localStorage.getItem('cm.lyricMode') || 'bi';

function lineParts(l) {
  const mode = lyricMode;
  let main = l.txt, sub = '';
  if (mode === 'trans') main = l.trans || l.txt;
  else if (mode === 'roma') main = l.roma || l.txt;
  else if (mode === 'bi') sub = l.trans || '';
  else if (mode === 'orig-roma') sub = l.roma || '';
  return { main: main || l.txt, sub };
}

// ---------- 桌面悬浮歌词（Android 原生窗口） ----------
// 原生窗口只负责显示，时间轴仍以播放器 currentTime 为唯一时钟；这里只在行变化时
// 推「当前行 + 下一行/翻译」，避免每帧跨 JS 桥。App 外/浏览器里没有 NativeApi 时静默跳过。
let lastDesktopLyric = '';
function pushDesktopLyric(index, loading, force) {
  const b = window.NativeApi;
  if (!b || typeof b.desktopLyric !== 'function') return;
  const m = player.meta;
  if (!m) {
    if (force || lastDesktopLyric) {
      lastDesktopLyric = 'idle';
      try { b.desktopLyric('桌面歌词已开启', '播放歌曲后显示歌词'); } catch { /* 忽略 */ }
    }
    return;
  }
  if (loading) {
    const payload = 'loading\u0000' + (m.name || '');
    if (!force && payload === lastDesktopLyric) return;
    lastDesktopLyric = payload;
    try { b.desktopLyric('歌词加载中…', m.name || ''); } catch { /* 忽略 */ }
    return;
  }
  if (!lyricLines.length) {
    const payload = 'empty\u0000' + (m.name || '');
    if (!force && payload === lastDesktopLyric) return;
    lastDesktopLyric = payload;
    try { b.desktopLyric('暂无歌词', m.name || ''); } catch { /* 忽略 */ }
    return;
  }
  let i = typeof index === 'number' ? index : curLyricIdx;
  if (i < 0) {
    const t = player.posMs();
    i = 0;
    for (let k = 0; k < lyricLines.length; k++) {
      if (lyricLines[k].t <= t) i = k; else break;
    }
  }
  i = Math.max(0, Math.min(i, lyricLines.length - 1));
  const cur = lyricLines[i];
  if (!cur) return;
  const next = lyricLines.slice(i + 1).find(l => l && l.txt);
  const second = (cur.trans || cur.roma || (next && next.txt) || m.name || '').trim();
  const payload = cur.txt + '\u0000' + second;
  if (!force && payload === lastDesktopLyric) return;
  lastDesktopLyric = payload;
  try { b.desktopLyric(cur.txt || '', second); } catch { /* 忽略 */ }
}
// 原生在开启桌面歌词/页面恢复时主动要一次当前行。
window.__cmDesktopLyricsRequest = () => pushDesktopLyric(undefined, false, true);

const LYRIC_SIZES = [
  { key: 's', label: 'Aa·小', fs: 13 },
  { key: 'm', label: 'Aa·标准', fs: 15 },
  { key: 'l', label: 'Aa·大', fs: 17 },
  { key: 'xl', label: 'Aa·特大', fs: 19 },
];
let lyricSizeKey = localStorage.getItem('cm.lyricSize') || defaultLyricSizeKey();
let bgGradOn = localStorage.getItem('cm.bgGrad') === '1';   // 沉浸模式（原动态渐变背景），默认关闭
let lyricKaraoke = localStorage.getItem('cm.karaoke') !== '0';   // 逐字歌词（卡拉OK），默认开启

// 窄屏播放页视图：cover（封面+控制） ↔ lyric（整屏歌词），点击主区域切换
let playerView = sessionStorage.getItem('cm.playerView') || 'cover';
function setPlayerView(v) {
  playerView = v;
  try { sessionStorage.setItem('cm.playerView', v); } catch { /* 隐私模式 */ }
  const bodyEl = document.querySelector('.pl-body');
  if (bodyEl) {
    // 保留主题自定义的附加类（如翱翔鸟Music 的 sb-grid），只替换视图类
    const extra = Array.from(bodyEl.classList).filter(c => c !== 'pl-body' && !c.startsWith('view-')).join(' ');
    bodyEl.className = ('pl-body ' + extra + ' view-' + v).replace(/\s+/g, ' ').trim();
  }
  if (v === 'lyric') {
    // 视图尺寸变化后：重算垫片并让当前行重新居中
    requestAnimationFrame(() => {
      layoutLyricPads();
      userScrollUntil = 0;
      curLyricIdx = -1;      // 强制 syncLyric 重新滚动到当前行
      syncLyric();
    });
  }
}

function renderLyric() {
  const box = document.getElementById('plLyric');
  if (!box) return;
  const soar = isSoaringBirdTheme();
  if (!lyricLines.length) {
    box.innerHTML = soar
      ? `<div class="lp-nolyrics"><span class="lp-nolyrics__badge" aria-hidden="true"><span class="material-icons-outlined">music_note</span></span><p class="lp-nolyrics__title">暂无歌词</p><p class="lp-nolyrics__sub">这首歌是纯音乐，或歌词尚未收录</p></div>`
      : `<div class="pl-lyric-empty">暂无歌词</div>`;
    return;
  }
  const size = LYRIC_SIZES.find(s => s.key === lyricSizeKey) || LYRIC_SIZES[1];
  // 歌词字号 = 用户选的档位 × 全局字体大小倍率：否则选了「特大」字体后歌词还是原大小
  box.style.setProperty('--pl-fs', `calc(${size.fs}px * var(--cm-fs, 1))`);
  // 翱翔鸟Music：1:1 复刻参考项目的 lp-lyrics 结构（首垫片 + 尾垫片，均可停到中线）
  if (soar) {
    box.style.setProperty('--active-i', String(curLyricIdx >= 0 ? curLyricIdx : 0));
    // 只按纯文本渲染全部行，当前行再在 syncLyric 里按词切分。
    // 若全量切词，每行都变成一串 inline-block，行内不再有换行机会（长句横向溢出、错位），
    // 而且每次重建都要为整首歌词做大量文本栅格化，播放时表现为明显卡顿。
    // 首垫片 = 半个面板高：否则第一句永远只能贴在顶部，滚不到中线（Apple 同款居中）。
    // 整列包进 __track：滚动改用 transform 位移（合成层），不再逐帧写 scrollTop。
    // scrollTop 会让「overflow + mask」的容器每帧重新栅格化整列文字，这是换行必卡的根因。
    box.innerHTML = `<div class="lp-lyrics__track">` +
      `<div class="lp-lyrics__start" aria-hidden="true"></div>` + lyricLines.map((l, i) => {
        const { main, sub } = lineParts(l);
        return `<div class="lp-lyric" data-i="${i}" style="--i:${i}"><span class="lp-lyric__text">${esc(main)}</span>${sub ? `<span class="lp-lyric__trans">${esc(sub)}</span>` : ''}</div>`;
      }).join('') + `<div class="lp-lyrics__end" aria-hidden="true">&nbsp;</div>` +
      `</div>`;
    soarScrollY = 0;
    if (lpScrollAnim) { try { lpScrollAnim.cancel(); } catch { /* 忽略 */ } lpScrollAnim = null; }
    lpAnimMeta = null;
    box.classList.remove('is-manual');
    const track = box.querySelector('.lp-lyrics__track');
    if (track) track.style.transform = 'translate3d(0,0,0)';
  } else {
    // 关键：每行都渲染（缺翻译/罗马音回退原文），行号与 lyricLines 一一对应；
    // 首尾垫片让第一句/最后一句也能停在中线
    box.innerHTML =
      `<div class="pl-lyric-pad" id="padTop"></div>` +
      lyricLines.map((l, i) => {
        const { main, sub } = lineParts(l);
        // 逐字：仅当该行有逐字/逐词轴、且当前显示的是原文时启用（翻译/罗马音无逐字轴）
        const karaokeOK = lyricKaraoke && l.w && l.w.length
          && (lyricMode === 'bi' || lyricMode === 'orig' || lyricMode === 'orig-roma');
        const body = karaokeOK
          ? `<div class="lyr">${l.w.map(([wt, tx]) => `<span class="ch" data-t="${wt}">${esc(tx)}</span>`).join('')}</div>`
          : `<div>${esc(main)}</div>`;
        return `<div class="pl-lyric-line" data-i="${i}" style="--i:${i}">${body}${sub ? `<div class="pl-lyric-trans">${esc(sub)}</div>` : ''}</div>`;
      }).join('') +
      `<div class="pl-lyric-pad" id="padBot"></div>`;
  }
  box.querySelectorAll('.pl-lyric-line, .lp-lyric').forEach(el => {
    let lp = null, lpFired = false;
    el.onclick = e => {
      e.stopPropagation();
      if (lpFired) { lpFired = false; return; }   // 长按已摘录：不要再 seek
      player.seek(lyricLines[+el.dataset.i].t / 1000);
    };
    // 长按摘录歌词（阶段二）：/song/lyrics/mark/add 是写操作，需登录 + 绑定网易云
    el.addEventListener('pointerdown', () => {
      lp = setTimeout(async () => {
        lp = null; lpFired = true;
        const line = lyricLines[+el.dataset.i];
        if (!line || !player.meta) return;
        const { addLyricMark } = await import('./pages/lyricmarks.js');
        addLyricMark(player.meta, line.txt);
      }, 600);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(evt =>
      el.addEventListener(evt, () => { if (lp) { clearTimeout(lp); lp = null; } }));
  });
  // 重建后恢复当前行标记（syncLyric 在行号未变时会提前返回）
  if (soar && curLyricIdx >= 0) {
    box.style.setProperty('--active-i', String(curLyricIdx));
    box.querySelectorAll('.lp-lyric').forEach(el => {
      const idx = +el.dataset.i;
      el.classList.toggle('is-active', idx === curLyricIdx);
      el.classList.toggle('is-past', idx < curLyricIdx);
      el.classList.toggle('is-far', Math.abs(idx - curLyricIdx) >= 4);
      soarStagger(el, idx, curLyricIdx);
    });
    soarTokenizeAround(box, curLyricIdx);
  }
  if (soar) layoutSoarPads();
  if (!soar) layoutLyricPads();
  // 只在真实用户输入时暂停自动跟随 3 秒。
  // 不要用 onscroll + 标志位判定——scrollTo 的平滑动画也会触发 scroll 事件，
  // 动画期间标志位被 setTimeout 重置后，后续动画事件会被误判为用户操作，
  // 误设 userScrollUntil → 自动跟随被禁 → 视觉上歌词"卡住不滚"。
  ['pointerdown', 'touchstart'].forEach(evt => {
    box.addEventListener(evt, () => {
      if (springRaf) { cancelAnimationFrame(springRaf); springRaf = 0; }   // 终止弹簧，交给用户
      if (lpScrollRaf) { cancelAnimationFrame(lpScrollRaf); lpScrollRaf = 0; }
      if (soarScrollRaf) { cancelAnimationFrame(soarScrollRaf); soarScrollRaf = 0; }
      soarRolling = false;
      userScrollUntil = Date.now() + 3000;
    }, { passive: true });
  });
  // 翱翔鸟Music 的歌词是 transform 轨道，没有原生滚动：滚轮/手指拖动自己算位移
  box.addEventListener('wheel', e => {
    if (!isSoaringBirdTheme()) return;
    e.preventDefault();
    if (lpScrollRaf) { cancelAnimationFrame(lpScrollRaf); lpScrollRaf = 0; soarRolling = false; }
    soarManualScroll(box, e.deltaY);
  }, { passive: false });
  let soarTouchY = 0;
  box.addEventListener('touchstart', e => {
    if (isSoaringBirdTheme() && e.touches[0]) soarTouchY = e.touches[0].clientY;
  }, { passive: true });
  box.addEventListener('touchmove', e => {
    if (!isSoaringBirdTheme() || !e.touches[0]) return;
    if (lpScrollRaf) { cancelAnimationFrame(lpScrollRaf); lpScrollRaf = 0; soarRolling = false; }
    soarManualScroll(box, soarTouchY - e.touches[0].clientY);
    soarTouchY = e.touches[0].clientY;
  }, { passive: true });
}

/* 中英混排分词：中文按字、英文按词、空白与符号各自成段（逐字动画的最小单元） */
const SOAR_TOKEN_RE = /[\u4e00-\u9fa5]|[a-zA-Z0-9'’]+|\s+|./gu;

/** 翱翔鸟Music：逐字只在当前行启用（与参考实现一致）。
    有词级轴（l.w）就按词切；没有就按「中文按字、英文按词、空白/符号各成段」切，
    交给 soarSweep 用行时长做连续扫光——绝大多数歌词只有行级时间轴，这样才有逐字效果。 */
function soarKaraokeOK() {
  return lyricKaraoke && (lyricMode === 'bi' || lyricMode === 'orig' || lyricMode === 'orig-roma');
}

function soarTokenizeLine(box, idx) {
  const line = lyricLines[idx];
  if (!line || !soarKaraokeOK()) return;
  const el = box.querySelector(`.lp-lyric[data-i="${idx}"]`);
  const txt = el && el.querySelector('.lp-lyric__text');
  if (!txt || txt.querySelector('.lp-tk')) return;
  // 一律按「原文」分词：词级时间轴（l.w）里的 token 往往不带空格，
  // 直接拼回去会把长句末尾的词粘在一起（表现为「末尾被分割/缺字」）。
  // 行级时间轴下用按字符权重的匀速扫光，观感与 Apple 一致，也保证文本完整。
  const tokens = (lineParts(line).main || '').match(SOAR_TOKEN_RE) || [];
  if (!tokens.length) return;
  txt.innerHTML = tokens.map(tx => `<span class="lp-tk">${esc(tx)}</span>`).join('');
  soarResetSweep();
}

/* 换行前就把上下若干行分好词：换行时无需再重建 DOM，
   既不会在切行那一帧重排（卡顿），也不会出现「文字先消失再出现」。 */
const SOAR_TOKEN_WINDOW = 6;
function soarTokenizeAround(box, i) {
  const from = Math.max(0, i - SOAR_TOKEN_WINDOW);
  const to = Math.min(lyricLines.length - 1, i + SOAR_TOKEN_WINDOW);
  for (let k = from; k <= to; k += 1) soarTokenizeLine(box, k);
}

// 翱翔鸟Music：首垫片 = 半个面板高，让第一句也能滚到中线（尾垫片由 CSS 的 42vh 负责）
function layoutSoarPads() {
  const box = document.getElementById('plLyric');
  if (!box) return;
  const st = box.querySelector('.lp-lyrics__start');
  if (!st) return;
  const h = Math.max(0, Math.round(box.clientHeight / 2) - 22);
  const want = h + 'px';
  if (st.style.height !== want) st.style.height = want;
}

// 垫片高度 = 容器半高，使任意行（含首尾）都能滚动到垂直中线
function layoutLyricPads() {
  const box = document.getElementById('plLyric');
  if (!box) return;
  const h = Math.max(0, Math.round(box.clientHeight / 2) - 12);
  const top = document.getElementById('padTop'), bot = document.getElementById('padBot');
  if (top) top.style.height = h + 'px';
  if (bot) bot.style.height = h + 'px';
}
window.addEventListener('resize', () => {
  layoutLyricPads();
  layoutSoarPads();
  // 旋转/分栏/改窗口大小后重新量取画布（控制器随播放页存在与否，安全空转）
  if (waveCtl) waveCtl.resize();
});
if (window.addEventListener) window.addEventListener('orientationchange', () => { if (waveCtl) waveCtl.resize(); });

// ---------- 逐字点亮（卡拉OK） ----------
let karaokeRaf = 0, karaokeLine = -1, karaokeIdx = -1, karaokeTick = 0;

// 支持连续填充（background-clip:text）时走 Apple 风格的「扫光」，
// 否则退化为逐字跳色（老引擎兜底）
const CAN_SWEEP = (() => {
  try {
    return CSS.supports('-webkit-background-clip', 'text') || CSS.supports('background-clip', 'text');
  } catch (e) {
    return false;
  }
})();

let karaokeSpans = null;
let karaokeVals = [];

/* ---------- 翱翔鸟Music：无词级轴时的「行内匀速扫光」 ----------
   数据源大多只有行级时间轴（l.w 为空），Apple Music 的观感是：
   把整行按字符宽度均分到这一行的时间跨度里，羽化边界连续向右推进，
   而不是「每个字各扫各的」。只有边界所在的那个字符需要写 --cp，
   其余已唱/未唱分别固定 100 / 0，因此每帧只有一次样式写入。 */
const SOAR_LEAD_MS = 90;          // 补偿音频输出与渲染延迟
let soarLine = -1, soarSpans = [], soarIdx = -1, soarCp = -1, soarDone = false;

function soarResetSweep() {
  soarLine = -1; soarSpans = []; soarIdx = -1; soarCp = -1; soarDone = false;
}

function soarSweep(now, line, spans) {
  if (soarLine !== curLyricIdx || !soarSpans.length || soarSpans.length !== spans.length) {
    // 按字符「文本宽度」分配时间：中文/全角按 1，西文/半角按 0.55。
    // 之前用 getBoundingClientRect 量真实像素，会在换行那一帧强制同步布局（整列文字重排），
    // 正是「换行卡住/闪一下」的来源之一；字符权重足够接近，还完全不需要读布局。
    const widths = Array.prototype.map.call(spans, s => {
      const tx = s.textContent || '';
      let w = 0;
      for (let k = 0; k < tx.length; k += 1) w += tx.charCodeAt(k) > 255 ? 1 : 0.55;
      return w || 1;
    });
    const total = widths.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    soarSpans = widths.map(w => { const s0 = acc; acc += w; return [s0 / total, acc / total]; });
    soarLine = curLyricIdx; soarIdx = -1; soarCp = -1; soarDone = false;
  }
  const next = lyricLines[curLyricIdx + 1];
  const dur = Math.max(400, (next ? next.t : line.t + 4000) - line.t);
  const p = Math.min(1, Math.max(0, (now + SOAR_LEAD_MS - line.t) / dur));

  let ci = soarIdx >= 0 ? soarIdx : 0;
  while (ci < soarSpans.length - 1 && p > soarSpans[ci][1]) ci += 1;
  while (ci > 0 && p < soarSpans[ci][0]) ci -= 1;
  const [s0, e0] = soarSpans[ci];
  const frac = e0 > s0 ? Math.min(1, Math.max(0, (p - s0) / (e0 - s0))) : 0;

  if (ci !== soarIdx) {
    const prev = soarIdx;
    const lo = Math.max(0, Math.min(prev, ci));
    const hi = Math.min(spans.length - 1, Math.max(prev, ci));
    for (let i = lo; i <= hi; i += 1) {
      const el = spans[i];
      if (!el) continue;
      el.classList.toggle('is-sung', i < ci);
      el.classList.toggle('is-current', i === ci);
      el.style.setProperty('--cp', i < ci ? '100' : '0');
    }
    soarIdx = ci; soarCp = -1;
  }

  const cp = Math.round(frac * 200) / 2;      // 0.5% 步进，肉眼连续又不刷爆
  if (cp !== soarCp) { spans[ci].style.setProperty('--cp', String(cp)); soarCp = cp; }

  // 末字唱满：整行补满，避免切行瞬间最后一个字停在 99.5%
  if (ci === spans.length - 1 && cp >= 100 && !soarDone) {
    for (let i = 0; i < spans.length; i += 1) {
      spans[i].style.setProperty('--cp', '100');
      spans[i].classList.add('is-sung');
    }
    spans[spans.length - 1].classList.remove('is-current');
    soarDone = true;
  }
}

function fireKaraoke() {
  if (!lyricKaraoke) return;
  if (overlay().hidden) return;
  // 手机封面视图里歌词区是 display:none：不必每帧给不可见的逐字 span 写样式。
  // 翱翔鸟Music 在窄屏也始终显示歌词，不受这条限制。
  if (!isSoaringBirdTheme() && window.innerWidth < 600 && playerView === 'cover') return;
  if (curLyricIdx < 0) return;
  const line = lyricLines[curLyricIdx];
  if (!line) return;
  const now = player.posMs();

  // 获取或重建当前行的 DOM 缓存
  if (karaokeLine !== curLyricIdx || !karaokeSpans) {
    const box = document.getElementById('plLyric');
    if (!box) return;
    const el = box.querySelector(`${lyricLineSel()}[data-i="${curLyricIdx}"]`);
    if (!el) return;
    karaokeSpans = el.querySelectorAll(lyricTokenSel());
    // 兜底：该行还没分词（跳转/首次载入落在预热窗口外）→ 立刻补分词
    if (!karaokeSpans.length && isSoaringBirdTheme()) {
      soarTokenizeLine(box, curLyricIdx);
      karaokeSpans = el.querySelectorAll(lyricTokenSel());
    }
    karaokeVals = new Array(karaokeSpans.length).fill(-1);
    karaokeLine = curLyricIdx;
    karaokeTick = 0;                 // 换行后首帧立即绘制
  }
  const spans = karaokeSpans;
  if (!spans.length) return;

  const sbTheme = isSoaringBirdTheme();
  // 翱翔鸟Music：始终走「行内匀速扫光」，不吃词级轴（见 soarTokenizeLine 的说明）；
  // 换行滚动由合成层 CSS transition 完成，主线程只写当前字的 --cp。
  if (sbTheme) { soarSweep(now, line, spans); return; }
  if (!line.w) return;
  const w = line.w;

  if (!CAN_SWEEP) {                  // 老引擎兜底：逐字跳色
    let idx = -1;
    for (let k = 0; k < w.length; k++) { if (w[k][0] <= now) idx = k; else break; }
    if (idx === karaokeIdx) return;
    karaokeIdx = idx;
    spans.forEach((sp, k) => sp.classList.toggle('on', k <= idx));
    return;
  }

  // 翱翔鸟Music 逐字扫光按帧更新（Apple 的 --line-animation-play-state 就是逐帧推进）；
  // 其余皮肤仍节流到 ~30fps 省电。
  if (!sbTheme) {
    const t = performance.now();
    if (t - karaokeTick < 33) return;
    karaokeTick = t;
  }

  for (let k = 0; k < spans.length && k < w.length; k++) {
    const start = w[k][0];
    const end = (k + 1 < w.length) ? w[k + 1][0] : start + 280;
    let p = (now - start) / Math.max(60, end - start);
    p = p < 0 ? 0 : (p > 1 ? 1 : p);
    // 量化后比较（避免无变化时重写样式导致重栅格化闪烁）：
    // 翱翔鸟用 1%（100 档，肉眼连续），其余皮肤 5%。
    const step = sbTheme ? 100 : 20;
    const q = Math.round(p * step) / step;
    if (q === karaokeVals[k]) continue;
    karaokeVals[k] = q;
    spans[k].style.setProperty('--p', q.toFixed(2));
    if (sbTheme) {
      // 翱翔鸟Music：Apple Music 用 --cp（0-100）驱动羽化扫光，并标记已唱/正在唱
      spans[k].style.setProperty('--cp', String(Math.round(q * 100)));
      spans[k].classList.toggle('is-sung', q >= 1);
      spans[k].classList.toggle('is-current', q > 0 && q < 1);
    }
    const sweeping = q > 0 && q < 1;
    if (spans[k].classList.contains('sweep') !== sweeping) spans[k].classList.toggle('sweep', sweeping);
  }
}

function startKaraoke() {
  if (karaokeRaf) return;
  const step = () => { karaokeRaf = requestAnimationFrame(step); fireKaraoke(); };
  karaokeRaf = requestAnimationFrame(step);
}
function stopKaraoke() {
  if (karaokeRaf) cancelAnimationFrame(karaokeRaf);
  karaokeRaf = 0;
  karaokeLine = -1;
  karaokeIdx = -1;
  karaokeSpans = null;
  karaokeVals = [];
  karaokeTick = 0;
}

let curLyricIdx = -1;
let userScrollUntil = 0;

// ---------- 弹簧滚动引擎 ----------
// 替代 CSS behavior:'smooth'（固定缓动、无弹性），用胡克定律做带微弹的跟随：
//   force = -k·(位移) - c·速度     → 轻微过冲后自然回稳（灵动感的来源）
const SPRING = { k: 130, c: 16, snapDist: 0.4, snapVel: 12 };
let springRaf = 0;

function springScrollTo(box, target) {
  if (springRaf) cancelAnimationFrame(springRaf);
  const start = box.scrollTop;
  const dist = target - start;
  if (Math.abs(dist) < 2) { box.scrollTop = target; updateLyricDepth(box); return; }
  let pos = start;
  let vel = dist * 3;            // 初速度朝目标方向（减少起步延迟）
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const force = -SPRING.k * (pos - target) - SPRING.c * vel;
    vel += force * dt;
    pos += vel * dt;
    box.scrollTop = pos;
    updateLyricDepth(box);
    if (Math.abs(pos - target) < SPRING.snapDist && Math.abs(vel) < SPRING.snapVel) {
      box.scrollTop = target;    // 收敛后吸附
      updateLyricDepth(box);
      springRaf = 0;
      return;
    }
    springRaf = requestAnimationFrame(step);
  };
  springRaf = requestAnimationFrame(step);
}

// ---------- 距离感知渐变：离中心越远的行越淡（灵动层次感） ----------
let depthRaf = 0;
function updateLyricDepth(box) {
  if (depthRaf) return;
  depthRaf = requestAnimationFrame(() => {
    depthRaf = 0;
    const centerY = box.scrollTop + box.clientHeight / 2;
    const maxDist = box.clientHeight * 0.55;
    const lines = box.querySelectorAll('.pl-lyric-line');
    for (let j = 0; j < lines.length; j++) {
      const el = lines[j];
      const lineCenter = el.offsetTop + el.offsetHeight / 2;
      const d = Math.abs(lineCenter - centerY);
      // 近处 0.68 → 远处 0.30（.cur 行的 opacity 由 CSS 覆盖为 1）
      const fade = Math.max(0.30, 0.68 - (d / maxDist) * 0.38);
      el.style.setProperty('--depth', fade.toFixed(2));
    }
  });
}

/** 逐行错落：只改每行的 --sd 延时变量（不重写 transition 简写），
    以当前行上方 2 行为起点、每行 +200ms（封顶 5 行），模糊在换行时直接换值不参与动画。 */
function soarStagger(el, idx, active) {
  const order = Math.max(0, idx - (active - 2));
  const d = Math.min(5, order) * 200;
  el.style.setProperty('--sd', `${d}ms`);
}

function syncLyric(force = false) {
  if (!lyricLines.length) {
    pushDesktopLyric(-1);
    return;
  }
  const t = player.posMs();
  let i = 0;
  for (let k = 0; k < lyricLines.length; k++) {
    if (lyricLines[k].t <= t) i = k; else break;
  }
  const changed = i !== curLyricIdx;
  if (changed) {
    curLyricIdx = i;
    pushDesktopLyric(i);        // 播放页未打开时也要喂原生悬浮窗
  }
  const box = document.getElementById('plLyric');
  if (!box) return;
  if (!changed && !force) return;
  const soar = isSoaringBirdTheme();
  // 翱翔鸟Music 主题：纵深/停位交给 CSS（父级只更新 --active-i），并补 past 状态
  if (soar) {
    box.style.setProperty('--active-i', String(i));
    box.querySelectorAll('.lp-lyric').forEach(el => {
      const idx = +el.dataset.i;
      el.classList.toggle('is-active', idx === i);
      el.classList.toggle('is-past', idx < i);
      // 远离当前行的整行模糊在滚动时会反复重绘，是换行/滚动卡顿的主因；
      // 这些行本来就很淡，直接去掉 blur，肉眼无差但省一大笔合成开销。
      el.classList.toggle('is-far', Math.abs(idx - i) >= 4);
      soarStagger(el, idx, i);
    });
  } else {
    box.querySelectorAll('.pl-lyric-line').forEach(el => el.classList.toggle('cur', +el.dataset.i === i));
  }
  karaokeSpans = null;
  soarResetSweep();
  // 预分词：当前行 ±6 行都切好，换行时不再动 DOM
  if (soar) soarTokenizeAround(box, i);
  const cur = box.querySelector(`${lyricLineSel()}[data-i="${i}"]`);
  if (!cur) return;
  if (Date.now() < userScrollUntil) return;
  if (soar) {
    // 换行这一帧刚把新行改成逐字 span，行高可能刚变过；等布局落定再测量，
    // 否则滚动目标基于旧高度，上一行会被顶出遮罩（表现为「上方少一行」）。
    if (soarScrollRaf) cancelAnimationFrame(soarScrollRaf);
    soarScrollRaf = requestAnimationFrame(() => {
      soarScrollRaf = 0;
      if (curLyricIdx !== i) return;
      lpScrollToArtwork(box, cur);
    });
    return;
  }
  const target = Math.max(0, cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2);
  springScrollTo(box, target);
}

/** 翱翔鸟Music：当前行对齐「封面中线」，expo-out 缓动（参考实现同款 560–1150ms）。
 *
 *  这里**不用 scrollTop**，而是给整列套一层 __track 做 translate3d 位移：
 *  scrollTop 每次赋值都会触发布局 + 让 overflow:auto 的容器（还带 mask）重新栅格化
 *  整列歌词文字，42 行带模糊的文字每帧重画就是「换行必卡」的真正来源；
 *  transform 只改合成层偏移，GPU 直接平移，帧率稳定。
 */
function soarTrack(box) {
  return box.querySelector('.lp-lyrics__track');
}

function soarApplyScroll(box, y) {
  const track = soarTrack(box);
  if (!track) return;
  soarScrollY = y;
  track.style.transform = `translate3d(0,${-y}px,0)`;
}

/** 轨道当前**视觉**位移：优先用动画的 timing.progress，避免部分内核
    getComputedStyle 在 WAAPI 播放期间只返回底层值（会导致续接时跳回旧位置 → 硬切）。 */
function soarCurrentY(box) {
  if (lpScrollAnim && lpAnimMeta) {
    try {
      const p = lpScrollAnim.effect.getComputedTiming().progress;
      if (p != null && isFinite(p)) {
        return lpAnimMeta.start + (lpAnimMeta.target - lpAnimMeta.start) * p;
      }
    } catch { /* 忽略 */ }
    return lpAnimMeta.target;
  }
  const track = soarTrack(box);
  if (!track) return soarScrollY;
  const t = getComputedStyle(track).transform;
  if (!t || t === 'none') return soarScrollY;
  const nums = t.replace(/^matrix(3d)?\(|\)$/g, '').split(',').map(Number);
  if (!nums.length || nums.some(n => !isFinite(n))) return soarScrollY;
  const y = nums.length === 16 ? nums[13] : nums[5];
  return -y;
}

function soarScrollMax(box) {
  const track = soarTrack(box);
  if (!track) return 0;
  return Math.max(0, track.offsetHeight - box.clientHeight);
}

function lpScrollToArtwork(box, el) {
  const track = soarTrack(box);
  if (!track) return;
  const max = soarScrollMax(box);
  if (max < 2) return;               // 歌词比面板短：没有可滚动的余量
  const boxTop = box.getBoundingClientRect().top;
  const art = document.querySelector('#playerOverlay .lp-artwork');
  // 只有双栏布局才对齐「封面中线」；≤980 是单列，封面在歌词上方，
  // 按封面中线算 anchor 会得到负值并把歌词顶到最底，改为在歌词面板内居中。
  let anchor = box.clientHeight / 2;
  if (art && window.innerWidth > 980) {
    const ar = art.getBoundingClientRect();
    anchor = (ar.top + ar.height / 2) - boxTop;
    // 防御：封面还在入场动画/被其他层遮挡时可能量到异常值，退回面板居中
    if (!(anchor >= 0 && anchor <= box.clientHeight * 1.5)) anchor = box.clientHeight / 2;
  }
  // 用 offsetTop（布局坐标）而非 getBoundingClientRect：后者会把该行正在进行的
  // CSS translateY 也算进测量值，每次换行都会偏一点，滚到后面就是明显错位。
  const target = Math.min(max, Math.max(0, el.offsetTop - anchor + el.clientHeight / 2));
  // 先读上一段的视觉位置（WAAPI 动画进行中也能读到当前帧），再取消，
  // 这样连续换行时从「当前位置」接着滑，而不是跳回旧目标（硬切感来源）。
  const start = soarCurrentY(box);
  if (lpScrollAnim) { try { lpScrollAnim.cancel(); } catch { /* 忽略 */ } lpScrollAnim = null; }
  lpAnimMeta = null;
  const delta = target - start;
  if (Math.abs(delta) < 1) {
    track.style.transition = 'none';
    track.style.transform = `translate3d(0,${-target}px,0)`;
    soarScrollY = target;
    return;
  }
  // 用 WAAPI 而不是 CSS transition：起止值明确、可中断续接、走合成层，
  // 不会出现「换行那一帧直接跳到新位置」的硬切。
  // 平滑的 ease-in-out（expo-out 起步速度最大，换行会像「先弹一下再滑」）
  const dur = Math.min(950, 560 + Math.abs(delta) * 0.5);
  track.style.transition = 'none';
  // 先把底层值放回起点，再挂动画：否则会有一帧先跳到目标位置，看起来就是「硬切」。
  track.style.transform = `translate3d(0,${-start}px,0)`;
  soarScrollY = target;
  if (typeof track.animate !== 'function') {
    track.style.transform = `translate3d(0,${-target}px,0)`;
    return;
  }
  const anim = track.animate(
    [
      { transform: `translate3d(0,${-start}px,0)` },
      { transform: `translate3d(0,${-target}px,0)` },
    ],
    { duration: dur, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'both' }
  );
  lpScrollAnim = anim;
  lpAnimMeta = { start, target };
  anim.onfinish = () => {
    if (lpScrollAnim !== anim) return;
    lpScrollAnim = null;
    lpAnimMeta = null;
    // 先写底层目标值，再撤掉动画：撤掉时不会回跳到起点
    track.style.transform = `translate3d(0,${-target}px,0)`;
    try { anim.cancel(); } catch { /* 忽略 */ }
  };
}

/** 用户滚轮 / 手指拖动歌词：直接改轨道位移，3 秒内不自动跟随；期间取消模糊便于阅读/点选。 */
function soarManualScroll(box, dy) {
  const track = soarTrack(box);
  if (!track) return;
  const max = soarScrollMax(box);
  // 若自动滚动还在进行，从当前视觉位置开始拖动，避免「跳一下」
  const cur = soarCurrentY(box);
  if (lpScrollAnim) { try { lpScrollAnim.cancel(); } catch { /* 忽略 */ } lpScrollAnim = null; }
  lpAnimMeta = null;
  const y = Math.min(max, Math.max(0, cur + dy));
  track.style.transition = 'none';
  soarApplyScroll(box, y);
  userScrollUntil = Date.now() + 3000;
  box.classList.add('is-manual');
  clearTimeout(soarManualTimer);
  soarManualTimer = setTimeout(() => box.classList.remove('is-manual'), 3200);
}

async function openFull() {
  const ov = overlay();
  const m = player.meta;
  if (!m) return;
  if (!localStorage.getItem('cm.lyricSize')) lyricSizeKey = defaultLyricSizeKey();   // 未手动选择：按当前视口自适应（移动=大 / Pad=特大）
  const st = getStatus(m.ncm_id);
  clearTimeout(closeTimer);
  ov.classList.remove('closing');
  ov.hidden = false;
  document.body.classList.add('player-open');
  // 主题「翱翔鸟Music」：全屏播放页 = 翱翔鸟 Music 的 Apple Music 歌词页布局。
  // 只替换这一主题下的结构与样式，其它皮肤维持原有 DOM 与 CSS 不变。
  const sb = isSoaringBirdTheme();
  const bgStyle = m.pic ? `background-image:linear-gradient(rgba(24,22,30,.45),rgba(24,22,30,.62)),url('${esc(m.pic)}')` : '';
  const qualityNow = player.urlInfo ? tierLabel(player.urlInfo.level) : tierLabel(settings.quality);
  const modeNow = PLAY_MODES.find(x => x.key === player.playMode);
  const plAi = `<span class="pl-ai-btn" id="plAskAi" title="问 CurrentMusicAI"><span class="pl-ai-ava material-icons-outlined">auto_awesome</span><b>问AI</b></span>`;
  const plActions = `${plAi}${castIconHTML()}<span class="pl-btn" id="plMore" title="更多（歌词/背景/下载）"><span class="material-icons-outlined">more_vert</span></span>`;
  const plCtrlIcons = `
            <span class="pl-btn ${st.liked ? 'on' : ''}" id="plLike" title="选择收录到哪个我喜欢"><span class="material-icons-outlined">${st.liked ? 'favorite' : 'favorite_border'}</span><i class="cm-ncmdot" id="plNcmBadge" hidden></i></span>
            <span class="pl-btn" id="plAdd"><span class="material-icons-outlined">playlist_add</span></span>
            <span class="pl-btn" id="plComments" title="评论区"><span class="material-icons-outlined">forum</span></span>
            <span class="pl-btn ${player.playMode !== 'order' ? 'on' : ''}" id="plMode" title="${modeNow.label}"><span class="material-icons-outlined">${modeNow.icon}</span></span>
            <span class="pl-btn ${player.heartMode ? 'on' : ''}" id="plHeart" title="${player.heartMode ? '心动模式已开启：队列快见底自动续播（点击关闭）' : '心动模式：以当前曲目为种子持续智能续播（点击开启）'}"><span class="material-icons-outlined">auto_awesome</span></span>
            <span class="pl-btn" id="plQueue" title="当前播放列表"><span class="material-icons-outlined">queue_music</span></span>`;
  const plStall = `<div class="pl-stall" id="plStall" hidden>
              <mdui-circular-progress style="width:13px;height:13px"></mdui-circular-progress>
              <span id="plStallText">缓冲中…</span>
            </div>`;

  // 翱翔鸟Music：1:1 复刻参考项目 NowPlaying 的 lp-* 结构。
  // 参考页只有「封面 / 元信息 / 进度+音质 / 走带 / 音量 / 歌词」；
  // 其余功能（喜欢、歌单、评论、播放模式、心动、队列、AI、投屏、更多）折叠进右上角汉堡菜单。
  const sbMenu = `
    <button type="button" class="lp-menu__item" id="plLike"><span>喜欢</span><span class="lp-menu__ic material-icons-outlined">${st.liked ? 'favorite' : 'favorite_border'}</span><i class="cm-ncmdot" id="plNcmBadge" hidden></i></button>
    <button type="button" class="lp-menu__item" id="plAdd"><span>加入歌单</span><span class="lp-menu__ic material-icons-outlined">playlist_add</span></button>
    <button type="button" class="lp-menu__item" id="plComments"><span>评论</span><span class="lp-menu__ic material-icons-outlined">forum</span></button>
    <button type="button" class="lp-menu__item ${player.playMode !== 'order' ? 'is-on' : ''}" id="plMode"><span>播放模式</span><em>${modeNow.label}</em><span class="lp-menu__ic material-icons-outlined">${modeNow.icon}</span></button>
    <button type="button" class="lp-menu__item ${player.heartMode ? 'is-on' : ''}" id="plHeart"><span>心动模式</span><em>${player.heartMode ? '开' : '关'}</em><span class="lp-menu__ic material-icons-outlined">auto_awesome</span></button>
    <button type="button" class="lp-menu__item" id="plQueue"><span>播放队列</span><span class="lp-menu__ic material-icons-outlined">queue_music</span></button>
    <button type="button" class="lp-menu__item" id="plAskAi"><span>问 AI</span><span class="lp-menu__ic pl-ai-ava material-icons-outlined">auto_awesome</span></button>
    <div class="lp-menu__row" id="plCastSlot"><span>投屏</span>${castIconHTML()}</div>
    <button type="button" class="lp-menu__item" id="plMore"><span>更多设置</span><span class="lp-menu__ic material-icons-outlined">more_horiz</span></button>`;

  ov.innerHTML = sb ? `
    <div class="lp" role="dialog" aria-label="正在播放">
      <div class="lp-backdrop" id="plBg" aria-hidden="true">
        ${m.pic ? `<img src="${esc(m.pic)}" alt="">` : ''}
        <div class="lp-fluid">
          <span class="lp-blob lp-blob--1"></span>
          <span class="lp-blob lp-blob--2"></span>
          <span class="lp-blob lp-blob--3"></span>
          <span class="lp-blob lp-blob--4"></span>
        </div>
      </div>

      <button type="button" class="lp-close" id="plClose" aria-label="收起">
        <span class="material-icons-outlined">keyboard_arrow_down</span>
      </button>

      <button type="button" class="lp-trans ${lyricMode !== 'orig' ? 'is-on' : ''}" id="plTrans" title="歌词翻译开关" aria-label="歌词翻译开关">
        ${SB_ICON.translate}
      </button>
      <!-- 手机端：封面/歌词切换（Apple Music 同款逻辑，桌面隐藏） -->
      <button type="button" class="lp-lyricview" id="plLyricView" aria-label="歌词">
        <span class="material-icons-outlined">lyrics</span>
      </button>

      <div class="lp-grid">
        <div class="lp-left">
          <div class="lp-artwork" id="plCoverWrap">
            <span class="lp-artwork__glow" aria-hidden="true">${m.pic ? `<img src="${esc(m.pic)}" alt="">` : ''}</span>
            <img id="plCover" src="${esc(m.pic)}" onerror="this.style.visibility='hidden'">
          </div>

          <div class="lp-meta">
            <div class="lp-meta__text">
              <h2 class="pl-name">${esc(m.name)}</h2>
              <p class="pl-artist" id="plArtist">${artistLineHTML(m)}</p>
            </div>
            <button type="button" class="lp-menu-btn lp-star-btn${st.liked ? ' is-on' : ''}" id="plStar" aria-label="收藏" title="收藏">${st.liked ? SB_ICON.starFill : SB_ICON.star}</button>
            <button type="button" class="lp-menu-btn" id="plMenuBtn" aria-label="更多操作" aria-haspopup="menu" aria-expanded="false">${SB_ICON.more}</button>
            <div class="lp-menu" id="plMenu" role="menu" hidden>${sbMenu}</div>
          </div>

          <div class="lp-scrubber">
            <div class="lp-scrubber__bar" id="plSeekbar"></div>
            <div class="lp-scrubber__times">
              <span id="plCur">0:00</span>
              <div class="lp-quality">
                <button type="button" class="lp-quality__chip" id="plQuality" title="播放音质">
                  <span class="lp-quality__ico material-icons-outlined">graphic_eq</span>
                  <span class="lp-quality__label">${esc(qualityNow)}</span>
                </button>
              </div>
              <span id="plDur">-0:00</span>
            </div>
            <div class="lp-scrubber__stall">${plStall}</div>
          </div>

          <div class="lp-controls">
            <button type="button" class="lp-ctl lp-ctl--side ${player.playMode === 'shuffle' ? 'is-on' : ''}" id="plShuffle" aria-label="随机播放">${SB_ICON.shuffle}</button>
            <button type="button" class="lp-ctl" id="plPrev" aria-label="上一首">${AM_ICON.prev}</button>
            <button type="button" class="lp-ctl lp-ctl--play" id="plPlay" aria-label="播放/暂停">${sbPlayIcon()}</button>
            <button type="button" class="lp-ctl" id="plNext" aria-label="下一首">${AM_ICON.next}</button>
            <button type="button" class="lp-ctl lp-ctl--side ${player.playMode === 'one' ? 'is-on' : ''}" id="plRepeat" aria-label="单曲循环">${SB_ICON.repeat}</button>
          </div>

          <div class="lp-volume">
            <span class="lp-volume__icon" aria-hidden="true">${SB_ICON.speaker}</span>
            <input type="range" id="plVolume" min="0" max="1" step="0.01" value="${savedVolume()}" aria-label="音量">
          </div>
        </div>

        <div class="lp-right">
          <div class="lp-lyrics" id="plLyric"></div>
        </div>
      </div>
    </div>` : `
    <div class="pl-bg" id="plBg" style="${bgStyle}"></div>
    <div class="pl-page">
      <div class="pl-top">
        <span class="pl-btn" id="plClose"><span class="material-icons-outlined">keyboard_arrow_down</span></span>
        <div class="pl-quality" id="plQuality">${qualityNow}</div>
        <span class="pl-topact">
          ${plActions}
        </span>
      </div>
      <div class="pl-body view-${playerView}">
        <div class="pl-left">
          <div class="pl-cover-wrap" id="plCoverWrap" title="点击查看歌词">
            <img id="plCover" src="${esc(m.pic)}" onerror="this.style.visibility='hidden'">
          </div>
          <div class="pl-info">
            <div class="pl-name">${esc(m.name)}</div>
            <div class="pl-artist" id="plArtist">${artistLineHTML(m)}</div>
            <div class="pl-stats" id="plStats"><mdui-linear-progress style="width:120px"></mdui-linear-progress></div>
          </div>
          <div class="pl-ctrl">${plCtrlIcons}</div>
          <div class="pl-progress-stack">
            ${waveformHTML()}
            <div class="pl-seek">
              <span id="plCur">0:00</span>
              <div class="pl-seekbar" id="plSeekbar"></div>
              <span id="plDur">0:00</span>
            </div>
            ${plStall}
          </div>
          <div class="pl-transport">
            <span class="pl-btn big" id="plPrev" title="上一首">${AM_ICON.prev}</span>
            <span class="pl-btn huge" id="plPlay" title="播放/暂停">${amPlayIcon()}</span>
            <span class="pl-btn big" id="plNext" title="下一首">${AM_ICON.next}</span>
          </div>
        </div>
        <div class="pl-right">
          <div class="pl-lyric" id="plLyric"></div>
        </div>
      </div>
    </div>`;

  ov.querySelector('#plClose').onclick = closeFull;
  const askAi = ov.querySelector('#plAskAi');
  if (askAi) {
    askAi.onclick = () => openAskAI(player.meta);
    ensureAiBot().then(bot => {
      const ava = askAi.querySelector('.pl-ai-ava');
      if (bot && ava) ava.outerHTML = `<span class="pl-ai-ava">${avatarHTML(bot, 22)}</span>`;
    });
  }
  bindArtistLinks(ov);

  // 翱翔鸟Music：右上角 Apple 扁平风汉堡菜单（多余功能折叠于此）
  const menuBtn = ov.querySelector('#plMenuBtn');
  const menu = ov.querySelector('#plMenu');
  if (menuBtn && menu) {
    const onDoc = e => {
      if (menu.hidden) return;
      if (e.target.closest('#plMenu') || e.target.closest('#plMenuBtn')) return;
      setMenu(false);
    };
    const onKey = e => { if (e.key === 'Escape') setMenu(false); };
    function setMenu(open) {
      menu.hidden = !open;
      menuBtn.classList.toggle('is-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
      if (open) {
        // 菜单改成 position:fixed 后由这里定位：跟随三点按钮右缘，下方放不下就向上弹出，
        // 这样窄屏/矮窗口也不会被 .lp 的 overflow:hidden 裁掉。
        const r = menuBtn.getBoundingClientRect();
        const mw = Math.min(236, window.innerWidth - 24);
        menu.style.width = mw + 'px';
        const mh = Math.min(menu.scrollHeight || 360, window.innerHeight - 24);
        let top = r.bottom + 8;
        if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 8);
        menu.style.top = top + 'px';
        menu.style.left = 'auto';
        menu.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
        document.addEventListener('pointerdown', onDoc, true);
        document.addEventListener('keydown', onKey);
      } else {
        document.removeEventListener('pointerdown', onDoc, true);
        document.removeEventListener('keydown', onKey);
      }
    }
    menuBtn.onclick = e => { e.stopPropagation(); setMenu(menu.hidden); };
    menu.addEventListener('click', e => {
      if (e.target.closest('.lp-menu__item')) setTimeout(() => setMenu(false), 0);
    });
    ov.__cmSbMenuClose = () => setMenu(false);
  }
  // 参考页右上角的「翻译」开关：双语 ↔ 原文
  const transBtn = ov.querySelector('#plTrans');
  if (transBtn) {
    transBtn.onclick = () => {
      lyricMode = lyricMode === 'orig' ? (localStorage.getItem('cm.lyricModePrev') || 'bi') : 'orig';
      if (lyricMode === 'orig') localStorage.setItem('cm.lyricModePrev', transBtn.dataset.prev || 'bi');
      else localStorage.setItem('cm.lyricModePrev', lyricMode);
      try { localStorage.setItem('cm.lyricMode', lyricMode); } catch { /* 隐私模式 */ }
      transBtn.classList.toggle('is-on', lyricMode !== 'orig');
      curLyricIdx = -1;
      karaokeSpans = null;
      renderLyric();
      syncLyric();
    };
    transBtn.dataset.prev = lyricMode !== 'orig' ? lyricMode : 'bi';
  }
  // 参考页的随机 / 单曲循环按钮（与汉堡菜单里的「播放模式」同源）
  const shuffleBtn = ov.querySelector('#plShuffle');
  const repeatBtn = ov.querySelector('#plRepeat');
  const syncModeBtns = () => {
    if (shuffleBtn) shuffleBtn.classList.toggle('is-on', player.playMode === 'shuffle');
    if (repeatBtn) repeatBtn.classList.toggle('is-on', player.playMode === 'one');
    const mb = ov.querySelector('#plMode');
    if (!mb) return;
    const pm = PLAY_MODES.find(x => x.key === player.playMode);
    mb.classList.toggle('on', pm.key !== 'order');
    mb.classList.toggle('is-on', pm.key !== 'order');
    mb.title = pm.label;
    const ic = mb.querySelector('.material-icons-outlined');
    if (ic) ic.textContent = pm.icon;
    const em = mb.querySelector('em');
    if (em) em.textContent = pm.label;
  };
  if (shuffleBtn) shuffleBtn.onclick = () => {
    player.setPlayMode(player.playMode === 'shuffle' ? 'list' : 'shuffle');
    syncModeBtns(); toast(PLAY_MODES.find(x => x.key === player.playMode).label);
  };
  if (repeatBtn) repeatBtn.onclick = () => {
    player.setPlayMode(player.playMode === 'one' ? 'list' : 'one');
    syncModeBtns(); toast(PLAY_MODES.find(x => x.key === player.playMode).label);
  };
  // 音量（参考页底部一条 4px 细线）
  const vol = ov.querySelector('#plVolume');
  if (vol) {
    const paintVol = () => vol.style.setProperty('--vol', (Number(vol.value) * 100) + '%');
    paintVol();
    applyVolume();
    vol.addEventListener('input', () => {
      const v = Number(vol.value);
      paintVol();
      try { localStorage.setItem('cm.volume', String(v)); } catch { /* 隐私模式 */ }
      const a = player.audio;
      if (a) { try { a.volume = v; } catch { /* iOS 只读 */ } }
    });
    vol.addEventListener('click', e => e.stopPropagation());
  }

  // 窄屏：点击封面/周围空白 ↔ 整屏歌词 双视图切换（≥600px 双栏不参与）
  // 翱翔鸟Music 主题沿用 Apple 的单列「封面在上、歌词在下」长页，不再需要视图切换。
  const bodyEl = ov.querySelector('.pl-body');
  if (!sb) bodyEl.addEventListener('click', e => {
    if (window.matchMedia('(min-width: 600px)').matches) return;
    if (e.target.closest('.pl-ctrl, .pl-progress-stack, .pl-transport')) return;      // 控制区不触发
    if (e.target.closest('.pl-lyric-line')) return;                          // 歌词行点击=跳播
    setPlayerView(playerView === 'cover' ? 'lyric' : 'cover');
  });

  ov.querySelector('#plPlay').onclick = () => player.toggle();
  ov.querySelector('#plPrev').onclick = () => player.prev();
  ov.querySelector('#plNext').onclick = () => player.next();
  const modeBtn = ov.querySelector('#plMode');
  modeBtn.onclick = () => {
    const idx = PLAY_MODES.findIndex(x => x.key === player.playMode);
    const next = PLAY_MODES[(idx + 1) % PLAY_MODES.length];
    player.setPlayMode(next.key);
    if (sb) { syncModeBtns(); }
    else {
      modeBtn.classList.toggle('on', next.key !== 'order');
      modeBtn.title = next.label;
      modeBtn.querySelector('.material-icons-outlined').textContent = next.icon;
    }
    toast(next.label);
  };
  // 心动模式开关：开了就立即补一批（队列够长时也会等到快见底才续）
  const heartBtn = ov.querySelector('#plHeart');
  heartBtn.onclick = async () => {
    const on = player.toggleHeartMode();
    heartBtn.classList.toggle('on', on);
    heartBtn.classList.toggle('is-on', on);
    const em = heartBtn.querySelector('em');
    if (em) em.textContent = on ? '开' : '关';
    heartBtn.title = on
      ? '心动模式已开启：队列快见底自动续播（点击关闭）'
      : '心动模式：以当前曲目为种子持续智能续播（点击开启）';
    if (!on) { toast('心动模式已关闭'); return; }
    toast('心动模式已开启');
    if (player.queue.length - player.index <= 3) {
      const n = await player.heartExtend();
      if (!n) toast(player._heartErr || '暂时没取到续播推荐');
    }
  };
  ov.querySelector('#plQueue').onclick = openQueue;
  if (fullProgress) fullProgress.destroy();
  fullProgress = createPlayerProgress(ov.querySelector('#plSeekbar'), player,
    ov.querySelector('#plCur'), sb ? null : ov.querySelector('#plDur'));
  updateSbRemaining();
  // 波形控制器：数据来自真实频谱（wave.read），进度来自 posMs/durMs
  // （投屏时这两个值来自设备上报，直接读 audio 会是 0）
  const canvas = ov.querySelector('#plWaveCanvas');
  if (waveCtl) { waveCtl.destroy(); waveCtl = null; }
  if (canvas) {
    // 纯波形指示：不接收进度（进度由下面专门的可拖动进度条表达）
    waveCtl = createWaveform(canvas, {
      read: u8 => wave.read(u8),
      bins: () => wave.bins,
      rate: () => wave.sampleRate,
      tilt: waveTilt(),
      style: waveStyle(),
    });
    waveCtl.setDbRange(wave.minDb, wave.maxDb);
    waveCtl.setPlaying(player.isPlaying());
    window.__cmWave = waveCtl;          // 调试/测试入口（只读引用）
  }
  ov.querySelector('#plQuality').onclick = qualityMenu;
  ov.querySelector('#plMore').onclick = openMoreDrawer;
  const castBtn = ov.querySelector('#plCast');
  const castSlot = ov.querySelector('#plCastSlot');
  if (castSlot) castSlot.onclick = () => openCastDialog();
  else if (castBtn) castBtn.onclick = () => openCastDialog();
  applyPlayerBg();
  applyDynamicScheme();
  ov.querySelector('#plComments').onclick = () => openComments(player.meta);
  ov.querySelector('#plLike').onclick = async () => {
    await toggleLikeDefault(m, () => syncPlayerLike(m));
  };
  // 汉堡菜单左侧的五角星：复用「喜欢」逻辑，状态由 syncPlayerLike 同步
  const star = ov.querySelector('#plStar');
  if (star) star.onclick = () => ov.querySelector('#plLike').click();
  // 手机端封面/歌词切换：进入歌词视图后重新居中当前行
  const lyricViewBtn = ov.querySelector('#plLyricView');
  if (lyricViewBtn) lyricViewBtn.onclick = () => {
    const lp = ov.querySelector('.lp');
    if (!lp) return;
    lp.classList.toggle('lp-mobile-lyrics');
    if (lp.classList.contains('lp-mobile-lyrics')) {
      requestAnimationFrame(() => {
        const box = ov.querySelector('#plLyric');
        const cur = ov.querySelector('.lp-lyric.is-active');
        if (box && cur) lpScrollToArtwork(box, cur);
      });
    }
  };
  ov.querySelector('#plAdd').onclick = () => addToPlaylist([player.meta]);

  loadLyric();
  loadStats();
  startKaraoke();   // 逐字点亮（暂停时在 state 回调里停）
  syncPlayerLike(m);
}

async function loadStats() {
  const m = player.meta;
  if (!m) return;
  const el = document.getElementById('plStats');
  if (!el) return;
  let pop = m.pop || 0, comments = null, count = getStatus(m.ncm_id).count;
  try {
    const d = await api.songDetail([m.ncm_id]);
    if (d.songs && d.songs[0]) pop = d.songs[0].pop || pop;
  } catch { /* 忽略 */ }
  let topLiked = 0;
  try {
    const cc = await api.commentCount(m.ncm_id);
    comments = cc.total; topLiked = cc.topLiked || 0;
  } catch { /* 忽略 */ }
  if (!player.meta || player.meta.ncm_id !== m.ncm_id) return;
  el.innerHTML = [
    `<span id="plLikeStat"><span class="mi">favorite</span> ${fmtCount(count || 0)} 红心</span>`,
    pop ? `<span><span class="mi">local_fire_department</span> 热度 ${pop}</span>` : '',
    comments !== null ? `<span><span class="mi">forum</span> 评论 ${comments}</span>` : '',
    topLiked ? `<span><span class="mi">thumb_up</span> 网易云最热评论 ${topLiked} 赞</span>` : '',
  ].filter(Boolean).join('');
}

function closeFull() {
  const ov = overlay();
  if (ov.hidden) return;
  if (fullProgress) { fullProgress.destroy(); fullProgress = null; }
  stopKaraoke();
  // 关键：销毁波形控制器。否则关闭播放页后 rAF 仍会每帧读频谱并往**已脱离 DOM**
  // 的 canvas 上绘制——后台空转费电（AI 审查指出的一处真实泄漏）。
  if (waveCtl) { waveCtl.destroy(); waveCtl = null; window.__cmWave = null; }
  if (springRaf) { cancelAnimationFrame(springRaf); springRaf = 0; }
  if (lpScrollRaf) { cancelAnimationFrame(lpScrollRaf); lpScrollRaf = 0; }
  if (typeof ov.__cmSbMenuClose === 'function') { ov.__cmSbMenuClose(); ov.__cmSbMenuClose = null; }
  ov.classList.add('closing');
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    ov.hidden = true;
    ov.innerHTML = '';
    ov.classList.remove('closing');
    document.body.classList.remove('player-open');
  }, 240);
}

// 设置页切换波形样式 / 频谱倾斜时，若播放页正开着就立刻换（不必重开播放页）
['cm-wavestyle', 'cm-wavecfg'].forEach(ev => document.addEventListener(ev, () => {
  const ov = overlay();
  if (!ov || ov.hidden) return;
  const canvas = ov.querySelector('#plWaveCanvas');
  if (!canvas) return;
  if (waveCtl) { waveCtl.destroy(); waveCtl = null; }
  waveCtl = createWaveform(canvas, {
    read: u8 => wave.read(u8), bins: () => wave.bins, rate: () => wave.sampleRate,
    tilt: waveTilt(), style: waveStyle(),
  });
  waveCtl.setDbRange(wave.minDb, wave.maxDb);
  waveCtl.setPlaying(player.isPlaying());
  window.__cmWave = waveCtl;
}));
document.addEventListener('cm-colorscheme', () => {
  if (waveCtl) waveCtl.refreshColor();
});

// ---------- 均衡器 ----------
function openEqDialog() {
  import('./eq.js').then(({ EQ_PRESETS, EQ_BANDS, EQ_LABELS, EQ_GAIN_MAX, eqConfig, setEqConfig, eqActive }) => {
    let cfg = eqConfig();
    const presetChips = () => Object.keys(EQ_PRESETS).map(k =>
      `<mdui-chip data-p="${k}" ${cfg.preset === k ? 'selected' : ''}>${EQ_PRESETS[k].label}</mdui-chip>`).join('');
    const sliders = () => cfg.gains.map((g, i) => `
      <div class="cm-eq-row">
        <span class="cm-eq-label">${EQ_LABELS[i]}<i>${EQ_BANDS[i] >= 1000 ? (EQ_BANDS[i]/1000) + 'k' : EQ_BANDS[i]}</i></span>
        <input type="range" class="cm-eq-slider" data-i="${i}" min="${-EQ_GAIN_MAX}" max="${EQ_GAIN_MAX}" step="1" value="${g}">
        <span class="cm-eq-val">${g > 0 ? '+' : ''}${g}dB</span>
      </div>`).join('');
    const diag = mdui.dialog({
      headline: '均衡器',
      body: `<div class="cm-eq">
        <div class="cm-more-chips" id="eqPresets">${presetChips()}</div>
        <div id="eqSliders">${sliders()}</div>
        <div class="cm-more-s" id="eqHint" style="margin-top:8px">${eqActive() ? '' : '提示：均衡器在音频可视化可用时生效（若当前歌曲走了兼容回退，EQ 可能不生效）'}</div>
      </div>`,
      actions: [{ text: '关闭' }],
    });
    setTimeout(() => {
      diag.querySelectorAll('#eqPresets mdui-chip').forEach(ch => {
        ch.onclick = () => {
          cfg = { preset: ch.dataset.p, gains: EQ_PRESETS[ch.dataset.p].gains.slice() };
          setEqConfig(cfg);
          diag.querySelector('#eqPresets').innerHTML = presetChips();
          diag.querySelector('#eqSliders').innerHTML = sliders();
          bindSliders();
        };
      });
      const bindSliders = () => {
        diag.querySelectorAll('.cm-eq-slider').forEach(sl => {
          sl.oninput = () => {
            const i = +sl.dataset.i, v = +sl.value;
            cfg.gains[i] = v;
            sl.closest('.cm-eq-row').querySelector('.cm-eq-val').textContent = (v > 0 ? '+' : '') + v + 'dB';
            setEqConfig({ preset: 'custom', gains: cfg.gains });
          };
        });
      };
      bindSliders();
    }, 0);
  }).catch(() => toast('均衡器加载失败'));
}

// ---------- 更多抽屉：语言 / 字号 / 渐变背景 / 下载 ----------

function chipsHTML(list, curKey, group) {
  return list.map(it =>
    `<mdui-chip ${it.key === curKey ? 'selected' : ''} data-g="${group}" data-k="${it.key}">${it.label.replace(/^Aa·/, '')}</mdui-chip>`).join('');
}

function openMoreDrawer() {
  dismissToasts();
  const m = player.meta;
  if (!m) return toast('当前没有播放中的歌曲');
  const tier = player.urlInfo ? tierLabel(player.urlInfo.level) : tierLabel(settings.quality);
  const diag = mdui.dialog({
    headline: '更多',
    body: `<div class="cm-more">
      <div class="cm-more-hero">
        ${m.pic ? `<img src="${esc(m.pic)}?param=96y96" alt="">` : '<span class="cm-more-hero-ph material-icons-outlined">music_note</span>'}
        <div class="cm-more-hero-t">
          <div class="cm-more-hero-name">${esc(m.name)}</div>
          <div class="cm-more-hero-sub">${esc(m.artists || '')}</div>
        </div>
        <span class="cm-more-hero-q">${esc(tier)}</span>
      </div>
      <div class="cm-more-grid">
        <div class="cm-more-col">
          <section class="cm-more-card">
            <div class="cm-more-h"><span class="material-icons-outlined">subtitles</span>歌词显示</div>
            <div class="cm-more-field">
              <span class="cm-more-fl">语言</span>
              <div class="cm-more-chips" id="chipsLang">${chipsHTML(LYRIC_MODES, lyricMode, 'lang')}</div>
            </div>
            <div class="cm-more-field">
              <span class="cm-more-fl">字号</span>
              <div class="cm-more-chips" id="chipsSize">${chipsHTML(LYRIC_SIZES, lyricSizeKey, 'size')}</div>
            </div>
          </section>
          <section class="cm-more-card">
            <div class="cm-more-h"><span class="material-icons-outlined">auto_awesome</span>播放增强</div>
            <div class="cm-more-row">
              <div><div class="cm-more-t">逐字歌词</div><div class="cm-more-s">官方逐字精确同步；没有时按行时长自动估算点亮</div></div>
              <mdui-switch id="mKara" ${lyricKaraoke ? 'checked' : ''}></mdui-switch>
            </div>
            <div class="cm-more-row">
              <div><div class="cm-more-t">沉浸模式</div><div class="cm-more-s">封面主色流动渐变铺满播放页</div></div>
              <mdui-switch id="mGrad" ${bgGradOn ? 'checked' : ''}></mdui-switch>
            </div>
          </section>
        </div>
        <div class="cm-more-col">
          <section class="cm-more-card">
            <div class="cm-more-h"><span class="material-icons-outlined">tune</span>工具</div>
            <button type="button" class="cm-more-nav" id="mEq">
              <span class="cm-more-nav-ic material-icons-outlined">graphic_eq</span>
              <span><span class="cm-more-t">均衡器</span><span class="cm-more-s">五段 EQ · 预设与自定义</span></span>
              <span class="cm-more-chev material-icons-outlined">chevron_right</span>
            </button>
            <button type="button" class="cm-more-nav" id="mShare">
              <span class="cm-more-nav-ic material-icons-outlined">share</span>
              <span><span class="cm-more-t">分享歌曲</span><span class="cm-more-s">分享图 / 链接 / 歌曲信息</span></span>
              <span class="cm-more-chev material-icons-outlined">chevron_right</span>
            </button>
          </section>
          <section class="cm-more-card">
            <div class="cm-more-h"><span class="material-icons-outlined">menu_book</span>歌曲资料</div>
            <button type="button" class="cm-more-nav" id="mWiki">
              <span class="cm-more-nav-ic material-icons-outlined">subject</span>
              <span><span class="cm-more-t">歌曲百科</span><span class="cm-more-s">创作信息 / 基本信息 / 百科正文</span></span>
              <span class="cm-more-chev material-icons-outlined">chevron_right</span>
            </button>
            <button type="button" class="cm-more-nav" id="mSongInfo">
              <span class="cm-more-nav-ic material-icons-outlined">info</span>
              <span><span class="cm-more-t">查看歌曲详情</span><span class="cm-more-s">音质档位 / 副歌时间 / 红心数 / 创作者 / 相似歌曲</span></span>
              <span class="cm-more-chev material-icons-outlined">chevron_right</span>
            </button>
          </section>
        </div>
      </div>
      <section class="cm-more-card cm-more-dl">
        <div class="cm-more-h"><span class="material-icons-outlined">download</span>下载到本机</div>
        <div class="cm-more-chips" id="chipsDl">${QUALITY_TIERS.map(t =>
          `<mdui-chip data-g="dl" data-k="${t.key}" ${t.key === settings.quality ? 'selected' : ''}>${t.label}</mdui-chip>`).join('')}</div>
        <div class="cm-more-s" style="margin-top:8px">目录：Music/${esc(localStorage.getItem('cm.downloadDir') || 'CurrentMusic')}（可在「我的-快捷功能」修改）</div>
      </section>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  diag.classList.add('cm-more-dialog');
  setTimeout(() => {
    const msh = diag.querySelector('#mShare');
    if (msh) msh.onclick = () => {
      if (!player.meta) return toast('当前没有播放中的歌曲');
      diag.open = false;
      openShare(player.meta);
    };
    const meq = diag.querySelector('#mEq');
    if (meq) meq.onclick = () => { diag.open = false; openEqDialog(); };
    const wk = diag.querySelector('#mWiki');
    if (wk) wk.onclick = () => {
      diag.open = false;
      import('./wiki.js').then(x => x.openWiki(player.meta)).catch(() => toast('百科加载失败'));
    };
    const si = diag.querySelector('#mSongInfo');
    if (si) si.onclick = () => {
      diag.open = false;
      import('./songinfo.js').then(x => x.openSongInfo(player.meta)).catch(() => {});
    };
    diag.querySelectorAll('mdui-chip[data-g="lang"]').forEach(ch => {
      ch.onclick = () => {
        lyricMode = ch.dataset.k;
        localStorage.setItem('cm.lyricMode', lyricMode);
        diag.querySelectorAll('mdui-chip[data-g="lang"]').forEach(x => x.selected = x === ch);
        curLyricIdx = -1;
        renderLyric(); syncLyric();
      };
    });
    diag.querySelectorAll('mdui-chip[data-g="size"]').forEach(ch => {
      ch.onclick = () => {
        lyricSizeKey = ch.dataset.k;
        localStorage.setItem('cm.lyricSize', lyricSizeKey);
        diag.querySelectorAll('mdui-chip[data-g="size"]').forEach(x => x.selected = x === ch);
        renderLyric(); syncLyric();
      };
    });
    diag.querySelector('#mKara').addEventListener('change', e => {
      lyricKaraoke = e.target.checked;
      localStorage.setItem('cm.karaoke', lyricKaraoke ? '1' : '0');
      renderLyric();
      stopKaraoke(); startKaraoke(); fireKaraoke();
    });
    diag.querySelector('#mGrad').addEventListener('change', e => {
      bgGradOn = e.target.checked;
      localStorage.setItem('cm.bgGrad', bgGradOn ? '1' : '0');
      applyPlayerBg();
    });
    diag.querySelectorAll('mdui-chip[data-g="dl"]').forEach(ch => {
      ch.onclick = () => { diag.open = false; doDownload(ch.dataset.k); };
    });
  }, 0);
}

async function doDownload(level) {
  const m = player.meta;
  if (!m) return;
  toast('正在解析下载地址…');
  try {
    // 优先用上游「客户端下载链接」（/song/download/url/v1）：直接给出带 size/md5/type 的下载地址，
    // 拿不到再回退到播放用的音源地址。
    let info = null;
    try {
      const d = await api.ncm('/song/download/url/v1', { id: m.ncm_id, level: level || 'exhigh' });
      const dd = d.data || {};
      if (dd.url) info = { url: dd.url, type: dd.type || 'mp3' };
    } catch { /* 回退 */ }
    if (!info) {
      // 第二层：老版客户端下载链接（参数是码率 br，不是档位名）
      try {
        const d2 = await api.ncm('/song/download/url', { id: m.ncm_id, br: 320000 });
        const dd2 = d2.data || d2;
        if (dd2 && dd2.url) info = { url: dd2.url, type: dd2.type || 'mp3' };
      } catch { /* 继续回退 */ }
    }
    if (!info) info = await api.songUrl(m.ncm_id, level);
    const ext = (info.type || 'mp3').toLowerCase();
    const name = `${m.name} - ${m.artists}.${ext}`.replace(/[\\/:*?"<>|]/g, '_');
    const dir = localStorage.getItem('cm.downloadDir') || 'CurrentMusic';
    if (window.NativeApi && window.NativeApi.download) {
      window.NativeApi.download(info.url, name, dir);
    } else {
      window.open(info.url, '_blank');
      toast('浏览器环境：已打开音频，可手动保存');
    }
  } catch (e) {
    toast(`下载失败：${e.message}`);
  }
}

// ---------- 播放页背景：动态渐变（默认开）/ 封面模糊 ----------

async function applyPlayerBg() {
  const el = document.getElementById('plBg');
  if (!el || !player.meta) return;
  // 翱翔鸟Music：背景就是参考项目的「封面模糊 + 四个流动色团」，
  // 不使用 CurrentMusic 的动态渐变/静态封面底，避免多套滤镜叠加（卡顿来源之一）。
  if (isSoaringBirdTheme()) {
    const m = player.meta;
    const img = el.querySelector('img');
    if (img && m.pic && img.getAttribute('src') !== m.pic) img.src = m.pic;
    if (!m.pic) return;
    coverColors(m.pic).then(cs => {
      if (!cs || !player.meta || player.meta.pic !== m.pic) return;
      el.style.setProperty('--c1', cs.primary);
      el.style.setProperty('--c2', cs.deep);
      el.style.setProperty('--c3', cs.dark);
      el.style.setProperty('--c4', cs.accent || cs.deep);
    }).catch(() => {});
    return;
  }
  if (!bgGradOn) {
    el.className = 'pl-bg';
    el.style.backgroundImage = player.meta.pic
      ? `linear-gradient(rgba(24,22,30,.45),rgba(24,22,30,.62)),url('${esc(player.meta.pic)}')` : '';
    return;
  }
  el.className = 'pl-bg grad';
  const g = (cs, deg) => `linear-gradient(${deg}deg, ${cs.primary} 0%, ${cs.deep} 48%, ${cs.dark} 100%)`;
  const setG = (a, b) => {
    el.style.setProperty('--g1', a);
    el.style.setProperty('--g2', b);
  };
  setG('linear-gradient(155deg, #6750a4 0%, #4a3a78 48%, #322653 100%)',
       'linear-gradient(205deg, #4a3a78 0%, #6750a4 55%, #322653 100%)');   // 兜底色组，取色成功后覆盖
  // 先用「上一次成功的色组」立即上色（coverColors 在取不到时也会返回它），
  // 再等本次取色回来覆盖：这样切歌不会先闪一下默认紫。
  const quick = await coverColors(player.meta.pic);
  if (quick && player.meta && document.getElementById('plBg') === el) {
    setG(g(quick, 155), g({ ...quick, primary: quick.deep, deep: quick.primary }, 205));
  }
  const cs = await coverColors(player.meta.pic);
  if (!cs || !player.meta || document.getElementById('plBg') !== el) return;
  setG(g(cs, 155), g({ ...cs, primary: cs.deep, deep: cs.primary }, 205));
}

// 动态取色：配色方案为 dynamic 时随封面切换全局主色（含深色档/强调色，见 applyColorScheme）
async function applyDynamicScheme() {
  if (getColorSchemeKey() !== 'dynamic' || !player.meta) return;
  const meta = player.meta;
  const cs = await coverColors(meta.pic);
  // 快速切歌时，较慢的上一张封面不能反过来覆盖当前歌曲的配色。
  if (cs && player.meta === meta && getColorSchemeKey() === 'dynamic') applyColorScheme(cs.primary, cs);
}
on('song', () => { applyDynamicScheme(); });
document.addEventListener('cm-colorscheme-mode', e => {
  if (e.detail && e.detail.key === 'dynamic') applyDynamicScheme();
});
// 缓冲进度：progress 事件与 tick 都会驱动，这里保证进度条上的缓冲区间实时更新
on('buffer', () => {
  if (miniProgress) miniProgress.update();
  if (fullProgress) fullProgress.update();
});
// 卡顿提示：waiting/stalled 时显示「缓冲中…」，恢复或自愈成功即隐藏
on('stalling', on => {
  const box = document.getElementById('plStall');
  if (box) box.hidden = !on;
});

/** 切歌时轻量更新播放页的歌曲字段（封面/标题/歌手/统计/音质），不重建 overlay——
 * 重建会导致歌词区被清空再异步填充，产生"突然消失又出现"的闪烁。 */
/** 歌手行：每位歌手各自可点（跳其主页）；无 id 时退化为纯文本。 */
function artistLineHTML(m) {
  const ids = m.artist_ids || [];
  const names = String(m.artists || '').split(' / ');
  const parts = names.map((n, i) => ids[i]
    ? `<span class="pl-artist-link" data-aid="${ids[i]}" title="查看 ${esc(n)} 的主页">${esc(n)}</span>`
    : esc(n));
  return parts.join(' / ') + (m.album ? ' · ' + esc(m.album) : '');
}

/** 绑定歌手名的点击（打开歌手主页前先收起播放页） */
function bindArtistLinks(scope) {
  (scope || document).querySelectorAll('.pl-artist-link').forEach(el => {
    el.onclick = e => {
      e.stopPropagation();
      const aid = el.dataset.aid;
      if (!aid) return;
      const ov = overlay();
      if (ov && !ov.hidden) closeFull();          // 先收播放页，避免盖住目标页
      setTimeout(() => { location.hash = `#/artist/${aid}`; }, 180);
    };
  });
}

/** 按「默认红心目标」同步播放页红心、网易云小圆点与红心数。 */
async function syncPlayerLike(m) {
  if (!m) return;
  try {
    await ensureStatus(m.ncm_id).catch(() => {});   // 同时刷新本地状态与网易云红心数
    const s = await ensureLikeState(m);
    if (!player.meta || player.meta.ncm_id !== m.ncm_id) return;
    const btn = document.getElementById('plLike');
    if (btn) {
      btn.classList.toggle('on', s.liked);
      btn.classList.toggle('is-on', s.liked);
      btn.querySelector('.material-icons-outlined').textContent = s.liked ? 'favorite' : 'favorite_border';
      btn.title = s.source === 'ncm' ? '红心到网易云' : '加入 CurrentMusic 我喜欢';
    }
    const star = document.getElementById('plStar');
    if (star) {
      star.classList.toggle('is-on', s.liked);
      star.innerHTML = s.liked ? SB_ICON.starFill : SB_ICON.star;
      star.title = s.liked ? '已收藏' : '收藏';
    }
    const badge = document.getElementById('plNcmBadge');
    if (badge) badge.hidden = !(s.bound && s.source === 'local' && isNcmLiked(m.ncm_id));
    const stat = document.getElementById('plLikeStat');
    if (stat) stat.innerHTML = `<span class="mi">favorite</span> ${fmtCount(s.count || 0)} 红心`;
  } catch { /* 未绑定/网络失败：保留当前 UI */ }
}

function updateSongInfo() {
  const ov = overlay();
  const m = player.meta;
  if (!ov || ov.hidden || !m) return;
  const cover = document.getElementById('plCover');
  if (cover) cover.src = m.pic || '';
  const glow = ov.querySelector('.lp-artwork__glow img, .sb-artwork-glow img');
  if (glow) glow.src = m.pic || '';
  const name = ov.querySelector('.pl-name');
  if (name) name.textContent = m.name;
  const menuTitle = ov.querySelector('.lp-menu__title');
  if (menuTitle) menuTitle.textContent = m.name;
  const artist = ov.querySelector('.pl-artist');
  if (artist) { artist.innerHTML = artistLineHTML(m); bindArtistLinks(artist); }
  paintQuality();
  if (fullProgress) fullProgress.update();
  syncPlayerLike(m);
  // 更新背景
  applyPlayerBg();
}

/** 音质胶囊：翱翔鸟Music 的 chip 里还有图标，不能直接写 textContent（会清空结构）。 */
function paintQuality() {
  const q = document.getElementById('plQuality');
  if (!q) return;
  const txt = player.urlInfo ? tierLabel(player.urlInfo.level) : tierLabel(settings.quality);
  const label = q.querySelector('.lp-quality__label');
  if (label) label.textContent = txt; else q.textContent = txt;
}

on('song', () => {
  if (!overlay().hidden) {
    updateSongInfo();           // 只更新歌曲字段，不重建整个 overlay（重建会清空歌词区 → 闪烁）
  }
  karaokeLine = -1; karaokeIdx = -1; karaokeSpans = null; karaokeTick = 0;
  loadLyric();
  loadStats();
  fireKaraoke();
});
on('state', () => {
  if (!player.isPlaying()) stopKaraoke(); else startKaraoke();
  const b = document.getElementById('plPlay');
  if (b) b.innerHTML = isSoaringBirdTheme() ? sbPlayIcon() : amPlayIcon();
  if (waveCtl) waveCtl.setPlaying(player.isPlaying());
  if (fullProgress) fullProgress.update();
  renderMini();
});

function qualityMenu() {
  const cur = settings.quality;
  const items = QUALITY_TIERS.map(t =>
    `<div class="cm-qm-item" data-v="${t.key}">${t.label}${t.spec ? `<em class="cm-qm-spec">${t.spec}</em>` : ''}${t.key === cur ? '<span class="material-icons-outlined">check</span>' : ''}</div>`).join('');
  const diag = mdui.dialog({
    headline: '选择音质',
    body: `<div class="cm-qm">${items}</div>`,
    actions: [{ text: '关闭' }],
  });
  setTimeout(() => {
    diag.querySelectorAll('.cm-qm-item').forEach(it => {
      it.onclick = () => {
        const v = it.dataset.v;
        player.changeQuality(v);
        paintQuality();
        diag.open = false;
      };
    });
  }, 0);
}


// ---------- 当前播放列表 ----------

export function openQueue() {
  const q = player.queue;
  if (!q.length) return toast('播放列表为空');
  const diag = mdui.dialog({
    headline: `当前播放（${q.length} 首）`,
    body: `<div class="cm-queue">${q.map((s, i) => `
      <div class="cm-queue-item ${i === player.index ? 'cur' : ''}" data-i="${i}">
        <span class="q-idx">${i === player.index ? '<span class="material-icons-outlined">graphic_eq</span>' : i + 1}</span>
        <div class="q-main">
          <div class="q-name">${esc(s.name)}</div>
          <div class="q-sub">${esc(s.artists)}</div>
        </div>
        <span class="q-dur">${fmtDur(s.duration)}</span>
      </div>`).join('')}</div>`,
    actions: [{ text: '关闭' }],
  });
  setTimeout(() => {
    diag.querySelectorAll('.cm-queue-item').forEach(it => {
      it.onclick = () => {
        player.playAt(+it.dataset.i);
        diag.open = false;
      };
    });
    const cur = diag.querySelector('.cm-queue-item.cur');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }, 0);
}

// ---------- 评论区（内容同步网易云，发评走绑定账号） ----------


// 歌曲评论：统一走通用评论抽屉（web/src/comments.js），覆盖 6 个维度
// 说明：此处原先是一份 200 行的「只在歌曲维度可用」的实现，已抽到 comments.js，
// 以免同一套热门/最新/楼层/点赞/回复逻辑在多处分叉。
export async function openComments(meta) {
  if (!meta) return;
  const { openComments: openEntityComments } = await import('./comments.js');
  return openEntityComments({ type: 0, id: meta.ncm_id, title: meta.name || '歌曲' });
}


// ---------- 加入歌单 bottom sheet ----------

export async function addToPlaylist(songs) {
  if (!auth.token) return toast('登录后才能操作歌单');
  if (!songs || !songs.length) return;
  let pls = [];
  try { pls = ((await api.myPlaylists()).playlists || []).filter(p => p.source !== "ncm"); }
  catch (e) { return toast(e.message); }

  const diag = mdui.dialog({
    headline: `加入歌单（${songs.length} 首）`,
    body: `
      <div class="cm-pl-pick">
        ${pls.map(p => `<div class="cm-pl-pick-item" data-id="${p.id}"><span class="material-icons-outlined">queue_music</span><div><div>${esc(p.name)}</div><div class="sub">${p.track_count} 首</div></div></div>`).join('')}
        <div class="cm-pl-pick-item new" id="plNew"><span class="material-icons-outlined">add</span><div>新建歌单</div></div>
      </div>`,
    actions: [{ text: '取消' }],
  });
  setTimeout(() => {
    diag.querySelectorAll('.cm-pl-pick-item').forEach(el => {
      el.onclick = async () => {
        if (el.id === 'plNew') {
          diag.open = false;
          const { promptDialog } = await import('./ui.js');
          promptDialog({
            title: '新建歌单', label: '歌单名称',
            onOk: async name => {
              const p = await api.createPlaylist(name, '');
              await api.addPlaylistTracks(p.id, songs);
              toast(`已创建「${name}」并加入 ${songs.length} 首`);
            },
          });
          return;
        }
        try {
          await api.addPlaylistTracks(+el.dataset.id, songs);
          toast(`已加入「${el.querySelector('div div').textContent}」`);
          diag.open = false;
        } catch (e) { toast(e.message); }
      };
    });
  }, 0);
}

export function initPlayerUI() {
  renderMini();
  applyDynamicScheme();   // 启动即随上次播放的封面取色（配色为 dynamic 时）
  // 切换皮肤时若播放页正开着：按新主题重建一次结构与背景（其它皮肤走原模板，等价于原样重开）
  document.addEventListener('cm-uipreset', () => {
    const ov = overlay();
    if (ov && !ov.hidden) openFull();
    // 迷你播放条是**按主题生成不同 DOM** 的：切换皮肤后必须强制重建，
    // 否则会把翱翔鸟的三段式胶囊留在 cmx/frost/glass 下（看起来就是「其他主题乱掉了」）。
    // 切换皮肤：先彻底清空迷你条，再按当前主题重建，杜绝旧皮肤 DOM 残留
    const miniEl = document.getElementById('mini');
    if (miniEl) { miniEl.innerHTML = ''; miniEl.style.display = ''; }
    if (miniProgress) { miniProgress.destroy(); miniProgress = null; }
    miniMeta = null;
    renderMini();
  });
}
