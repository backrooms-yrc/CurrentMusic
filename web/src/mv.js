// MV 播放浮层：歌曲条右侧的「播放 MV」按钮 → 全屏播放对应 MV。
//
// 为什么走事件而不是直接 import：ui.js 负责渲染歌曲条，而 player.js 已经 import 了
// ui.js；若 ui.js 再 import 本模块（本模块需要 player 来暂停音乐）就会形成循环依赖。
// 所以 ui.js 只派发 `cm-playmv`，本模块监听并处理。
import { api, auth } from './api.js';
import { esc, toast } from './ui.js';
import { player } from './player.js';

let overlay = null;
let video = null;
let resumeAfter = false;      // 打开 MV 前音乐是否在播（关闭后恢复）
let lastFocus = null;

function ensureOverlay() {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'cm-mv-overlay';
  overlay.innerHTML = `
    <div class="cm-mv-box" role="dialog" aria-modal="true" aria-label="MV 播放">
      <div class="cm-mv-head">
        <div class="cm-mv-title" id="cmMvTitle">MV</div>
        <span class="cm-mv-close" id="cmMvClose" title="关闭"><span class="material-icons-outlined">close</span></span>
      </div>
      <video class="cm-mv-video" id="cmMvVideo" controls playsinline preload="metadata"></video>
      <div class="cm-mv-tip" id="cmMvTip">正在解析 MV 地址…</div>
    </div>`;
  document.body.appendChild(overlay);
  video = overlay.querySelector('#cmMvVideo');
  overlay.querySelector('#cmMvClose').onclick = closeMv;
  overlay.onclick = e => { if (e.target === overlay) closeMv(); };
  return overlay;
}

function onKey(e) {
  if (e.key === 'Escape') closeMv();
}

export function closeMv() {
  if (!overlay) return;
  document.removeEventListener('keydown', onKey);
  try { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } } catch (e) { /* 忽略 */ }
  overlay.remove();
  overlay = null; video = null;
  if (resumeAfter) { resumeAfter = false; try { player.play && player.play(); } catch (e) { /* 忽略 */ } }
  if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* 忽略 */ } }
  lastFocus = null;
}

/** 打开某首歌的 MV；无 MV / 解析失败都给出明确提示。 */
export async function openMv(song) {
  if (!song) return;
  const mvId = song.mv || 0;
  if (!mvId) { toast('这首歌没有 MV'); return; }
  const ov = ensureOverlay();
  const title = `${song.name || ''}${song.artists ? ' · ' + song.artists : ''}`;
  ov.querySelector('#cmMvTitle').textContent = title || 'MV';
  const tip = ov.querySelector('#cmMvTip');
  tip.textContent = '正在解析 MV 地址…';
  tip.hidden = false;
  // 播放 MV 时先暂停音乐，避免两路声音叠在一起；关闭后恢复原来的播放状态
  resumeAfter = !!(player && player.isPlaying && player.isPlaying());
  if (resumeAfter) { try { player.pause(); } catch (e) { /* 忽略 */ } }
  lastFocus = document.activeElement;
  document.addEventListener('keydown', onKey);
  try {
    // r=1080 请求最高档；上游若没有该档会**降级返回**，响应里的 r 是实际档位
    const d = await api.ncm('/mv/url', { id: mvId, r: 1080 });
    const it = (d && d.data) || {};
    const url = it.url || '';
    if (!url) throw new Error('未取得 MV 地址（可能受版权或地区限制）');
    video.src = url;
    tip.hidden = true;
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* 自动播放被拦时由用户点播放键 */ });
  } catch (e) {
    tip.textContent = `MV 加载失败：${(e && e.message) || '未知错误'}`;
    tip.hidden = false;
  }
}

/** 绑定全局监听（由 main.js 调用一次）。 */
export function initMv() {
  document.addEventListener('cm-playmv', e => { openMv(e.detail).catch(() => {}); });
}
