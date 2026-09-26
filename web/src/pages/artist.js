// 歌手作品页：资料 + 专辑 + 热度排序全部歌曲（分页加载）+ 播放全部
import { api, auth } from '../api.js';
import { esc, toast, renderSongList } from '../ui.js';
import { mdui } from '../md.js';
import { player } from '../player.js';

// 专辑行：封面 + 名称 + 年份/类型；点封面整张入队播放，「查看全部」弹窗看完整专辑列表
function albumCard(a) {
  const sub = [a.year || '', a.type || ''].filter(Boolean).join(' · ');
  return `
    <div class="cm-card cm-album-card" data-id="${a.id}" data-name="${esc(a.name)}">
      <img src="${esc(a.pic)}?param=200y200" loading="lazy" onerror="this.classList.add('none')">
      <div class="cm-card-name" title="${esc(a.name)}">${esc(a.name)}</div>
      <div class="cm-card-sub">${esc(sub || `${a.size || 0} 首`)}</div>
    </div>`;
}

async function playAlbum(id, name, btn) {
  toast('正在打开专辑…');
  try {
    const al = await api.album(id);
    const songs = (al && al.songs) || [];
    if (!songs.length) return toast('专辑暂无曲目');
    player.playList(songs, 0);
    toast(`${name || '专辑'} · ${songs.length} 首已加入播放`);
  } catch (e) { toast('打开专辑失败：' + e.message); }
  finally { if (btn) btn.classList.remove('busy'); }
}

// 全部专辑：弹窗网格 + 加载更多（歌手专辑可达数百张，首屏只取 30 张）
function albumsDialog(artistId, artistName, total) {
  let all = [], more = false;
  const diag = mdui.dialog({
    headline: `${artistName} · 专辑`,
    body: `<div class="cm-album-dlg">
             <div id="albumAllGrid" class="cm-album-grid"></div>
             <div class="cm-sq-more" id="albumMoreWrap" hidden><mdui-button variant="tonal" id="albumMore">加载更多</mdui-button></div>
             <div class="cm-empty small" id="albumDlgEmpty" hidden>暂无专辑</div>
           </div>`,
    actions: [{ text: '关闭' }],
  });
  const paint = (box, list) => {
    box.insertAdjacentHTML('beforeend', list.map(albumCard).join(''));
    box.querySelectorAll('.cm-album-card').forEach(c => {
      if (c.dataset.bound) return;
      c.dataset.bound = '1';
      c.onclick = () => playAlbum(c.dataset.id, c.dataset.name);
    });
  };
  const load = async (offset) => {
    const d = await api.artistAlbums(artistId, offset, 30);
    all = all.concat(d.albums || []);
    more = !!d.more;
    const grid = diag.querySelector('#albumAllGrid');
    if (grid) paint(grid, d.albums || []);
    const empty = diag.querySelector('#albumDlgEmpty');
    if (empty) empty.hidden = all.length > 0;
    const wrap = diag.querySelector('#albumMoreWrap');
    if (wrap) wrap.hidden = !more;
    const btn = diag.querySelector('#albumMore');
    if (btn) {
      btn.onclick = async () => {
        btn.loading = true;
        try { await load(all.length); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };
  load(0).catch(e => {
    const grid = diag.querySelector('#albumAllGrid');
    if (grid) grid.innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`;
  });
}

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
  const albums = d.albums || [];
  const albumTotal = d.albumTotal || albums.length;

  el.innerHTML = `
    <div class="cm-detail-head cm-artist-head">
      <div class="cm-artist-bigava">${d.pic ? `<img src="${esc(d.pic)}?param=300y300">` : '<span class="material-icons-outlined">person</span>'}</div>
      <div>
        <h2>${esc(d.name)}</h2>
        <div class="cm-detail-sub">${esc(d.alias || '')}${d.total ? `${d.alias ? ' · ' : ''}共 ${d.total} 首作品` : ''}${albumTotal ? ` · ${albumTotal} 张专辑` : ''}</div>
        <div class="cm-detail-actions">
          <mdui-button variant="filled" id="playAll"><span class="material-icons-outlined">play_arrow</span>播放全部</mdui-button>
          <mdui-button variant="tonal" id="followBtn"><span class="material-icons-outlined">favorite_border</span>关注歌手</mdui-button>
        </div>
      </div>
    </div>
    ${albums.length ? `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>专辑</h2>${albumTotal > albums.length ? `<span class="cm-sec-more" id="albumsAll">查看全部<i>${albumTotal}</i></span>` : `<span class="cm-sec-sub">共 ${albumTotal} 张</span>`}</div>
      <div class="cm-hscroll" id="albumRow">${albums.map(albumCard).join('')}</div>
    </section>` : ''}
    <div id="artistList"></div>
    <div class="cm-sq-more" id="artistMoreWrap" hidden>
      <mdui-button variant="tonal" id="artistMore">加载更多</mdui-button>
    </div>`;

  const albumRow = el.querySelector('#albumRow');
  if (albumRow) albumRow.querySelectorAll('.cm-album-card').forEach(c => {
    c.onclick = () => playAlbum(c.dataset.id, c.dataset.name, c);
  });
  const albumsAll = el.querySelector('#albumsAll');
  if (albumsAll) albumsAll.onclick = () => albumsDialog(id, d.name, albumTotal);

  const list = el.querySelector('#artistList');
  await renderSongList(list, all, { onPlay: i => player.playList(all, i) });
  el.querySelector('#playAll').onclick = () => all.length ? player.playList(all, 0) : toast('暂无作品');

  // 关注歌手：与网易云账号同步（读 /artist/sublist、写 /artist/sub），需已绑定网易云
  const fBtn = el.querySelector('#followBtn');
  let following = false, bound = !!auth.token;
  const paintFollow = on => {
    fBtn.innerHTML = on
      ? '<span class="material-icons-outlined">favorite</span>已关注'
      : '<span class="material-icons-outlined">favorite_border</span>关注歌手';
    fBtn.classList.toggle('on', on);
  };
  const paintNeedBind = () => {
    fBtn.innerHTML = '<span class="material-icons-outlined">cloud_off</span>绑定网易云后可关注';
    fBtn.classList.remove('on');
  };
  if (bound) {
    api.followedArtists(true).then(r => {            // 进页面取最新（绕过缓存）
      following = (r.artists || []).some(a => String(a.artist_id) === String(id));
      paintFollow(following);
    }).catch(e => {
      // 未绑定网易云：关注能力依赖用户自己的网易云账号
      if (e && e.status === 400) { bound = false; paintNeedBind(); }
    });
  } else {
    paintNeedBind();
  }
  fBtn.onclick = async () => {
    if (!auth.token) return toast('请先登录后再关注歌手');
    if (!bound) {
      toast('关注需先绑定网易云账号（与网易云 App 关注同步）');
      location.hash = '#/user';
      return;
    }
    if (fBtn.dataset.busy) return;
    fBtn.dataset.busy = '1';
    try {
      const on = !following;
      await api.followArtist(id, on, d.name, d.pic);   // 回传歌名/头像：服务端乐观展示用
      following = on;
      paintFollow(on);
      toast(on ? `已在网易云关注 ${d.name}` : `已在网易云取消关注 ${d.name}`);
    } catch (e) { toast('操作失败：' + e.message); }
    finally { delete fBtn.dataset.busy; }
  };

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
