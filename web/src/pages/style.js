// 曲风详情页（#/style/:tagId）：歌曲 / 歌单 / 歌手 / 专辑 四分区
// 数据来自阶段一登记的 /style/detail 与 /style/{song,playlist,artist,album}。
import { api, ncmSongs } from '../api.js';
import { esc, toast, renderSongList } from '../ui.js';
import { player } from '../player.js';

const TABS = [
  { key: 'song', label: '歌曲' },
  { key: 'playlist', label: '歌单' },
  { key: 'artist', label: '歌手' },
  { key: 'album', label: '专辑' },
];
const SIZE = 30;
const LOADING = '<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>';

/** 各分区的取数函数与「原始项 → 展示项」映射。 */
const FETCHERS = {
  playlist: { fn: (tagId, size, cursor) => api.stylePlaylists(tagId, size, cursor), key: 'playlist',
    map: x => ({ id: x.id, name: x.name, pic: x.cover, songCount: x.songCount, userName: x.userName }) },
  artist: { fn: (tagId, size, cursor) => api.styleArtists(tagId, size, cursor), key: 'artists',
    map: x => ({ id: x.id, name: x.name, pic: x.picUrl, alias: (x.alias || []).join(' / ') }) },
  album: { fn: (tagId, size, cursor) => api.styleAlbums(tagId, size, cursor), key: 'albums',
    map: x => ({ id: x.id, name: x.name, pic: x.picUrl, artist: (x.artist || {}).name || '' }) },
};

export async function render(el, params = []) {
  const tagId = String(params[0] || '');
  if (!tagId) { el.innerHTML = '<div class="cm-empty">缺少曲风参数</div>'; return; }

  const state = { cur: 'song', cursor: {}, done: { song: false }, acc: {}, total: {}, loading: false };

  el.innerHTML = `
    <div class="cm-sec" id="styleHead">${LOADING}</div>
    <div class="cm-plsort" id="styleTabs">
      ${TABS.map((t, i) => `<mdui-chip ${i === 0 ? 'selected' : ''} data-k="${t.key}">${t.label}</mdui-chip>`).join('')}
    </div>
    <div id="styleBody"></div>`;

  const head = el.querySelector('#styleHead');
  const body = el.querySelector('#styleBody');

  // 头部信息：失败不阻塞列表
  api.styleDetail(tagId).then(d => {
    const t = d.data || {};
    head.innerHTML = `
      <div class="cm-sec-head"><h2>${esc(t.name || '曲风')}</h2>
        <span class="cm-sec-sub">${t.songNum ? `${t.songNum} 首` : ''}${t.artistNum ? ` · ${t.artistNum} 位歌手` : ''}</span></div>
      ${t.desc ? `<div class="cm-sec-sub" style="line-height:1.6">${esc(t.desc)}</div>` : ''}`;
  }).catch(() => { head.innerHTML = '<div class="cm-sec-head"><h2>曲风</h2></div>'; });

  /** 渲染歌单 / 歌手 / 专辑卡片（每次整块重绘累积结果）。 */
  function renderCards(cur, list) {
    if (cur === 'playlist') {
      body.innerHTML = `<div class="cm-plgrid" id="styleList">${list.map(pl => `
        <div class="cm-plcard" data-id="${pl.id}">
          <div class="cm-plcover">${pl.pic ? `<img src="${esc(pl.pic)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
          <div class="cm-plname">${esc(pl.name)}</div>
          <div class="cm-plsub">${pl.songCount || 0} 首${pl.userName ? ` · ${esc(pl.userName)}` : ''}</div>
        </div>`).join('')}</div>`;
      body.querySelectorAll('.cm-plcard').forEach(c => {
        c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; };
      });
    } else if (cur === 'artist') {
      body.innerHTML = `<div class="cm-hscroll cm-artist-row" id="styleList">${list.map(a => `
        <div class="cm-artist-card" data-id="${a.id}">
          <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
          <div class="cm-artist-name">${esc(a.name)}</div>
          ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
        </div>`).join('')}</div>`;
      body.querySelectorAll('.cm-artist-card').forEach(c => {
        c.onclick = () => { location.hash = `#/artist/${c.dataset.id}`; };
      });
    } else {
      body.innerHTML = `<div class="cm-hscroll">${list.map(a => `
        <div class="cm-card cm-album-card" data-id="${a.id}">
          <img src="${esc(a.pic)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(a.name)}</div>
          <div class="cm-card-sub">${esc(a.artist)}</div>
        </div>`).join('')}</div>`;
      body.querySelectorAll('.cm-album-card').forEach(c => {
        c.onclick = () => { location.hash = `#/album/${c.dataset.id}`; };
      });
    }
  }

  /** 拉一页。append=true 时追加到已有结果之后。 */
  async function loadPage(cur, append) {
    if (state.loading) return;
    state.loading = true;
    const cursor = append ? (state.cursor[cur] || 0) : 0;
    if (!append) body.innerHTML = LOADING;
    let shown = 0;
    try {
      if (cur === 'song') {
        const d = await api.styleSongs(tagId, SIZE, cursor);
        const got = ncmSongs((d.data || {}).songs || []);
        const page = (d.data || {}).page || {};
        state.cursor[cur] = page.cursor || 0;
        state.done[cur] = !page.more;
        const all = append ? (state.acc[cur] || []).concat(got) : got;
        state.acc[cur] = all;
        state.total[cur] = page.total || all.length;
        shown = all.length;
        if (!all.length) { body.innerHTML = '<div class="cm-empty small">该曲风暂无歌曲</div>'; return; }
        if (!append) body.innerHTML = '<div id="styleSongs"></div>';
        await renderSongList(body.querySelector('#styleSongs'), all, {
          from: append ? all.length - got.length : 0,
          onPlay: i => player.playList(all, i),
        });
      } else {
        const { fn, key, map } = FETCHERS[cur];
        const d = await fn(tagId, SIZE, cursor);
        const data = d.data || {};
        const raw = data[key] || [];
        const page = data.page || {};
        state.cursor[cur] = page.cursor || 0;
        state.done[cur] = !(page.more || page.hasNext);
        const got = raw.map(map);
        state.acc[cur] = append ? (state.acc[cur] || []).concat(got) : got;
        state.total[cur] = page.total || state.acc[cur].length;
        shown = state.acc[cur].length;
        if (!shown) { body.innerHTML = `<div class="cm-empty small">该曲风暂无${TABS.find(t => t.key === cur).label}</div>`; return; }
        renderCards(cur, state.acc[cur]);
      }
    } catch (e) {
      body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      return;
    } finally {
      state.loading = false;
    }
    // 「加载更多」：还有下一页且已有内容时挂按钮
    if (!state.done[cur] && shown > 0) {
      const total = state.total[cur] || shown;
      body.insertAdjacentHTML('beforeend',
        `<div class="cm-sq-more"><mdui-button variant="tonal" id="styleMore">加载更多（${shown}${total > shown ? `/${total}` : ''}）</mdui-button></div>`);
      const btn = body.querySelector('#styleMore');
      if (btn) btn.onclick = () => { btn.parentElement.remove(); loadPage(cur, true); };
    }
  }

  el.querySelectorAll('#styleTabs mdui-chip').forEach(ch => {
    ch.onclick = () => {
      const k = ch.dataset.k;
      if (k === state.cur) return;
      state.cur = k;
      el.querySelectorAll('#styleTabs mdui-chip').forEach(c => c.toggleAttribute('selected', c === ch));
      loadPage(k, false);
    };
  });

  loadPage('song', false);
}
