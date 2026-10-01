// 个性化：自定义背景图 + 玻璃效果值（模糊 / 浓度）。
//
// 设计要点：
//   · 全部存 localStorage，不改后端、不改皮肤代码；
//   · 通过把 CSS 变量写到 <html> 的**内联 style** 上生效——内联优先级高于
//     app.css 里皮肤块的默认值，因此无需 !important，也不污染皮肤变量表；
//   · 未设置时**移除**内联变量，回落到皮肤默认值（默认 UI 零变化）；
//   · 玻璃浓度对亮/暗两种模式同时生效（暗色的默认略低，见 app.css 注释）。
//
// 相关 CSS 变量：
//   --cm-bg-image    背景图（url(...) 字符串），body 上消费
//   --frs-lens-blur  折射透镜模糊（数字，glass.js 读走拼 blur(Npx)）
//   --frs-alpha      玻璃本体不透明度 0~1（frost 的胶囊/底栏/迷你条都用它）


// 播放页波形样式（纯指示，不表达进度）：bars（默认）| wave | capsule
const WAVE_KEY = 'cm.waveStyle';
const WAVE_KEYS = ['bars', 'wave', 'capsule'];

/** 当前波形样式（非法值/未设置 → 默认 bars）。 */
// 频谱倾斜补偿（dB/倍频程）：0 = 关闭（原始频谱，左高右低），4.5 ≈ 标准补偿
const TILT_KEY = 'cm.waveTilt';
export const TILT_DEFAULT = 4.5;

/** 当前倾斜值（未设置 → 默认 4.5）。 */
export function waveTilt() {
  const raw = localStorage.getItem(TILT_KEY);
  if (raw == null || raw === '') return TILT_DEFAULT;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(12, v)) : TILT_DEFAULT;
}

/** 设置倾斜补偿并即时通知播放页重建波形。 */
export function setWaveTilt(v) {
  const n = Math.max(0, Math.min(12, Number(v) || 0));
  localStorage.setItem(TILT_KEY, String(n));
  try { document.dispatchEvent(new Event('cm-wavecfg')); } catch (e) { /* 忽略 */ }
}

export function waveStyle() {
  const v = localStorage.getItem(WAVE_KEY);
  return WAVE_KEYS.indexOf(v) >= 0 ? v : 'bars';
}

/** 设置波形样式并即时通知播放页（若正开着播放页，会立刻换成新样式）。 */
export function setWaveStyle(k) {
  const v = WAVE_KEYS.indexOf(k) >= 0 ? k : 'bars';
  localStorage.setItem(WAVE_KEY, v);
  try { document.dispatchEvent(new Event('cm-wavestyle')); } catch (e) { /* 忽略 */ }
}
const BG_KEY = 'cm.bgImage';
const BLUR_KEY = 'cm.glassBlur';
const TINT_KEY = 'cm.glassTint';

const BLUR_MIN = 0, BLUR_MAX = 12, BLUR_DEF = 4;
const TINT_MIN = 0.2, TINT_MAX = 0.95;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 自定义背景图（URL 或 dataURL；空串表示未设置）。 */
export function bgImage() {
  return localStorage.getItem(BG_KEY) || '';
}

/** 折射透镜模糊值（数字；未设置时为皮肤默认 4）。 */
export function glassBlur() {
  const v = parseFloat(localStorage.getItem(BLUR_KEY));
  return Number.isFinite(v) ? clamp(v, BLUR_MIN, BLUR_MAX) : BLUR_DEF;
}

/** 玻璃浓度 0~1（null 表示未自定义，用皮肤默认：亮 .58 / 暗 .52）。 */
export function glassTint() {
  const raw = localStorage.getItem(TINT_KEY);
  if (raw == null || raw === '') return null;
  const v = parseFloat(raw);
  return Number.isFinite(v) ? clamp(v, TINT_MIN, TINT_MAX) : null;
}

export const glassRange = { BLUR_MIN, BLUR_MAX, BLUR_DEF, TINT_MIN, TINT_MAX };

function setOrRemove(el, prop, value) {
  if (value == null || value === '') el.style.removeProperty(prop);
  else el.style.setProperty(prop, value);
}

/**
 * 把当前个性化设置写到 <html> 上。
 * @param opts.rebuild 为真时派发 cm-uipreset，让折射引擎（glass.js）按新的
 *   模糊值重建透镜。拖动滑杆时不要带 rebuild（每次重建都要重新生成位移图，
 *   会卡），只在对话框关闭 / 点确定时带一次。
 */
export function applyCustomize({ rebuild = false } = {}) {
  const el = document.documentElement;
  const bg = bgImage();
  // url("...") 里可能出现引号/括号，用 CSS 转义包一层，避免拼进 url() 后被截断
  setOrRemove(el, '--cm-bg-image', bg ? `url("${bg.replace(/["\\]/g, '\\$&')}")` : null);
  setOrRemove(el, '--frs-lens-blur', String(glassBlur()));
  const t = glassTint();
  setOrRemove(el, '--frs-alpha', t == null ? null : String(t));
  if (rebuild) {
    try { document.dispatchEvent(new Event('cm-uipreset')); } catch (e) { /* 忽略 */ }
  }
}

export function setBgImage(v) {
  if (v) localStorage.setItem(BG_KEY, v);
  else localStorage.removeItem(BG_KEY);
  applyCustomize();
}

export function setGlass({ blur, tint }) {
  if (blur != null) localStorage.setItem(BLUR_KEY, String(clamp(blur, BLUR_MIN, BLUR_MAX)));
  if (tint != null) localStorage.setItem(TINT_KEY, String(clamp(tint, TINT_MIN, TINT_MAX)));
  applyCustomize();
}

export function resetGlass() {
  localStorage.removeItem(BLUR_KEY);
  localStorage.removeItem(TINT_KEY);
  applyCustomize({ rebuild: true });
}
