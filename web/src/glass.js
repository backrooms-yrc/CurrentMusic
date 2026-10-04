// 液体玻璃折射（Liquid Glass）：让「玻璃」真的把背后的画面掰弯，而不只是糊一层。
//
// 技法来源（GitHub，均已在注释中署名，本文件是按文档自行实现）：
//   · VII-Cae/hyalite--liquid-glass（v0.5.0）—— 把元素当作**带斜边的玻璃**，按元素的真实尺寸
//     与圆角算出「透镜位移图」（R = x 位移、G = y 位移），交给 SVG feDisplacementMap，
//     由 backdrop-filter: url(#…) 去掰弯背后的画面。
//     它的默认值就是本项目的对标值：`DEFAULTS.blur = 1`（透镜中心霜化）、
//     边缘高光 `edgeShadow()`（edge .32 / light −140°，落在 app.css 的 --frs-edge）、
//     以及 README 的 CSS 兜底 `var(--hyalite, blur(6px))`。
//     其原话："中心保持清晰；边缘把世界向内拉；沿边缘接住一条亮线；直线会弯，而不是糊。"
//   · rdev/liquid-glass-react / dashersw/liquid-glass-js —— 参数化（位移强度、胶囊形状）。
//
// 为什么需要它：普通磨砂（blur）只是把背景糊掉，边缘不会有形变，
// 所以看起来像"毛玻璃贴纸"而不是一块玻璃。折射才是 Liquid Glass 的核心。
//
// 两个会**静默失效**的坑（都踩过，务必留意）：
//   1) 位移图必须按元素的**真实尺寸**生成。元素 display:none 时量到 0×0，
//      图会退化成 2×2，折射完全看不出来。
//   2) 圆角矩形 SDF 的惯例是「内部为负」。若当成「内部为正」来用，
//      位移最强的位置会跑到正中心、边缘反而不动 —— 与真玻璃恰好相反。
//
// 兼容性：backdrop-filter: url() 需要 Chromium 79+。不支持的浏览器
// （Safari / Firefox / 旧 WebView）不会调用到这里，CSS 里的 blur(...) 兜底会接管，
// 而边缘高光是用 CSS inset 阴影实现的，在所有浏览器都能看到。

import { on } from './player.js';

const MAX_MAP_PX = 640 * 640;

let seq = 0;
const built = {};        // id -> { el, sig, filterNode }

/** 是否支持在 backdrop-filter 里引用 SVG 滤镜（不支持则整块逻辑跳过）。 */
export function glassRefractionSupported() {
  try {
    return CSS.supports('backdrop-filter', 'url(#x)') ||
           CSS.supports('-webkit-backdrop-filter', 'url(#x)');
  } catch (e) {
    return false;
  }
}

// iq 经典圆角矩形有符号距离：内部为负、外部为正
function sdOut(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r), qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}
// 转成「内部为正」：值即离边缘的深度
const sdDepth = (px, py, w, h, r) => -sdOut(px, py, w, h, r);

/**
 * 为元素生成/更新透镜位移图与 SVG 滤镜，并把 url(#id) 写进元素的 --frs-lens。
 * @param {Element} el
 * @param {string} id   滤镜 id（每个元素一个）
 * @param {object} o    { radius, bevel, maxd, blur }
 * @returns {object|null} 生成的图信息（调试/验证用）
 */
