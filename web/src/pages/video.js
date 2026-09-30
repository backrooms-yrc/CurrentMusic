// 视频详情页与视频广场（阶段三新增）
// 详情：/video/detail、/video/detail/info、/video/url、/related/allvideo、/video/sub（T2 写）
// 广场：/video/timeline/recommend、/video/timeline/all、/video/category/list、
//      /video/group/list、/video/group
// 评论走通用抽屉（CM 类型 5 = 视频）。
import { api } from '../api.js';
import { esc, toast, fmtCount } from '../ui.js';

const fmtTime = ms => {
  const s = Math.round((Number(ms) || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 视频卡片：广场与详情页的「相关视频」共用。 */
const videoCard = v => `
  <div class="cm-plcard" data-vid="${esc(v.vid || v.id || '')}">
    <div class="cm-plcover cm-cover-16x9">${v.coverUrl || v.cover ? `<img src="${esc(v.coverUrl || v.cover)}?param=400y225" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">play_circle</span></div>
    <div class="cm-plname">${esc(v.title || v.name || '')}</div>
    <div class="cm-plsub">${esc((v.creator && v.creator.nickname) || '')}${v.playTime ? ` · ${fmtCount(v.playTime)}播放` : ''}${v.durationms ? ` · ${fmtTime(v.durationms)}` : ''}</div>
  </div>`;

function openComments(id, title) {
  import('../comments.js')
    .then(m => m.openComments({ type: 5, id, title }))
    .catch(() => toast('评论加载失败'));
}

function bindCards(root, sel) {
  root.querySelectorAll(sel).forEach(c => {
    if (c.dataset.bound) return;
    c.dataset.bound = '1';
    c.onclick = () => { if (c.dataset.vid) location.hash = `#/video/${c.dataset.vid}`; };
  });
}

