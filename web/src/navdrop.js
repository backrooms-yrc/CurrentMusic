// 底栏「液态玻璃水滴」指示器（Apple Liquid Glass / iOS 26 的选中态）
//
// 它是包裹在当前选中 tab 外的一颗玻璃液滴：切换 tab 时会**流动**过去，
// 移动过程中略微拉伸（squash & stretch），落位时回弹 —— 液滴的手感就在这一步。
//
// 只负责两件事：
//   1) 把 #navDrop 的位移与宽度对齐到「当前选中项的图标+文字」外框；
//   2) 切换时给出方向感（拉伸方向朝行进方向，落位后复位）。
// 外观（玻璃本体、高光边、圆角、过渡曲线）全部在 app.css 里，且限定在 frost 皮肤下。
// 默认皮肤（MD3）不显示它，仍用原来的胶囊指示器。

const DROP_ID = 'navDrop';
const NAV_SEL = '#bottomNav';
const ITEM_SEL = '.navItem';
const PAD_X = 11;          // 水滴比图标+文字外框左右各多出的留白
const PAD_Y = 5;           // 上下留白
const MOVE_MS = 460;       // 与 CSS 过渡时长保持一致

let drop = null, nav = null;
let lastX = null, lastW = null;
let animTimer = null;

function currentItem() {
  return nav ? nav.querySelector(ITEM_SEL + '.cur') : null;
}

/** 计算当前选中项相对 #bottomNav 的外框（包裹图标 + 文字）。 */
function measure() {
  const item = currentItem();
  if (!item || !nav) return null;
  const nr = nav.getBoundingClientRect();
  const icon = item.querySelector('.nav-ic');
  // 文字是 .navItem 的**直接子** span；不能用 span:not(.nav-ic)——
  // 那样会先匹配到 .nav-ic 里的图标字形 span，文字就被漏掉了。
  let label = null;
  for (let i = 0; i < item.children.length; i++) {
    const ch = item.children[i];
    if (ch.tagName === 'SPAN' && !ch.classList.contains('nav-ic')) { label = ch; break; }
  }
  const parts = [icon, label].filter(Boolean).map(el => el.getBoundingClientRect())
    .filter(r => r.width > 0 && r.height > 0);
  if (!parts.length) return null;
  const left = Math.min.apply(null, parts.map(r => r.left));
  const right = Math.max.apply(null, parts.map(r => r.right));
  const top = Math.min.apply(null, parts.map(r => r.top));
  const bottom = Math.max.apply(null, parts.map(r => r.bottom));
  // 横向包裹「图标 + 文字」；纵向同样贴合内容，但不超出导航条
  let h = (bottom - top) + PAD_Y * 2;
  const maxH = Math.max(0, nr.height - 4);
  if (h > maxH) h = maxH;
  let y = (top - nr.top) - PAD_Y;
  if (y < 2) y = 2;
  if (y + h > nr.height - 2) y = Math.max(2, nr.height - 2 - h);
  return {
    x: left - nr.left - PAD_X,
    w: (right - left) + PAD_X * 2,
    h,
    y,
  };
}

/** 落位（不带动画）：首次定位、尺寸变化、皮肤刚切过来时用。 */
function place(noAnim) {
  if (!drop || !nav) return;
  const m = measure();
  if (!m) { drop.style.opacity = '0'; return; }
  drop.style.opacity = '';
  if (noAnim) drop.classList.add('no-anim');
  drop.style.setProperty('--nd-x', m.x.toFixed(1) + 'px');
  drop.style.setProperty('--nd-w', m.w.toFixed(1) + 'px');
  drop.style.setProperty('--nd-y', m.y.toFixed(1) + 'px');
  drop.style.setProperty('--nd-h', m.h.toFixed(1) + 'px');
  if (noAnim) {
    // 强制一次回流后再打开过渡，避免"首次也飞过来"
    void drop.offsetWidth;
    requestAnimationFrame(() => drop.classList.remove('no-anim'));
  }
  lastX = m.x; lastW = m.w;
}

