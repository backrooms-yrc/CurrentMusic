// 管理台图表：无第三方依赖的 Canvas 折线 / 柱状 / 组合 / 环图。
//
// 只负责绘制、坐标轴与 hover 提示；数据、颜色与文案由页面传入。所有绘制都按
// canvas.clientWidth/Height 重新算尺寸（高 DPI 下乘 devicePixelRatio），因此
// 布局变化后再次调用即可，不需要维护内部坐标系。

const FONT = 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

let _cssKey = '', _cssCache = {};
function css(name, fallback) {
  // 图表 hover 时每帧都会重绘；getComputedStyle 很贵，按当前皮肤/主题缓存一轮。
  try {
    const root = document.documentElement;
    const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const key = [root.className, root.getAttribute('data-theme'), root.getAttribute('data-ui-preset'),
      root.style.getPropertyValue('--cm-fs'), dark].join('|');
    if (key !== _cssKey) { _cssKey = key; _cssCache = {}; }
    if (name in _cssCache) return _cssCache[name];
    const v = getComputedStyle(root).getPropertyValue(name).trim();
    _cssCache[name] = v || fallback;
    return _cssCache[name];
  } catch { return fallback; }
}

function primary() { return css('--cm-primary', '#6750a4'); }
function muted() { return css('--label-2', 'rgba(128,128,145,.85)'); }
function hairline() { return css('--hairline', 'rgba(128,128,145,.18)'); }

/** 把任意 CSS 颜色转成带透明度的 rgba()；Canvas 渐变只认颜色字面量。 */
const _alphaCache = new Map();
function alpha(color, a) {
  const key = color + '|' + a;
  if (_alphaCache.has(key)) return _alphaCache.get(key);
  try {
    const cv = document.createElement('canvas');
    const cx = cv.getContext('2d');
    cx.fillStyle = color;
    const norm = cx.fillStyle;      // 统一成 #rrggbb 或 rgba(...)
    if (norm.startsWith('#')) {
      const n = parseInt(norm.slice(1), 16);
      const out = `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
      _alphaCache.set(key, out);
      return out;
    }
    const m = norm.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(',').map(x => x.trim());
      const out = `rgba(${p[0]},${p[1]},${p[2]},${a})`;
      _alphaCache.set(key, out);
      return out;
    }
  } catch { /* 取色失败回退 */ }
  _alphaCache.set(key, color);
  return color;
}

function setup(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, canvas.clientWidth || canvas.parentElement?.clientWidth || 600);
  const h = Math.max(1, canvas.clientHeight || 220);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** 取一个「好看」的坐标轴上限：1/2/5 × 10^n。 */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * base;
}

function emptyChart(canvas, text = '暂无数据') {
  canvas._cmChart = null;
  const { ctx, w, h } = setup(canvas);
  ctx.fillStyle = muted();
  ctx.font = `13px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tip = canvas.parentElement && canvas.parentElement.querySelector('.cm-chart-tip');
  if (tip) tip.hidden = true;
}

/** 获取/创建画布右上角的 tooltip 容器。 */
function tipOf(canvas) {
  const parent = canvas.parentElement;
  if (!parent) return null;
  parent.classList.add('cm-chart-wrap');
  let tip = parent.querySelector('.cm-chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'cm-chart-tip';
    tip.hidden = true;
    parent.appendChild(tip);
  }
  return tip;
}

function bindHover(canvas) {
  if (canvas._cmHoverBound) return;
  canvas._cmHoverBound = true;
  const tip = tipOf(canvas);
  const hide = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    last = null;
    if (tip) tip.hidden = true;
    const c = canvas._cmChart;
    if (c) c.draw(null);
  };
  let raf = 0, last = null;
  const apply = () => {
    const c = canvas._cmChart;
    if (!c || !last) return;
    const rect = canvas.getBoundingClientRect();
    const x = last.clientX - rect.left;
    const y = last.clientY - rect.top;
    const idx = c.hit(x, y);
    if (idx == null) { hide(); return; }
    c.draw(idx);
    if (!tip) return;
    const info = c.tip(idx);
    if (!info) { tip.hidden = true; return; }
    tip.innerHTML = info.html;
    tip.hidden = false;
    const parent = canvas.parentElement;
    const pw = parent ? parent.clientWidth : rect.width;
    const tw = tip.offsetWidth || 120;
    tip.style.left = Math.round(Math.max(6, Math.min(pw - tw - 6, info.x - tw / 2))) + 'px';
    tip.style.top = Math.round(Math.max(6, info.y - (tip.offsetHeight || 40) - 10)) + 'px';
  };
  const move = e => {
    last = { clientX: e.clientX, clientY: e.clientY };
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; apply(); });
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerdown', move);
  canvas.addEventListener('pointerleave', hide);
}

