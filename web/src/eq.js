// 均衡器（EQ）：基于 Web Audio BiquadFilter 的五段图示均衡。
//
// 挂载点：player.js 的音频图（src → [EQ 链] → analyser → destination）。
// 图不存在时（CORS 回退 / 可视化被禁用）EQ 不生效——UI 侧要给出提示。
//
// 频点选取：60/230/910/3600/14000 Hz——对数均匀覆盖可听域，
// 与常见"五段 EQ"（低音/中低/中/中高/高音）对齐；每段 ±12dB。
// 预设值参考常见商用播放器的经典曲线（Apple Music「均衡器」的预设量级）。
import { player } from './player.js';

const EQ_KEY = 'cm.eq';
export const EQ_BANDS = [60, 230, 910, 3600, 14000];
export const EQ_LABELS = ['低音', '中低音', '中音', '中高音', '高音'];
export const EQ_GAIN_MAX = 12;

/** 预设：名称 → 五段增益（dB）。'flat' 为平直（全 0，即关闭）。 */
export const EQ_PRESETS = {
  flat:    { label: '关闭',    gains: [0, 0, 0, 0, 0] },
  bass:    { label: '低音增强', gains: [8, 4, 0, 0, 1] },
  vocal:   { label: '人声',    gains: [-2, 0, 4, 4, 1] },
  pop:     { label: '流行',    gains: [3, 1, 0, -1, 2] },
  rock:    { label: '摇滚',    gains: [6, 2, -2, 2, 5] },
  jazz:    { label: '爵士',    gains: [4, 1, 0, 2, 3] },
  classical: { label: '古典',  gains: [4, 2, 0, 2, 4] },
  treble:  { label: '高音增强', gains: [0, 0, 0, 3, 7] },
};

/** 当前 EQ 配置：{ preset: 'flat'|…|'custom', gains: number[5] }。 */
export function eqConfig() {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(EQ_KEY) || 'null'); } catch (e) { /* 忽略 */ }
  if (!cfg || !Array.isArray(cfg.gains) || cfg.gains.length !== 5) {
    return { preset: 'flat', gains: EQ_PRESETS.flat.gains.slice() };
  }
  const clamp = v => Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, +v || 0));
  return { preset: EQ_PRESETS[cfg.preset] ? cfg.preset : 'custom', gains: cfg.gains.map(clamp) };
}

export function setEqConfig(cfg) {
  localStorage.setItem(EQ_KEY, JSON.stringify({
    preset: cfg && cfg.preset || 'custom',
    gains: (cfg && cfg.gains || EQ_PRESETS.flat.gains).slice(0, 5),
  }));
  applyEqGains(currentGains());
  try { document.dispatchEvent(new Event('cm-eq')); } catch (e) { /* 忽略 */ }
}

export function currentGains() { return eqConfig().gains; }

/** EQ 是否处于生效状态（有增益且图在跑）。供 UI 提示用。 */
export function eqActive() {
  const g = currentGains();
  return g.some(v => Math.abs(v) > 0.1) && !!(window.__cmEqNodes && window.__cmEqNodes.length);
}

// ---------- 音频图侧 ----------

let nodes = null;   // BiquadFilter[]（五段串联）

/** 在音频图里插入 EQ 链：返回 {input, output}；重复调用先拆旧。 */
export function buildEqChain(ctx) {
  removeEqChain();
  try {
    nodes = EQ_BANDS.map((hz, i) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = hz;
      f.Q.value = 1.0;                     // Q=1：段与段平滑衔接，不产生共振尖峰
      f.gain.value = currentGains()[i] || 0;
      return f;
    });
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    // 调试/状态探针（eqActive 与验证脚本用；不暴露任何可变对象）
    window.__cmEqNodes = nodes;
    return { input: nodes[0], output: nodes[nodes.length - 1] };
  } catch (e) {
    removeEqChain();
    return null;
  }
}

export function removeEqChain() {
  try {
    if (nodes) nodes.forEach(n => { try { n.disconnect(); } catch (e) { /* 忽略 */ } });
  } catch (e) { /* 忽略 */ }
  nodes = null;
  try { delete window.__cmEqNodes; } catch (e) { /* 忽略 */ }
}

/** 实时改增益（不动图结构，滑块拖动时逐段生效）。 */
export function applyEqGains(gains) {
  if (!nodes) return false;
  try {
    nodes.forEach((f, i) => { f.gain.value = (gains && gains[i]) || 0; });
    return true;
  } catch (e) { return false; }
}

// 播放页开着时，其它入口（设置页）改 EQ 也能即时生效
try {
  document.addEventListener('cm-eq', () => applyEqGains(currentGains()));
} catch (e) { /* 忽略 */ }

// 播放器引用仅用于未来按曲目记忆 EQ；当前保持全局配置
void player;
