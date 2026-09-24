// 播放器 UI：底部迷你条 + 全屏播放页（封面/歌词/进度/音质/点赞/收藏/加入歌单）。
import { mdui } from './md.js';
import { api, auth, settings } from './api.js';
import { esc, toast, fmtDur, tierLabel, QUALITY_TIERS, getStatus, setStatus, openLikeMenu, isNcmLiked, ensureNcmLiked, skelComments, coverColors, defaultLyricSizeKey, getColorSchemeKey, applyColorScheme } from './ui.js';
import { player, on } from './player.js';

const overlay = () => document.getElementById('playerOverlay');

// ---------- 迷你条 ----------

function renderMini() {
  const el = document.getElementById('mini');
  if (!player.meta) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  const m = player.meta;
  el.innerHTML = `
    <div class="cm-mini-prog"><i id="miniProg"></i></div>
    <div class="cm-mini-inner">
      ${m.pic ? `<img src="${esc(m.pic)}">` : `<div class="cm-mini-ph"><span class="material-icons-outlined">music_note</span></div>`}
      <div class="cm-mini-text">
        <div class="cm-mini-name">${esc(m.name)}</div>
        <div class="cm-mini-sub">${esc(m.artists)}${player.urlInfo ? ' · ' + tierLabel(player.urlInfo.level) : player.loading ? ' · 解析音质中…' : ''}</div>
      </div>
      <span class="cm-mini-btn" id="miniPlay"><span class="material-icons-outlined">${!player.audio.paused ? 'pause_circle' : 'play_circle'}</span></span>
      <span class="cm-mini-btn" id="miniNext"><span class="material-icons-outlined">skip_next</span></span>
    </div>`;
  el.querySelector('#miniPlay').onclick = e => { e.stopPropagation(); player.toggle(); };
  el.querySelector('#miniNext').onclick = e => { e.stopPropagation(); player.next(); };
  el.querySelector('.cm-mini-inner').onclick = () => openFull();
}

on('song', renderMini);
on('state', renderMini);

on('time', () => {
  // 进度线紧贴迷你播放条上缘
  const bar = document.getElementById('miniProg');
  if (bar) bar.style.width = player.audio.duration ? (player.audio.currentTime / player.audio.duration * 100) + '%' : '0%';
  syncLyric();
  const t = document.getElementById('plCur'), d = document.getElementById('plDur'), s = document.getElementById('plSeek');
  if (t) t.textContent = fmtDur(player.audio.currentTime * 1000);
  if (d && player.audio.duration) d.textContent = fmtDur(player.audio.duration * 1000);
  if (s && !s.dataset.drag) { s.value = player.audio.duration ? (player.audio.currentTime / player.audio.duration) * 100 : 0; }
});

// ---------- 全屏播放页 ----------

let lyricLines = [];
let lyricLoadedFor = null;

async function loadLyric() {
  const m = player.meta;
  if (!m) return;
  lyricLines = []; curLyricIdx = -1; lyricLoadedFor = m.ncm_id;
  try {
    const d = await api.lyric(m.ncm_id);
    if (!player.meta || player.meta.ncm_id !== m.ncm_id) return;
    lyricLines = (d.lines || []).filter(l => l.txt);
  } catch { lyricLoadedFor = m.ncm_id + ':err'; }
  renderLyric();
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
  if (bodyEl) bodyEl.className = `pl-body view-${v}`;
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
  if (!lyricLines.length) {
    box.innerHTML = `<div class="pl-lyric-empty">暂无歌词</div>`;
    return;
  }
  const size = LYRIC_SIZES.find(s => s.key === lyricSizeKey) || LYRIC_SIZES[1];
  box.style.setProperty('--pl-fs', size.fs + 'px');
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
      return `<div class="pl-lyric-line" data-i="${i}">${body}${sub ? `<div class="pl-lyric-trans">${esc(sub)}</div>` : ''}</div>`;
    }).join('') +
    `<div class="pl-lyric-pad" id="padBot"></div>`;
  box.querySelectorAll('.pl-lyric-line').forEach(el => {
    el.onclick = e => { e.stopPropagation(); player.seek(lyricLines[+el.dataset.i].t / 1000); };
  });
  layoutLyricPads();
  // 只在真实用户输入时暂停自动跟随 3 秒。
  // 不要用 onscroll + 标志位判定——scrollTo 的平滑动画也会触发 scroll 事件，
  // 动画期间标志位被 setTimeout 重置后，后续动画事件会被误判为用户操作，
  // 误设 userScrollUntil → 自动跟随被禁 → 视觉上歌词"卡住不滚"。
  ['pointerdown', 'wheel', 'touchstart'].forEach(evt => {
    box.addEventListener(evt, () => { userScrollUntil = Date.now() + 3000; }, { passive: true });
  });
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
window.addEventListener('resize', () => { layoutLyricPads(); });

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

