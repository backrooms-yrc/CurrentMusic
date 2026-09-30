// MV 详情页与 MV 列表页（阶段三新增）
// 详情：/mv/detail、/mv/detail/info、/mv/url、/simi/mv、/mv/sub（T2 写）
// 列表：/mv/all、/mv/first、/mv/exclusive/rcmd、/mv/sublist（T1 账号读）
// 评论走通用抽屉（CM 类型 1 = MV），与歌曲/专辑/歌单同一套实现。
import { api, auth } from '../api.js';
import { esc, toast, fmtCount } from '../ui.js';
import { openMlog } from '../mlog.js';

const AREAS = ['全部', '内地', '港台', '欧美', '日本', '韩国'];
const ORDERS = ['上升最快', '最热', '最新', '独家'];

const fmtTime = ms => {
  const s = Math.round((Number(ms) || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const mvCard = m => `
  <div class="cm-plcard" data-mvid="${m.id}">
    <div class="cm-plcover">${m.cover ? `<img src="${esc(m.cover)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">videocam</span></div>
    <div class="cm-plname">${esc(m.name)}</div>
    <div class="cm-plsub">${esc(m.artistName || (m.artists || []).map(a => a.name).join(' / '))}${m.playCount ? ` · ${fmtCount(m.playCount)}` : ''}</div>
  </div>`;

/** 通用评论抽屉（与专辑页同一入口，避免把评论模块打进首屏包）。 */
function openComments(type, id, title) {
  import('../comments.js')
    .then(m => m.openComments({ type, id, title }))
    .catch(() => toast('评论加载失败'));
}

/** 挂载一个 <video>（MV 与视频共用）：拿到播放地址后再赋值，缺地址时降级为提示。 */
function playMedia(box, { load, cover }) {
  api.ncm(load.path, load.params).then(d => {
    const url = (d.data || {}).url;
    if (!url) {
      box.innerHTML = '<div class="cm-empty small">该资源暂无播放地址（可能受版权或地区限制）</div>';
      return;
    }
    box.innerHTML = `<video class="cm-media" controls playsinline preload="metadata"${cover ? ` poster="${esc(cover)}"` : ''}></video>`;
    const v = box.querySelector('video');
    v.src = url;
    v.onerror = () => { box.innerHTML = '<div class="cm-empty small">播放失败，请稍后重试</div>'; };
  }).catch(e => {
    box.innerHTML = `<div class="cm-empty small">播放地址获取失败：${esc(e.message)}</div>`;
  });
}

// ---------------- MV 详情 ----------------

async function renderDetail(el, id) {
  el.innerHTML = '<div class="cm-loading" style="padding:40px 0"><mdui-circular-progress></mdui-circular-progress></div>';
  let d;
  try {
    d = await api.ncm('/mv/detail', { mvid: id });
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">MV 加载失败：${esc(e.message)}</div>`;
    return;
  }
  const mv = d.data || d;
  if (!mv || !mv.id) { el.innerHTML = '<div class="cm-empty">未找到该 MV</div>'; return; }
  const meta = [mv.artistName, mv.publishTime, mv.duration ? fmtTime(mv.duration) : '', mv.playCount ? `${fmtCount(mv.playCount)}次播放` : '']
    .filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="cm-media-box" id="mvBox"></div>
    <div class="cm-detail-head cm-mv-head">
      <div>
        <h2>${esc(mv.name)}</h2>
        <div class="cm-detail-sub">${esc(meta)}</div>
        <div class="cm-detail-sub" id="mvStats"></div>
        <div class="cm-detail-actions">
          <mdui-button variant="tonal" id="mvSub"><span class="material-icons-outlined">favorite_border</span>收藏 MV</mdui-button>
          <mdui-button variant="tonal" id="mvCmt"><span class="material-icons-outlined">comment</span>评论</mdui-button>
          <mdui-button variant="tonal" id="mvLike"><span class="material-icons-outlined">thumb_up</span>点赞 MV</mdui-button>
          ${mv.artistId ? `<mdui-button variant="text" id="mvArtist"><span class="material-icons-outlined">person</span>歌手页</mdui-button>` : ''}
        </div>
      </div>
    </div>
    ${mv.desc ? `<section class="cm-sec"><div class="cm-sec-head"><h2>MV 介绍</h2></div><div class="cm-al-desc">${esc(mv.desc)}</div></section>` : ''}
    <section class="cm-sec" id="mvSimiSec" hidden><div class="cm-sec-head"><h2>相似 MV</h2></div><div class="cm-plgrid" id="mvSimi"></div></section>
    <section class="cm-sec" id="mvMlogSec" hidden><div class="cm-sec-head"><h2>同曲 MLOG</h2></div><div class="cm-hscroll" id="mvMlog"></div></section>
    <section class="cm-sec" id="mvWikiSec" hidden><div class="cm-sec-head"><h2>MV 百科</h2></div><div id="mvWiki"></div></section>`;

  playMedia(el.querySelector('#mvBox'), { load: { path: '/mv/url', params: { id: mv.id, r: 1080 } }, cover: mv.cover });
  el.querySelector('#mvCmt').onclick = () => openComments(1, mv.id, mv.name);
  const aBtn = el.querySelector('#mvArtist');
  if (aBtn) aBtn.onclick = () => { location.hash = `#/artist/${mv.artistId}`; };

  // 收藏状态与计数（T0 只读；subed 来自 /mv/detail，liked 来自 /mv/detail/info）
  let subed = !!mv.subed;
  const paintSub = on => {
    const b = el.querySelector('#mvSub');
    if (!b) return;
    b.innerHTML = on
      ? '<span class="material-icons-outlined">favorite</span>已收藏'
      : '<span class="material-icons-outlined">favorite_border</span>收藏 MV';
    b.setAttribute('variant', on ? 'filled' : 'tonal');
  };
  paintSub(subed);
  api.ncm('/mv/detail/info', { mvid: mv.id }).then(info => {
    const bits = [];
    if (info.likedCount) bits.push(`收藏 ${fmtCount(info.likedCount)}`);
    if (info.commentCount) bits.push(`评论 ${fmtCount(info.commentCount)}`);
    if (info.shareCount) bits.push(`分享 ${fmtCount(info.shareCount)}`);
    const box = el.querySelector('#mvStats');
    if (box) box.textContent = bits.join(' · ');
  }).catch(() => {});

  // 点赞 MV（/resource/like，T2；type=1 表示 MV，上游按资源类型拼 threadId）
  el.querySelector('#mvLike').onclick = ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    api.ncm('/resource/like', { type: 1, id: mv.id, t: 1, confirm: 1 })
      .then(() => { toast('已点赞'); btn.innerHTML = '<span class="material-icons-outlined">thumb_up</span>已点赞'; })
      .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message))
      .finally(() => { btn.loading = false; });
  };

  // 收藏/取消（T2：需绑定网易云 + confirm=1）
  el.querySelector('#mvSub').onclick = async ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    try {
      await api.ncm('/mv/sub', { mvid: mv.id, t: subed ? 0 : 1, confirm: 1 });
      subed = !subed;
      paintSub(subed);
      toast(subed ? '已收藏到网易云' : '已取消收藏');
    } catch (e) {
      toast(/绑定|绑定网易云|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
    } finally { btn.loading = false; }
  };

  // 相似 MV
  api.ncm('/simi/mv', { mvid: mv.id }).then(s => {
    const list = (s.mvs || []).slice(0, 9);
    if (!list.length) return;
    const sec = el.querySelector('#mvSimiSec');
    sec.hidden = false;
    el.querySelector('#mvSimi').innerHTML = list.map(mvCard).join('');
    el.querySelectorAll('#mvSimi .cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/mv/${c.dataset.mvid}`; };
    });
  }).catch(() => {});

  // 同曲 MLOG：/mlog/music/rcmd 按 mvid 给出关联 MLOG；播放地址走 /mlog/url，
  // 若该 MLOG 有对应视频则用 /mlog/to/video 转换后跳到视频页播放。
  api.ncm('/mlog/music/rcmd', { mvid: mv.id, limit: 6 }).then(r => {
    const feeds = ((r.data || {}).feeds || []).map(f => {
      const base = (f.resource || {}).mlogBaseData || {};
      return { id: base.id || f.id, name: base.text || base.originalTitle || 'MLOG', cover: base.coverUrl, duration: base.duration };
    }).filter(f => f.id);
    if (!feeds.length) return;
    const sec = el.querySelector('#mvMlogSec');
    sec.hidden = false;
    el.querySelector('#mvMlog').innerHTML = feeds.map(f => `
      <div class="cm-card" data-mlog="${esc(f.id)}">
        <img src="${esc(f.cover || mv.cover)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
        <div class="cm-card-name">${esc(f.name)}</div>
        <div class="cm-card-sub">${f.duration ? fmtTime(f.duration) : 'MLOG'}</div>
      </div>`).join('');
    el.querySelectorAll('#mvMlog .cm-card').forEach(c => {
      c.onclick = () => openMlog(c.dataset.mlog, mv.cover);
    });
  }).catch(() => {});

  // MV 百科（账号维度；未绑定会 401，静默不显示）
  if (auth.token) {
    api.ncm('/ugc/mv/get', { id: mv.id }).then(d => {
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
      el.querySelector('#mvWikiSec').hidden = false;
      el.querySelector('#mvWiki').innerHTML = `<div class="cm-si-wiki">${uniq.map(t => `<p>${esc(t)}</p>`).join('')}</div>`;
    }).catch(() => {});
  }
}

