// 歌手作品页：资料 + 专辑 + 热度排序全部歌曲（分页加载）+ 播放全部
// 阶段三扩展：/artist/desc、/artist/detail、/artist/detail/dynamic、/artist/fans、
//            /artist/follow/count、/artist/top/song、/artist/mv、/artist/video、/simi/artist
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast, renderSongList, fmtCount } from '../ui.js';
import { mdui } from '../md.js';
import { player } from '../player.js';
import { openMlog } from '../mlog.js';

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

// 专辑封面：进入专辑详情页（阶段三新增 #/album/:id）。
// 详情页首屏即为「播放全部」，比原来的「盲播整张」多出元数据/收藏/相关歌单/评论。
function openAlbum(id) {
  if (!id) return;
  location.hash = `#/album/${id}`;
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
      c.onclick = () => openAlbum(c.dataset.id, c.dataset.name);
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
        <div class="cm-detail-sub" id="artStats"></div>
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
    <section class="cm-sec" id="artDescSec" hidden>
      <div class="cm-sec-head"><h2>歌手简介</h2></div>
      <div id="artDesc"></div>
    </section>
    <section class="cm-sec" id="artTopSec" hidden>
      <div class="cm-sec-head"><h2>热门作品</h2><span class="cm-sec-more" id="artTopPlay"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
      <div id="artTop"></div>
    </section>
    <section class="cm-sec" id="artMvSec" hidden>
      <div class="cm-sec-head"><h2>MV</h2><span class="cm-sec-more" id="artMvMore">更多 MV</span></div>
      <div class="cm-plgrid" id="artMv"></div>
    </section>
    <section class="cm-sec" id="artVideoSec" hidden>
      <div class="cm-sec-head"><h2>视频</h2></div>
      <div class="cm-plgrid" id="artVideo"></div>
    </section>
    <section class="cm-sec" id="artSimiSec" hidden>
      <div class="cm-sec-head"><h2>相似歌手</h2></div>
      <div class="cm-hscroll cm-artist-row" id="artSimi"></div>
    </section>
    <div class="cm-sq-more" id="artistMoreWrap" hidden>
      <mdui-button variant="tonal" id="artistMore">加载更多</mdui-button>
    </div>`;

  const albumRow = el.querySelector('#albumRow');
  if (albumRow) albumRow.querySelectorAll('.cm-album-card').forEach(c => {
    c.onclick = () => openAlbum(c.dataset.id, c.dataset.name, c);
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

  // ---------- 阶段三：歌手资料 / 热门作品 / MV / 视频 / 相似歌手 ----------

  // 粉丝与关注数（/artist/follow/count）；点击查看粉丝榜（/artist/fans）
  api.ncm('/artist/follow/count', { id }).then(r => {
    const s = r.data || {};
    const box = el.querySelector('#artStats');
    if (!box) return;
    box.innerHTML = [
      s.fansCnt ? `<span class="cm-artist-link" id="artFans">粉丝 ${fmtCount(s.fansCnt)}</span>` : '',
      s.followCnt ? `关注 ${fmtCount(s.followCnt)}` : '',
    ].filter(Boolean).join(' · ');
    const fans = el.querySelector('#artFans');
    if (fans) {
      fans.style.cursor = 'pointer';
      fans.onclick = () => fansDialog(id, d.name);
    }
  }).catch(() => {});

  // 歌手详情与动态（职业标签 / 视频数 / 演唱会动态计数）
  Promise.allSettled([api.ncm('/artist/detail', { id }), api.ncm('/artist/detail/dynamic', { id })]).then(([detR, dynR]) => {
    const box = el.querySelector('#artStats');
    if (!box) return;
    const det = detR.status === 'fulfilled' ? (detR.value.data || {}) : {};
    const dyn = dynR.status === 'fulfilled' ? dynR.value : {};
    const bits = [];
    if (det.identify && det.identify.imageDesc) bits.push(esc(det.identify.imageDesc));
    if (det.videoCount) bits.push(`${det.videoCount} 个视频`);
    if (dyn.concert && dyn.concert.onlineCount) bits.push(`${dyn.concert.onlineCount} 场演出`);
    const extra = (dyn.videoNum || []).reduce((n, x) => n + (x.num || 0), 0);
    if (extra) bits.push(`${extra} 条动态视频`);
    if (bits.length) box.insertAdjacentHTML('beforeend', `${box.textContent ? ' · ' : ''}${bits.join(' · ')}`);
  });

  // 歌手简介（/artist/desc：introduction 是 [{ti,txt}] 分段结构）
  api.ncm('/artist/desc', { id }).then(r => {
    const intro = (r.introduction || []).map(x => (x.ti ? `${x.ti}：${x.txt}` : x.txt)).filter(Boolean);
    if (!intro.length) return;
    const sec = el.querySelector('#artDescSec');
    sec.hidden = false;
    const text = intro.join('\n');
    el.querySelector('#artDesc').innerHTML =
      `<div class="cm-al-desc${text.length > 200 ? ' cm-al-desc-clamp' : ''}" id="artDescText">${esc(text)}</div>`
      + (text.length > 200 ? '<span class="cm-sec-more" id="artDescMore">展开</span>' : '');
    const more = el.querySelector('#artDescMore');
    if (more) more.onclick = () => {
      const on = el.querySelector('#artDescText').classList.toggle('cm-al-desc-clamp');
      more.textContent = on ? '展开' : '收起';
    };
  }).catch(() => {});

  // 热门作品（/artist/top/song）：与「全部作品」区分——这是网易云侧的热度排序榜
  api.ncm('/artist/top/song', { id }).then(r => {
    const songs = ncmSongs(r.songs || []);
    if (!songs.length) return;
    const sec = el.querySelector('#artTopSec');
    sec.hidden = false;
    renderSongList(el.querySelector('#artTop'), songs, { onPlay: i => player.playList(songs, i) });
    el.querySelector('#artTopPlay').onclick = () => player.playList(songs, 0);
  }).catch(() => {});

  // 歌手 MV（/artist/mv）→ 直达 MV 详情页
  api.ncm('/artist/mv', { id, limit: 9, offset: 0 }).then(r => {
    const list = (r.mvs || []).slice(0, 9);
    if (!list.length) return;
    const sec = el.querySelector('#artMvSec');
    sec.hidden = false;
    el.querySelector('#artMv').innerHTML = list.map(m => `
      <div class="cm-plcard" data-mvid="${m.id}">
        <div class="cm-plcover">${m.imgurl ? `<img src="${esc(m.imgurl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">videocam</span></div>
        <div class="cm-plname">${esc(m.name)}</div>
        <div class="cm-plsub">${m.playCount ? fmtCount(m.playCount) : ''}</div>
      </div>`).join('');
    el.querySelectorAll('#artMv .cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/mv/${c.dataset.mvid}`; };
    });
    el.querySelector('#artMvMore').onclick = () => { location.hash = '#/mvlist'; };
  }).catch(() => {});

  // 歌手视频（/artist/video 返回 MLOG records）→ 复用 MLOG 播放抽屉
  api.ncm('/artist/video', { id, size: 9, cursor: 0, order: 0 }).then(r => {
    const recs = (((r.data || {}).records) || []).map(x => {
      const base = (x.resource || {}).mlogBaseData || {};
      return { id: base.id || x.id, name: base.text || base.originalTitle || '视频', cover: base.coverUrl, duration: base.duration };
    }).filter(x => x.id);
    if (!recs.length) return;
    const sec = el.querySelector('#artVideoSec');
    sec.hidden = false;
    el.querySelector('#artVideo').innerHTML = recs.map(x => `
      <div class="cm-plcard cm-mlog-card" data-mlog="${esc(x.id)}">
        <div class="cm-plcover cm-cover-16x9">${x.cover ? `<img src="${esc(x.cover)}?param=400y225" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">play_circle</span></div>
        <div class="cm-plname">${esc(x.name)}</div>
        <div class="cm-plsub">MLOG</div>
      </div>`).join('');
    el.querySelectorAll('#artVideo .cm-plcard').forEach(c => {
      c.onclick = () => openMlog(c.dataset.mlog, (recs.find(x => String(x.id) === c.dataset.mlog) || {}).cover);
    });
  }).catch(() => {});

  // 相似歌手（/simi/artist）
  api.ncm('/simi/artist', { id }).then(r => {
    const list = (r.artists || []).slice(0, 12);
    if (!list.length) return;
    const sec = el.querySelector('#artSimiSec');
    sec.hidden = false;
    el.querySelector('#artSimi').innerHTML = list.map(a => `
      <div class="cm-artist-card" data-aid="${a.id}">
        <div class="cm-artist-ava">${a.picUrl ? `<img src="${esc(a.picUrl)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div class="cm-artist-name">${esc(a.name)}</div>
      </div>`).join('');
    el.querySelectorAll('#artSimi .cm-artist-card').forEach(c => {
      c.onclick = () => { location.hash = `#/artist/${c.dataset.aid}`; };
    });
  }).catch(() => {});
}

