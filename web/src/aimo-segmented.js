// ==========================================================================
// Aimo 风格分段选择器（N 段式滑动开关）
// 支持：
// 1. 视差滑动指示器（尺寸与位置跟随激活项几何无级形变）
// 2. 指针拖动与跟手吸附（支持触摸与鼠标，拖过阈值松手平滑吸附到目标项）
// 3. 严格限定在 html[data-ui-preset="aimo"] 生效
// ==========================================================================

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

export function enhanceAimoSegmented(container) {
  if (!container || container.__aimoSegInit) return;
  if (!isAimoActive()) return;

  const itemSelector = '.cm-sqtab, .cm-atab, button';
  const getButtons = () => Array.from(container.querySelectorAll(itemSelector));
  const buttons = getButtons();
  if (buttons.length < 2) return;

  container.__aimoSegInit = true;

  // 确保指示器滑块存在
  let indicator = container.querySelector(':scope > .cm-sqtabs-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'cm-sqtabs-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    container.prepend(indicator);
  }

  let dragging = false;
  let moved = false;
  let pointerId = null;
  let startX = 0;
  let startCenter = 0;
  let suppressClickUntil = 0;

  const getActiveButton = () => {
    const list = getButtons();
    return list.find(b => b.classList.contains('on') || b.classList.contains('active')) || list[0];
  };

  const getGeometry = (button) => {
    if (!button) return null;
    return {
      x: button.offsetLeft,
      width: button.offsetWidth,
      center: button.offsetLeft + button.offsetWidth / 2,
    };
  };

  const getAllGeometries = () => {
    return getButtons().map(button => ({
      button,
      ...getGeometry(button),
    }));
  };

  // 根据中心位置在相邻按钮间线性插值，使滑块在不同宽度的标签间丝滑伸缩变形
  const getInterpolatedGeometry = (center) => {
    const list = getAllGeometries();
    if (!list.length) return null;
    if (center <= list[0].center) return { x: list[0].x, width: list[0].width };
    const last = list[list.length - 1];
    if (center >= last.center) return { x: last.x, width: last.width };

    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (center >= a.center && center <= b.center) {
        const span = Math.max(1, b.center - a.center);
        const t = Math.max(0, Math.min(1, (center - a.center) / span));
        return {
          x: a.x + (b.x - a.x) * t,
          width: a.width + (b.width - a.width) * t,
        };
      }
    }
    return { x: last.x, width: last.width };
  };

  const getNearestButton = (center) => {
    const list = getAllGeometries();
    if (!list.length) return null;
    return list.reduce((best, cur) =>
      Math.abs(cur.center - center) < Math.abs(best.center - center) ? cur : best
    ).button;
  };

  const applyGeometry = (geo, animate = true) => {
    if (!geo) {
      indicator.style.opacity = '0';
      return;
    }
    indicator.style.transition = animate ? '' : 'none';
    indicator.style.transform = `translate3d(${geo.x}px, 0, 0)`;
    indicator.style.width = `${geo.width}px`;
    indicator.style.opacity = '1';
  };

  const sync = (animate = true) => {
    if (!isAimoActive()) return;
    const active = getActiveButton();
    if (!active) return;
    const geo = getGeometry(active);
    applyGeometry(geo, animate);
  };

  // 初始落位（下一帧执行以确保布局已渲染测量）
  requestAnimationFrame(() => sync(false));

  // 监听按钮点击以触发滑动动画
  container.addEventListener('click', (e) => {
    if (!isAimoActive()) return;
    if (performance.now() < suppressClickUntil) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const btn = e.target.closest(itemSelector);
    if (!btn || !container.contains(btn)) return;
    // 延迟一帧让页面现有的 classList 切换生效
    requestAnimationFrame(() => sync(true));
  });

  // 指针拖拽事件
  container.addEventListener('pointerdown', (e) => {
    if (!isAimoActive()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const active = getActiveButton();
    if (!active) return;

    dragging = true;
    moved = false;
    pointerId = e.pointerId;
    startX = e.clientX;
    const geo = getGeometry(active);
    startCenter = geo ? geo.center : 0;
  });

  const onPointerMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) >= 6) {
      moved = true;
      try { container.setPointerCapture(pointerId); } catch (_) {}
      container.classList.add('dragging');
    }
    if (moved) {
      if (e.cancelable) e.preventDefault();
      const currentCenter = startCenter + dx;
      const geo = getInterpolatedGeometry(currentCenter);
      if (geo) applyGeometry(geo, false);
    }
  };

  const onPointerFinish = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    container.classList.remove('dragging');

    if (e.type === 'pointercancel') {
      sync(true);
      return;
    }

    if (!moved) return;

    suppressClickUntil = performance.now() + 320;
    const dx = e.clientX - startX;
    const target = getNearestButton(startCenter + dx);
    if (target) {
      const geo = getGeometry(target);
      applyGeometry(geo, true);
      // 触发目标按钮的原生点击处理
      target.click();
    } else {
      sync(true);
    }
  };

  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', onPointerFinish);
  container.addEventListener('pointercancel', onPointerFinish);

  // 尺寸与 DOM 变动同步
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!dragging) sync(false);
    });
    ro.observe(container);
  }

  const mo = new MutationObserver(() => {
    if (!dragging) requestAnimationFrame(() => sync(true));
  });
  mo.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
}

export function autoEnhanceAimoSegmented() {
  const scan = () => {
    if (!isAimoActive()) return;
    const tabs = document.querySelectorAll('.cm-sqtabs, .cm-atabs');
    tabs.forEach(enhanceAimoSegmented);
  };
  scan();
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(scan);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
}
