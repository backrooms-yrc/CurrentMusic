import { mdui } from './md.js';
import { blobToBase64, shrinkImage } from './api.js';
import { coverColors, toast } from './ui.js';

const MODE_KEY = 'cm.playerBgMode';
const IMAGE_KEY = 'cm.playerBgImage';
const BLUR_KEY = 'cm.playerBgBlur';
const SPEED_KEY = 'cm.bgSpeed';
const MODES = [
  ['flow', '流动背景'],
  ['frosted', '封面毛玻璃'],
  ['custom', '自定义图片'],
];
const SPEED_MIN = 0.5, SPEED_MAX = 2;
const savedSpeed = Number(localStorage.getItem(SPEED_KEY));
let speed = savedSpeed >= SPEED_MIN && savedSpeed <= SPEED_MAX ? savedSpeed : 1;
let blur = Math.max(0, Math.min(100, Number(localStorage.getItem(BLUR_KEY) ?? 35) || 0));
let image = localStorage.getItem(IMAGE_KEY) || '';
const savedMode = localStorage.getItem(MODE_KEY);
let mode = savedMode === 'custom' && image ? 'custom'
  : savedMode === 'frosted' || (!savedMode && localStorage.getItem('cm.bgGrad') === '0') ? 'frosted' : 'flow';
let preview;
const requestedCover = new WeakMap();

export const backgroundLabel = () => MODES.find(([key]) => key === mode)[1];

function renderBackground(el, cover) {
  if (!el) return;
  el.classList.toggle('grad', mode === 'flow');
  el.dataset.background = mode;
  el.style.setProperty('--pl-bg-blur', `${blur * 0.65}px`);
  if (mode !== 'flow') {
    const src = mode === 'custom' ? image : cover;
    el.style.setProperty('--pl-cover-image', src ? `url(${JSON.stringify(src)})` : 'none');
    requestedCover.delete(el);
    return;
  }
  el.style.setProperty('--pl-bg-speed', String(speed));
  if (requestedCover.get(el) === cover) return;
  requestedCover.set(el, cover);
  coverColors(cover, { fallback: false }).then(colors => {
    if (!el.isConnected || requestedCover.get(el) !== cover) return;
    el.style.setProperty('--pl-bg-base', colors?.dark || '');
    el.style.setProperty('--pl-bg-main', colors?.primary || '');
    el.style.setProperty('--pl-bg-accent', colors?.accent || '');
  });
}

export function applyPlayerBackground(cover) {
  renderBackground(document.getElementById('plBg'), cover);
  renderBackground(preview, cover);
}

let bins, previousBeat = 0;
export function updateBackgroundMotion(wave, playing) {
  const el = document.getElementById('plBg');
  if (!el || mode !== 'flow') return;
  let energy = 0;
  if (playing && wave.ready) {
    if (bins?.length !== wave.bins) bins = new Uint8Array(wave.bins);
    if (wave.read(bins)) {
      const upper = Math.min(bins.length, Math.max(2, Math.round(240 * bins.length * 2 / wave.sampleRate)));
      for (let i = 1; i < upper; i++) energy += bins[i];
      energy /= (upper - 1) * 255;
    }
  }
  const beat = Math.round(energy * 15);
  if (beat !== previousBeat || !el.style.getPropertyValue('--pl-bg-pulse')) {
    previousBeat = beat;
    const scale = String(1 + beat / 250);
    el.style.setProperty('--pl-bg-pulse', scale);
    preview?.style.setProperty('--pl-bg-pulse', scale);
  }
}

function changeSpeed(value) {
  const previous = speed;
  speed = value;
  localStorage.setItem(SPEED_KEY, String(speed));
  for (const el of [document.getElementById('plBg'), preview]) {
    if (!el) continue;
    // 保留色团的动画相位，调速时从当前位置继续。
    const drifts = (el.getAnimations?.({ subtree: true }) || []).filter(a => a.animationName === 'plAmbientDrift');
    const times = drifts.map(a => a.currentTime);
    el.style.setProperty('--pl-bg-speed', String(speed));
    drifts.forEach((animation, i) => {
      if (typeof times[i] === 'number') animation.currentTime = times[i] * previous / speed;
    });
  }
}

