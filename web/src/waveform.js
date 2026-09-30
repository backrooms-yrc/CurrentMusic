// 播放页波形可视化（canvas + 真实频谱）。
//
// 设计参考（GitHub 上两个主流开源实现，取其**默认值**而非花哨特效）：
//  · audioMotion-analyzer（hvianna/audioMotion-analyzer，高分辨率频谱分析器）
//      barSpace 默认 **0.1** —— 间隙只占 10%，柱体密实；柱形默认**方头**、无发光；
//      showPeaks 默认**开**（峰值帽 + gravity 3.8 回落）；smoothing 0.5；
//      frequencyScale 'log'、minFreq 20 / maxFreq 22000；
//      minDecibels -85 / maxDecibels -25（**这一项最关键**：浏览器默认 -100/-30
//      会把正常音量的频谱全部顶到 255，导致"每根柱都满格"、糊成一片）。
//  · wavesurfer.js（katspaugh/wavesurfer.js）
//      默认配色 waveColor '#4F4A85' / progressColor '#383351' 是**低对比、无霓虹**的，
//      形态是连续的填充轮廓，而不是一根根圆柱。
//
// 因此本文件提供三种风格，全部走同一套频谱分析，只是画法不同：
//   bars    —— 密实方柱 + 峰值帽（audioMotion 默认形态）★默认
//   wave    —— 平滑镜像波形轮廓（wavesurfer 形态）
//   capsule —— 少量圆角粗柱（现代流媒体播放器常见）
//
// **本控件只做"波形指示"，不表达播放进度**：下面已有专门的可拖动进度条，
// 波形上再画"已播放/未播放"分段或扫描线属于重复表达，因此这里不接收进度、
// 不画分段、不画播放头——整幅只有随音乐起伏的波形。
//
// 数据不足时一律画**静默基线**，不假装有律动。

// 默认方案 B（密实方柱）。用户可在「设置 → 外观 → 波形样式」改，存 localStorage。
export const WAVE_STYLE = 'bars';
export const WAVE_STYLES = [
  { key: 'bars', name: '密实方柱', desc: '频谱方柱 + 峰值帽（默认）' },
  { key: 'wave', name: '平滑波形', desc: '连续剪影轮廓，最克制' },
  { key: 'capsule', name: '圆角胶囊', desc: '少量粗柱，最轻' },
];

const STYLES = ['wave', 'bars', 'capsule'];

// 包络时间常数（毫秒）→ 与帧率无关：慢帧不会让柱子"涨不上来/掉不下去"
const ATTACK_MS = 45;
const RELEASE_MS = 190;
const PEAK_HOLD_MS = 480;               // 峰值帽保持时间（audioMotion peakHoldTime 500ms）
const PEAK_FALL = 1.9;                  // 峰值回落加速度（相对高度/秒²）