export function attachLens(el, id, o) {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return null;      // 未布局（隐藏）→ 拒绝生成废图
  // 圆角不得越过"短边的一半"：超过之后圆角矩形 SDF 的 W/2−R 变负、梯度在轴上翻转，
  // 位移图会退化成一条十字缝（上游 hyalite rule 2 踩过同一个坑，它把方向场的半径
  // 夹在短边的一半）。宽屏左侧导航栏这种又高又窄的元素就落在这一档上。
  const maxR = Math.min(rect.width, rect.height) / 2 - 0.5;
  const radius = Math.max(0, Math.min(o.radius != null ? o.radius : rect.height / 2, maxR));
  const bevel = Math.max(0, o.bevel);
  const maxd = Math.max(0, o.maxd);
  const blur = o.blur != null ? o.blur : 0.5;

  const w = Math.round(rect.width), h = Math.round(rect.height);
  const k = Math.min(1, Math.sqrt(MAX_MAP_PX / (w * h)));
  const mw = Math.max(2, Math.round(w * k)), mh = Math.max(2, Math.round(h * k));
  const cv = document.createElement('canvas');
  cv.width = mw; cv.height = mh;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(mw, mh), d = img.data;
  const rad = radius * k, bev = bevel * k, scale = 2 * maxd;

  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const px = x + 0.5, py = y + 0.5;
      const depth = sdDepth(px, py, mw, mh, rad);   // 0 = 边缘，越大越靠里
      let t = bev > 0 ? 1 - depth / bev : 0;        // 边缘 = 1，斜边带内沿 = 0，再往里为负
      let dx = 0, dy = 0, edge = 0;
      if (t > 0) {                                  // 只在斜边带内位移：中心保持清晰
        if (t > 1) t = 1;
        const m = t * t * maxd;                     // 越靠外越强（平方剖面更接近真玻璃）
        const e = 0.75;
        const gx = sdDepth(px + e, py, mw, mh, rad) - sdDepth(px - e, py, mw, mh, rad);
        const gy = sdDepth(px, py + e, mw, mh, rad) - sdDepth(px, py - e, mw, mh, rad);
        const gl = Math.sqrt(gx * gx + gy * gy) || 1;
        dx = -gx / gl * m; dy = -gy / gl * m;       // 向外采样 ⇒ 视觉上把世界向内拉
        edge = Math.round(255 * t);
      }
      const i = (y * mw + x) * 4;
      const rx = Math.round(127.5 + 127.5 * dx / maxd);
      const ry = Math.round(127.5 + 127.5 * dy / maxd);
      d[i]     = Math.max(0, Math.min(255, isFinite(rx) ? rx : 128));
      d[i + 1] = Math.max(0, Math.min(255, isFinite(ry) ? ry : 128));
      d[i + 2] = edge;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = cv.toDataURL('image/png');

  // 复用已存在的滤镜节点（避免每次重建都往 DOM 里堆），没有就建一个
  let node = document.getElementById(id);
  if (!node) {
    const defs = ensureDefs();
    defs.insertAdjacentHTML('beforeend', `<filter id="${id}"></filter>`);
    node = document.getElementById(id);
  }
  node.setAttribute('filterUnits', 'userSpaceOnUse');
  node.setAttribute('primitiveUnits', 'userSpaceOnUse');
  node.setAttribute('x', '0'); node.setAttribute('y', '0');
  node.setAttribute('width', String(w)); node.setAttribute('height', String(h));
  node.setAttribute('color-interpolation-filters', 'sRGB');
  // feImage 必须同时给 href 与 xlink:href：部分实现只认后者
  node.innerHTML =
    `<feImage x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map" ` +
      `href="${url}" xlink:href="${url}"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale.toFixed(2)}" ` +
      `xChannelSelector="R" yChannelSelector="G"/>`;

  el.style.setProperty('--frs-lens', `url(#${id}) blur(${blur}px)`);
  built[id] = { el, sig: `${w}x${h}:${bevel}:${maxd}:${blur}`, filterNode: node };
  return { w, h, mw, mh, radius, bevel, maxd, blur, mapPx: mw * mh, filterId: id };
}

function ensureDefs() {
  let defs = document.getElementById('cmGlassDefs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    defs.setAttribute('id', 'cmGlassDefs');
    defs.setAttribute('width', '0');
    defs.setAttribute('height', '0');
    defs.style.position = 'absolute';
    defs.style.pointerEvents = 'none';
    document.body.appendChild(defs);
  }
  return defs;
}