function fireKaraoke() {
  if (!lyricKaraoke) return;
  if (curLyricIdx < 0) return;
  const line = lyricLines[curLyricIdx];
  if (!line || !line.w) return;
  const now = player.audio.currentTime * 1000;
  const w = line.w;

  // 获取或重建当前行的 DOM 缓存
  if (karaokeLine !== curLyricIdx || !karaokeSpans) {
    const box = document.getElementById('plLyric');
    if (!box) return;
    const el = box.querySelector(`.pl-lyric-line[data-i="${curLyricIdx}"]`);
    if (!el) return;
    karaokeSpans = el.querySelectorAll('.ch');
    karaokeVals = new Array(karaokeSpans.length).fill(-1);
    karaokeLine = curLyricIdx;
    karaokeTick = 0;                 // 换行后首帧立即绘制
  }
  const spans = karaokeSpans;
  if (!spans.length) return;

  if (!CAN_SWEEP) {                  // 老引擎兜底：逐字跳色
    let idx = -1;
    for (let k = 0; k < w.length; k++) { if (w[k][0] <= now) idx = k; else break; }
    if (idx === karaokeIdx) return;
    karaokeIdx = idx;
    spans.forEach((sp, k) => sp.classList.toggle('on', k <= idx));
    return;
  }

  // 节流到 ~30fps
  const t = performance.now();
  if (t - karaokeTick < 33) return;
  karaokeTick = t;

  for (let k = 0; k < spans.length && k < w.length; k++) {
    const start = w[k][0];
    const end = (k + 1 < w.length) ? w[k + 1][0] : start + 280;
    let p = (now - start) / Math.max(60, end - start);
    p = p < 0 ? 0 : (p > 1 ? 1 : p);
    // 5% 量化后比较（避免无变化时重写样式导致重栅格化闪烁）
    const q = Math.round(p * 20) / 20;
    if (q === karaokeVals[k]) continue;
    karaokeVals[k] = q;
    spans[k].style.setProperty('--p', q.toFixed(2));
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

function syncLyric() {
  if (!lyricLines.length) return;
  const box = document.getElementById('plLyric');
  if (!box) return;
  const t = player.audio.currentTime * 1000;
  let i = 0;
  for (let k = 0; k < lyricLines.length; k++) {
    if (lyricLines[k].t <= t) i = k; else break;
  }
  if (i === curLyricIdx) return;
  const prev = curLyricIdx;
  curLyricIdx = i;
  box.querySelectorAll('.pl-lyric-line').forEach(el => el.classList.toggle('cur', +el.dataset.i === i));
  // 逐字缓存随行切换而失效
  karaokeSpans = null;
  const cur = box.querySelector(`.pl-lyric-line[data-i="${i}"]`);
  if (!cur) return;
  if (Date.now() < userScrollUntil) return;         // 用户正在浏览
  const target = cur.offsetTop - box.clientHeight / 2 + cur.clientHeight / 2;
  if (target < 0) { box.scrollTop = 0; return; }
  const dist = Math.abs(target - box.scrollTop);
  // 短距离平滑、长距离瞬时（拖进度/切歌时 smooth 跟不上）
  box.scrollTo({ top: target, behavior: dist > 500 ? 'auto' : 'smooth' });
}

async function openFull() {
  const ov = overlay();
  const m = player.meta;
  if (!m) return;
  if (!localStorage.getItem('cm.lyricSize')) lyricSizeKey = defaultLyricSizeKey();   // 未手动选择：按当前视口自适应（移动=大 / Pad=特大）
  const st = getStatus(m.ncm_id);
  ov.hidden = false;
  ov.innerHTML = `
    <div class="pl-bg" id="plBg" style="${m.pic ? `background-image:linear-gradient(rgba(24,22,30,.45),rgba(24,22,30,.62)),url('${esc(m.pic)}')` : ''}"></div>
    <div class="pl-page">
      <div class="pl-top">
        <span class="pl-btn" id="plClose"><span class="material-icons-outlined">keyboard_arrow_down</span></span>
        <div class="pl-quality" id="plQuality">${player.urlInfo ? tierLabel(player.urlInfo.level) : tierLabel(settings.quality)}</div>
        <span class="pl-btn" id="plMore" title="更多（歌词/背景/下载）"><span class="material-icons-outlined">more_vert</span></span>
      </div>
      <div class="pl-body view-${playerView}">
        <div class="pl-left">
          <div class="pl-cover-wrap" id="plCoverWrap" title="点击查看歌词">
            <img id="plCover" src="${esc(m.pic)}" onerror="this.style.visibility='hidden'">
          </div>
          <div class="pl-info">
            <div class="pl-name">${esc(m.name)}</div>
            <div class="pl-artist">${esc(m.artists)}${m.album ? ' · ' + esc(m.album) : ''}</div>
            <div class="pl-stats" id="plStats"><mdui-linear-progress style="width:120px"></mdui-linear-progress></div>
          </div>
          <div class="pl-ctrl">
            <span class="pl-btn ${st.liked ? 'on' : ''}" id="plLike" title="选择收录到哪个我喜欢"><span class="material-icons-outlined">${st.liked ? 'favorite' : 'favorite_border'}</span><i class="cm-ncmdot" id="plNcmBadge" hidden></i></span>
            <span class="pl-btn" id="plAdd"><span class="material-icons-outlined">playlist_add</span></span>
            <span class="pl-btn" id="plComments" title="评论区"><span class="material-icons-outlined">forum</span></span>
            <span class="pl-btn ${player.playMode !== 'order' ? 'on' : ''}" id="plMode" title="${PLAY_MODES.find(x => x.key === player.playMode).label}"><span class="material-icons-outlined">${PLAY_MODES.find(x => x.key === player.playMode).icon}</span></span>
            <span class="pl-btn" id="plQueue" title="当前播放列表"><span class="material-icons-outlined">queue_music</span></span>
          </div>
          <div class="pl-seek">
            <span id="plCur">0:00</span>
            <input type="range" id="plSeek" min="0" max="100" step="0.1" value="0">
            <span id="plDur">0:00</span>
          </div>
          <div class="pl-transport">
            <span class="pl-btn big" id="plPrev"><span class="material-icons-outlined">skip_previous</span></span>
            <span class="pl-btn huge" id="plPlay"><span class="material-icons-outlined">${player.loading ? 'hourglass_empty' : (!player.audio.paused ? 'pause_circle' : 'play_circle')}</span></span>
            <span class="pl-btn big" id="plNext"><span class="material-icons-outlined">skip_next</span></span>
          </div>
        </div>
        <div class="pl-right">
          <div class="pl-lyric" id="plLyric"></div>
        </div>
      </div>
    </div>`;

  ov.querySelector('#plClose').onclick = closeFull;

  // 窄屏：点击封面/周围空白 ↔ 整屏歌词 双视图切换（≥600px 双栏不参与）
  const bodyEl = ov.querySelector('.pl-body');
  bodyEl.addEventListener('click', e => {
    if (window.matchMedia('(min-width: 600px)').matches) return;
    if (e.target.closest('.pl-ctrl, .pl-seek, .pl-transport')) return;      // 控制区不触发
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
    modeBtn.classList.toggle('on', next.key !== 'order');
    modeBtn.title = next.label;
    modeBtn.querySelector('.material-icons-outlined').textContent = next.icon;
    toast(next.label);
  };
  ov.querySelector('#plQueue').onclick = openQueue;
  const seek = ov.querySelector('#plSeek');
  seek.oninput = () => { seek.dataset.drag = '1'; };
  seek.onchange = () => {
    if (player.audio.duration) player.seek(seek.value / 100 * player.audio.duration);
    delete seek.dataset.drag;
  };
  ov.querySelector('#plQuality').onclick = qualityMenu;
  ov.querySelector('#plMore').onclick = openMoreDrawer;
  applyPlayerBg();
  applyDynamicScheme();
  ov.querySelector('#plComments').onclick = () => openComments(player.meta);
  ov.querySelector('#plLike').onclick = () => openLikeMenu(m, () => {
    const st2 = getStatus(m.ncm_id);
    const btn = document.getElementById('plLike');
    if (btn) {
      btn.classList.toggle('on', st2.liked);
      btn.querySelector('.material-icons-outlined').textContent = st2.liked ? 'favorite' : 'favorite_border';
    }
    loadStats();
  });
  ov.querySelector('#plAdd').onclick = () => addToPlaylist([player.meta]);

  loadLyric();
  loadStats();
  startKaraoke();   // 逐字点亮（暂停时在 state 回调里停）
  // 网易云红心小徽标（绑定账号已红心时显示；未登录不请求）
  if (auth.token) ensureNcmLiked().then(() => {
    const badge = document.getElementById('plNcmBadge');
    if (badge) badge.hidden = !isNcmLiked(m.ncm_id);
  });
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
    `<span><span class="mi">favorite</span> ${count || 0} 人点赞</span>`,
    pop ? `<span><span class="mi">local_fire_department</span> 热度 ${pop}</span>` : '',
    comments !== null ? `<span><span class="mi">forum</span> 评论 ${comments}</span>` : '',
    topLiked ? `<span><span class="mi">thumb_up</span> 网易云最热评论 ${topLiked} 赞</span>` : '',
  ].filter(Boolean).join('');
}

function closeFull() {
  const ov = overlay();
  if (ov.hidden) return;
  stopKaraoke();
  ov.classList.add('closing');
  setTimeout(() => { ov.hidden = true; ov.innerHTML = ''; ov.classList.remove('closing'); }, 240);
}

// ---------- 更多抽屉：语言 / 字号 / 渐变背景 / 下载 ----------

function chipsHTML(list, curKey, group) {
  return list.map(it =>
    `<mdui-chip ${it.key === curKey ? 'selected' : ''} data-g="${group}" data-k="${it.key}">${it.label.replace(/^Aa·/, '')}</mdui-chip>`).join('');
}

function openMoreDrawer() {
  const diag = mdui.dialog({
    headline: '更多',
    body: `<div class="cm-more">
      <div class="cm-more-sec">歌词语言</div>
      <div class="cm-more-chips" id="chipsLang">${chipsHTML(LYRIC_MODES, lyricMode, 'lang')}</div>
      <div class="cm-more-sec">歌词字号</div>
      <div class="cm-more-chips" id="chipsSize">${chipsHTML(LYRIC_SIZES, lyricSizeKey, 'size')}</div>
      <div class="cm-more-row">
        <div><div class="cm-more-t">逐字歌词</div><div class="cm-more-s">有逐字数据的歌曲逐字点亮（卡拉OK）</div></div>
        <mdui-switch id="mKara" ${lyricKaraoke ? 'checked' : ''}></mdui-switch>
      </div>
      <div class="cm-more-row">
        <div><div class="cm-more-t">沉浸模式</div><div class="cm-more-s">封面主色流动渐变铺满播放页</div></div>
        <mdui-switch id="mGrad" ${bgGradOn ? 'checked' : ''}></mdui-switch>
      </div>
      <div class="cm-more-sec">下载到本机</div>
      <div class="cm-more-chips" id="chipsDl">${QUALITY_TIERS.map(t =>
        `<mdui-chip data-g="dl" data-k="${t.key}" ${t.key === settings.quality ? 'selected' : ''}>${t.label}</mdui-chip>`).join('')}</div>
      <div class="cm-more-s" style="margin-top:6px">目录：Music/${esc(localStorage.getItem('cm.downloadDir') || 'CurrentMusic')}（可在「我的-快捷功能」修改）</div>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  setTimeout(() => {
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
    const info = await api.songUrl(m.ncm_id, level);
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
  const cs = await coverColors(player.meta.pic);
  if (!cs || !player.meta || document.getElementById('plBg') !== el) return;
  setG(g(cs, 155), g({ ...cs, primary: cs.deep, deep: cs.primary }, 205));
}

// 动态取色：配色方案为 dynamic 时随封面切换全局主色
async function applyDynamicScheme() {
  if (getColorSchemeKey() !== 'dynamic' || !player.meta) return;
  const cs = await coverColors(player.meta.pic);
  if (cs && player.meta) applyColorScheme(cs.primary);
}
on('song', () => { applyDynamicScheme(); });

on('song', () => { if (!overlay().hidden) openFull(); karaokeLine = -1; karaokeIdx = -1; karaokeSpans = null; karaokeTick = 0; fireKaraoke(); });
on('state', () => {
  if (player.audio.paused) stopKaraoke(); else startKaraoke();
  const b = document.getElementById('plPlay');
  if (b) b.innerHTML = `<span class="material-icons-outlined">${player.loading ? 'hourglass_empty' : (!player.audio.paused ? 'pause_circle' : 'play_circle')}</span>`;
  renderMini();
});

function qualityMenu() {
  const cur = settings.quality;
  const items = QUALITY_TIERS.map(t =>
    `<div class="cm-qm-item" data-v="${t.key}">${t.label}${t.key === cur ? '<span class="material-icons-outlined">check</span>' : ''}</div>`).join('');
  const diag = mdui.dialog({
    headline: '选择音质',
    body: `<div class="cm-qm">${items}</div>`,
    actions: [{ text: '关闭' }],
  });
  setTimeout(() => {
    diag.querySelectorAll('.cm-qm-item').forEach(it => {
      it.onclick = () => {
        const v = it.dataset.v;
        const label = it.textContent.trim();
        player.changeQuality(v);
        const q = document.getElementById('plQuality');
        if (q) q.textContent = v === 'auto' ? label : tierLabel(v);
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

function fmtCmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (d.toDateString() === now.toDateString()) return Math.floor(diff / 3600) + ' 小时前';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export async function openComments(meta) {
  if (!meta) return;
  const old = document.getElementById('commentOverlay');
  if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'commentOverlay';
  document.body.appendChild(ov);

  let offset = 0, total = 0, more = true, meUid = 0, loading = false;

  const render = () => {
    ov.innerHTML = `
      <div class="cmt-page">
        <div class="cmt-top">
          <span class="pl-btn" id="cmtClose"><span class="material-icons-outlined">keyboard_arrow_down</span></span>
          <div class="cmt-title">评论区 · ${meta.name}</div>
          <span style="width:36px"></span>
        </div>
        <div class="cmt-list" id="cmtList">${skelComments(5)}</div>
        <div class="cmt-composer">
          <div id="cmtReplyBar" hidden><span></span><i id="cmtReplyCancel"><span class="material-icons-outlined">close</span></i></div>
          <input id="cmtInput" type="text" maxlength="140" placeholder="${meUid ? '以网易云账号发表评论…' : '绑定网易云账号后可发评'}" ${meUid ? '' : 'disabled'}>
          <mdui-button variant="filled" id="cmtSend" ${meUid ? '' : 'disabled'}>发送</mdui-button>
        </div>
      </div>`;
    ov.querySelector('#cmtClose').onclick = () => {
      ov.classList.add('closing');
      setTimeout(() => ov.remove(), 240);
    };
    ov.querySelector('#cmtSend').onclick = send;
    ov.querySelector('#cmtInput').onkeydown = e => { if (e.key === 'Enter') send(); };
    ov.querySelector('#cmtReplyCancel').onclick = () => setReply(null);
  };

  const likedSet = new Set(JSON.parse(sessionStorage.getItem('cm.cmtLiked') || '[]'));
  const saveLiked = () => sessionStorage.setItem('cm.cmtLiked', JSON.stringify([...likedSet]));

  const cmtHTML = c => {
    const liked = likedSet.has(c.id);
    const hasReply = !!(c.beNickname || c.replyCount);
    return `
    <div class="cmt-item" data-cid="${c.id}">
      ${c.avatar ? `<img src="${esc(c.avatar)}" loading="lazy">` : `<div class="cmt-avaph"></div>`}
      <div class="cmt-main">
        <div class="cmt-head">
          <span class="cmt-nick">${esc(c.nickname)}</span>
          ${c.userId && c.userId === meUid ? '<span class="cmt-mine">我</span><span class="cmt-del" title="删除">删除</span>' : ''}
        </div>
        ${c.beNickname ? `<div class="cmt-be">回复 @${esc(c.beNickname)}：${esc(c.beContent)}</div>` : ''}
        <div class="cmt-content">${esc(c.content)}</div>
        <div class="cmt-foot">
          <span>${fmtCmtTime(c.time)}</span>
          <span class="cmt-like ${liked ? 'on' : ''}" data-like="${c.id}"><span class="mi">${liked ? 'thumb_up' : 'thumb_up_alt'}</span> ${c.liked || 0}</span>
          <span class="cmt-reply" data-rep="${c.id}">回复</span>
          ${hasReply ? `<span class="cmt-floor-btn" data-floor="${c.id}">查看回复${c.replyCount ? `(${c.replyCount})` : ''}</span>` : ''}
        </div>
        <div class="cmt-floor" id="floor-${c.id}" hidden></div>
      </div>
    </div>`;
  };

  async function load(reset) {
    if (loading) return;
    loading = true;
    if (reset) { offset = 0; more = true; }
    if (!more) { loading = false; return; }
    try {
      // 「加载更多」→ 进度指示
      const pg = document.getElementById('cmtMore');
      if (pg) pg.outerHTML = '<div class="cmt-more-loading" id="cmtMoreWrap"><mdui-circular-progress></mdui-circular-progress> 加载中…</div>';
      const d = await api.comments(meta.ncm_id, offset);
      meUid = d.meUid || meUid;
      total = d.total;
      if (reset) render();                       // 重建（含骨架屏），数据到达后替换
      const box = ov.querySelector('#cmtList');
      box.querySelectorAll('.cmt-skel').forEach(el => el.remove());
      const html = (offset === 0 && d.hot && d.hot.length
        ? `<div class="cmt-sec">热门评论</div>` + d.hot.map(cmtHTML).join('') : '') +
        (offset === 0 ? `<div class="cmt-sec">最新评论（${total}）</div>` : '') +
        d.comments.map(cmtHTML).join('');
      // 批次渐入（stagger）
      const wrapEl = document.createElement('div');
      wrapEl.className = 'cmt-batch';
      wrapEl.innerHTML = html;
      box.appendChild(wrapEl);
      document.getElementById('cmtMoreWrap')?.remove();
      offset += d.comments.length;
      more = d.more;
      if (more) {
        box.insertAdjacentHTML('beforeend', `<div class="cm-empty small" id="cmtMore" style="cursor:pointer">加载更多</div>`);
        box.querySelector('#cmtMore').onclick = () => { load(false); };
      }
      bindDels();
    } catch (e) {
      document.getElementById('cmtMoreWrap')?.remove();
      toast(`评论加载失败：${e.message}`);
    } finally {
      loading = false;
    }
  }

  function bindDels() {
    ov.querySelectorAll('.cmt-del').forEach(el => {
      el.onclick = async () => {
        const item = el.closest('.cmt-item');
        const cid = +item.dataset.cid;
        try {
          await api.commentDelete(meta.ncm_id, cid);
          item.remove();
          toast('评论已删除');
        } catch (e2) { toast(e2.message); }
      };
    });
    // 点赞
    ov.querySelectorAll('.cmt-like').forEach(el => {
      el.onclick = async () => {
        const cid = +el.dataset.like;
        const cur = likedSet.has(cid);
        try {
          await api.commentLike(meta.ncm_id, cid, !cur);
          if (cur) likedSet.delete(cid); else likedSet.add(cid);
          saveLiked();
          const n = el.textContent.replace(/^\D+/, '');
          el.classList.toggle('on', !cur);
          el.querySelector('.mi').textContent = !cur ? 'thumb_up' : 'thumb_up_alt';
          el.innerHTML = el.querySelector('.mi').outerHTML + ' ' + Math.max(0, parseInt(n || '0', 10) + (cur ? -1 : 1));
          toast(cur ? '已取消点赞' : '已点赞');
        } catch (e2) {
          toast(e2.message.includes('绑定') ? '点赞需先绑定网易云账号' : e2.message);
        }
      };
    });
    // 回复
    ov.querySelectorAll('.cmt-reply').forEach(el => {
      el.onclick = () => {
        const item = el.closest('.cmt-item');
        setReply({ id: +el.dataset.rep, nickname: item.querySelector('.cmt-nick').textContent });
        ov.querySelector('#cmtList').scrollTo({ top: ov.querySelector('#cmtList').scrollHeight, behavior: 'smooth' });
      };
    });
    // 展开楼层回复
    ov.querySelectorAll('.cmt-floor-btn').forEach(el => {
      el.onclick = async () => {
        const cid = +el.dataset.floor;
        const box = ov.querySelector(`#floor-${cid}`);
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        if (box.dataset.loaded) return;
        box.innerHTML = '<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>';
        try {
          const d = await api.commentFloor(meta.ncm_id, cid);
          box.dataset.loaded = '1';
          box.innerHTML = d.comments.map(c => `
            <div class="cmt-floor-item" data-cid="${c.id}">
              <div class="cmt-head"><span class="cmt-nick">${esc(c.nickname)}</span>
              ${c.beNickname ? `<span class="cmt-be-in">@${esc(c.beNickname)}</span>` : ''}</div>
              <div class="cmt-content">${esc(c.content)}</div>
              <div class="cmt-foot"><span>${fmtCmtTime(c.time)}</span><span><span class="mi">thumb_up</span> ${c.liked || 0}</span><span class="cmt-reply" data-rep="${c.id}">回复</span></div>
            </div>`).join('') || '<div class="cm-empty small">暂无回复</div>';
          bindDels();   // 楼层内也有回复按钮
        } catch (e2) { box.innerHTML = `<div class="cm-empty small">回复加载失败</div>`; }
      };
    });
  }

  let replyTo = null;   // {id, nickname}
  function setReply(r) {
    replyTo = r;
    const bar = ov.querySelector('#cmtReplyBar');
    const input = ov.querySelector('#cmtInput');
    if (!bar || !input) return;
    bar.hidden = !r;
    if (r) {
      bar.querySelector('span').textContent = `回复 @${r.nickname}`;
      input.placeholder = `回复 @${r.nickname}…`;
      input.focus();
    } else {
      input.placeholder = meUid ? '以网易云账号发表评论…' : '绑定网易云账号后可发评';
    }
  }

  async function send() {
    const input = ov.querySelector('#cmtInput');
    const content = (input.value || '').trim();
    if (!content) return;
    const btn = ov.querySelector('#cmtSend');
    btn.loading = true;
    try {
      await api.commentPost(meta.ncm_id, content, replyTo && replyTo.id);
      input.value = '';
      toast(replyTo ? '回复已发表' : '评论已发表（同步网易云）');
      setReply(null);
      await load(true);
    } catch (e) {
      toast(e.message.includes('绑定') ? '请先在「我的」页绑定网易云账号' : e.message);
    } finally {
      btn.loading = false;
    }
  }

  render();
  await load(true);
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
}
