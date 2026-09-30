// 发现页「音乐」TAB：Banner / 推荐歌单 / 推荐新歌 / 独家放送 / 榜单 / 曲风入口
// 数据全部来自阶段一的 /ncm/* 泛化网关（接口须在 backend/cm_ncm_registry.py 登记）。
import { api, auth, ncmSongs } from './api.js';
import { esc, toast } from './ui.js';
import { player } from './player.js';

const fmtPlay = n => {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
};

const cardShell = (id, title) => `
  <section class="cm-sec" id="${id}">
    <div class="cm-sec-head"><h2>${title}</h2></div>
    <div class="cm-loading"><mdui-linear-progress style="width:120px"></mdui-linear-progress></div>
  </section>`;

/** 歌单卡片网格（复用现有 .cm-plgrid/.cm-plcard 样式，不新增默认皮肤样式）。 */
function playlistsHTML(list) {
  return `<div class="cm-plgrid">${list.map(pl => `
    <div class="cm-plcard" data-id="${pl.id}">
      <div class="cm-plcover">${
        pl.pic ? `<img src="${esc(pl.pic)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''
      }<span class="material-icons-outlined">queue_music</span></div>
      <div class="cm-plname">${esc(pl.name)}</div>
      <div class="cm-plsub">${pl.sub || ''}</div>
    </div>`).join('')}</div>`;
}

export async function mountDiscover(el) {
  const root = document.createElement('div');
  root.className = 'cm-disc';
  root.innerHTML = `
    <div id="discBanner"></div>
    ${cardShell('discRec', '推荐歌单')}
    ${cardShell('discNew', '推荐新歌')}
    ${cardShell('discTop', '排行榜')}
    ${cardShell('discStyle', '曲风分类')}
    ${cardShell('discHq', '精品歌单')}
    ${cardShell('discAlbum', '新碟上架')}
    ${cardShell('discMv', 'MV 排行')}
    ${cardShell('discArtistTop', '歌手榜')}
    ${cardShell('discPriv', '独家放送')}`;
  el.appendChild(root);
  const q = sel => root.querySelector(sel);

  const sec = id => q('#' + id);
  const setEmpty = (id, msg) => {
    const s = sec(id);
    if (!s) return;
    const title = s.querySelector('h2') ? s.querySelector('h2').textContent : '';
    s.innerHTML = `<div class="cm-sec-head"><h2>${title}</h2></div><div class="cm-empty small">${msg}</div>`;
  };

  const jobs = [];

  // --- Banner ---
  jobs.push(api.banner(0).then(d => {
    const list = (d.banners || []).filter(b => b.imageUrl);
    const box = q('#discBanner');
    if (!box) return;
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="cm-hscroll">${list.map((b, i) => `
      <div class="cm-card cm-disc-banner" data-i="${i}">
        <img src="${esc(b.imageUrl)}?param=600y240" loading="lazy" onerror="this.remove()">
        <div class="cm-card-name">${esc(b.typeTitle || '')}</div>
      </div>`).join('')}</div>`;
    box.querySelectorAll('.cm-disc-banner').forEach(c => {
      const b = list[+c.dataset.i];
      // 歌单类 Banner 可直达；其余（活动/新歌）不猜路由，保持纯展示，避免死链
      if (b.targetType === 1000 && b.targetId) {
        c.onclick = () => { location.hash = `#/ncmpl/${b.targetId}`; };
      }
    });
  }).catch(() => { const b = q('#discBanner'); if (b) b.innerHTML = ''; }));

  // --- 推荐歌单 ---
  jobs.push(api.personalized(12).then(d => {
    const list = (d.result || []).map(x => ({
      id: x.id, name: x.name, pic: x.picUrl,
      sub: `${x.trackCount || 0} 首 · ${fmtPlay(x.playCount)}播放`,
    }));
    if (!list.length) return setEmpty('discRec', '暂无推荐歌单');
    const s = sec('discRec');
    s.innerHTML = `<div class="cm-sec-head"><h2>推荐歌单</h2>
      <span class="cm-sec-more" id="discPlaza">歌单广场</span></div>` + playlistsHTML(list);
    s.querySelectorAll('.cm-plcard').forEach(c => { c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; }; });
    s.querySelector('#discPlaza').onclick = () => { location.hash = '#/plaza'; };
  }).catch(() => setEmpty('discRec', '推荐歌单加载失败')));

  // --- 推荐新歌 ---
  jobs.push(api.personalizedNewSong(12).then(d => {
    const songs = ncmSongs((d.result || []).map(x => x.song || x));
    const s = sec('discNew');
    if (!songs.length) return setEmpty('discNew', '暂无推荐新歌');
    s.innerHTML = `<div class="cm-sec-head"><h2>推荐新歌</h2>
      <span class="cm-sec-more" id="discPlayNew"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
      <div class="cm-hscroll">${songs.map((s2, i) => `
        <div class="cm-card" data-i="${i}">
          <img src="${esc(s2.pic)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(s2.name)}</div>
          <div class="cm-card-sub">${esc(s2.artists)}</div>
        </div>`).join('')}</div>`;
    s.querySelectorAll('.cm-card').forEach(c => {
      c.onclick = () => player.playList(songs, +c.dataset.i);
    });
    s.querySelector('#discPlayNew').onclick = () => player.playList(songs, 0);
  }).catch(() => setEmpty('discNew', '推荐新歌加载失败')));

  // --- 排行榜（/toplist 提供全部榜单；/toplist/detail/v2 提供分组，用于分类切换）---
  jobs.push(Promise.allSettled([api.toplist(), api.ncm('/toplist/detail/v2')]).then(([allR, v2R]) => {
    const s = sec('discTop');
    const all = (allR.status === 'fulfilled' ? (allR.value.list || []) : []);
    const groups = (v2R.status === 'fulfilled' ? (v2R.value.data || []) : [])
      .filter(g => (g.list || []).length);
    const norm = t => ({
      id: t.id, name: t.name, pic: t.coverUrl || t.coverImgUrl,
      sub: `${t.updateFrequency || ''}${t.trackCount ? ` · ${t.trackCount} 首` : ''}`,
    });
    const tabs = [{ key: 'all', label: '全部榜单', items: all.map(norm) }]
      .concat(groups.map((g, i) => ({ key: 'g' + i, label: g.name, items: (g.list || []).map(norm) })));
    if (!tabs[0].items.length && !groups.length) return setEmpty('discTop', '暂无榜单');
    const draw = idx => {
      s.innerHTML = `<div class="cm-sec-head"><h2>排行榜</h2></div>
        <div class="cm-chips">${tabs.map((t, i) =>
          `<span class="cm-hot${i === idx ? ' on' : ''}" data-i="${i}">${esc(t.label)}</span>`).join('')}</div>`
        + playlistsHTML(tabs[idx].items.slice(0, 12));
      s.querySelectorAll('[data-i]').forEach(c => { c.onclick = () => draw(+c.dataset.i); });
      s.querySelectorAll('.cm-plcard').forEach(c => { c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; }; });
    };
    draw(0);
  }).catch(() => setEmpty('discTop', '排行榜加载失败')));

  // --- 曲风分类 ---
  jobs.push(api.styleList().then(d => {
    const tags = (d.data || []).filter(t => (t.level || 1) === 1);
    const s = sec('discStyle');
    if (!tags.length) return setEmpty('discStyle', '暂无曲风');
    s.innerHTML = `<div class="cm-sec-head"><h2>曲风分类</h2></div>
      <div class="cm-chips">${tags.map(t =>
        `<span class="cm-hot" data-tag="${t.tagId}">${esc(t.tagName)}</span>`).join('')}</div>`;
    s.querySelectorAll('[data-tag]').forEach(c => {
      c.onclick = () => { location.hash = `#/style/${c.dataset.tag}`; };
    });
  }).catch(() => setEmpty('discStyle', '曲风加载失败')));

  // --- 精品歌单 ---
  jobs.push(api.ncm('/top/playlist/highquality', { cat: '全部', limit: 9 }).then(d => {
    const list = (d.playlists || []).map(pl => ({
      id: pl.id, name: pl.name, pic: pl.coverImgUrl,
      sub: `${pl.trackCount || 0} 首 · ${fmtPlay(pl.playCount)}播放`,
    }));
    const s = sec('discHq');
    if (!list.length) return setEmpty('discHq', '暂无精品歌单');
    s.innerHTML = `<div class="cm-sec-head"><h2>精品歌单</h2></div>` + playlistsHTML(list);
    s.querySelectorAll('.cm-plcard').forEach(c => { c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; }; });
  }).catch(() => setEmpty('discHq', '精品歌单加载失败')));

  // --- 新碟上架（本周新碟）---
  jobs.push(api.ncm('/top/album', { limit: 12 }).then(d => {
    const list = (d.weekData || d.monthData || []).slice(0, 12).map(a => ({
      id: a.id, name: a.name, pic: a.picUrl, artist: (a.artist || {}).name || '',
    }));
    const s = sec('discAlbum');
    if (!list.length) return setEmpty('discAlbum', '暂无新碟');
    s.innerHTML = `<div class="cm-sec-head"><h2>新碟上架</h2>
      <span class="cm-sec-more" id="discAlbumsAll">更多新碟</span></div>
      <div class="cm-hscroll">${list.map(a => `
        <div class="cm-card cm-album-card" data-id="${a.id}">
          <img src="${esc(a.pic)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(a.name)}</div>
          <div class="cm-card-sub">${esc(a.artist)}</div>
        </div>`).join('')}</div>`;
    s.querySelectorAll('.cm-album-card').forEach(c => {
      c.onclick = () => { location.hash = `#/album/${c.dataset.id}`; };
    });
    s.querySelector('#discAlbumsAll').onclick = () => { location.hash = '#/albums'; };
  }).catch(() => setEmpty('discAlbum', '新碟上架加载失败')));

  // --- MV 排行（卡片直达 MV 详情页；头部另给「全部 MV」与「视频广场」入口）---
  jobs.push(api.ncm('/top/mv', { limit: 12 }).then(d => {
    const list = (d.data || []).slice(0, 12);
    const s = sec('discMv');
    if (!list.length) return setEmpty('discMv', '暂无 MV');
    s.innerHTML = `<div class="cm-sec-head"><h2>MV 排行</h2>
      <span class="cm-sec-more" id="discMvAll">全部 MV</span>
      <span class="cm-sec-more" id="discVideo">视频广场</span></div>
      <div class="cm-hscroll">${list.map(m => `
        <div class="cm-card" data-id="${m.id}">
          <img src="${esc(m.cover)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(m.name)}</div>
          <div class="cm-card-sub">${esc(m.artistName || '')} · ${fmtPlay(m.playCount)}</div>
        </div>`).join('')}</div>`;
    s.querySelectorAll('.cm-card').forEach(c => {
      c.onclick = () => { location.hash = `#/mv/${c.dataset.id}`; };
    });
    s.querySelector('#discMvAll').onclick = () => { location.hash = '#/mvlist'; };
    s.querySelector('#discVideo').onclick = () => { location.hash = '#/videohome'; };
  }).catch(() => setEmpty('discMv', 'MV 排行加载失败')));

  // --- 歌手榜 ---
  jobs.push(api.ncm('/toplist/artist', {}).then(d => {
    const list = (((d.list || {}).artists) || []).slice(0, 12).map(a => ({
      id: a.id, name: a.name, pic: a.picUrl, alias: (a.alias || []).join(' / '),
    }));
    const s = sec('discArtistTop');
    if (!list.length) return setEmpty('discArtistTop', '暂无歌手榜');
    s.innerHTML = `<div class="cm-sec-head"><h2>歌手榜</h2>
      <span class="cm-sec-more" id="discArtistsAll">全部歌手</span></div>
      <div class="cm-hscroll cm-artist-row">${list.map(a => `
        <div class="cm-artist-card" data-id="${a.id}">
          <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
          <div class="cm-artist-name">${esc(a.name)}</div>
          ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
        </div>`).join('')}</div>`;
    s.querySelectorAll('.cm-artist-card').forEach(c => {
      c.onclick = () => { location.hash = `#/artist/${c.dataset.id}`; };
    });
    s.querySelector('#discArtistsAll').onclick = () => { location.hash = '#/artists'; };
  }).catch(() => setEmpty('discArtistTop', '歌手榜加载失败')));

  // --- 独家放送 ---
  jobs.push(api.privateContent().then(d => {
    const list = (d.result || []).slice(0, 9).map(x => ({
      id: x.id, name: x.name, pic: x.sPicUrl || x.picUrl, sub: x.copywriter || '',
    }));
    const s = sec('discPriv');
    if (!list.length) return setEmpty('discPriv', '暂无独家放送');
    s.innerHTML = `<div class="cm-sec-head"><h2>独家放送</h2></div>` + playlistsHTML(list);
    // 独家放送多为视频/MV，无稳定站内路由 → 不做假跳转，仅展示
    s.querySelectorAll('.cm-plcard').forEach(c => { c.style.cursor = 'default'; });
  }).catch(() => setEmpty('discPriv', '独家放送加载失败')));

  // --- 曲风偏好（T1：账号维度数据，走用户自己的 cookie，未绑定不请求）---
  jobs.push((async () => {
    const s = sec('discStyle');
    if (!s || !auth.token) return;
    let bound = false;
    try { bound = !!(await api.bindStatus()).bound; } catch { return; }
    if (!bound) return;
    const d = await api.ncm('/style/preference');
    const vos = (((d.data || {}).tagPreferenceVos) || []).filter(v => v.tagId).slice(0, 8);
    if (!vos.length) return;
    s.insertAdjacentHTML('afterbegin',
      `<div class="cm-sec-head"><h2 style="font-size:13px;opacity:.75">我的曲风偏好</h2></div>
       <div class="cm-chips">${vos.map(v =>
         `<span class="cm-hot" data-tag="${v.tagId}">${esc(v.tagName)}${v.ratio ? ` <b>${Math.round(v.ratio * 100)}%</b>` : ''}</span>`).join('')}</div>`);
    // 只挂偏好这一行的点击；曲风分类那行的点击已在上面绑好（用最近作用域避免覆盖）
    s.querySelectorAll('.cm-chips:first-of-type [data-tag]').forEach(c => {
      c.onclick = () => { location.hash = `#/style/${c.dataset.tag}`; };
    });
  })().catch(() => {}));

  await Promise.allSettled(jobs);
}
