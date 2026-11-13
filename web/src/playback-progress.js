import { coverColors, fmtDur } from './ui.js';
import { api, settings } from './api.js';

const clamp = value => Math.max(0, Math.min(100, Number(value) || 0));

// 迷你条与全屏页共用当前歌曲的请求。切歌后允许重新查询，失败不打断播放。
let currentChorus;
function loadChorus(id) {
  const base = settings.base;
  if (!currentChorus || currentChorus.id !== id || currentChorus.base !== base) {
    const promise = api.songChorus(id).then(data =>
      String(data?.id) === id && Array.isArray(data.segments) ? data.segments : [],
      () => []);
    currentChorus = { id, base, promise };
  }
  return currentChorus.promise;
}

/** 两处播放器共用定位逻辑，原生 range 保留触屏与键盘操作。 */
function createProgress(root, player, full, current, remaining) {
  const ids = full ? ['plSeek', 'plBuf', 'plFill'] : ['miniSeek', 'miniBuf', 'miniProg'];
  root.innerHTML = `
    ${full ? '<div class="pl-seek-halo" aria-hidden="true"></div>' : ''}
    <div class="${full ? 'pl-seek-track' : 'cm-mini-track'}" aria-hidden="true">
      <i id="${ids[1]}"></i><i id="${ids[2]}"></i><div class="cm-chorus-track"></div>
      ${full ? '<div class="pl-chorus-played"></div><div class="pl-seek-shine"></div>' : ''}
    </div>
    ${full ? '' : '<span class="cm-mini-thumb" aria-hidden="true"></span>'}
    <output class="${full ? 'pl-seek-time' : 'cm-mini-time'}" aria-hidden="true"></output>
    <input id="${ids[0]}" type="range" min="0" max="100" step="0.1" value="0" aria-label="播放进度" disabled>
    <span id="${ids[0]}Chorus" hidden></span>`;
  const input = root.querySelector('input'), fill = root.querySelector('#' + ids[2]);
  const buffer = root.querySelector('#' + ids[1]), time = root.querySelector('output');
  const chorusTrack = root.querySelector('.cm-chorus-track');
  const playedChorus = root.querySelector('.pl-chorus-played');
  const chorusDescription = root.querySelector('#' + ids[0] + 'Chorus');
  let dragging = false, active = true, blocked = false, meta = player.meta;
  let chorusId, chorusRequest, segments = [], paintedSegments, paintedDuration, cover;

  const duration = () => {
    const value = player.durMs();
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  function paintChorus(dur) {
    if (segments === paintedSegments && dur === paintedDuration) return;
    paintedSegments = segments;
    paintedDuration = dur;
    chorusTrack.textContent = '';
    if (playedChorus) playedChorus.textContent = '';
    const ranges = [];
    const valid = [];
    for (const segment of segments) {
      const start = segment?.startMs;
      const endMs = segment?.endMs;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endMs) || start < 0) continue;
      const end = Math.min(endMs, dur);
      if (end <= start) continue;
      valid.push([start, end]);
    }
    for (const [start, end] of valid.sort((a, b) => a[0] - b[0])) {
      const previous = ranges[ranges.length - 1];
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else ranges.push([start, end]);
    }
    for (const [start, end] of ranges) {
      const band = document.createElement('span');
      band.style.left = start / dur * 100 + '%';
      band.style.width = (end - start) / dur * 100 + '%';
      if (start === 0) band.classList.add('starts-track');
      if (end === dur) band.classList.add('ends-track');
      chorusTrack.appendChild(band);
      if (playedChorus) playedChorus.appendChild(band.cloneNode());
    }
    const description = ranges.length
      ? '高潮（副歌） ' + ranges.map(([start, end]) => `${fmtDur(start)}–${fmtDur(end)}`).join('、') : '';
    chorusDescription.textContent = description;
    if (description) {
      input.setAttribute('aria-describedby', chorusDescription.id);
      input.title = description;
    } else {
      input.removeAttribute('aria-describedby');
      input.removeAttribute('title');
    }
  }
  function paint(pos, dur) {
    const position = Math.max(0, Math.min(dur, Number(pos) || 0));
    const pct = dur ? position / dur * 100 : 0;
    const value = `${fmtDur(position)} / ${fmtDur(dur)}`;
    root.style.setProperty('--playback-progress', pct + '%');
    fill.style.transform = `scaleX(${pct / 100})`;
    input.value = pct;
    if (input.getAttribute('aria-valuetext') !== value) {
      input.setAttribute('aria-valuetext', value);
      time.textContent = value;
    }
    if (current) current.textContent = fmtDur(position);
    if (remaining) remaining.textContent = '−' + fmtDur(dur - position);
  }
  function update() {
    if (!active) return;
    if (meta !== player.meta) {
      blocked = dragging;
      meta = player.meta;
      dragging = false;
      root.classList.remove('is-dragging');
    }
    const id = String(meta?.ncm_id || '');
    const pic = meta?.pic || '';
    if (full && cover !== pic) {
      cover = pic;
      coverColors(pic, { fallback: false }).then(colors => {
        if (active && cover === pic) root.style.setProperty('--pl-seek-color', colors?.primary || '');
      });
    }
    if (chorusId !== id) {
      chorusId = id;
      segments = [];
      chorusRequest = /^[1-9]\d*$/.test(id) ? loadChorus(id) : null;
      const request = chorusRequest;
      if (request) request.then(result => {
        if (!active || request !== chorusRequest) return;
        segments = result;
        update();
      });
    }
    const dur = duration();
    paintChorus(player.loading ? 0 : dur);
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

export function createPlayerProgress(root, player, current, remaining) {
  return createProgress(root, player, true, current, remaining);
}