// 需要折射的玻璃元素：所有**浮层**（栏 / 胶囊 / 弹层 / 输入条），内容卡片不做
// （Apple 的 Liquid Glass 也只用在 chrome 上，卡片是实体分组；见 app.css 注释）。
// 几何量（bevel / maxd）沿用本引擎原有一组保守值：上游 README 里 0.3.1 版
// 展示用的就是「28px 斜边 / 19px 玻璃」，并说明 `DEFAULTS` 一直是刻意保守的；
// 我们这套 22/18 与 16/12 正落在同一档。上游 v0.5.0 的 DEFAULTS（bevel 37 /
// thickness 59 / dispersion 1.6 —— 按它 demo 里 ~300px 的卡片调）若原样套到
// 64px 高的胶囊上，斜边会被它自己的规则夹到 31px、位移达 60px 以上，
// 那是给「厚玻璃卡片」用的量，不是给标签栏用的。
// 模糊值刻意**不写死在这里**，而是从元素的 CSS 变量 --frs-lens-blur 读，
// 这样"玻璃有多毛"属于样式调参，改一行 CSS 即可，不必动 JS。
// 默认 1px = 上游 hyalite `DEFAULTS.blur`。
const DEFAULT_BLUR = 1;
function lensBlurOf(el) {
  const raw = getComputedStyle(el).getPropertyValue('--frs-lens-blur').trim();
  const n = parseFloat(raw);
  return isFinite(n) ? n : DEFAULT_BLUR;
}

const TARGETS = [
  { sel: '#bottomNav',        id: 'cmLensNav',    radius: null, bevel: 22, maxd: 18 },
  { sel: '.cm-mini-inner',    id: 'cmLensMini',   radius: 16,   bevel: 18, maxd: 14 },
  { sel: '#topbar',           id: 'cmLensTop',    radius: 0,    bevel: 18, maxd: 12 },
  { sel: '.cmt-composer',     id: 'cmLensCmt',    radius: 0,    bevel: 16, maxd: 10 },
  { sel: '.pl-lyric-mode',    id: 'cmLensLyric',  radius: 999,  bevel: 12, maxd: 10 },
  { sel: '.cm-plmenu',        id: 'cmLensPlMenu', radius: 12,   bevel: 14, maxd: 10 },
  // mdui 的弹层：可见的「面板」在 shadow DOM 里（外面那层只是遮罩，尺寸不对），
  // 必须钻进 shadowRoot 找 [part=panel]。面板读的是继承来的 --frs-lens，
  // 直接写在面板元素上同样生效（::part 规则里的 var() 会取到它）。
  { sel: 'mdui-dialog',       id: 'cmLensDialog', radius: 18,   bevel: 18, maxd: 14, panel: true },
  { sel: 'mdui-menu',         id: 'cmLensMenu',   radius: 14,   bevel: 14, maxd: 12, panel: true },
];
const MAX_PER_SEL = 4;      // 同选择器最多给几个实例挂滤镜（弹层可能同时开多个）

/** 解析一个 target 当前实际要挂滤镜的元素（可能 0~4 个，每个一个滤镜 id）。 */
function targetEls(t) {
  const hosts = document.querySelectorAll(t.sel);
  const out = [];
  for (let i = 0; i < hosts.length && out.length < MAX_PER_SEL; i++) {
    const host = hosts[i];
    const el = t.panel
      ? (host.shadowRoot && host.shadowRoot.querySelector('[part="panel"]'))
      : host;
    if (el) out.push({ el, id: out.length ? t.id + out.length : t.id });
  }
  return out;
}

/** 按当前皮肤与尺寸重建所有折射图（非 frost 皮肤时直接跳过）。 */
export function refreshGlass() {
  if (!glassRefractionSupported()) return;
  if (document.documentElement.getAttribute('data-ui-preset') !== 'frost') return;
  TARGETS.forEach(t => {
    targetEls(t).forEach(({ el, id }) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const radius = t.radius != null ? t.radius : r.height / 2;
      attachLens(el, id, { radius, bevel: t.bevel, maxd: t.maxd, blur: lensBlurOf(el) });
    });
  });
  observeTargets();
}

