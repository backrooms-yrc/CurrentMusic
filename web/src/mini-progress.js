import { fmtDur } from './ui.js';

const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

/** 原生滑块保留触屏和键盘操作；拖动只预览，松手后再向本机/投屏播放器定位。 */
export function createMiniProgress(root, player) {
  root.innerHTML = `
    <div class="cm-mini-track" aria-hidden="true"><i id="miniBuf"></i><i id="miniProg"></i></div>
    <span class="cm-mini-thumb" aria-hidden="true"></span>
    <output class="cm-mini-time" aria-hidden="true"></output>
    <input id="miniSeek" type="range" min="0" max="100" step="0.1" value="0" aria-label="播放进度" disabled>`;
  const input = root.querySelector('input'), fill = root.querySelector('#miniProg');
  const buffer = root.querySelector('#miniBuf'), time = root.querySelector('output');
  let dragging = false;

  const duration = () => {
    const value = player.durMs();
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  function paint(pos, dur) {
    const pct = dur ? clamp(pos / dur * 100) : 0;
    const value = `${fmtDur(dur * pct / 100)} / ${fmtDur(dur)}`;
    root.style.setProperty('--mini-progress', pct + '%');
    fill.style.transform = `scaleX(${pct / 100})`;
    input.value = pct;
    if (input.getAttribute('aria-valuetext') !== value) {
      input.setAttribute('aria-valuetext', value);
      time.textContent = value;
    }
  }
  function update() {
    const dur = duration();
    input.disabled = !dur || !player.urlInfo || player.loading;
    root.classList.toggle('is-disabled', input.disabled);
    if (input.disabled) { dragging = false; root.classList.remove('is-dragging'); }
    if (!dragging) paint(player.posMs(), dur);
    buffer.style.transform = `scaleX(${clamp(player.bufferPct()) / 100})`;
  }
  function begin(event) {
    if (input.disabled || (event.type === 'pointerdown' && event.button !== 0)) return;
    dragging = true;
    root.classList.add('is-dragging');
  }
  function cancel() {
    dragging = false;
    root.classList.remove('is-dragging');
    update();
  }
  input.addEventListener('pointerdown', begin);
  // 旧版 Safari 没有 Pointer Events，仍使用原生 range 的触屏操作。
  if (!window.PointerEvent) {
    input.addEventListener('touchstart', begin, { passive: true });
    input.addEventListener('mousedown', begin);
  }
  input.addEventListener('input', () => {
    if (input.disabled) return;
    dragging = true;
    root.classList.add('is-dragging');
    paint(clamp(input.value) / 100 * duration(), duration());
  });
  input.addEventListener('change', () => {
    if (!dragging || input.disabled || !root.isConnected) return;
    player.seek(clamp(input.value) / 100 * duration() / 1000);
    cancel();
  });
  const finish = () => {
    // 点击当前位置不会触发 change；延后到原生 change 之后清除拖动状态。
    setTimeout(() => { if (dragging) cancel(); }, 0);
  };
  input.addEventListener('pointerup', finish);
  input.addEventListener('touchend', finish);
  if (!window.PointerEvent) input.addEventListener('mouseup', finish);
  input.addEventListener('pointercancel', cancel);
  input.addEventListener('touchcancel', cancel);
  input.addEventListener('blur', cancel);
  input.addEventListener('click', event => event.stopPropagation());
  update();
  return { update };
}
