// 歌曲页（v1.28.46）：分享链接的落地页。
// 打开分享链接后展示歌曲信息并可播放/再次分享；不自动播放（浏览器会拦截自动播放）。
import { api, ncmSongs } from '../api.js';
import { esc, toast } from '../ui.js';
import { player } from '../player.js';
import { openShare } from '../share.js';

export async function render(el, params) {
  const id = parseInt((params && params[0]) || 0, 10);
  el.innerHTML = `<div class="cm-page"><div class="cm-loading" style="padding:64px 0">
    <mdui-circular-progress></mdui-circular-progress></div></div>`;
  let s = null;
  try {
    const d = await api.songDetail([id]);
    s = (ncmSongs(d.songs || []) || [])[0] || null;
  } catch (e) { /* 下面统一显示错误态 */ }
  if (!s) {
    el.innerHTML = `<div class="cm-page"><div class="cm-empty" style="padding:64px 0">
      歌曲不存在或暂时无法加载</div></div>`;
    return;
  }
  el.innerHTML = `
    <div class="cm-page cm-songpage">
      <div class="cm-songpage-cover">${s.pic
        ? `<img src="${esc(s.pic)}?param=600y600" alt="">`
        : '<span class="material-icons-outlined">music_note</span>'}</div>
      <h2>${esc(s.name)}</h2>
      <div class="cm-songpage-sub">${esc(s.artists || '')}${s.album ? ' · ' + esc(s.album) : ''}</div>
      <div class="cm-songpage-acts">
        <mdui-button variant="filled" id="spPlay">播放这首歌</mdui-button>
        <mdui-button variant="tonal" id="spShare">分享</mdui-button>
      </div>
      <div class="cm-songpage-tip">来自 CurrentMusic 的歌曲分享</div>
    </div>`;

  el.querySelector('#spPlay').onclick = () => {
    player.playList([s], 0);
    toast('开始播放：' + s.name);
  };
  el.querySelector('#spShare').onclick = () => openShare(s);
}