// 元素尺寸变化（安全区迟到、旋转、窗口缩放、键盘弹出）都必须重建位移图，
// 否则位移图与实际尺寸不匹配，折射位置会整体错位。
// ResizeObserver 比 window.resize 可靠：它盯的是**元素自己**的盒子变化。
let ro = null;
function observeTargets() {
  if (typeof ResizeObserver === 'undefined') return;   // 旧内核自动跳过
  if (!ro) ro = new ResizeObserver(scheduleRefresh);
  TARGETS.forEach(t => {
    targetEls(t).forEach(({ el }) => {
      if (el.__cmLensObserved) return;
      el.__cmLensObserved = true;
      ro.observe(el);
    });
  });
}

let timer = null;
function scheduleRefresh() {
  clearTimeout(timer);
  timer = setTimeout(refreshGlass, 180);
}

// 尺寸看门狗：每 600ms 只比较两个目标的尺寸，变化才重建。
// 为什么还要它（已有 ResizeObserver + window.resize + 播放器事件）：
// 位移图与实际尺寸一旦不匹配，折射位置会整体错位，而这类布局变化
// （安全区迟到、键盘弹出、WebView 分屏、DOM 被替换）在真机上很难穷举，
// 一个极轻的兜底比"漏一次就错位"划算得多。
const lastSig = {};
function watchSize() {
  if (!glassRefractionSupported()) return;
  if (document.documentElement.getAttribute('data-ui-preset') !== 'frost') return;
  const seen = {};
  TARGETS.forEach(t => {
    targetEls(t).forEach(({ el, id }) => {
      seen[id] = 1;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;        // 尚未布局
      const sig = Math.round(r.width) + 'x' + Math.round(r.height);
      // 除尺寸外还要比对**元素实例**：目标元素若被 innerHTML 重建而尺寸恰好
      // 相同，lastSig 命中会跳过重建——新节点上没有内联 --frs-lens，折射就丢了。
      const sameEl = built[id] && built[id].el === el;
      if (lastSig[id] === sig && sameEl) return;
      lastSig[id] = sig;
      const radius = t.radius != null ? t.radius : r.height / 2;
      attachLens(el, id, { radius, bevel: t.bevel, maxd: t.maxd, blur: lensBlurOf(el) });
    });
  });
  // 关掉的弹层要把签名清掉，否则下次打开时旧签名命中会导致不重建
  Object.keys(lastSig).forEach(k => { if (!seen[k]) delete lastSig[k]; });
}

export function initGlass() {
  if (!glassRefractionSupported()) return;      // 旧内核：CSS 的 blur 兜底接管
  refreshGlass();
  window.addEventListener('resize', scheduleRefresh);
  window.addEventListener('orientationchange', scheduleRefresh);
  // 切换皮肤 / 页面重建后重新生成（事件由 uipreset.js 派发）
  document.addEventListener('cm-uipreset', scheduleRefresh);
  document.addEventListener('cm-layout', scheduleRefresh);
  // 迷你播放条是**播歌之后**才出现的：启动时它还不存在（或尺寸为 0），
  // 必须跟随播放器事件重建，否则它只会拿到 blur 兜底、没有折射。
  try {
    on('song', scheduleRefresh);
    on('state', scheduleRefresh);
  } catch (e) { /* 忽略 */ }
  // 兜底：页面刚起来的几秒内，布局（安全区/尺寸）可能还在变，补几次重建
  [400, 1200, 2600].forEach(ms => setTimeout(refreshGlass, ms));
  setInterval(watchSize, 600);
}

/** 供验证脚本读取（不影响功能）。 */
export function glassDebug() {
  return Object.keys(built).map(k => ({ id: k, sig: built[k].sig }));
}
