// 真实音乐波形可视化（canvas + 实时频谱）。
//
// 数据来源：Web Audio 的 AnalyserNode（由 player.js 提供 read(u8)）。
//  · read() 返回 false 表示当前没有可用的分析器（例如音源 CORS 不干净、
//    或系统不支持 Web Audio）——此时画「静默基线」，绝不假装有律动。
//  · 舞动效果来自**真实音频信号**：每帧读一次频谱，按对数分箱聚合成每根柱的
//    能量，再做「快攻击 / 慢释放」的包络平滑（这才是听觉上"跟着节奏跳"的观感，
//    直接画瞬时值会抖动得像噪点）。
//
// 画法：柱子以水平中轴对称展开（音乐播放器的经典波形形态），已播放区间用亮色
// （淡紫 → 白渐变）、未播放区间压暗，并在播放位置画一条柔光进度线。

const MIN_BAR_H = 1.5;      // 静默时柱高（px）
const ATTACK = 0.55;        // 起音：新值占比（越大越跟手）
const RELEASE = 0.12;       // 释放：旧值残留（越小回落越快）

export function createWaveform(canvas, opts) {
  const read = opts.read;
  const progressOf = opts.progress;                       // 帧循环里每帧取进度
  const binsOf = opts.bins || function () { return 256; };

  const ctx = canvas.getContext('2d');
  let dpr = 1, cssW = 0, cssH = 0;
  let bars = 0;               // 柱数（按宽度自适应）
  let level = null;           // 每根柱的平滑能量（0..1）
  let raf = 0;
  let playing = false;
  let progress = 0;           // 0..1
  let reduced = false;
  let alive = true;
  let u8 = null;
  let bins = binsOf();

  try {
    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { reduced = false; }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(40, Math.round(rect.width));
    const h = Math.max(12, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);   // 高分屏够清晰即可，避免 3x 过度绘制
    if (w === cssW && h === cssH && canvas.width) return;
    cssW = w; cssH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bars = Math.max(18, Math.min(52, Math.round(w / 6.4)));
    level = new Float32Array(bars);
  }

  /** 把频谱聚合成每根柱的目标能量 0..1（对数分箱，低频不挤爆）。 */
  function sample() {
    const n = level.length;
    const want = binsOf();
    if (want !== bins || !u8 || u8.length !== want) {
      bins = want;
      u8 = new Uint8Array(want);
    }
    if (!read(u8)) return false;
    // 可用频段：低频端噪声大，高频端基本是空的 → 取前 3/4 用
    const usable = Math.floor(u8.length * 0.75);
    for (let i = 0; i < n; i++) {
      const f0 = Math.pow(i / n, 1.7);            // 对数感映射：低频占更少格子
      const f1 = Math.pow((i + 1) / n, 1.7);
      let a = Math.floor(f0 * usable), b = Math.floor(f1 * usable);
      if (b <= a) b = a + 1;
      let sum = 0, cnt = 0;
      for (let k = a; k < b && k < u8.length; k++) { sum += u8[k]; cnt++; }
      const v = cnt ? (sum / cnt) / 255 : 0;
      // 快攻击 / 慢释放包络
      const prev = level[i];
      level[i] = v > prev ? prev + (v - prev) * ATTACK : prev + (v - prev) * RELEASE;
    }
    return true;
  }

  /** 画一帧。hasData=false 时画静默基线。 */
  function draw(hasData) {
    if (!alive) return;
    if (!cssW) resize();          // 首次绘制前补量（容器可能刚挂上 DOM）
    if (!cssW) return;
    const w = cssW, h = cssH, mid = h / 2;
    const n = bars;
    const slot = w / n;
    const barW = Math.max(1.4, Math.min(3.2, slot * 0.44));
    const maxH = h - 6;
    ctx.clearRect(0, 0, w, h);
    const head = progress * w;

    // 已播放区域底色，让"扫过"的感觉更明确
    if (progress > 0) {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(208,188,255,.10)');
      g.addColorStop(1, 'rgba(255,255,255,.045)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, head, h);
    }

    for (let i = 0; i < n; i++) {
      const x = i * slot + (slot - barW) / 2;
      let v = 0;
      if (hasData && level) v = Math.min(1, level[i] * 1.18);   // 轻微提亮，让弱段也可见
      const bh = Math.max(MIN_BAR_H, v * maxH);
      const played = (x + barW / 2) <= head;
      const r = barW / 2;
      const y = mid - bh / 2;
      if (played) {
        const g = ctx.createLinearGradient(0, mid - maxH / 2, 0, mid + maxH / 2);
        g.addColorStop(0, 'rgba(255,255,255,.96)');
        g.addColorStop(.5, 'rgba(224,208,255,.92)');
        g.addColorStop(1, 'rgba(255,255,255,.96)');
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,.30)';
      }
      roundRect(x, y, barW, bh, r);
      ctx.fill();
    }

    // 播放位置：柔光竖线
    if (progress > 0.001 && progress < 1) {
      ctx.save();
      ctx.shadowColor = 'rgba(208,188,255,.85)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.fillRect(head - 0.5, 1, 1, h - 2);
      ctx.restore();
    }
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function frame() {
    if (!alive) return;
    raf = 0;
    if (!playing || reduced) { stop(); return; }
    if (progressOf) progress = Math.max(0, Math.min(1, progressOf() || 0));
    const has = sample();
    draw(has);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!alive) return;
    resize();
    if (!playing || reduced) { draw(false); return; }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  return {
    /** 播放态变化：播放时开循环，暂停/结束时停循环并定格最后一帧。 */
    setPlaying(on) {
      playing = !!on;
      if (playing && !reduced) start();
      else { stop(); draw(false); }      // 暂停：回到静默基线（不保留残影，视觉上"停住"）
    },
    /** 进度变化（0..1）：跑循环时由帧循环自己取；静态时重画一帧。 */
    setProgress(p) {
      progress = Math.max(0, Math.min(1, p || 0));
      if (!raf) draw(false);      // 静态时重画一帧（draw 内部会按需量尺寸）
    },
    start,
    stop,
    /** 调试用：当前每根柱的平滑能量（0..1）副本，便于验证数据是否真的作用到柱高。 */
    levels() { return level ? Array.prototype.slice.call(level) : []; },
    /** 容器尺寸变化（旋转/分栏/窗口缩放）后重新量取。 */
    resize() { const w = cssW, h = cssH; cssW = 0; resize(); if (w !== cssW || h !== cssH) draw(false); },
    destroy() { alive = false; stop(); },
  };
}
