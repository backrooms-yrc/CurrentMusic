// 关注的歌手（独立页）：来自用户自己的网易云账号，可点击进入歌手主页
// 阶段三扩展：关注歌手的新歌 / 新 MV / 综合新作流（均为 T1 账号态接口）
//   /artist/new/song、/artist/new/mv、/artist/new/song/mv/list/v2、/artist/new/song/playall
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast, renderSongList } from '../ui.js';
import { player } from '../player.js';

const TAB_KEY = 'cm.followedTab';

/** 上游这几个接口的包裹层不统一（data / songs / mvs / 裸数组），统一收敛成数组。 */
const pickList = (d, ...keys) => {
  if (Array.isArray(d)) return d;
  for (const k of keys) {
    if (Array.isArray(d && d[k])) return d[k];
  }
  if (d && Array.isArray(d.data)) return d.data;
  return [];
};

export async function render(el, params = {}) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">favorite</span>
      <div>登录后可查看你在网易云关注的歌手</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
  let d;
  try {
    d = await api.followedArtists(true);      // 进页面取最新（绕过缓存）
  } catch (e) {
    el.innerHTML = e.status === 400
      ? `<div class="cm-login-tip page">
           <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">cloud_off</span>
           <div>关注歌手与你的网易云账号同步，需先绑定</div>
           <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button>
         </div>`
      : `<div class="cm-empty">${esc(e.message)}</div>`;
    return;
  }
  const list = d.artists || [];
  const tab = params.tab || sessionStorage.getItem(TAB_KEY) || 'artists';

  el.innerHTML = `
    <div class="cm-sqtabs" id="faTabs">
      <button class="cm-sqtab${tab === 'artists' ? ' on' : ''}" data-k="artists">歌手</button>
      <button class="cm-sqtab${tab === 'songs' ? ' on' : ''}" data-k="songs">新歌</button>
      <button class="cm-sqtab${tab === 'mvs' ? ' on' : ''}" data-k="mvs">新 MV</button>
      <button class="cm-sqtab${tab === 'mixed' ? ' on' : ''}" data-k="mixed">综合</button>
    </div>
    <div id="faBody"></div>`;

  el.querySelectorAll('#faTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(TAB_KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#faBody');

  if (tab === 'artists') {
    body.innerHTML = `
      <div class="cm-sec-head"><h2>关注的歌手</h2>
        <span class="cm-sec-sub">${d.count ?? list.length} 位 · 来自网易云</span></div>
      ${list.length ? `<div class="cm-artist-grid" id="faGrid">${list.map(a => `
        <div class="cm-artist-card" data-aid="${a.artist_id}">
          <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=160y160" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
          <div class="cm-artist-name">${esc(a.name || '歌手')}</div>
          ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
        </div>`).join('')}</div>`
        : `<div class="cm-empty">还没有关注的歌手<br><span class="cm-empty-sub">在歌手主页点「关注歌手」即可（与网易云同步）</span></div>`}
      ${d.hasMore ? `<div class="cm-sq-stats" style="margin-top:12px"><span class="material-icons-outlined">info</span>仅显示前 100 位（网易云接口限制）</div>` : ''}`;
    body.querySelectorAll('#faGrid .cm-artist-card').forEach(c => {
      c.onclick = () => { location.hash = `#/artist/${c.dataset.aid}`; };
    });
    return;
  }

  // 三个「新作」TAB 共用的空态与错误态
  const fail = e => {
    body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}${e.status === 401 || e.status === 400
      ? '<br><span class="cm-empty-sub">该功能需绑定网易云账号</span>' : ''}</div>`;
  };

  if (tab === 'songs') {
    body.innerHTML = '<div class="cm-loading" style="padding:30px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    api.ncm('/artist/new/song', { limit: 30 }).then(r => {
      const songs = ncmSongs(pickList(r, 'songs', 'data'));
      if (!songs.length) { body.innerHTML = '<div class="cm-empty small">关注的歌手最近没有新歌</div>'; return; }
      body.innerHTML = `<div class="cm-sec-head"><h2>关注歌手的新歌</h2>
        <span class="cm-sec-more" id="faPlayAll"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
        <div id="faSongList"></div>`;
      renderSongList(body.querySelector('#faSongList'), songs, { onPlay: i => player.playList(songs, i) });
      body.querySelector('#faPlayAll').onclick = async ev => {
        const btn = ev.currentTarget;
        try {
          // 播放全部走专用接口（一次拿全量列表，避免前端反复翻页）
          const all = await api.ncm('/artist/new/song/playall');
          const full = ncmSongs(pickList(all, 'songs', 'data'));
          player.playList(full.length ? full : songs, 0);
        } catch {
          player.playList(songs, 0);
        }
        void btn;
      };
    }).catch(fail);
    return;
  }

  if (tab === 'mvs') {
    body.innerHTML = '<div class="cm-loading" style="padding:30px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    api.ncm('/artist/new/mv', { limit: 24 }).then(r => {
      const mvs = pickList(r, 'mvs', 'data');
      if (!mvs.length) { body.innerHTML = '<div class="cm-empty small">关注的歌手最近没有新 MV</div>'; return; }
      body.innerHTML = `<div class="cm-plgrid">${mvs.map(m => `
        <div class="cm-plcard" data-mvid="${m.id || m.mvid}">
          <div class="cm-plcover">${(m.cover || m.picUrl || m.imgurl) ? `<img src="${esc(m.cover || m.picUrl || m.imgurl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">videocam</span></div>
          <div class="cm-plname">${esc(m.name || '')}</div>
          <div class="cm-plsub">${esc(m.artistName || '')}</div>
        </div>`).join('')}</div>`;
      body.querySelectorAll('.cm-plcard').forEach(c => {
        c.onclick = () => { location.hash = `#/mv/${c.dataset.mvid}`; };
      });
    }).catch(fail);
    return;
  }

  // 综合流：/artist/new/song/mv/list/v2 同时给出歌曲与 MV（上游分页游标是 before）
  body.innerHTML = '<div class="cm-loading" style="padding:30px 0"><mdui-circular-progress></mdui-circular-progress></div>';
  api.ncm('/artist/new/song/mv/list/v2', { limit: 30, before: 0, firstRequest: true, sourceType: 0, startTimestamp: 0 }).then(r => {
    const items = pickList(r, 'data', 'list', 'songs');
    if (!items.length) { body.innerHTML = '<div class="cm-empty small">暂无新作</div>'; return; }
    const songs = ncmSongs(items.filter(x => (x.type === undefined || x.type === 0 || x.song) && (x.id || x.song)).map(x => x.song || x));
    const mvs = items.filter(x => x.type === 1 || x.mvid);
    body.innerHTML = `
      ${songs.length ? `<div class="cm-sec"><div class="cm-sec-head"><h2>新歌</h2>
        <span class="cm-sec-more" id="faMixedPlay"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
        <div id="faMixedSongs"></div></div>` : ''}
      ${mvs.length ? `<div class="cm-sec"><div class="cm-sec-head"><h2>新 MV</h2></div>
        <div class="cm-plgrid">${mvs.map(m => `
          <div class="cm-plcard" data-mvid="${m.id || m.mvid}">
            <div class="cm-plcover">${(m.cover || m.picUrl) ? `<img src="${esc(m.cover || m.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">videocam</span></div>
            <div class="cm-plname">${esc(m.name || '')}</div>
            <div class="cm-plsub">${esc(m.artistName || '')}</div>
          </div>`).join('')}</div></div>` : ''}`;
    if (songs.length) {
      renderSongList(body.querySelector('#faMixedSongs'), songs, { onPlay: i => player.playList(songs, i) });
      body.querySelector('#faMixedPlay').onclick = () => player.playList(songs, 0);
    }
    body.querySelectorAll('.cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/mv/${c.dataset.mvid}`; };
    });
  }).catch(fail);
}
