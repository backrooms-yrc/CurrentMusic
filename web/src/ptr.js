import { loadingMarkup, loadingCycle, LOADING_CYCLE_MS } from './loading.js';
// 下拉刷新复用七形态动画；松手重新从第一形态开始，至少完整播放一轮。
// 仅触摸手势（App/移动网页）；桌面上静默不生效。刷新动作由 main.js 注入（router 重跑当前路由）。
const THRESHOLD = 64;     // 触发阈值：原始下拉 px
const MAX_HIDE_MS = LOADING_CYCLE_MS * 3; // 刷新指示器最长展示（防页面渲染挂死卡住转圈）

export function initPullToRefresh(runRefresh) {
  const out = document.getElementById('out');
  if (!out) return;

  const ind = document.createElement('div');
  ind.id = 'ptrInd';
  ind.setAttribute('role', 'status');
  ind.setAttribute('aria-label', '正在刷新');
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = loadingMarkup();
  document.body.appendChild(ind);
  let currentCycle = null, refreshId = 0;

  let startId = -1, startY = 0, startX = 0;
  let pulling = false;     // 本轮触摸从 scrollTop=0 处开始（候选）
  let engaged = false;     // 已判定为下拉刷新（垂直占优且继续向下）
  let refreshing = false;  // 松手触发后，等待页面重渲染完成

  const reset = () => { pulling = false; engaged = false; startId = -1; };

  const hideIndicator = () => {
    ind.classList.remove('drag');
    ind.classList.remove('show', 'armed', 'spin');
    ind.setAttribute('aria-hidden', 'true');
    setProgress(0);
  };

  function setProgress(p) {           // p: 0~1（拉动进度）；armed 前弧最多 3/4 圈
    const s = 0.62 + 0.38 * Math.min(1, p);
    ind.style.opacity = p > 0 ? String(Math.min(1, 0.3 + p)) : '0';
    ind.style.transform = `translateY(${(-8 + 14 * Math.min(1, p)).toFixed(1)}px) scale(${s.toFixed(2)})`;
  }

  const springBack = () => {
    ind.classList.remove('drag');     // 恢复 transition，弹回初始态
    requestAnimationFrame(() => { ind.classList.remove('show', 'armed'); setProgress(0); });
  };

  const startRefresh = () => {
    refreshing = true;
    const own = ++refreshId;
    ind.classList.remove('drag', 'armed');
    ind.classList.add('spin');
    ind.setAttribute('aria-hidden', 'false');
    ind.removeAttribute('data-loading-start');
    ind.innerHTML = loadingMarkup(); // restart at shape one, independent of the drag duration
    currentCycle = loadingCycle(ind);
    const cycle = currentCycle;
    setProgress(1);
    let timeout;
    const limit = new Promise(resolve => { timeout = setTimeout(resolve, MAX_HIDE_MS); });
    Promise.race([Promise.resolve().then(() => runRefresh()).catch(() => {}), limit])
      .then(() => { clearTimeout(timeout); return cycle.finish(); })
      .then(() => {
        if (own !== refreshId) return;
        currentCycle = null; refreshing = false; hideIndicator();
      });
  };
  window.addEventListener('hashchange', () => {
    ++refreshId;
    if (currentCycle) { currentCycle.cancel(); currentCycle = null; }
    refreshing = false; reset(); hideIndicator();
  });

  // 表单区域不接管：手指落在输入框（真实 target 是内层 input）或 mdui-text-field 宿主上时，手势留给原生
  const formish = t => t && t.closest && t.closest('input, textarea, [contenteditable="true"], mdui-text-field');

  // 页面内自带纵向滚动区（如 Chat 的消息列表）不接管：它的滚动属于组件自己，
  // 在列表顶部继续下拉也不应刷新整页。显式标记 data-ptr-ignore 用于没有溢出的
  // 短列表/头部区域。
  const ignored = t => t && t.closest && t.closest('[data-ptr-ignore]');
  const innerScroller = t => {
    for (let el = t; el && el !== out; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if (/^(auto|scroll|overlay)$/.test(oy) && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return null;
  };

  out.addEventListener('touchstart', e => {
    if (refreshing || e.touches.length !== 1) { reset(); return; }
    if (out.scrollTop > 0 || formish(e.target) || ignored(e.target) || innerScroller(e.target)) { reset(); return; }
    const t = e.touches[0];
    startId = t.identifier; startY = t.clientY; startX = t.clientX;
    pulling = true; engaged = false;
  }, { passive: true });

  out.addEventListener('touchmove', e => {
    if (!pulling || refreshing) return;
    let t = null;
    for (const x of e.touches) { if (x.identifier === startId) { t = x; break; } }
    if (!t) { reset(); springBack(); return; }
    const dy = t.clientY - startY;
    const dx = t.clientX - startX;
    if (!engaged) {
      if (out.scrollTop > 0 || dy <= 0) return;             // 已滚离顶部/向上滑 → 交回原生滚动
      if (dy < 10 || dy < Math.abs(dx) * 1.3) return;       // 垂直占优才接管（避免劫持横滑轮播）
      engaged = true;
      ind.classList.add('show', 'drag');                    // drag：拖动期关 transition（跟手）
      setProgress(0);
    }
    e.preventDefault();                                     // 接管后阻止原生 overscroll
    const p = Math.max(0, Math.min(1, dy / THRESHOLD));
    setProgress(p);
    ind.classList.toggle('armed', p >= 1);
  }, { passive: false });

  const finish = e => {
    if (!pulling) return;
    let t = null;
    for (const x of e.changedTouches) { if (x.identifier === startId) { t = x; break; } }
    if (!t) return;
    const dy = t.clientY - startY;
    if (engaged && !refreshing) {
      if (dy >= THRESHOLD) startRefresh();
      else springBack();
    }
    reset();
  };
  out.addEventListener('touchend', finish, { passive: true });
  out.addEventListener('touchcancel', () => { if (engaged) springBack(); reset(); }, { passive: true });
}
