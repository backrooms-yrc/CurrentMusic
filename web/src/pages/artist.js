// 歌手作品页：资料 + 热度排序全部歌曲（分页加载）+ 播放全部
import { api } from '../api.js';
import { esc, toast, renderSongList } from '../ui.js';
import { player } from '../player.js';

export async function render(el, params) {
  const id = params[0];
  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
  let d;
  try {
    d = await api.artist(id, 0, 100);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>`;
    return;
  }
  let all = d.songs || [];

  el.innerHTML = `
    <div class="cm-detail-head cm-artist-head">
      <div class="cm-artist-bigava">${d.pic ? `<img src="${esc(d.pic)}?param=300y300">` : '<span class="material-icons-outlined">person</span>'}</div>
      <div>
        <h2>${esc(d.name)}</h2>
        <div class="cm-detail-sub">${esc(d.alias || '')}${d.total ? `${d.alias ? ' · ' : ''}共 ${d.total} 首作品` : ''}</div>
        <div class="cm-detail-actions">
          <mdui-button variant="filled" id="playAll"><span class="material-icons-outlined">play_arrow</span>播放全部</mdui-button>
        </div>
      </div>
    </div>
    <div id="artistList"></div>
    <div class="cm-sq-more" id="artistMoreWrap" hidden>
      <mdui-button variant="tonal" id="artistMore">加载更多</mdui-button>
    </div>`;

  const list = el.querySelector('#artistList');
  await renderSongList(list, all, { onPlay: i => player.playList(all, i) });
  el.querySelector('#playAll').onclick = () => all.length ? player.playList(all, 0) : toast('暂无作品');

  // 分页加载更多
  const moreWrap = el.querySelector('#artistMoreWrap');
  const moreBtn = el.querySelector('#artistMore');
  const updateMore = () => { moreWrap.hidden = !(all.length < d.total); };
  updateMore();
  moreBtn.onclick = async () => {
    moreBtn.loading = true;
    try {
      const nd = await api.artist(id, all.length, 100);
      const fresh = nd.songs || [];
      if (!fresh.length) { moreWrap.hidden = true; return; }
      const base = all.length;
      all = all.concat(fresh);
      const box = document.createElement('div');
      list.appendChild(box);
      await renderSongList(box, fresh, { onPlay: i => player.playList(all, base + i) });
      d.total = nd.total;
      updateMore();
    } catch (e) { toast(e.message); }
    finally { moreBtn.loading = false; }
  };
}