/** 播放视频：先取地址，再挂 <video>；缺地址时给出可读原因。 */
function playVideo(box, vid, cover) {
  api.ncm('/video/url', { id: vid }).then(d => {
    const url = (d.urls && d.urls[0] && d.urls[0].url) || (d.data && d.data.url);
    if (!url) {
      box.innerHTML = '<div class="cm-empty small">该视频暂无播放地址（可能受版权或地区限制）</div>';
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

// ---------------- 视频详情 ----------------

async function renderDetail(el, vid) {
  el.innerHTML = '<div class="cm-loading" style="padding:40px 0"><mdui-circular-progress></mdui-circular-progress></div>';
  // 注意参数名：/video/detail 上游读的是 `id`，而 /video/detail/info 读的是 `vid`
  // （两者不一致，曾把 id 传成 vid 导致上游 502 —— 已在 tools/ncm-smoke.py 钉住）。
  // 详情失败不阻塞整页：播放地址与计数都能独立取到，缺了详情也要能看能收藏。
  const [detailR, infoR] = await Promise.allSettled([
    api.ncm('/video/detail', { id: vid }),
    api.ncm('/video/detail/info', { vid }),
  ]);
  const v = detailR.status === 'fulfilled' ? (detailR.value.data || {}) : {};
  const info0 = infoR.status === 'fulfilled' ? infoR.value : {};
  const degraded = detailR.status !== 'fulfilled';
  v.vid = v.vid || vid;
  const meta = [(v.creator && v.creator.nickname), v.publishTime ? new Date(v.publishTime).toLocaleDateString('zh-CN') : '', v.durationms ? fmtTime(v.durationms) : '']
    .filter(Boolean).join(' · ');

  el.innerHTML = `
    <div class="cm-media-box" id="vdBox"></div>
    <div class="cm-detail-head cm-mv-head">
      <div>
        <h2>${esc(v.title || '视频')}</h2>
        <div class="cm-detail-sub">${esc(meta)}</div>
        ${degraded ? '<div class="cm-detail-sub">详情接口暂不可用，已降级为「可播放 + 计数 + 评论」</div>' : ''}
        <div class="cm-detail-sub" id="vdStats"></div>
        <div class="cm-detail-actions">
          <mdui-button variant="tonal" id="vdSub"><span class="material-icons-outlined">favorite_border</span>收藏视频</mdui-button>
          <mdui-button variant="tonal" id="vdCmt"><span class="material-icons-outlined">comment</span>评论</mdui-button>
          ${v.creator && v.creator.userId ? `<mdui-button variant="text" id="vdUser"><span class="material-icons-outlined">person</span>UP 主</mdui-button>` : ''}
        </div>
      </div>
    </div>
    ${v.description ? `<section class="cm-sec"><div class="cm-sec-head"><h2>简介</h2></div><div class="cm-al-desc">${esc(v.description)}</div></section>` : ''}
    <section class="cm-sec" id="vdRelSec" hidden><div class="cm-sec-head"><h2>相关视频</h2></div><div class="cm-plgrid" id="vdRel"></div></section>`;

  playVideo(el.querySelector('#vdBox'), v.vid, v.coverUrl);
  el.querySelector('#vdCmt').onclick = () => openComments(v.vid, v.title || '视频');
  const uBtn = el.querySelector('#vdUser');
  if (uBtn) uBtn.onclick = () => { location.hash = `#/u/${v.creator.userId}`; };

  // 计数（/video/detail/info 返回 likedCount/commentCount/shareCount 与 subed/liked）
  let subed = !!v.subed;
  const paintSub = on => {
    const b = el.querySelector('#vdSub');
    if (!b) return;
    b.innerHTML = on
      ? '<span class="material-icons-outlined">favorite</span>已收藏'
      : '<span class="material-icons-outlined">favorite_border</span>收藏视频';
    b.setAttribute('variant', on ? 'filled' : 'tonal');
  };
  paintSub(subed);
  {
    const info = info0;
    if (info.subed !== undefined) { subed = !!info.subed; paintSub(subed); }
    const bits = [];
    if (v.playTime) bits.push(`播放 ${fmtCount(v.playTime)}`);
    if (info.likedCount) bits.push(`点赞 ${fmtCount(info.likedCount)}`);
    if (info.commentCount) bits.push(`评论 ${fmtCount(info.commentCount)}`);
    if (info.shareCount) bits.push(`分享 ${fmtCount(info.shareCount)}`);
    const box = el.querySelector('#vdStats');
    if (box) box.textContent = bits.join(' · ');
  }

  // 收藏/取消（T2：需绑定网易云 + confirm=1）
  el.querySelector('#vdSub').onclick = async ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    try {
      await api.ncm('/video/sub', { id: v.vid, t: subed ? 0 : 1, confirm: 1 });
      subed = !subed;
      paintSub(subed);
      toast(subed ? '已收藏到网易云' : '已取消收藏');
    } catch (e) {
      toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
    } finally { btn.loading = false; }
  };

  // 相关视频（上游对该维度常返回空，空则不显示区块）
  api.ncm('/related/allvideo', { id: v.vid }).then(r => {
    const list = (r.data || []).slice(0, 9);
    if (!list.length) return;
    const sec = el.querySelector('#vdRelSec');
    sec.hidden = false;
    el.querySelector('#vdRel').innerHTML = list.map(videoCard).join('');
    bindCards(el, '#vdRel .cm-plcard');
  }).catch(() => {});
}

// ---------------- 视频广场 ----------------

const TABS = [
  { key: 'rec', label: '推荐' },
  { key: 'all', label: '最新' },
  { key: 'cat', label: '分类' },
];

async function renderHome(el, params = {}) {
  const TAB_KEY = 'cm.videoTab';
  const tab = params.tab || sessionStorage.getItem(TAB_KEY) || 'rec';

  el.innerHTML = `
    <div class="cm-sqtabs" id="vdTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.key === tab ? ' on' : ''}" data-k="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="vdFilter"></div>
    <div id="vdList" class="cm-plgrid"></div>`;

  el.querySelectorAll('#vdTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(TAB_KEY, b.dataset.k);
      renderHome(el, { tab: b.dataset.k });
    };
  });
  const listBox = el.querySelector('#vdList');
  const filterBox = el.querySelector('#vdFilter');

  const appendCards = (list, offset, emptyMsg) => {
    if (!offset) listBox.innerHTML = '';
    if (!list.length && !offset) {
      listBox.innerHTML = `<div class="cm-empty small" style="grid-column:1/-1">${esc(emptyMsg || '该维度暂无视频')}</div>`;
      return;
    }
    listBox.insertAdjacentHTML('beforeend', list.map(videoCard).join(''));
    bindCards(el, '#vdList .cm-plcard');
  };

  const loadMore = (next) => {
    listBox.querySelector('#vdMore')?.remove();
    listBox.insertAdjacentHTML('beforeend',
      '<div class="cm-sq-more" id="vdMore" style="grid-column:1/-1"><mdui-button variant="tonal">加载更多</mdui-button></div>');
    listBox.querySelector('#vdMore mdui-button').onclick = async ev => {
      const btn = ev.currentTarget;
      btn.loading = true;
      try { await next(); } catch (e) { toast(e.message); } finally { btn.loading = false; }
    };
  };

  if (tab === 'cat') {
    // 分类：/video/group/list 给出分类分组，/video/group 拉该分类下的视频
    let groups = [], cur = null, offset = 0;
    filterBox.innerHTML = '<div class="cm-plsort"><span class="cm-plsort-l">分类</span><span id="vdGroups"></span></div>';
    const drawGroups = () => {
      const box = el.querySelector('#vdGroups');
      if (!box) return;
      box.innerHTML = groups.map(g => `<mdui-chip ${cur && cur.id === g.id ? 'selected' : ''} data-g="${g.id}">${esc(g.name)}</mdui-chip>`).join('');
      box.querySelectorAll('[data-g]').forEach(c => {
        c.onclick = () => {
          cur = groups.find(g => String(g.id) === c.dataset.g);
          offset = 0;
          drawGroups();
          load(true).catch(e => toast(e.message));
        };
      });
    };
    const load = async (reset) => {
      if (!cur) return;
      const d = await api.ncm('/video/group', { id: cur.id, offset: reset ? 0 : offset });
      const datas = (d.datas || []).map(x => x.data || x);
      offset = reset ? datas.length : offset + datas.length;
      appendCards(datas, reset ? 0 : 1, '该分类在上游暂无返回（/video/group 实测恒为空，已记为上游降级项）');
      if (datas.length) loadMore(() => load(false));
    };
    listBox.innerHTML = '<div class="cm-loading" style="grid-column:1/-1"><mdui-circular-progress></mdui-circular-progress></div>';
    try {
      const d = await api.ncm('/video/group/list');
      groups = d.data || [];
      cur = groups[0] || null;
      drawGroups();
      if (!cur) throw new Error('暂无视频分类');
      await load(true);
    } catch (e) {
      listBox.innerHTML = `<div class="cm-empty" style="grid-column:1/-1">分类加载失败：${esc(e.message)}</div>`;
    }

    // 分类清单接口同时用于「分类导航」兜底展示（部分分类来自 /video/category/list）
    api.ncm('/video/category/list', { limit: 30, offset: 0 }).then(d => {
      const cats = d.data || [];
      if (!cats.length || !el.querySelector('#vdGroups')) return;
      const box = el.querySelector('#vdGroups');
      cats.forEach(c => {
        if (groups.some(g => String(g.id) === String(c.id))) return;
        const chip = document.createElement('mdui-chip');
        chip.textContent = c.name;
        chip.dataset.g = c.id;
        chip.onclick = () => {
          cur = { id: c.id, name: c.name };
          offset = 0;
          load(true).catch(e => toast(e.message));
        };
        box.appendChild(chip);
      });
    }).catch(() => {});
    return;
  }

  listBox.innerHTML = '<div class="cm-loading" style="grid-column:1/-1"><mdui-circular-progress></mdui-circular-progress></div>';
  let offset = 0;
  const load = async (reset) => {
    const path = tab === 'rec' ? '/video/timeline/recommend' : '/video/timeline/all';
    const d = await api.ncm(path, { offset: reset ? 0 : offset });
    const datas = (d.datas || []).map(x => x.data || x).filter(x => x && (x.vid || x.id));
    offset = reset ? datas.length : offset + datas.length;
    appendCards(datas, reset ? 0 : 1, '该维度暂无视频（上游可能需登录态，返回为空）');
    if (datas.length) loadMore(() => load(false));
  };
  try { await load(true); } catch (e) {
    listBox.innerHTML = `<div class="cm-empty" style="grid-column:1/-1">加载失败：${esc(e.message)}</div>`;
  }
}

export async function render(el, params = []) {
  if (!params || params[0] === 'home') return renderHome(el, {});
  return renderDetail(el, String(params[0]));
}