/** 粉丝榜（/artist/fans）：弹窗列出前 30 位，点击进用户主页。 */
function fansDialog(artistId, artistName) {
  const diag = mdui.dialog({
    headline: `${artistName} · 粉丝`,
    body: '<div id="fansBox"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>',
    actions: [{ text: '关闭' }],
  });
  api.ncm('/artist/fans', { id: artistId, limit: 30, offset: 0 }).then(r => {
    const users = (r.data || []).map(x => x.userProfile || x).filter(u => u && u.userId);
    const box = diag.querySelector('#fansBox');
    if (!box) return;
    box.innerHTML = users.length
      ? users.map(u => `
        <div class="cm-si-simi-i" data-uid="${u.userId}">
          ${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=60y60" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}
          <div><div class="cm-si-simi-n">${esc(u.nickname || '')}</div>
          <div class="cm-si-simi-a">${esc(u.signature || '')}</div></div>
        </div>`).join('')
      : '<div class="cm-empty small">暂无公开粉丝</div>';
    box.querySelectorAll('[data-uid]').forEach(x => {
      x.onclick = () => { diag.open = false; location.hash = `#/u/${x.dataset.uid}`; };
    });
  }).catch(e => {
    const box = diag.querySelector('#fansBox');
    if (box) box.innerHTML = `<div class="cm-empty small">粉丝列表加载失败：${esc(e.message)}</div>`;
  });
}
