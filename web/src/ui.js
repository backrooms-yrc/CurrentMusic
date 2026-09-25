// UI 工具：转义、toast、时长格式、歌曲行渲染（含点赞/收藏状态）、对话框封装。
import { mdui } from './md.js';
import { api, auth } from './api.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(message) {
  mdui.snackbar({ message, placement: 'bottom', closeable: false, timeout: 2200 });
}

export const fmtDur = ms => {
  const s = Math.round((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtCount = n => n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(n ?? 0);

// 音质档位（高 → 低），与后端探测逻辑一致
export const QUALITY_TIERS = [
  { key: 'auto', label: '自动·最高' },
  { key: 'jymaster', label: '超清母带' },
  { key: 'jyeffect', label: '臻音全景声' },
  { key: 'sky', label: '沉浸环绕声' },
  { key: 'hires', label: '高清臻音' },
  { key: 'lossless', label: '无损 FLAC' },
  { key: 'exhigh', label: '极高 320k' },
  { key: 'standard', label: '标准 128k' },
];
export const tierLabel = k => (QUALITY_TIERS.find(t => t.key === k) || {}).label || k;

export function loadingBar() {
  return `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
}

// ---------- MD3 涟漪（事件委托，零模板侵入） ----------

const RIPPLE_SEL = [
  '.cm-song', '.cm-quick', '.cm-setting', '.cm-qm-item', '.cm-pl-pick-item',
  '.cm-plcard', '.cm-card', '.nav-ic', '.cm-mini-inner', '.cm-song-like',
  '.cm-song-more', '.cm-plmenu', '.cm-bindbanner', '.pl-btn', '#topAction',
  '.pl-quality', '.pl-lyric-mode', '.cm-sec-more', '.cmt-del', '#cmtMore',
  '.cm-ava-wrap', 'mdui-chip', '.cmt-like', '.cmt-reply', '.cmt-floor-btn',
].join(',');

export function initRipple() {
  document.addEventListener('pointerdown', e => {
    const t = e.target.closest(RIPPLE_SEL);
    if (!t || !e.isPrimary) return;
    const r = t.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const d = Math.max(r.width, r.height) * 2.2;
    const rip = document.createElement('i');
    rip.className = 'cm-rip';
    rip.style.width = rip.style.height = d + 'px';
    rip.style.left = (e.clientX - r.left - d / 2) + 'px';
    rip.style.top = (e.clientY - r.top - d / 2) + 'px';
    t.appendChild(rip);
    // animationend 在部分内核/headless 下不触发，定时兜底清理
    rip.addEventListener('animationend', () => rip.remove(), { once: true });
    setTimeout(() => rip.remove(), 700);
  }, { passive: true });
}

// ---------- 封面取色（动态取色 / 渐变背景共用，带缓存） ----------

const _coverColorCache = new Map();

// 亮度收敛：让取出的主色在深浅色主题上都可读（L 收敛到 0.46~0.62）
function _clampL(hex) {
  let n = parseInt(hex.slice(1), 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  const cl = Math.min(.62, Math.max(.46, l));
  const q = cl < .5 ? cl * (1 + s) : cl + s - cl * s;
  const p = 2 * cl - q;
  const f = t => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const to = x => Math.round(x * 255);
  return '#' + ((1 << 24) + (to(f(h + 1 / 3)) << 16) + (to(f(h)) << 8) + to(f(h - 1 / 3))).toString(16).slice(1);
}

function _shadeL(hex, dl) {
  let n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = Math.min(1, Math.max(0, (mx + mn) / 2 + dl));
  const k = l / ((mx + mn) / 2 || 1e-6);
  const to = x => Math.min(255, Math.round(x * 255 * k));
  return '#' + ((1 << 24) + (to(r) << 16) + (to(g) << 8) + to(b)).toString(16).slice(1);
}

// 画布取色（crossOrigin 匿名；CDN 带 ACAO:* 不污染 canvas）
function _extract(imgUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 24;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, 24, 24);
        const d = cx.getImageData(0, 0, 24, 24).data;
        // 饱和度加权平均，避开接近黑白的背景
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < d.length; i += 4) {
          const R = d[i], G = d[i + 1], B = d[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const sat = (mx - mn) / 255, lum = mx / 255;
          const wt = .25 + sat * (1 - Math.abs(lum - .5) * 1.4);
          r += R * wt; g += G * wt; b += B * wt; w += wt;
        }
        if (!w) return reject(new Error('empty'));
        resolve('#' + ((1 << 24) + (Math.round(r / w) << 16) + (Math.round(g / w) << 8) + Math.round(b / w)).toString(16).slice(1));
      } catch (e) { reject(e); }   // canvas 污染等
    };
    img.onerror = () => reject(new Error('load'));
    img.src = imgUrl;
  });
}

// 取色入口：缩略图直连 → 后端代理兜底 → null（调用方用默认色组）
export async function coverColors(pic) {
  if (!pic) return null;
  if (_coverColorCache.has(pic)) return _coverColorCache.get(pic);
  const thumb = pic + (pic.includes('?') ? '&' : '?') + 'param=120y120';
  const base = localStorage.getItem('cm.base') || '';
  let hex = null;
  try { hex = await _extract(thumb); }
  catch {
    try { hex = await _extract(base + '/img?url=' + encodeURIComponent(thumb)); }
    catch { hex = null; }
  }
  const out = hex ? { primary: _clampL(hex), deep: _shadeL(_clampL(hex), -.16), dark: _shadeL(_clampL(hex), -.30) } : null;
  _coverColorCache.set(pic, out);
  return out;
}

// ---------- 配色方案（默认动态取色） ----------

export const COLOR_SCHEMES = [
  { key: 'dynamic', label: '动态取色（随封面）', color: null, swatch: 'gradient' },
  { key: 'purple', label: '紫罗兰', color: '#6750A4' },
  { key: 'blue', label: '海洋蓝', color: '#1565C0' },
  { key: 'teal', label: '青碧', color: '#00695C' },
  { key: 'green', label: '森林绿', color: '#2E7D32' },
  { key: 'pink', label: '樱花粉', color: '#AD1457' },
  { key: 'orange', label: '落日橙', color: '#E65100' },
];

export const getColorSchemeKey = () => localStorage.getItem('cm.colorScheme') || 'dynamic';
export function setColorSchemeKey(key) {
  localStorage.setItem('cm.colorScheme', key);
  if (key !== 'dynamic') applyColorScheme((COLOR_SCHEMES.find(s => s.key === key) || {}).color || '#6750A4');
}

export function applyColorScheme(hex) {
  if (!hex) return;
  try { mdui.setColorScheme(hex); } catch { /* 部分内核 */ }
  document.documentElement.style.setProperty('--cm-primary', hex);
}

export function bootColorScheme() {
  const key = getColorSchemeKey();
  if (key !== 'dynamic') {
    applyColorScheme((COLOR_SCHEMES.find(s => s.key === key) || {}).color || '#6750A4');
  }
}

// ---------- 全局图片加载动画（骨架微光占位 → 渐显） ----------
// CSS 对 img:not(.ld) 显示微光占位；这里负责标记：load 事件（捕获期，img 的 load 不冒泡）
// + 缓存图兜底（插入时已 complete 的，load 事件可能已错过）+ error 也标记（停止微光，多数图另有 onerror 隐藏）
export function initImageFade() {
  const mark = t => { if (t && t.tagName === 'IMG') t.classList.add('ld'); };
  document.addEventListener('load', e => mark(e.target), true);
  document.addEventListener('error', e => mark(e.target), true);
  let pending = false;
  const sweep = () => {
    document.querySelectorAll('img').forEach(i => { if (i.complete) i.classList.add('ld'); });
  };
  const mo = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; sweep(); });
  });
  mo.observe(document.body, { childList: true, subtree: true });
  sweep();
}

// ---------- 歌词默认字号：移动端「大」、平板「特大」（用户手动选过后尊重选择） ----------

export function defaultLyricSizeKey() {
  return window.matchMedia('(min-width: 600px)').matches ? 'xl' : 'l';
}

// ---------- 骨架屏（MD3 形状 + 微妙 shimmer） ----------

export const skelList = (n = 6) =>
  `<div class="cm-skel-list">${Array.from({ length: n }, () =>
    `<div class="cm-skel-song"><div class="sk sk-pic"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join('')}</div>`;

export const skelCards = (n = 8) =>
  `<div class="cm-hscroll">${Array.from({ length: n }, () =>
    `<div class="cm-skel-card"><div class="sk sk-cover"></div><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div>`).join('')}</div>`;

export const skelGrid = (n = 6) =>
  `<div class="cm-plgrid">${Array.from({ length: n }, () =>
    `<div><div class="sk sk-cover"></div><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div>`).join('')}</div>`;

export const skelComments = (n = 5) =>
  Array.from({ length: n }, () =>
    `<div class="cmt-item cmt-skel">
      <div class="sk cmt-skava"></div>
      <div class="cmt-main">
        <div class="sk cmt-sknick"></div>
        <div class="sk cmt-skl1"></div>
        <div class="sk cmt-skl2"></div>
      </div>
    </div>`).join('');

export const skelProfile = () =>
  `<div class="cm-skel-profile">
    <div class="cm-skel-head"><div class="sk sk-ava"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>
    ${skelGrid(6)}
  </div>`;

// ---------- 歌曲列表渲染（状态一次拉取） ----------

const statusCache = new Map(); // ncm_id -> {liked, faved, count}

async function fetchStatus(ids) {
  const need = ids.filter(i => !statusCache.has(i));
  if (need.length) {
    try {
      const st = await api.songsStatus(need);
      need.forEach(i => statusCache.set(i, {
        liked: (st.liked || []).includes(i),
        faved: (st.faved || []).includes(i),
        count: (st.counts || {})[i] || 0,
      }));
    } catch { /* 未登录等情况：保持默认 */ }
  }
  return ids.map(i => statusCache.get(i) || { liked: false, faved: false, count: 0 });
}

export function setStatus(ncmId, patch) {
  const cur = statusCache.get(ncmId) || { liked: false, faved: false, count: 0 };
  statusCache.set(ncmId, Object.assign(cur, patch));
}
export const getStatus = ncmId => statusCache.get(ncmId) || { liked: false, faved: false, count: 0 };

// ---------- 网易云红心状态（会话级缓存，来自绑定账号 likelist） ----------

let _ncmLikedSet = null;

export async function ensureNcmLiked() {
  if (_ncmLikedSet === null) {
    try { _ncmLikedSet = new Set((await api.ncmLikelist()).ids || []); }
    catch { _ncmLikedSet = new Set(); }   // 未绑定/未同步：空集
  }
  return _ncmLikedSet;
}
export const isNcmLiked = id => !!(_ncmLikedSet && _ncmLikedSet.has(id));
export function setNcmLiked(id, on) { if (_ncmLikedSet) { on ? _ncmLikedSet.add(id) : _ncmLikedSet.delete(id); } }
export function resetNcmLiked() { _ncmLikedSet = null; }

/**
 * 喜欢/红心二级菜单：选择收录到 CurrentMusic 我喜欢 还是 网易云·我喜欢的音乐。
 * @param song    歌曲元数据
 * @param onChange 状态变化回调（用于刷新所在 UI）
 */
export function openLikeMenu(song, onChange) {
  if (!auth.token) return toast('登录后才能使用喜欢功能');
  const diag = mdui.dialog({
    headline: '收录到哪个「我喜欢」？',
    body: `<div class="cm-qm">
      <div class="cm-qm-item" id="lkCm"></div>
      <div class="cm-qm-item" id="lkNcm"></div>
    </div>`,
    actions: [{ text: '关闭' }],
  });

  function renderItems(ncmState) {
    const cm = getStatus(song.ncm_id);
    diag.querySelector('#lkCm').innerHTML =
      `<span class="material-icons-outlined ${cm.liked ? 'red' : ''}">${cm.liked ? 'favorite' : 'favorite_border'}</span>
       <div><div>CurrentMusic · 我喜欢的音乐</div>
       <div class="sub">${cm.liked ? '已收录，点击移出' : '未收录，点击加入'}</div></div>
       <span class="material-icons-outlined tail">${cm.liked ? 'check' : 'add'}</span>`;
    diag.querySelector('#lkNcm').innerHTML =
      `<span class="material-icons-outlined ${ncmState.on ? 'red' : ''}">${ncmState.on ? 'favorite' : 'favorite_border'}</span>
       <div><div>网易云音乐 APP · 我喜欢的音乐</div>
       <div class="sub">${ncmState.msg}</div></div>
       <span class="material-icons-outlined tail">${ncmState.tail}</span>`;
  }

  renderItems({ on: isNcmLiked(song.ncm_id), msg: '红心将同步到网易云 APP', tail: 'cloud_upload' });

  diag.querySelector('#lkCm').onclick = async () => {
    try {
      const r = await api.toggleLike(song);
      setStatus(song.ncm_id, { liked: r.on, count: r.count });
      renderItems({ on: isNcmLiked(song.ncm_id), msg: '红心将同步到网易云 APP', tail: 'cloud_upload' });
      onChange && onChange();
    } catch (e) { toast(e.message); }
  };

  diag.querySelector('#lkNcm').onclick = async () => {
    const on = isNcmLiked(song.ncm_id);
    try {
      await api.ncmLike(song, !on);
      setNcmLiked(song.ncm_id, !on);
      renderItems({ on: !on, msg: !on ? '已红心（网易云侧可能有数秒延迟）' : '已取消红心', tail: 'cloud_done' });
      onChange && onChange();
      toast(!on ? '已红心到网易云·我喜欢的音乐' : '已取消网易云红心');
    } catch (e) {
      toast(e.message.includes('未绑定') ? '请先在「我的」页绑定网易云账号' : e.message);
    }
  };

  // 预热网易云红心集合（首次打开菜单时后台加载，二次点击即有准确状态）
  ensureNcmLiked().then(() => {
    if (!diag.open) return;
    renderItems({ on: isNcmLiked(song.ncm_id), msg: '红心将同步到网易云 APP', tail: 'cloud_upload' });
  });
}

export async function songListHTML(songs, { removable = false } = {}) {
  const st = await fetchStatus(songs.map(s => s.ncm_id));
  if (auth.token) ensureNcmLiked().catch(() => {});
  return `<div class="cm-songs">` + songs.map((s, i) => `
    <div class="cm-song" data-i="${i}">
      ${s.pic ? `<img class="cm-song-pic" src="${esc(s.pic)}" loading="lazy">` : `<div class="cm-song-pic ph"><span class="material-icons-outlined">music_note</span></div>`}
      <div class="cm-song-main">
        <div class="cm-song-name">${esc(s.name)}</div>
        <div class="cm-song-sub">
          <span>${esc(s.artists || '未知歌手')}${s.album ? ' · ' + esc(s.album) : ''}</span>
          ${s.pop ? `<span class="cm-pop" title="网易云热度"><span class="mi">local_fire_department</span>${s.pop}</span>` : ''}
          ${st[i].count ? `<span class="cm-like-n" title="CurrentMusic 点赞数"><span class="mi">favorite</span>${fmtCount(st[i].count)}</span>` : ''}
        </div>
      </div>
      <span class="cm-song-dur">${fmtDur(s.duration)}</span>
      <span class="cm-song-like ${st[i].liked ? 'on' : ''}" data-act="like" data-i="${i}" title="选择收录到哪个我喜欢">
        <span class="material-icons-outlined">${st[i].liked ? 'favorite' : 'favorite_border'}</span>
        ${isNcmLiked(s.ncm_id) ? '<i class="cm-ncmdot" title="已在网易云红心"></i>' : ''}
      </span>
      ${removable ? `<span class="cm-song-more" data-act="remove" data-i="${i}"><span class="material-icons-outlined">remove_circle_outline</span></span>` : ''}
    </div>`).join('') + `</div>`;
}

/**
 * 渲染歌曲列表并绑定行为。
 * @param el    容器
 * @param songs 歌曲数组
 * @param opts  { onPlay(i), onRemove(i) }
 */
export async function renderSongList(el, songs, opts = {}) {
  if (!songs.length) {
    el.innerHTML = `<div class="cm-empty"><span class="material-icons-outlined">queue_music</span>还没有歌曲</div>`;
    return;
  }
  el.innerHTML = await songListHTML(songs, { removable: !!opts.onRemove });
  el.querySelectorAll('.cm-song').forEach(row => {
    const i = +row.dataset.i;
    row.addEventListener('click', async e => {
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'like') {
        e.stopPropagation();
        openLikeMenu(songs[i], () => renderSongList(el, songs, opts));
        return;
      }
      if (act && act.dataset.act === 'remove') {
        e.stopPropagation();
        opts.onRemove && opts.onRemove(i);
        return;
      }
      opts.onPlay && opts.onPlay(i);
    });
  });
}

// ---------- 对话框 ----------
// 注意：mdui 2 的 dialog 不支持 onAction 选项，确认逻辑必须挂在
// action 的 onClick 上（返回 promise 自动在完成后关闭，返回 false 不关闭）。

export function promptDialog({ title, label, value = '', placeholder = '', type = 'text', onOk }) {
  const diag = mdui.dialog({
    headline: title,
    body: `<mdui-text-field label="${esc(label)}" variant="outlined" value="${esc(value)}" placeholder="${esc(placeholder)}" ${type === 'password' ? 'type="password"' : ''} style="width:100%"></mdui-text-field>`,
    actions: [
      { text: '取消' },
      {
        text: '确定',
        onClick: () => {
          const v = diag.querySelector('mdui-text-field').value.trim();
          if (!v) { toast('内容不能为空'); return false; }
          return Promise.resolve(onOk(v)).catch(e => { toast(e.message); return false; });
        },
      },
    ],
  });
  return diag;
}

export function confirmDialog({ title, body = '', onOk }) {
  return mdui.dialog({
    headline: title, body,
    actions: [
      { text: '取消' },
      { text: '确定', onClick: () => Promise.resolve(onOk()).catch(e => toast(e.message)) },
    ],
  });
}

export function avatarHTML(user, size = 72) {
  const url = user && user.avatar && api.avatarUrl(user.avatar);
  if (url) return `<img class="cm-avatar" src="${esc(url)}?v=${Date.now() % 86400000}" style="width:${size}px;height:${size}px">`;
  const ch = (user && user.nickname ? user.nickname[0] : '?').toUpperCase();
  return `<div class="cm-avatar ph" style="width:${size}px;height:${size}px;font-size:${size / 2.6}px">${esc(ch)}</div>`;
}