// ---------------- MV 列表 ----------------

const TABS = [
  { key: 'all', label: '全部 MV' },
  { key: 'first', label: '最新 MV' },
  { key: 'excl', label: '独家推荐' },
  { key: 'sub', label: '我的收藏' },
];

async function renderList(el, params = {}) {
  const state = { tab: params.tab || 'all', area: params.area || '全部', order: params.order || '上升最快', offset: 0, items: [] };
  const TAB_KEY = 'cm.mvTab';
  state.tab = params.tab || sessionStorage.getItem(TAB_KEY) || 'all';

  el.innerHTML = `
    <div class="cm-sqtabs" id="mvTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.key === state.tab ? ' on' : ''}" data-k="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="mvFilter"></div>
    <div id="mvList" class="cm-plgrid"></div>`;

  el.querySelectorAll('#mvTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(TAB_KEY, b.dataset.k);
      renderList(el, { tab: b.dataset.k });
    };
  });

  const listBox = el.querySelector('#mvList');
  const filterBox = el.querySelector('#mvFilter');

  // 全部 MV：地区 / 排序两个维度（/mv/all）；最新 MV：只看地区（/mv/first）
  if (state.tab === 'all' || state.tab === 'first') {
    filterBox.innerHTML = `
      <div class="cm-plsort"><span class="cm-plsort-l">地区</span>
        ${AREAS.map(a => `<mdui-chip ${a === state.area ? 'selected' : ''} data-area="${a}">${a}</mdui-chip>`).join('')}</div>
      ${state.tab === 'all' ? `<div class="cm-plsort"><span class="cm-plsort-l">排序</span>
        ${ORDERS.map(o => `<mdui-chip ${o === state.order ? 'selected' : ''} data-order="${o}">${o}</mdui-chip>`).join('')}</div>` : ''}`;
    filterBox.querySelectorAll('[data-area]').forEach(c => {
      c.onclick = () => renderList(el, { tab: state.tab, area: c.dataset.area, order: state.order });
    });
    filterBox.querySelectorAll('[data-order]').forEach(c => {
      c.onclick = () => renderList(el, { tab: state.tab, area: state.area, order: c.dataset.order });
    });
  }

  listBox.innerHTML = '<div class="cm-loading" style="grid-column:1/-1"><mdui-circular-progress></mdui-circular-progress></div>';

  const load = async (offset, append) => {
    let d;
    try {
      if (state.tab === 'all') {
        d = await api.ncm('/mv/all', { area: state.area, order: state.order, type: '全部', limit: 30, offset });
      } else if (state.tab === 'first') {
        d = await api.ncm('/mv/first', { area: state.area, limit: 30, offset });
      } else if (state.tab === 'excl') {
        d = await api.ncm('/mv/exclusive/rcmd', { limit: 30, offset });
      } else {
        d = await api.ncm('/mv/sublist', { limit: 30, offset });
      }
    } catch (e) {
      listBox.innerHTML = `<div class="cm-empty" style="grid-column:1/-1">${state.tab === 'sub'
        ? '需先绑定网易云账号才能看「我的 MV 收藏」'
        : '加载失败：' + esc(e.message)}</div>`;
      return;
    }
    const rows = d.data || d.mvs || [];
    if (!append) listBox.innerHTML = '';
    if (!rows.length && !append) {
      listBox.innerHTML = `<div class="cm-empty small" style="grid-column:1/-1">${state.tab === 'sub' ? '还没有收藏 MV' : '暂无 MV'}</div>`;
      return;
    }
    listBox.insertAdjacentHTML('beforeend', rows.map(mvCard).join(''));
    listBox.querySelectorAll('.cm-plcard').forEach(c => {
      if (c.dataset.bound) return;
      c.dataset.bound = '1';
      c.onclick = () => { location.hash = `#/mv/${c.dataset.mvid}`; };
    });
    const more = state.tab === 'all' ? d.hasMore : rows.length >= 30;
    listBox.querySelector('#mvMore')?.remove();
    if (more) {
      listBox.insertAdjacentHTML('beforeend',
        `<div class="cm-sq-more" id="mvMore" style="grid-column:1/-1"><mdui-button variant="tonal">加载更多</mdui-button></div>`);
      listBox.querySelector('#mvMore mdui-button').onclick = ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        load(offset + rows.length, true).finally(() => { btn.loading = false; });
      };
    }
  };
  await load(0, false);
}

export async function render(el, params = []) {
  if (!params || params[0] === 'list') return renderList(el, {});
  return renderDetail(el, String(params[0]));
}
