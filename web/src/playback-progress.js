import { fmtDur } from './ui.js';

const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

/** 两处播放器共用定位逻辑，原生 range 保留触屏与键盘操作。 */
function createProgress(root, player, full, current, total) {
  const ids = full ? ['plSeek', 'plBuf', 'plFill'] : ['miniSeek', 'miniBuf', 'miniProg'];
  root.innerHTML = `
    <div class="${full ? 'pl-seek-track' : 'cm-mini-track'}" aria-hidden="true"><i id="${ids[1]}"></i><i id="${ids[2]}"></i></div>
    <span class="${full ? 'pl-seek-thumb' : 'cm-mini-thumb'}" aria-hidden="true"></span>
    <output class="${full ? 'pl-seek-time' : 'cm-mini-time'}" aria-hidden="true"></output>
    <input id="${ids[0]}" type="range" min="0" max="100" step="0.1" value="0" aria-label="播放进度" disabled>`;
  const input = root.querySelector('input'), fill = root.querySelector('#' + ids[2]);
  const buffer = root.querySelector('#' + ids[1]), time = root.querySelector('output');
  let dragging = false, active = true, blocked = false, meta = player.meta;

  const duration = () => {
    const value = player.durMs();
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  function paint(pos, dur) {
    const pct = dur ? clamp(pos / dur * 100) : 0;
    const value = `${fmtDur(dur * pct / 100)} / ${fmtDur(dur)}`;
    root.style.setProperty('--playback-progress', pct + '%');
    fill.style.transform = `scaleX(${pct / 100})`;
    input.value = pct;
    if (input.getAttribute('aria-valuetext') !== value) {
      input.setAttribute('aria-valuetext', value);
      time.textContent = value;
    }
    if (current) current.textContent = fmtDur(dur * pct / 100);
    if (total) total.textContent = fmtDur(dur);
  }
  function update() {
    if (!active) return;
    if (meta !== player.meta) {
      blocked = dragging;
      meta = player.meta;
      dragging = false;
      root.classList.remove('is-dragging');
    }
    const dur = duration();
    input.disabled = !dur || !player.urlInfo || player.loading;
    root.classList.toggle('is-disabled', input.disabled);
    if (input.disabled) { dragging = false; root.classList.remove('is-dragging'); }
    if (!dragging) paint(player.posMs(), dur);
    buffer.style.transform = `scaleX(${clamp(player.bufferPct()) / 100})`;
  }
  function begin(event) {
    if (!active || input.disabled || (event.type === 'pointerdown' && event.button !== 0)) return;
    blocked = false;
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
    if (!active || input.disabled) return;
    if (blocked) { update(); return; }
    dragging = true;
    root.classList.add('is-dragging');
    paint(clamp(input.value) / 100 * duration(), duration());
  });
  input.addEventListener('change', () => {
    if (!active || !dragging || input.disabled || !root.isConnected || meta !== player.meta) { cancel(); return; }
    player.seek(clamp(input.value) / 100 * duration() / 1000);
    cancel();
  });
  input.addEventListener('keydown', () => { blocked = false; });
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
  return { update, destroy() { active = false; dragging = false; input.disabled = true; root.classList.remove('is-dragging'); } };
}

export function createMiniProgress(root, player) {
  return createProgress(root, player, false);
}

export function createPlayerProgress(root, player, current, total) {
  return createProgress(root, player, true, current, total);
}