function xLabels(ctx, points, x, w, h, pad, labelOf) {
  const n = points.length;
  if (!n) return;
  const max = w < 380 ? 3 : w < 620 ? 4 : 5;
  const idxs = [];
  for (let i = 0; i < max; i++) {
    const at = Math.round((n - 1) * i / Math.max(1, max - 1));
    if (idxs.indexOf(at) < 0) idxs.push(at);
  }
  ctx.fillStyle = muted();
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  idxs.forEach((i, k) => {
    const label = labelOf(points[i], i);
    if (!label) return;
    let tx = x(i);
    ctx.textAlign = k === 0 ? 'left' : k === idxs.length - 1 ? 'right' : 'center';
    tx = Math.max(pad.l, Math.min(w - pad.r, tx));
    ctx.fillText(label, tx, h - 7);
  });
}

function yGrid(ctx, w, h, pad, max, axisFormat) {
  ctx.font = `11px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = max * k / 4;
    const gy = h - pad.b - (h - pad.t - pad.b) * (v / max);
    ctx.strokeStyle = hairline();
    ctx.beginPath();
    ctx.moveTo(pad.l, gy);
    ctx.lineTo(w - pad.r, gy);
    ctx.stroke();
    ctx.fillStyle = muted();
    ctx.fillText(axisFormat(v), pad.l - 7, gy);
  }
}

/**
 * 折线图。
 * points: [{...}]；value / label 取字段；x 轴自动取首/均分/尾。
 * opts: { value, label, format, axisFormat, color, unit, tipTitle }
 */
export function drawLineChart(canvas, points, opts = {}) {
  bindHover(canvas);
  const valueOf = opts.value || (p => p.bytes);
  const labelOf = opts.label || (p => p.day || '');
  const fmt = opts.format || (v => String(v));
  const axisFmt = opts.axisFormat || fmt;
  const color = opts.color || primary();
  const tipTitle = opts.tipTitle || (p => labelOf(p));
  const vals = (points || []).map(p => Number(valueOf(p)) || 0);
  const max = niceMax(Math.max(1, ...vals) * 1.08);
  const pad = { l: 54, r: 12, t: 22, b: 26 };

  const draw = hover => {
    if (!points || !points.length) { emptyChart(canvas); return; }
    const { ctx, w, h } = setup(canvas);
    const plotW = Math.max(1, w - pad.l - pad.r);
    const plotH = Math.max(1, h - pad.t - pad.b);
    const n = points.length;
    const x = i => n === 1 ? pad.l + plotW / 2 : pad.l + plotW * i / (n - 1);
    const y = v => h - pad.b - plotH * ((Number(v) || 0) / max);

    yGrid(ctx, w, h, pad, max, axisFmt);
    xLabels(ctx, points, x, w, h, pad, labelOf);

    // 折线 + 渐变填充
    const line = () => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const px = x(i), py = y(valueOf(p));
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      });
    };
    if (n > 1) {
      line();
      ctx.lineTo(x(n - 1), h - pad.b);
      ctx.lineTo(x(0), h - pad.b);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
      grad.addColorStop(0, alpha(color, .26));
      grad.addColorStop(1, alpha(color, .02));
      ctx.fillStyle = grad;
      ctx.fill();
    }
    line();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    if (n === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(0), y(vals[0]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // 峰值标记：比只在 y 轴看数字更容易定位「哪天最高」
    let peak = 0;
    vals.forEach((v, i) => { if (v > vals[peak]) peak = i; });
    if (n > 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x(peak), y(vals[peak]), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hover != null && hover >= 0 && hover < n) {
      const hx = x(hover), hy = y(valueOf(points[hover]));
      ctx.strokeStyle = alpha(color, .38);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css('--surface', '#fff');
      ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, Math.PI * 2); ctx.fill();
    }

    canvas._cmChart = {
      draw,
      hit: (px, py) => {
        if (px < pad.l - 8 || px > w - pad.r + 8 || py < pad.t - 8 || py > h - pad.b + 8) return null;
        return Math.max(0, Math.min(n - 1, Math.round((px - pad.l) / plotW * (n - 1))));
      },
      tip: i => {
        const p = points[i];
        const px = x(i), py = y(valueOf(p));
        return { html: `<b>${tipTitle(p)}</b><div>${fmt(valueOf(p))}</div>`, x: px, y: py };
      },
    };
  };
  draw(null);
}

/**
 * 柱状图（纵向）。用于「近 30 天注册」这类离散日数据。
 * opts: { value, label, format, axisFormat, color }
 */
export function drawBarChart(canvas, points, opts = {}) {
  bindHover(canvas);
  const valueOf = opts.value || (p => p.count);
  const labelOf = opts.label || (p => p.day || '');
  const fmt = opts.format || (v => String(v));
  const axisFmt = opts.axisFormat || fmt;
  const color = opts.color || primary();
  const vals = (points || []).map(p => Number(valueOf(p)) || 0);
  const max = niceMax(Math.max(1, ...vals) * 1.08);
  const pad = { l: 48, r: 10, t: 22, b: 26 };

  const draw = hover => {
    if (!points || !points.length) { emptyChart(canvas); return; }
    const { ctx, w, h } = setup(canvas);
    const plotW = Math.max(1, w - pad.l - pad.r);
    const plotH = Math.max(1, h - pad.t - pad.b);
    const n = points.length;
    const bw = Math.max(2, plotW / n * .62);
    const x = i => pad.l + plotW * (i + .5) / n;
    const y = v => h - pad.b - plotH * ((Number(v) || 0) / max);

    yGrid(ctx, w, h, pad, max, axisFmt);
    xLabels(ctx, points, x, w, h, pad, labelOf);

    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const bx = x(i) - bw / 2;
      const by = y(v);
      const bh = Math.max(v > 0 ? 2 : 0, h - pad.b - by);
      ctx.fillStyle = i === hover ? color : alpha(color, .72);
      ctx.beginPath();
      // 顶部圆角：用 roundRect 不可用时回退矩形（Android 8 WebView 无 roundRect）
      if (ctx.roundRect) { ctx.roundRect(bx, by, bw, bh, Math.min(3, bw / 2)); ctx.fill(); }
      else ctx.fillRect(bx, by, bw, bh);
    }

    if (hover != null && hover >= 0 && hover < n) {
      const hx = x(hover);
      ctx.strokeStyle = alpha(color, .3);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
    }

    canvas._cmChart = {
      draw,
      hit: px => {
        if (px < pad.l - 8 || px > w - pad.r + 8) return null;
        const i = Math.floor((px - pad.l) / plotW * n);
        return Math.max(0, Math.min(n - 1, i));
      },
      tip: i => {
        const p = points[i];
        return { html: `<b>${labelOf(p)}</b><div>${fmt(valueOf(p))}</div>`, x: x(i), y: y(valueOf(p)) };
      },
    };
  };
  draw(null);
}

/**
 * 组合图：左侧柱（次数）+ 右侧折线（去重人数），两个量纲分开归一到各自上限。
 * opts: { barValue, lineValue, label, barFormat, lineFormat, axisFormat }
 */
export function drawComboChart(canvas, points, opts = {}) {
  bindHover(canvas);
  const barValue = opts.barValue || (p => p.plays);
  const lineValue = opts.lineValue || (p => p.users);
  const labelOf = opts.label || (p => p.day || '');
  const barFmt = opts.barFormat || (v => String(v));
  const lineFmt = opts.lineFormat || (v => String(v));
  const axisFmt = opts.axisFormat || barFmt;
  const color = opts.color || primary();
  const lineColor = opts.lineColor || css('--cm-warn', '#ff8d28');
  const bars = (points || []).map(p => Number(barValue(p)) || 0);
  const lines = (points || []).map(p => Number(lineValue(p)) || 0);
  const maxBar = niceMax(Math.max(1, ...bars) * 1.08);
  const maxLine = niceMax(Math.max(1, ...lines) * 1.08);
  const pad = { l: 48, r: 46, t: 22, b: 26 };

  const draw = hover => {
    if (!points || !points.length) { emptyChart(canvas); return; }
    const { ctx, w, h } = setup(canvas);
    const plotW = Math.max(1, w - pad.l - pad.r);
    const plotH = Math.max(1, h - pad.t - pad.b);
    const n = points.length;
    const bw = Math.max(2, plotW / n * .56);
    const x = i => pad.l + plotW * (i + .5) / n;
    const yBar = v => h - pad.b - plotH * ((Number(v) || 0) / maxBar);
    const yLine = v => h - pad.b - plotH * ((Number(v) || 0) / maxLine);

    yGrid(ctx, w, h, pad, maxBar, axisFmt);
    // 右轴给「活跃用户」折线自己的刻度，避免被误读成左轴次数
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = alpha(lineColor, .9);
    for (let k = 0; k <= 4; k++) {
      const v = maxLine * k / 4;
      const gy = h - pad.b - (h - pad.t - pad.b) * (v / maxLine);
      ctx.fillText(lineFmt(v), w - pad.r + 5, gy);
    }
    xLabels(ctx, points, x, w, h, pad, labelOf);

    for (let i = 0; i < n; i++) {
      const bx = x(i) - bw / 2;
      const by = yBar(bars[i]);
      const bh = Math.max(bars[i] > 0 ? 2 : 0, h - pad.b - by);
      ctx.fillStyle = i === hover ? color : alpha(color, .55);
      if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, Math.min(3, bw / 2)); ctx.fill(); }
      else ctx.fillRect(bx, by, bw, bh);
    }

    // 折线
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = x(i), py = yLine(lines[i]);
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = lineColor;
      ctx.beginPath();
      ctx.arc(x(i), yLine(lines[i]), i === hover ? 4 : 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hover != null && hover >= 0 && hover < n) {
      const hx = x(hover);
      ctx.strokeStyle = alpha(lineColor, .3);
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(hx, pad.t); ctx.lineTo(hx, h - pad.b); ctx.stroke();
      ctx.setLineDash([]);
    }

    canvas._cmChart = {
      draw,
      hit: px => {
        if (px < pad.l - 8 || px > w - pad.r + 8) return null;
        const i = Math.floor((px - pad.l) / plotW * n);
        return Math.max(0, Math.min(n - 1, i));
      },
      tip: i => {
        const p = points[i];
        return {
          html: `<b>${labelOf(p)}</b><div>播放 ${barFmt(bars[i])}</div><div>活跃用户 ${lineFmt(lines[i])}</div>`,
          x: x(i),
          y: Math.min(yBar(bars[i]), yLine(lines[i])),
        };
      },
    };
  };
  draw(null);
}

/**
 * 环图（角色构成）。items: [{label, value, color}]；图例由页面在 HTML 里渲染。
 */
export function drawDonutChart(canvas, items, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  const list = (items || []).filter(x => Number(x.value) > 0);
  const total = list.reduce((s, x) => s + Number(x.value), 0);
  if (!total) { emptyChart(canvas); return; }
  const cx = w / 2, cy = h / 2;
  const r = Math.max(18, Math.min(w, h) / 2 - 12);
  const inner = r * .62;
  let angle = -Math.PI / 2;
  const gap = list.length > 1 ? 0.02 : 0;
  ctx.lineCap = 'butt';
  list.forEach(x => {
    const a = Number(x.value) / total * Math.PI * 2;
    const g = Math.min(gap, a * .25);      // 极小占比时不能把缺口撑成负角度
    ctx.beginPath();
    ctx.arc(cx, cy, r, angle + g, angle + a - g);
    ctx.arc(cx, cy, inner, angle + a - g, angle + g, true);
    ctx.closePath();
    ctx.fillStyle = x.color || primary();
    ctx.fill();
    angle += a;
  });
  ctx.fillStyle = css('--label', '#1d1b20');
  ctx.font = `700 22px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(total), cx, cy - 6);
  ctx.fillStyle = muted();
  ctx.font = `11px ${FONT}`;
  ctx.fillText(opts.centerLabel || '个账号', cx, cy + 16);
}

/** 供页面在窗口尺寸变化后重绘：统一取 CSS 像素尺寸。 */
export function chartHeight(canvas) {
  return canvas.clientHeight || 220;
}
