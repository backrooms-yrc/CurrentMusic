// UI 预设（皮肤）：默认保持原样，可在「设置 → 外观」切换。
//
// 实现方式：把皮肤做成**纯 CSS 作用域切换** —— 在 <html> 上打 data-ui-preset 属性，
// 皮肤样式全部写在 html[data-ui-preset="..."] 之下。
// 默认（无该属性）时不匹配任何皮肤规则，原 UI 一行都不受影响，
// 因此新增皮肤零风险、可随时加更多套。
const KEY = 'cm.uiPreset';
export const DEFAULT_PRESET = 'md3';

export const UI_PRESETS = [
  { key: 'md3', name: '默认', desc: 'Material 3 · 当前样式', swatch: 'md3' },
  { key: 'frost', name: '简约玻璃', desc: '玻璃只在浮层 · 卡片磨砂白 + 发丝线 · 零投影', swatch: 'frost' },
  { key: 'glass', name: '液体玻璃', desc: '半透明玻璃 · 大圆角 · 柔和光影', swatch: 'glass' },
];

const KEYS = UI_PRESETS.map(p => p.key);

/** 当前预设 key（非法值一律回落到默认）。 */
export function uiPresetKey() {
  const k = localStorage.getItem(KEY);
  return KEYS.includes(k) ? k : DEFAULT_PRESET;
}

/** 当前预设名（设置页展示用）。 */
export function uiPresetName() {
  return (UI_PRESETS.find(p => p.key === uiPresetKey()) || UI_PRESETS[0]).name;
}

/** 只把属性写到 <html>；皮肤是否生效完全由 CSS 决定。 */
export function applyUiPreset(key) {
  const el = document.documentElement;
  if (key && key !== DEFAULT_PRESET && KEYS.includes(key)) el.setAttribute('data-ui-preset', key);
  else el.removeAttribute('data-ui-preset');
}

export function setUiPreset(key) {
  localStorage.setItem(KEY, KEYS.includes(key) ? key : DEFAULT_PRESET);
  applyUiPreset(key);
  // 通知折射引擎重建（皮肤切换后玻璃元素才存在/尺寸才确定）
  try { document.dispatchEvent(new Event('cm-uipreset')); } catch (e) { /* 忽略 */ }
}

/** 启动时套用（main.js 很早就调用；index.html 里另有一段内联脚本防闪白）。 */
export function bootUiPreset() {
  applyUiPreset(uiPresetKey());
}
