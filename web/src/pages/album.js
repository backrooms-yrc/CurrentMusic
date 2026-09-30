// 专辑详情页（#/album/:tagId → :id）
// 数据：/album（含元数据与曲目，走后端已归一的路由）、/album/detail/dynamic、
//      /album/privilege、/related/playlist、/album/sub（写）、/ugc/album/get（账号读）
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast, renderSongList } from '../ui.js';
import { player } from '../player.js';

const fmtDate = ms => {
  const n = Number(ms);
  if (!n) return '';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtNum = n => {
  const v = Number(n) || 0;
  return v >= 10000 ? (v / 10000).toFixed(1) + ' 万' : String(v);
};

export async function render(el, params = []) {
  const id = String(params[0] || '');
  if (!id) { el.innerHTML = '<div class="cm-empty">缺少专辑参数</div>'; return; }

  el.innerHTML = '<div class="cm-loading" style="padding:40px 0"><mdui-circular-progress></mdui-circular-progress></div>';

  let al;
  try {
    al = await api.album(id);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">专辑加载失败：${esc(e.message)}</div>`;
    return;
  }
  const songs = al.songs || [];
  const meta = [fmtDate(al.publishTime), al.company, al.subType, al.size ? `${al.size} 首` : '']
    .filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="cm-detail-head cm-album-head">
      <div class="cm-detail-cover">${al.pic ? `<img src="${esc(al.pic)}?param=300y300" onerror="this.remove()">` : ''}<span class="material-icons-outlined">album</span></div>
      <div>
        <h2>${esc(al.name || '专辑')}</h2>
        <div class="cm-detail-sub">${esc(al.artist || '')}</div>
        <div class="cm-detail-sub">${esc(meta)}</div>
        <div class="cm-detail-actions">
          <mdui-button variant="filled" id="alPlay"><span class="material-icons-outlined">play_arrow</span>播放全部</mdui-button>
          <mdui-button variant="tonal" id="alSub"><span class="material-icons-outlined">favorite_border</span>收藏专辑</mdui-button>
          <mdui-button variant="tonal" id="alCmt"><span class="material-icons-outlined">comment</span>评论</mdui-button>
        </div>
      </div>
    </div>
    <div class="cm-detail-sub" id="alStats"></div>
    ${al.description ? `<div class="cm-sec"><div class="cm-sec-head"><h2>专辑介绍</h2></div>
      <div class="cm-al-desc" id="alDesc">${esc(al.description)}</div></div>` : ''}
    <div class="cm-sec"><div class="cm-sec-head"><h2>曲目（${songs.length}）</h2></div><div id="alSongs"></div></div>
    <div class="cm-sec" id="alRelatedSec" hidden><div class="cm-sec-head"><h2>相关歌单</h2></div><div class="cm-plgrid" id="alRelated"></div></div>
    <div class="cm-sec" id="alWikiSec" hidden><div class="cm-sec-head"><h2>专辑百科</h2></div><div id="alWiki"></div></div>`;

  el.querySelector('#alPlay').onclick = () => {
    if (!songs.length) return toast('专辑暂无曲目');
    player.playList(songs, 0);
  };
  el.querySelector('#alCmt').onclick = () => {
    import('../comments.js').then(m => m.openComments({ type: 3, id, title: al.name || '专辑' }))
      .catch(() => toast('评论加载失败'));
  };

  // 简介折叠（过长时）
  const desc = el.querySelector('#alDesc');
  if (desc && desc.textContent.length > 160) {
    desc.classList.add('cm-al-desc-clamp');
    desc.insertAdjacentHTML('afterend', '<span class="cm-sec-more" id="alDescMore">展开</span>');
    desc.nextElementSibling.onclick = ev => {
      const on = desc.classList.toggle('cm-al-desc-clamp');
      ev.target.textContent = on ? '展开' : '收起';
    };
  }

  // 曲目
  if (songs.length) {
    await renderSongList(el.querySelector('#alSongs'), songs, { onPlay: i => player.playList(songs, i) });
  } else {
    el.querySelector('#alSongs').innerHTML = '<div class="cm-empty small">暂无曲目</div>';
  }

  // 动态信息 + 收藏状态 + 播放权限（/album/privilege）
  let isSub = false;
  api.ncm('/album/detail/dynamic', { id }).then(d => {
    isSub = !!d.isSub;
    const bits = [];
    if (d.subCount) bits.push(`收藏 ${fmtNum(d.subCount)}`);
    if (d.commentCount) bits.push(`评论 ${fmtNum(d.commentCount)}`);
    if (d.shareCount) bits.push(`分享 ${fmtNum(d.shareCount)}`);
    const box = el.querySelector('#alStats');
    if (box) box.textContent = bits.join(' · ');
    const btn = el.querySelector('#alSub');
    if (btn && isSub) {
      btn.innerHTML = '<span class="material-icons-outlined">favorite</span>已收藏';
      btn.setAttribute('variant', 'filled');
    }
  }).catch(() => {});

  // 播放权限（付费/码率）：进页面异步补一行，失败静默
  import('./albums.js').then(m => m.privilegeSummary(id)).then(text => {
    if (!text) return;
    const box = el.querySelector('#alStats');
    if (box) box.insertAdjacentHTML('afterend', `<div class="cm-detail-sub">${esc(text)}</div>`);
  }).catch(() => {});

  // 收藏/取消收藏（T2 写操作：需绑定网易云 + confirm=1）
  el.querySelector('#alSub').onclick = async ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    try {
      await api.ncm('/album/sub', { id, t: isSub ? 0 : 1, confirm: 1 });
      isSub = !isSub;
      btn.innerHTML = isSub
        ? '<span class="material-icons-outlined">favorite</span>已收藏'
        : '<span class="material-icons-outlined">favorite_border</span>收藏专辑';
      btn.setAttribute('variant', isSub ? 'filled' : 'tonal');
      toast(isSub ? '已收藏到网易云' : '已取消收藏');
    } catch (e) {
      toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
    } finally { btn.loading = false; }
  };

  // 相关歌单
  api.ncm('/related/playlist', { id }).then(d => {
    const list = (d.playlists || []).slice(0, 6);
    if (!list.length) return;
    const sec = el.querySelector('#alRelatedSec');
    sec.hidden = false;
    el.querySelector('#alRelated').innerHTML = list.map(pl => `
      <div class="cm-plcard" data-id="${pl.id}">
        <div class="cm-plcover">${pl.coverImgUrl ? `<img src="${esc(pl.coverImgUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
        <div class="cm-plname">${esc(pl.name)}</div>
        <div class="cm-plsub">${pl.playCount ? fmtNum(pl.playCount) + '播放' : ''}</div>
      </div>`).join('');
    el.querySelectorAll('#alRelated .cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; };
    });
  }).catch(() => {});

  // 专辑百科（账号维度；未绑定会 401，静默不显示）
  if (auth.token) {
    api.ncm('/ugc/album/get', { id }).then(d => {
      const texts = [];
      const walk = o => {
        if (!o) return;
        if (typeof o === 'string') { if (o.trim().length > 1) texts.push(o); return; }
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (typeof o === 'object') { if (typeof o.text === 'string') texts.push(o.text); else Object.values(o).forEach(walk); }
      };
      walk(d.data || d);
      const uniq = [...new Set(texts)].filter(t => !/^https?:/.test(t)).slice(0, 5);
      if (!uniq.length) return;
      el.querySelector('#alWikiSec').hidden = false;
      el.querySelector('#alWiki').innerHTML = `<div class="cm-si-wiki">${uniq.map(t => `<p>${esc(t)}</p>`).join('')}</div>`;
    }).catch(() => {});
  }
}