export function createWaveform(canvas, opts) {
  const read = opts.read;
  const binsOf = opts.bins || function () { return 1024; };
  const want = opts.style || WAVE_STYLE;
  const style = STYLES.indexOf(want) >= 0 ? want : WAVE_STYLE;

  const ctx = canvas.getContext('2d');
  let dpr = 1, cssW = 0, cssH = 0;
  let bars = 0;
  let level = null, peak = null, peakAt = null, peakVel = null;
  let raf = 0, lastTs = 0;
  let playing = false, hasData = false;
  let reduced = false, alive = true;
  let u8 = null, bins = binsOf();
  let grad = null, gradKey = '';

  try { reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { reduced = false; }

  // 配色：低对比、无霓虹。淡紫只作点缀，与播放页主色一致。
  const ACCENT = 'rgba(206,188,255,';
  const WHITE = 'rgba(255,255,255,';

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(40, Math.round(rect.width));
    const h = Math.max(14, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === cssW && h === cssH && canvas.width) return;
    cssW = w; cssH = h;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 柱数：wave 需要更多点才平滑；capsule 更粗；bars 居中
    bars = style === 'wave'
      ? Math.max(28, Math.min(72, Math.round(w / 4.6)))
      : style === 'capsule'
        ? Math.max(9, Math.min(20, Math.round(w / 22)))
        : Math.max(24, Math.min(56, Math.round(w / 6.4)));
    level = new Float32Array(bars);
    peak = new Float32Array(bars);
    peakAt = new Float32Array(bars);
    peakVel = new Float32Array(bars);
    grad = null;
  }

  /** 对数分箱取每根柱的目标能量（0..1）。 */
  function sample(dt) {
    const n = level.length;
    const wantBins = binsOf();
    if (wantBins !== bins || !u8 || u8.length !== wantBins) { bins = wantBins; u8 = new Uint8Array(wantBins); }
    hasData = !!read(u8);

    const usable = Math.max(8, Math.floor(u8.length * 0.72));
    const ka = 1 - Math.exp(-dt / ATTACK_MS);
    const kr = 1 - Math.exp(-dt / RELEASE_MS);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (hasData) {
        // 对数映射：低频占更少格子（audioMotion frequencyScale 'log'）
        const f0 = Math.pow(i / n, 1.65), f1 = Math.pow((i + 1) / n, 1.65);
        let a = Math.floor(f0 * usable), b = Math.floor(f1 * usable);
        if (b <= a) b = a + 1;
        let sum = 0, cnt = 0;
        for (let k = a; k < b && k < u8.length; k++) { sum += u8[k]; cnt++; }
        v = cnt ? (sum / cnt) / 255 : 0;
        v = Math.min(1, Math.pow(v, 1.12) * 1.05);      // 轻微伽马：弱段也保留层次
      }
      const prev = level[i];
      level[i] = v > prev ? prev + (v - prev) * ka : prev + (v - prev) * kr;

      // 峰值帽：保持 PEAK_HOLD_MS，之后按加速度回落
      if (level[i] >= peak[i]) { peak[i] = level[i]; peakAt[i] = now; peakVel[i] = 0; }
      else if (now - peakAt[i] > PEAK_HOLD_MS) {
        peakVel[i] += PEAK_FALL * dt / 1000;
        peak[i] = Math.max(level[i], peak[i] - peakVel[i] * dt / 1000);
      }
    }
    return hasData;
  }

  /** 全画布共用一个竖向渐变（每柱各建一次既慢、又会让柱与柱之间视觉"断开"）。 */
  function gradient() {
    const key = cssH + ':' + cssW;
    if (grad && gradKey === key) return grad;
    const g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, ACCENT + '0.98)');
    g.addColorStop(0.55, ACCENT + '0.72)');
    g.addColorStop(1, ACCENT + '0.42)');
    grad = g; gradKey = key;
    return g;
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    if (rr) ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    if (rr) ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    if (rr) ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    if (rr) ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  /** 镜像波形的闭合轮廓路径（上沿左→右，下沿右→左）。 */
  function wavePath(pts, step, mid) {
    const n = pts.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * step, y = mid - pts[i];
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(i * step, mid + pts[i]);
    ctx.closePath();
  }

  // ── 风格 wave：平滑镜像波形轮廓（wavesurfer 形态）──
  function drawWave() {
    const w = cssW, h = cssH, mid = h / 2;
    const maxH = h - 4;
    const n = bars;
    const step = w / (n - 1);
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = hasData ? Math.min(1, level[i] * 1.25) : 0;
      pts[i] = Math.max(1.2, v * maxH) / 2;
    }
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, ACCENT + '0.55)');
    g.addColorStop(1, ACCENT + '0.95)');
    wavePath(pts, step, mid);
    ctx.fillStyle = g;
    ctx.fill();
  }

  // ── 风格二：密实方柱 + 峰值帽（audioMotion 默认形态）──
  function drawBars() {
    const w = cssW, h = cssH;
    const n = bars;
    const slot = w / n;
    const gap = Math.max(0.6, slot * 0.1);       // barSpace ≈ 0.1
    const bw = Math.max(1, slot - gap);
    const maxH = h - 3;
    const g = gradient();
    for (let i = 0; i < n; i++) {
      const v = hasData ? level[i] : 0;
      const bh = Math.max(1, v * maxH);
      const x = i * slot + gap / 2;
      ctx.fillStyle = g;
      ctx.fillRect(x, h - bh, bw, bh);
      if (hasData && peak[i] > v + 0.02) {        // 峰值帽
        ctx.globalAlpha = 0.95;
        ctx.fillRect(x, h - Math.max(bh + 2, peak[i] * maxH), bw, 1.5);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ── 风格三：少量圆角粗柱（现代流媒体播放器常见）──
  function drawCapsule() {
    const w = cssW, h = cssH;
    const n = bars;
    const slot = w / n;
    const bw = Math.max(3, slot * 0.5);
    const r = bw / 2;
    const maxH = h - 2;
    const g = gradient();
    for (let i = 0; i < n; i++) {
      const v = hasData ? level[i] : 0;
      const bh = Math.max(bw, v * maxH);          // 停播时是一排圆点，形态干净
      const x = i * slot + (slot - bw) / 2;
      ctx.fillStyle = g;
      roundRect(x, h - bh, bw, bh, r);
      ctx.fill();
    }
  }

  function draw() {
    if (!alive) return;
    if (!cssW) resize();
    if (!cssW) return;
    ctx.clearRect(0, 0, cssW, cssH);
    if (style === 'bars') drawBars();
    else if (style === 'capsule') drawCapsule();
    else drawWave();
  }

  function frame(ts) {
    if (!alive) return;
    raf = 0;
    if (!playing || reduced) { stop(); return; }
    const dt = lastTs ? Math.min(64, Math.max(8, ts - lastTs)) : 16;
    lastTs = ts;
    sample(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (!alive) return;
    resize();
    if (!playing || reduced) { draw(); return; }
    lastTs = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  /** 清空能量与峰值（回到静默基线）。level/peak 同批创建，这里统一判空。 */
  function resetLevels() {
    if (level) level.fill(0);
    if (peak) peak.fill(0);
    if (peakVel) peakVel.fill(0);
  }

  return {
    style,
    setPlaying(on) {
      playing = !!on;
      if (playing && !reduced) { hasData = false; start(); }
      else {                                   // 暂停/无数据：停循环并回到静默基线
        stop();
        resetLevels();
        draw();
      }
    },
    levels() { return level ? Array.prototype.slice.call(level) : []; },
    peaks() { return peak ? Array.prototype.slice.call(peak) : []; },
    start, stop,
    resize() { const w = cssW, h = cssH; cssW = 0; resize(); if (w !== cssW || h !== cssH) draw(); },
    destroy() { alive = false; stop(); },
  };
}