async function readBackground(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('请选择 20 MB 以内的图片');
  const blob = await shrinkImage(file, 1600, 0.82);
  return 'data:image/jpeg;base64,' + await blobToBase64(blob);
}

export function openPlayerBackground(getCover) {
  const diag = mdui.dialog({
    headline: '播放背景',
    body: `<div class="cm-player-bg-settings">
      <div class="cm-player-bg-preview pl-background" aria-hidden="true"><div class="pl-ambient"></div></div>
      <div class="cm-more-chips" role="group" aria-label="背景方案">
        ${MODES.map(([key, label]) => `<button type="button" data-mode="${key}" aria-pressed="false">${label}</button>`).join('')}
      </div>
      <div class="cm-more-chips" id="plBgImageActions">
        <input type="file" id="plBgFile" accept="image/*" hidden>
        <button type="button" id="plBgPick">更换图片</button>
        <button type="button" id="plBgClear">移除图片</button>
        <span class="cm-more-s">图片仅保存在此浏览器</span>
      </div>
      <div class="cm-more-field cm-bg-speed" id="plBgSpeedField">
        <label class="cm-more-t" for="mBgSpeed">背景速度</label>
        <output for="mBgSpeed" id="mBgSpeedValue"></output>
        <input type="range" id="mBgSpeed" min="${SPEED_MIN}" max="${SPEED_MAX}" step="0.1" value="${speed}">
      </div>
      <div class="cm-more-field cm-bg-speed" id="plBgBlurField">
        <label class="cm-more-t" for="mBgBlur">模糊度</label>
        <output for="mBgBlur"></output>
        <input type="range" id="mBgBlur" min="0" max="100" step="1" value="${blur}">
      </div>
    </div>`,
    actions: [{ text: '完成' }],
  });
  setTimeout(() => {
    if (!diag.open) return;
    const surface = diag.querySelector('.cm-player-bg-preview');
    preview = surface;
    const buttons = [...diag.querySelectorAll('[data-mode]')];
    const speedField = diag.querySelector('#plBgSpeedField'), speedInput = speedField.querySelector('input');
    const blurField = diag.querySelector('#plBgBlurField'), blurInput = blurField.querySelector('input');
    const fileInput = diag.querySelector('#plBgFile');
    const imageActions = diag.querySelector('#plBgImageActions');
    const choose = diag.querySelector('#plBgPick'), clear = diag.querySelector('#plBgClear');
    function refresh() {
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
      speedField.hidden = mode !== 'flow';
      blurField.hidden = mode === 'flow';
      imageActions.hidden = mode !== 'custom';
      speedField.querySelector('output').textContent = `${speed.toFixed(1)}×`;
      speedInput.setAttribute('aria-valuetext', `${speed.toFixed(1)} 倍`);
      blurField.querySelector('output').textContent = `${blur}%`;
      applyPlayerBackground(getCover());
    }
    function setMode(value) {
      localStorage.setItem(MODE_KEY, value);
      mode = value;
      refresh();
    }
    for (const button of buttons) {
      button.onclick = () => {
        if (button.dataset.mode === 'custom' && !image) fileInput.click();
        else setMode(button.dataset.mode);
      };
    }
    choose.onclick = () => fileInput.click();
    clear.onclick = () => {
      setMode('flow');
      localStorage.removeItem(IMAGE_KEY);
      image = '';
    };
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';
      buttons.forEach(button => { button.disabled = true; });
      choose.disabled = clear.disabled = true;
      try {
        const data = await readBackground(file);
        if (!diag.open) return;
        localStorage.setItem(IMAGE_KEY, data);
        image = data;
        setMode('custom');
      } catch (error) {
        if (diag.open) toast(error.name === 'QuotaExceededError' ? '本地存储空间不足，无法保存背景' : error.message);
      } finally {
        buttons.forEach(button => { button.disabled = false; });
        choose.disabled = clear.disabled = false;
      }
    };
    speedInput.oninput = () => { changeSpeed(speedInput.valueAsNumber); refresh(); };
    blurInput.oninput = () => {
      blur = blurInput.valueAsNumber;
      localStorage.setItem(BLUR_KEY, String(blur));
      refresh();
    };
    diag.addEventListener('closed', () => { if (preview === surface) preview = null; }, { once: true });
    refresh();
  }, 0);
}
