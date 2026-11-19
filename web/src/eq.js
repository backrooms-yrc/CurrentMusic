// 均衡器（EQ）：基于 Web Audio BiquadFilter 的十段图示均衡。
//
// 挂载点：player.js 的音频图（src → [EQ 链] → analyser → destination）。
// 图不存在时（CORS 回退 / 可视化被禁用）EQ 不生效——UI 侧要给出提示。
//
const EQ_KEY = 'cm.eq';
const LEGACY_BANDS = [60, 230, 910, 3600, 14000];
export const EQ_BANDS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_GAIN_MAX = 12;

/** 十段增益（dB）。'flat' 为平直。 */
export const EQ_PRESETS = {
  flat:      { label: '关闭',    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass:      { label: '低音增强', gains: [6, 7, 5, 3, 1, 0, 0, 0, 0, 0] },
  vocal:     { label: '人声',    gains: [-3, -2, -1, 0, 2, 3, 4, 3, 2, 0] },
  pop:       { label: '流行',    gains: [2, 3, 2, 1, 0, 0, -1, -1, 1, 2] },
  rock:      { label: '摇滚',    gains: [3, 5, 4, 2, -1, -2, 0, 3, 4, 4] },
  jazz:      { label: '爵士',    gains: [2, 3, 2, 1, 0, 0, 1, 2, 3, 2] },
  classical: { label: '古典',    gains: [3, 3, 3, 2, 1, 0, 1, 2, 3, 3] },
  treble:    { label: '高音增强', gains: [0, 0, 0, 0, 0, 1, 2, 3, 5, 6] },
};

const clampGain = value => Math.max(-EQ_GAIN_MAX, Math.min(EQ_GAIN_MAX, Number(value) || 0));

function displayLegacyCurve(gains) {
  return EQ_BANDS.map(frequency => {
    const high = LEGACY_BANDS.findIndex(band => band >= frequency);
    if (high === 0) return gains[0];
    if (high < 0) return gains[gains.length - 1];
    const low = LEGACY_BANDS[high - 1];
    const ratio = Math.log(frequency / low) / Math.log(LEGACY_BANDS[high] / low);
    return Math.round(gains[high - 1] + (gains[high] - gains[high - 1]) * ratio);
  });
}

export function eqConfig() {
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(EQ_KEY) || 'null'); } catch (e) { /* 忽略 */ }
  if (!cfg || !Array.isArray(cfg.gains) || ![LEGACY_BANDS.length, EQ_BANDS.length].includes(cfg.gains.length)) {
    return { preset: 'flat', gains: EQ_PRESETS.flat.gains.slice() };
  }
  const preset = Object.prototype.hasOwnProperty.call(EQ_PRESETS, cfg.preset) ? cfg.preset : 'custom';
  const gains = cfg.gains.map(clampGain);
  if (gains.length === LEGACY_BANDS.length) {
    return { preset, gains: displayLegacyCurve(gains), legacyGains: gains };
  }
  return { preset, gains };
}

export function setEqConfig(cfg) {
  localStorage.setItem(EQ_KEY, JSON.stringify({
    preset: cfg?.preset || 'custom',
    gains: EQ_BANDS.map((_, i) => clampGain(cfg?.gains?.[i])),
  }));
  applyEqConfig();
  try { document.dispatchEvent(new Event('cm-eq')); } catch (e) { /* 忽略 */ }
}

/** EQ 是否处于生效状态（有增益且图在跑）。供 UI 提示用。 */
export function eqActive() {
  return !!nodes?.some(node => Math.abs(node.gain.value) > 0.1);
}

// ---------- 音频图侧 ----------

let nodes = null;
let nyquist = 0;

/** 在音频图里插入 EQ 链：返回 {input, output}；重复调用先拆旧。 */
export function buildEqChain(ctx) {
  removeEqChain();
  try {
    nyquist = ctx.sampleRate / 2;
    nodes = EQ_BANDS.map(() => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      return f;
    });
    applyEqConfig();
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

function applyEqConfig() {
  if (!nodes) return;
  const { gains, legacyGains } = eqConfig();
  const frequencies = legacyGains ? LEGACY_BANDS : EQ_BANDS;
  nodes.forEach((filter, i) => {
    const frequency = frequencies[i];
    filter.frequency.value = Math.min(frequency || EQ_BANDS[i], nyquist);
    filter.Q.value = legacyGains ? 1 : 1.4;
    filter.gain.value = frequency && (legacyGains || frequency < nyquist) ? (legacyGains || gains)[i] : 0;
  });
}
