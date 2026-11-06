// MV 详情页和歌曲行浮层共用播放器，歌曲行通过事件传入数据。
import { api } from './api.js';
import { esc, toast } from './ui.js';
import { on, player } from './player.js';
import './mv.css';

let modal = null;
let activeVideo = null;

export function mountMvPlayer(stage, { id, title, cover, autoplay = false }) {
  stage.innerHTML = `
    <video class="cm-mv-video" aria-label="${esc(title)}" playsinline preload="metadata"${cover ? ` poster="${esc(cover)}"` : ''}></video>
    <span class="cm-mv-quality" hidden></span>
    <button type="button" class="cm-mv-start" aria-label="播放 MV" hidden><span class="material-icons-outlined" aria-hidden="true">play_arrow</span></button>
    <div class="cm-mv-feedback">
      <div class="cm-mv-status" role="status"><span class="cm-play-spinner" aria-hidden="true"></span><span></span></div>
      <button type="button" class="cm-mv-retry" hidden>重新加载</button>
      <a class="cm-mv-login" href="#/user" hidden>去登录</a>
    </div>`;
  const video = stage.querySelector('video');
  const quality = stage.querySelector('.cm-mv-quality');
  const start = stage.querySelector('.cm-mv-start');
  const status = stage.querySelector('.cm-mv-status');
  const retry = stage.querySelector('.cm-mv-retry');
  const login = stage.querySelector('.cm-mv-login');
  const spinner = status.firstElementChild;
  const message = status.lastElementChild;
  let disposed = false;
  const active = () => !disposed && stage.isConnected;

  function paint(text, action = '') {
    message.textContent = text;
    spinner.hidden = !text || !!action;
    status.hidden = !text;
    retry.hidden = action !== 'retry';
    login.hidden = action !== 'login';
    start.hidden = !!text || !video.paused;
  }

  function unload() {
    if (activeVideo === video) activeVideo = null;
    video.pause();
    video.controls = false;
    video.removeAttribute('src');
    video.load();
    quality.hidden = true;
  }

  async function play() {
    try { await video.play(); }
    catch {
      // 系统禁止自动播放时，保留原生控件和居中的播放按钮。
      if (active() && video.paused && !video.error && video.hasAttribute('src')) paint('');
    }
  }

  async function load(shouldPlay) {
    if (video.hasAttribute('src')) unload();
    paint('正在获取播放地址…');
    try {
      // 上游可降级返回，清晰度以响应中的 r 为准。
      const { data } = await api.ncm('/mv/url', { id, r: 1080 });
      if (!active()) return;
      if (!data?.url) throw new Error('暂无播放地址，可能受版权或地区限制');
      video.src = data.url;
      video.controls = true;
      const resolution = Number(data.r);
      if (Number.isFinite(resolution) && resolution > 0) {
        quality.textContent = `${resolution}p`;
        quality.setAttribute('aria-label', `清晰度 ${resolution}p`);
        quality.hidden = false;
      }
      paint(shouldPlay ? '正在载入视频…' : '');
      if (shouldPlay) void play();
    } catch (error) {
      if (!active()) return;
      if (error.status === 401) paint('登录 CurrentMusic 后即可观看', 'login');
      else paint(error.message || '播放地址获取失败', 'retry');
    }
  }

  start.onclick = () => { video.focus(); void play(); };
  retry.onclick = () => { void load(true); };
  video.onplay = () => {
    if (!active() || video.paused) return;
    if (activeVideo && activeVideo !== video) activeVideo.pause();
    if (player.isPlaying() || player.playPending) player.pause();
    activeVideo = video;
    paint(video.readyState < 3 ? '正在缓冲…' : '');
  };
  video.onwaiting = () => { if (active() && !video.paused) paint('正在缓冲…'); };
  video.onplaying = () => { if (active()) paint(''); };
  video.onpause = () => {
    if (activeVideo === video && video.paused) activeVideo = null;
    if (active() && video.paused && !video.error && video.hasAttribute('src')) paint('');
  };
  video.onerror = () => {
    if (!active() || !video.hasAttribute('src')) return;
    unload();
    paint('视频播放失败，请重新加载', 'retry');
  };
  void load(autoplay);
  return () => { disposed = true; unload(); };
}

function keepFocus(event) {
  if (!modal.overlay.contains(event.target)) modal.close.focus();
}

function onKey(event) {
  if (event.key === 'Escape' && !document.fullscreenElement) {
    event.preventDefault();
    closeMv();
  }
}

export function closeMv() {
  if (!modal) return false;
  const { overlay, dispose, lastFocus, resume, song } = modal;
  modal = null;
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('focusin', keepFocus);
  window.removeEventListener('hashchange', closeMv);
  dispose();
  overlay.remove();
  if (resume && player.meta === song && !player.isPlaying()) player.play();
  if (lastFocus?.isConnected) lastFocus.focus();
  return true;
}

export function openMv(song) {
  if (!song?.mv) { toast('这首歌没有 MV'); return; }
  if (!modal) {
    const overlay = document.createElement('div');
    overlay.className = 'cm-mv-overlay';
    overlay.innerHTML = `
      <section class="cm-mv-box" role="dialog" aria-modal="true" aria-labelledby="cmMvTitle">
        <header class="cm-mv-bar">
          <span class="cm-mv-mark" aria-hidden="true">MV</span>
          <div class="cm-mv-caption"><h2 id="cmMvTitle"></h2><p></p></div>
          <button type="button" class="cm-mv-close" aria-label="关闭 MV"><span class="material-icons-outlined" aria-hidden="true">close</span></button>
        </header>
        <div class="cm-mv-stage"></div>
      </section>`;
    const close = overlay.querySelector('.cm-mv-close');
    const resume = player.isPlaying() || player.playPending;
    modal = { overlay, close, lastFocus: document.activeElement, resume, song: player.meta };
    if (resume) player.pause();
    document.body.appendChild(overlay);
    close.onclick = closeMv;
    overlay.onclick = event => { if (event.target === overlay) closeMv(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', keepFocus);
    window.addEventListener('hashchange', closeMv);
  } else {
    modal.dispose();
  }
  const title = song.name || 'MV 播放';
  modal.overlay.querySelector('h2').textContent = title;
  const artist = modal.overlay.querySelector('p');
  artist.textContent = song.artists || '';
  artist.hidden = !song.artists;
  modal.dispose = mountMvPlayer(modal.overlay.querySelector('.cm-mv-stage'), {
    id: song.mv, title, cover: song.pic, autoplay: true,
  });
  modal.close.focus();
}

export function initMv() {
  document.addEventListener('cm-playmv', event => openMv(event.detail));
  on('state', () => {
    if (activeVideo && !activeVideo.paused && (player.isPlaying() || player.playPending)) activeVideo.pause();
  });
}
