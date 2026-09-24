// 列表详情页：自己的歌单 / likes / favs / 每日推荐 / NCM 排行榜（#/ncmpl/:pid）
import { api, auth } from '../api.js';
import { esc, renderSongList, toast, confirmDialog, skelList } from '../ui.js';
import { player } from '../player.js';
import { addToPlaylist } from '../player-ui.js';

export async function render(el, params) {
  const kind = params[0]; // pl | ncmpl | special
  const id = params[1];

  el.innerHTML = skelList(8);
  let title = '', desc = '', songs = [], removable = false, owner = false, cover = '', badge = '';

  try {
    if (kind === 'pl' && id === 'likes') {
      if (!auth.token) throw new Error('请先登录');
      const d = await api.likedSongs();
      songs = d.songs || [];
      title = '我喜欢的音乐';
      desc = `共 ${songs.length} 首`;
      removable = true;
    } else if (kind === 'pl') {
      const p = await api.playlist(id);
      const isNcm = p.source === 'ncm';
      title = p.name;
      badge = isNcm ? '<span class="cm-ncmbadge">网易云</span>' : '';
      desc = (p.description ? p.description + ' · ' : '') + `共 ${p.tracks.length} 首`;
      songs = p.tracks || [];
      cover = p.cover || '';
      owner = !isNcm && p.user_id === (auth.user && auth.user.id);
      removable = owner;
    } else if (kind === 'daily') {
      const d = await api.daily();
      songs = d.daily || [];
      title = '每日推荐'; desc = `今天为你准备了 ${songs.length} 首`;
    } else if (kind === 'ncmpl') {
      const p = await api.ncmPlaylist(id);
      title = p.name || '排行榜'; desc = `网易云 · 共 ${p.trackCount || (p.songs || []).length} 首`;
      songs = p.songs || [];
    } else {
      throw new Error('未知列表');
    }
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>`;
    return;
  }

  // 排序：网易云导入歌单默认倒序，其余默认正序；四种方式会话内记忆
  const SORTS = [
    { key: 'asc', label: '正序' },
    { key: 'desc', label: '倒序' },
    { key: 'name', label: '歌名' },
    { key: 'artist', label: '歌手' },
  ];
  const isNcm = kind === 'pl' && badge;
  let sortKey = sessionStorage.getItem('cm.plSort') || (isNcm ? 'desc' : 'asc');
  const applySort = arr => {
    if (sortKey === 'desc') return [...arr].reverse();
    if (sortKey === 'name') return [...arr].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
    if (sortKey === 'artist') return [...arr].sort((a, b) => (a.artists || '').localeCompare(b.artists || '', 'zh'));
    return arr;
  };
  songs = applySort(songs);

  el.innerHTML = `
    <div class="cm-plsort" id="plSort">
      <span class="cm-plsort-l"><span class="material-icons-outlined">sort</span>排序</span>
      ${SORTS.map(s => `<mdui-chip ${s.key === sortKey ? 'selected' : ''} data-k="${s.key}">${s.label}</mdui-chip>`).join('')}
    </div>
    <div class="cm-detail-head">
      <div class="cm-detail-cover">${cover ? `<img src="${esc(cover)}" onerror="this.remove()">` : ''}<span class="material-icons-outlined">music_note</span></div>
      <div>
        <h2>${esc(title)} ${badge}</h2>
        <div class="cm-detail-sub">${esc(desc)}</div>
        <div class="cm-detail-actions">
          <mdui-button variant="filled" id="playAll"><span class="material-icons-outlined">play_arrow</span>播放全部</mdui-button>
          ${kind !== 'pl' || !owner ? '' : `<mdui-button variant="tonal" id="addSongs"><span class="material-icons-outlined">add</span>添加歌曲</mdui-button>`}
          ${kind === 'pl' && owner ? `<mdui-button variant="tonal" id="delPl"><span class="material-icons-outlined">delete</span>删除</mdui-button>` : ''}
          <mdui-button variant="tonal" id="addAll"><span class="material-icons-outlined">playlist_add</span>收入歌单</mdui-button>
        </div>
      </div>
    </div>
    <div id="list"></div>`;

  el.querySelectorAll('#plSort mdui-chip').forEach(ch => {
    ch.onclick = () => {
      sessionStorage.setItem('cm.plSort', ch.dataset.k);
      render(el, params);
    };
  });

  const list = el.querySelector('#list');
  await renderSongList(list, songs, {
    onPlay: i => player.playList(songs, i),
    onRemove: removable ? async i => {
      const s = songs[i];
      try {
        if (id === 'likes') await api.toggleLike(s);
        else await api.delPlaylistTracks(+id, [s.ncm_id]);
        songs.splice(i, 1);
        render(el, params);
      } catch (e) { toast(e.message); }
    } : undefined,
  });

  el.querySelector('#playAll').onclick = () => songs.length ? player.playList(songs, 0) : toast('列表为空');
  el.querySelector('#addAll').onclick = () => songs.length ? addToPlaylist(songs) : toast('列表为空');
  const del = el.querySelector('#delPl');
  if (del) del.onclick = () => confirmDialog({
    title: `删除歌单「${title}」？`, body: '删除后不可恢复。',
    onOk: async () => { await api.deletePlaylist(+id); toast('已删除'); location.hash = '#/library'; },
  });
  const addBtn = el.querySelector('#addSongs');
  if (addBtn) addBtn.onclick = () => {
    location.hash = '#/search';
    toast('在搜索结果用「全部收入歌单」，或在播放页加入歌单');
  };
}
