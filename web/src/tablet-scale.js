let scale = 1;

export function layoutScale() { return scale; }

// DOMRect 使用显示坐标，写回 CSS 像素前要换回布局坐标。
export function layoutRect(element) {
  const rect = element.getBoundingClientRect();
  if (scale === 1) return rect;
  return { left: rect.left / scale, top: rect.top / scale,
    right: rect.right / scale, bottom: rect.bottom / scale,
    width: rect.width / scale, height: rect.height / scale };
}

export function initTabletScale() {
  if (window.NativeApi?.versionCode || !navigator.maxTouchPoints) return;
  const ua = navigator.userAgent;
  // 安卓请求桌面站点时会用 Linux 桌面 UA，触点和屏幕短边仍可用来识别平板。
  const android = /\bAndroid\b/.test(ua) || (/\bLinux\b/.test(ua) && matchMedia('(pointer: coarse)').matches);
  if (!android || !/\b(?:Chrome|Chromium|EdgA)\//.test(ua)) return;
  const root = document.documentElement;
  const update = () => {
    const width = window.innerWidth;
    let next = 1;
    if (width >= 600 && Math.min(screen.width, screen.height) >= 600) {
      const pageZoom = window.outerWidth / width;
      // 优先补偿浏览器的页面放大。窗口和视口等宽时，兼容低密度安卓屏幕的轻度放大。
      // 高密度屏的 DPR 以及更大的用户缩放保留给浏览器处理。
      const ratio = pageZoom > 1.04 ? pageZoom : window.devicePixelRatio;
      if (ratio > 1.04 && ratio <= 1.28) next = 1 / ratio;
    }
    if (next === scale) return;
    scale = next;
    if (scale === 1) root.style.removeProperty('--cm-view-scale');
    else root.style.setProperty('--cm-view-scale', String(scale));
  };
  update();
  window.addEventListener('resize', update);
}