/** 带液滴感地移动到当前选中项。 */
function move() {
  if (!drop || !nav) return;
  const m = measure();
  if (!m) { drop.style.opacity = '0'; return; }
  const first = lastX === null;
  if (first) { place(true); return; }

  const dx = m.x - lastX;
  if (Math.abs(dx) < 0.5 && Math.abs(m.w - lastW) < 0.5) {   // 没变，仅同步尺寸
    drop.style.setProperty('--nd-w', m.w.toFixed(1) + 'px');
    drop.style.setProperty('--nd-h', m.h.toFixed(1) + 'px');
    lastW = m.w;
    return;
  }

  // 拉伸方向朝行进方向：向右移动时把原点放左边（向右拉长），反之亦然
  drop.style.transformOrigin = dx > 0 ? 'left center' : 'right center';
  drop.style.setProperty('--nd-x', m.x.toFixed(1) + 'px');
  drop.style.setProperty('--nd-w', m.w.toFixed(1) + 'px');
  drop.style.setProperty('--nd-y', m.y.toFixed(1) + 'px');
  drop.style.setProperty('--nd-h', m.h.toFixed(1) + 'px');

  // 拉伸（liquid 的关键）：与位移动画共用同一条过渡；
  // 落位后由 transitionend 复位到 1，并用定时器兜底 —— 过渡即使被中断也不会卡在"被压扁"的状态。
  drop.classList.add('moving');
  drop.style.setProperty('--nd-sx', '1.16');
  clearTimeout(animTimer);
  animTimer = setTimeout(resetStretch, MOVE_MS + 160);

  lastX = m.x; lastW = m.w;
}

/** 收尾：复位拉伸、去掉 moving 态（可重复调用）。 */
function resetStretch() {
  if (!drop) return;
  clearTimeout(animTimer);
  drop.classList.remove('moving');
  drop.style.setProperty('--nd-sx', '1');
  drop.style.transformOrigin = 'center';
}

function ensureRefs() {
  nav = document.querySelector(NAV_SEL);
  drop = document.getElementById(DROP_ID);
  return !!(nav && drop);
}

export function refreshNavDrop(noAnim) {
  if (!ensureRefs()) return;
  if (document.documentElement.getAttribute('data-ui-preset') !== 'frost') {
    drop.classList.remove('moving');
    return;                                  // 非玻璃皮肤：不参与定位（CSS 里也不显示）
  }
  // 皮肤刚切过来时 #navDrop 可能还没有过渡状态，直接落位更稳
  if (noAnim) place(true); else move();
}

let timer = null;
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => refreshNavDrop(), 60); };

export function initNavDrop() {
  if (!ensureRefs()) return;

  // 选中项变化：main.js 是给 .navItem 切换 .cur，故监听 class 变化
  try {
    new MutationObserver(schedule).observe(nav, {
      subtree: true, attributes: true, attributeFilter: ['class'],
    });
  } catch (e) { /* 忽略 */ }

  // 位移动画结束即复位拉伸（transitionend 是主路径，定时器兜底）
  drop.addEventListener('transitionend', function (e) {
    if (e.target === drop && e.propertyName === 'transform') resetStretch();
  });
  window.addEventListener('hashchange', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  document.addEventListener('cm-uipreset', schedule);
  try {
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(schedule).observe(nav);
  } catch (e) { /* 忽略 */ }

  // 兜底：字体图标加载完成、安全区迟到等会让外框变化，轻量比对即可
  setInterval(function () {
    if (document.documentElement.getAttribute('data-ui-preset') !== 'frost') return;
    const m = measure();
    if (!m) return;
    if (lastX === null || Math.abs(m.x - lastX) > 0.6 || Math.abs(m.w - lastW) > 0.6) move();
  }, 500);

  refreshNavDrop(true);
  // 首次进入时图标字体可能还没就绪，量到的宽度会偏小，稍后补一次
  [120, 420, 1200].forEach(ms => setTimeout(() => refreshNavDrop(true), ms));
}

/** 供验证脚本读取当前水滴几何。 */
export function navDropDebug() {
  if (!drop) return null;
  return {
    x: drop.style.getPropertyValue('--nd-x'),
    w: drop.style.getPropertyValue('--nd-w'),
    visible: getComputedStyle(drop).display !== 'none',
    opacity: getComputedStyle(drop).opacity,
  };
}
