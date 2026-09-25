// 全局下拉刷新：#out 滚动到顶后继续向下拖 → MD3 圆形进度指示器 → 松手重渲染当前页。
// 仅触摸手势（App/移动网页）；桌面上静默不生效。刷新动作由 main.js 注入（router 重跑当前路由）。
const THRESHOLD = 64;     // 触发阈值：原始下拉 px
const MAX_HIDE_MS = 4000; // 刷新指示器最长展示（防页面渲染挂死卡住转圈）

export function initPullToRefresh(runRefresh) {
  const out = document.getElementById('out');
  if (!out) return;

  const ind = document.createElement('div');
  ind.id = 'ptrInd';
  ind.setAttribute('aria-hidden', 'true');
  // 弧形进度用 SVG stroke-dashoffset（Chrome 58 可用），自转动画走 CSS（内层 svg）
  ind.innerHTML = '<svg viewBox="0 0 36 36"><circle class="ptr-ring" cx="18" cy="18" r="15"></circle></svg>';
  document.body.appendChild(ind);
  const ring = ind.querySelector('.ptr-ring');
  const CIRC = 2 * Math.PI * 15;
  ring.style.strokeDasharray = String(CIRC);

  let startId = -1, startY = 0, startX = 0;
  let pulling = false;     // 本轮触摸从 scrollTop=0 处开始（候选）
  let engaged = false;     // 已判定为下拉刷新（垂直占优且继续向下）
  let refreshing = false;  // 松手触发后，等待页面重渲染完成

  const reset = () => { pulling = false; engaged = false; startId = -1; };

  const hideIndicator = () => {
    ind.classList.remove('drag');
    ind.classList.remove('show', 'armed', 'spin');
    setProgress(0);
  };

  function setProgress(p) {           // p: 0~1（拉动进度）；armed 前弧最多 3/4 圈
    ring.style.strokeDashoffset = String(CIRC * (1 - 0.75 * Math.max(0, Math.min(1, p))));
    const s = 0.62 + 0.38 * Math.min(1, p);
    ind.style.opacity = p > 0 ? String(Math.min(1, 0.3 + p)) : '0';
    ind.style.transform = `translateY(${(-8 + 14 * Math.min(1, p)).toFixed(1)}px) scale(${s.toFixed(2)}) rotate(${Math.round(p * 150)}deg)`;
  }

  const springBack = () => {
    ind.classList.remove('drag');     // 恢复 transition，弹回初始态
    requestAnimationFrame(() => { ind.classList.remove('show', 'armed'); setProgress(0); });
  };

  const startRefresh = () => {
    refreshing = true;
    ind.classList.remove('drag');
    ind.classList.remove('armed');
    ind.classList.add('spin');        // 内层 svg 自转（不与外层定位 transform 冲突）
    setProgress(1);
    const began = Date.now();
    Promise.resolve()
      .then(() => runRefresh())
      .catch(() => {})
      .then(() => {
        // 页面重渲染完成（或超时兜底）后收起指示器
        const wait = Math.max(0, 350 - (Date.now() - began));   // 至少转 350ms，避免闪一下
        setTimeout(() => { refreshing = false; hideIndicator(); }, wait);
      });
  };

  // 表单区域不接管：手指落在输入框（真实 target 是内层 input）或 mdui-text-field 宿主上时，手势留给原生
  const formish = t => t && t.closest && t.closest('input, textarea, [contenteditable="true"], mdui-text-field');

  out.addEventListener('touchstart', e => {
    if (refreshing || e.touches.length !== 1) { reset(); return; }
    if (out.scrollTop > 0 || formish(e.target)) { reset(); return; }
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
