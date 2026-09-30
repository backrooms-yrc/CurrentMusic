// 电台（DJ / 播客电台）阶段五新增
// 列表：/dj/recommend、/dj/personalize/recommend、/dj/today/perfered、/dj/catelist、
//      /dj/radio/hot、/dj/category/recommend、/dj/category/excludehot、/dj/hot、
//      /dj/toplist、/dj/toplist/{newcomer,popular,pay,hours}、/dj/program/toplist{,/hours}、
//      /djRadio/top、/dj/banner、/dj/paygift、/dj/recommend/type、/dj/sublist
// 详情：/dj/detail、/dj/program、/dj/program/detail、/dj/subscriber
// 数字电台 DI.FM：/dj/difm/all/style/channel、/dj/difm/playing/tracks/list、
//                /dj/difm/subscribe/channels/get
// 写：  /dj/sub、/dj/difm/channel/subscribe、/dj/difm/channel/unsubscribe（均 T2）
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast, fmtCount, skelGrid, confirmDialog } from '../ui.js';
import { player } from '../player.js';

const KEY = 'cm.radioTab';

const radioCard = r => `
  <div class="cm-plcard" data-rid="${r.id}">
    <div class="cm-plcover">${r.picUrl ? `<img src="${esc(r.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">radio</span></div>
    <div class="cm-plname">${esc(r.name)}</div>
    <div class="cm-plsub">${r.programCount ? `${r.programCount} 期` : ''}${r.subCount ? ` · ${fmtCount(r.subCount)}订阅` : ''}</div>
  </div>`;

function bindRadios(scope, sel = '.cm-plcard') {
  scope.querySelectorAll(sel).forEach(c => {
    if (c.dataset.rid) c.onclick = () => { location.hash = `#/radio/${c.dataset.rid}`; };
  });
}

export async function render(el, params = []) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:44px">radio</span>
      <div>登录后可订阅电台、查看我的订阅</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button></div>`;
    return;
  }
  // #/radio/:rid → 电台详情；#/radio → 列表
  if (params[0] && params[0] !== 'list') return renderDetail(el, String(params[0]));
  return renderList(el);
}

async function renderList(el) {
  const tab = sessionStorage.getItem(KEY) || 'rec';
  const TABS = [
    { k: 'rec', l: '推荐' },
    { k: 'cat', l: '分类' },
    { k: 'top', l: '榜单' },
    { k: 'mine', l: '我的订阅' },
    { k: 'difm', l: '数字电台' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="rdTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="rdBody">${skelGrid(6)}</div>`;
  el.querySelectorAll('#rdTabs .cm-sqtab').forEach(b => {
    b.onclick = () => { sessionStorage.setItem(KEY, b.dataset.k); renderList(el); };
  });
  // 用 dataset 记住当前 tab：重绘时从 sessionStorage 取，避免把状态塞进 URL
  sessionStorage.setItem(KEY, tab);
  const body = el.querySelector('#rdBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  if (tab === 'rec') {
    body.innerHTML = skelGrid(6);
    const [recR, perR, banR, typeR] = await Promise.allSettled([
      api.ncm('/dj/recommend'),
      api.ncm('/dj/personalize/recommend', { limit: 6 }),
      api.ncm('/dj/banner'),
      api.ncm('/dj/recommend/type', { type: 0 }),
    ]);
    const rec = recR.status === 'fulfilled' ? (recR.value.djRadios || []) : [];
    const per = perR.status === 'fulfilled' ? (perR.value.data || []) : [];
    const banners = banR.status === 'fulfilled' ? (banR.value.data || []) : [];
    const typed = typeR.status === 'fulfilled' ? (typeR.value.djRadios || typeR.value.data || []) : [];
    body.innerHTML = `
      ${banners.length ? `<div class="cm-hscroll">${banners.map(b => `
        <div class="cm-card" ${b.id ? `data-rid="${b.id}"` : ''}>
          <img src="${esc(b.picUrl || b.pic || '')}?param=600y240" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(b.name || b.typeTitle || '')}</div>
        </div>`).join('')}</div>` : ''}
      ${per.length ? `<section class="cm-sec"><div class="cm-sec-head"><h2>为你推荐</h2>
        <span class="cm-sec-sub">/dj/personalize/recommend</span></div>
        <div class="cm-plgrid">${per.map(radioCard).join('')}</div></section>` : ''}
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>推荐电台</h2><span class="cm-sec-sub">/dj/recommend</span></div>
        ${rec.length ? `<div class="cm-plgrid">${rec.slice(0, 12).map(radioCard).join('')}</div>`
          : '<div class="cm-empty small">上游未返回推荐</div>'}
      </section>
      ${typed.length ? `<section class="cm-sec"><div class="cm-sec-head"><h2>分类精选</h2>
        <span class="cm-sec-sub">/dj/recommend/type</span></div>
        <div class="cm-plgrid">${typed.slice(0, 6).map(radioCard).join('')}</div></section>` : ''}
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>今日优选</h2><span class="cm-sec-sub">/dj/today/perfered</span></div>
        <div id="rdToday"><div class="cm-empty small">加载中…</div></div>
      </section>`;
    bindRadios(body);
    // 今日优选：上游按 page 翻页，且常返回空（如实展示）
    api.ncm('/dj/today/perfered', { page: 1 }).then(d => {
      const list = d.data || [];
      const box = body.querySelector('#rdToday');
      if (!box) return;
      box.innerHTML = list.length
        ? `<div class="cm-plgrid">${list.map(radioCard).join('')}</div>`
        : '<div class="cm-empty small">上游今天没有返回优选内容</div>';
      bindRadios(box);
    }).catch(() => {
      const box = body.querySelector('#rdToday');
      if (box) box.textContent = '加载失败';
    });
    return;
  }

  if (tab === 'cat') {
    body.innerHTML = skelGrid(6);
    let cats = [], cur = null;
    try {
      const d = await api.ncm('/dj/catelist');
      cats = d.categories || [];
      cur = cats[0] || null;
    } catch (e) { fail(e); return; }
    const draw = list => {
      body.innerHTML = `
        <div class="cm-plsort"><span class="cm-plsort-l">分类</span>
          ${cats.slice(0, 30).map(c => `<mdui-chip ${cur && c.id === cur.id ? 'selected' : ''} data-c="${c.id}">${esc(c.name)}</mdui-chip>`).join('')}</div>
        <div class="cm-plgrid">${list.map(radioCard).join('') || '<div class="cm-empty small">该分类暂无电台</div>'}</div>`;
      body.querySelectorAll('[data-c]').forEach(ch => {
        ch.onclick = () => {
          cur = cats.find(c => String(c.id) === ch.dataset.c);
          loadCat().catch(e => toast(e.message));
        };
      });
      bindRadios(body);
    };
    const loadCat = async () => {
      if (!cur) return;
      const d = await api.ncm('/dj/radio/hot', { cateId: cur.id, limit: 30, offset: 0 });
      draw(d.djRadios || []);
    };
    await loadCat();

    // 分类附带的两个维度（推荐 / 排除热门）与热门榜，作为页面下半部分的补充
    const extra = document.createElement('section');
    extra.className = 'cm-sec';
    extra.innerHTML = '<div class="cm-sec-head"><h2>热门与推荐</h2><span class="cm-sec-sub">/dj/hot · /dj/category/*</span></div><div id="rdCatExtra"></div>';
    body.appendChild(extra);
    Promise.allSettled([
      api.ncm('/dj/hot', { limit: 6, offset: 0 }),
      api.ncm('/dj/category/recommend'),
      api.ncm('/dj/category/excludehot'),
    ]).then(([hotR, recR, excR]) => {
      const groups = [
        ['热门电台', hotR.status === 'fulfilled' ? (hotR.value.djRadios || []) : [], '/dj/hot'],
        ['分类推荐', recR.status === 'fulfilled' ? (recR.value.data || recR.value.djRadios || []) : [], '/dj/category/recommend'],
        ['新晋分类', excR.status === 'fulfilled' ? (excR.value.data || excR.value.categories || []) : [], '/dj/category/excludehot'],
      ];
      const box = body.querySelector('#rdCatExtra');
      if (!box) return;
      box.innerHTML = groups.map(([title, list, path]) => list.length ? `
        <div class="cm-sec-head" style="margin-top:10px"><h2 style="font-size:14px">${title}</h2>
          <span class="cm-sec-sub">${path}</span></div>
        <div class="cm-chips">${list.slice(0, 12).map(x =>
          `<span class="cm-hot" ${x.id ? `data-rid="${x.id}"` : ''}>${esc(x.name || '')}</span>`).join('')}</div>` : '').join('')
        || '<div class="cm-empty small">上游未返回</div>';
      box.querySelectorAll('[data-rid]').forEach(c => { c.onclick = () => { location.hash = `#/radio/${c.dataset.rid}`; }; });
    });
    return;
  }

  if (tab === 'top') {
    body.innerHTML = skelGrid(6);
    const TOP_TYPES = [
      { k: 'hot', l: '热榜', path: '/dj/toplist', extra: { type: 'hot' } },
      { k: 'newcomer', l: '新人榜', path: '/dj/toplist/newcomer', extra: { limit: 30, offset: 0 } },
      { k: 'popular', l: '流行榜', path: '/dj/toplist/popular', extra: { limit: 30 } },
      { k: 'pay', l: '付费榜', path: '/dj/toplist/pay', extra: { limit: 30 } },
      { k: 'hours', l: '24 小时', path: '/dj/toplist/hours', extra: { limit: 30 } },
      { k: 'prog', l: '节目榜', path: '/dj/program/toplist', extra: { limit: 30, offset: 0 } },
      { k: 'progH', l: '节目 24 小时', path: '/dj/program/toplist/hours', extra: { limit: 30 } },
      { k: 'radio', l: 'djRadio', path: '/djRadio/top', extra: { dataType: 1, dataGapDays: 7, sortIndex: 0 } },
    ];
    let cur = TOP_TYPES[0];
    const draw = list => {
      body.innerHTML = `
        <div class="cm-plsort"><span class="cm-plsort-l">榜单</span>
          ${TOP_TYPES.map(t => `<mdui-chip ${t.k === cur.k ? 'selected' : ''} data-t="${t.k}">${t.l}</mdui-chip>`).join('')}</div>
        <div class="cm-plgrid">${list.map(radioCard).join('') || '<div class="cm-empty small">该榜单暂无数据</div>'}</div>
        <div class="cm-sec"><div class="cm-sec-head"><h2>赞助榜</h2><span class="cm-sec-sub">/dj/paygift</span></div>
          <div id="rdPay"></div></div>`;
      body.querySelectorAll('[data-t]').forEach(ch => {
        ch.onclick = () => { cur = TOP_TYPES.find(t => t.k === ch.dataset.t); load().catch(e => toast(e.message)); };
      });
      bindRadios(body);
      api.ncm('/dj/paygift', { limit: 6, offset: 0 }).then(d => {
        const box = body.querySelector('#rdPay');
        const list2 = d.data || d.djRadios || [];
        if (box) box.innerHTML = list2.length
          ? `<div class="cm-plgrid">${list2.map(radioCard).join('')}</div>`
          : '<div class="cm-empty small">上游未返回</div>';
        if (box) bindRadios(box);
      }).catch(() => {});
    };
    const load = async () => {
      const d = await api.ncm(cur.path, cur.extra);
      // 各榜单外层字段不统一：toplist / data.list / djRadios / data
      const list = d.toplist || (d.data && (d.data.list || d.data)) || d.djRadios || d.data || [];
      draw(Array.isArray(list) ? list : []);
    };
    try { await load(); } catch (e) { fail(e); }
    return;
  }

  if (tab === 'mine') {
    body.innerHTML = skelGrid(6);
    let offset = 0;
    const load = async append => {
      let d;
      try { d = await api.ncm('/dj/sublist', { limit: 30, offset }); } catch (e) { fail(e); return; }
      const list = d.djRadios || [];
      if (!append) body.innerHTML = '';
      if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">还没有订阅电台</div>'; return; }
      body.insertAdjacentHTML('beforeend', `<div class="cm-plgrid" data-batch="${offset}">${list.map(r => `
        <div class="cm-plcard" data-rid="${r.id}">
          <div class="cm-plcover">${r.picUrl ? `<img src="${esc(r.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">radio</span></div>
          <div class="cm-plname">${esc(r.name)}</div>
          <div class="cm-plsub">${r.programCount || 0} 期
            <i class="cm-si-act" data-unsub="${r.id}">退订</i>
            <i class="cm-si-act" data-subs="${r.id}">订阅者</i></div>
        </div>`).join('')}</div>`);
      body.querySelectorAll('[data-rid]').forEach(c => {
        c.onclick = ev => {
          if (ev.target.closest('[data-unsub]') || ev.target.closest('[data-subs]')) return;
          location.hash = `#/radio/${c.dataset.rid}`;
        };
      });
      body.querySelectorAll('[data-unsub]').forEach(x => {
        x.onclick = () => confirmDialog({
          title: '退订这个电台？', body: '',
          onOk: () => api.ncm('/dj/sub', { rid: x.dataset.unsub, t: 0, confirm: 1 })
            .then(() => { toast('已退订'); renderList(el); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      });
      body.querySelectorAll('[data-subs]').forEach(x => {
        x.onclick = () => subscribersDialog(x.dataset.subs);
      });
      offset += list.length;
      body.querySelector('#rdMore')?.remove();
      if (d.hasMore || offset < (d.count || 0)) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="rdMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#rdMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  // 数字电台 DI.FM：频道列表（公开）+ 我正在听的频道（账号）+ 订阅开关（写）
  body.innerHTML = skelGrid(6);
  try {
    const [allR, mineR] = await Promise.allSettled([
      api.ncm('/dj/difm/all/style/channel', { sources: '[0]' }),
      api.ncm('/dj/difm/subscribe/channels/get'),
    ]);
    const all = allR.status === 'fulfilled' ? (allR.value.data || []) : [];
    const mine = mineR.status === 'fulfilled'
      ? ((mineR.value.data && (mineR.value.data.channels || mineR.value.data)) || [])
      : [];
    const mineIds = new Set((Array.isArray(mine) ? mine : []).map(x => x && (x.channelId || x.id)));
    const channels = [];
    (Array.isArray(all) ? all : []).forEach(g => {
      (g.channels || g.styles || []).forEach(c => channels.push({ ...c, style: g.name || g.styleName }));
    });
    body.innerHTML = `
      <div class="cm-sq-stats"><span class="material-icons-outlined">podcasts</span>
        数字电台频道 ${channels.length} 个 · 已订阅 ${mineIds.size} 个</div>
      <div class="cm-plgrid">${channels.slice(0, 60).map(c => {
        const id = c.channelId || c.id;
        const on = mineIds.has(id);
        return `<div class="cm-plcard" data-ch="${id}">
          <div class="cm-plcover">${c.coverUrl || c.picUrl ? `<img src="${esc(c.coverUrl || c.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">podcasts</span></div>
          <div class="cm-plname">${esc(c.name || '')}</div>
          <div class="cm-plsub">${esc(c.style || '')} <i class="cm-si-act" data-toggle="${id}" data-on="${on ? 1 : 0}">${on ? '取消订阅' : '订阅'}</i>
            <i class="cm-si-act" data-now="${id}">在播</i></div>
        </div>`;
      }).join('') || '<div class="cm-empty small">上游未返回频道</div>'}</div>`;
    body.querySelectorAll('[data-toggle]').forEach(x => {
      x.onclick = () => {
        const id = x.dataset.toggle;
        const on = x.dataset.on === '1';
        confirmDialog({
          title: on ? '取消订阅该频道？' : '订阅该频道？', body: '',
          onOk: () => api.ncm(on ? '/dj/difm/channel/unsubscribe' : '/dj/difm/channel/subscribe',
            { channelId: id, confirm: 1 })
            .then(() => { toast(on ? '已取消订阅' : '已订阅'); renderList(el); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    body.querySelectorAll('[data-now]').forEach(x => {
      x.onclick = async () => {
        try {
          const d = await api.ncm('/dj/difm/playing/tracks/list', { channelId: x.dataset.now, limit: 10, source: 0 });
          const list = d.data || d.tracks || [];
          toast(list.length ? `在播：${list.slice(0, 3).map(t => t.name || (t.song && t.song.name) || '').filter(Boolean).join(' / ')}`
            : (d.msg || '该频道暂无在播曲目'));
        } catch (e) { toast(e.message); }
      };
    });
  } catch (e) { fail(e); }
}

/** 电台详情：/dj/detail + /dj/program（节目列表，可分页）+ 订阅开关。 */
async function renderDetail(el, rid) {
  el.innerHTML = `<div class="cm-loading" style="padding:40px 0"><mdui-circular-progress></mdui-circular-progress></div>`;
  let d;
  try { d = await api.ncm('/dj/detail', { rid }); } catch (e) {
    el.innerHTML = `<div class="cm-empty">电台加载失败：${esc(e.message)}</div>`;
    return;
  }
  const radio = d.data || {};
  const dj = radio.dj || {};
  let subed = !!radio.subed;
  el.innerHTML = `
    <div class="cm-detail-head">
      <div class="cm-detail-cover">${radio.picUrl ? `<img src="${esc(radio.picUrl)}?param=300y300" onerror="this.remove()">` : '<span class="material-icons-outlined">radio</span>'}</div>
      <div>
        <h2>${esc(radio.name || '')}</h2>
        <div class="cm-detail-sub">${esc(dj.nickname || '')}${radio.programCount ? ` · ${radio.programCount} 期` : ''}${radio.subCount ? ` · ${fmtCount(radio.subCount)}订阅` : ''}</div>
        <div class="cm-detail-sub">${esc(radio.desc || '')}</div>
        <div class="cm-detail-actions">
          <mdui-button variant="filled" id="rdSub"><span class="material-icons-outlined">favorite_border</span>订阅电台</mdui-button>
          <mdui-button variant="tonal" id="rdSubs">订阅者</mdui-button>
        </div>
      </div>
    </div>
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>节目</h2><span class="cm-sec-sub">/dj/program</span></div>
      <div id="rdProgs"></div>
    </section>`;
  const paintSub = on => {
    const b = el.querySelector('#rdSub');
    b.innerHTML = on
      ? '<span class="material-icons-outlined">favorite</span>已订阅'
      : '<span class="material-icons-outlined">favorite_border</span>订阅电台';
    b.setAttribute('variant', on ? 'filled' : 'tonal');
  };
  paintSub(subed);
  el.querySelector('#rdSub').onclick = () => confirmDialog({
    title: subed ? '退订这个电台？' : '订阅这个电台？', body: '',
    onOk: () => api.ncm('/dj/sub', { rid, t: subed ? 0 : 1, confirm: 1 })
      .then(() => { subed = !subed; paintSub(subed); toast(subed ? '已订阅' : '已退订'); })
      .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
  });
  el.querySelector('#rdSubs').onclick = () => subscribersDialog(rid);

  const box = el.querySelector('#rdProgs');
  let offset = 0;
  // 播放要构造完整歌曲对象（标题/歌手/时长），所以按节目 id 记住它的 mainSong。
  // 只把 mainSong.id 塞进 data-* 会得到"空名字"的播放项，列表里看着像丢了信息。
  const songsByProgram = new Map();
  const load = async append => {
    if (!append) box.innerHTML = '<div class="cm-loading" style="padding:16px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    let pd;
    try { pd = await api.ncm('/dj/program', { rid, limit: 30, offset, asc: false }); } catch (e) {
      box.innerHTML = `<div class="cm-empty small">节目加载失败：${esc(e.message)}</div>`;
      return;
    }
    const programs = pd.programs || [];
    if (!append) box.innerHTML = '';
    if (!programs.length && !append) { box.innerHTML = '<div class="cm-empty small">该电台还没有节目</div>'; return; }
    box.insertAdjacentHTML('beforeend', programs.map(p => {
      const s = p.mainSong || {};
      if (p.id) songsByProgram.set(String(p.id), s);
      return `<div class="cm-lm-item" data-pid="${p.id}">
        <div class="cm-lm-lyric">${esc(p.name || s.name || '')}</div>
        <div class="cm-lm-meta"><span>${esc((s.ar || []).map(a => a.name).join(' / '))}</span>
        <span><i class="cm-si-act" data-play="${p.id || ''}">播放</i><i class="cm-si-act" data-detail="1">详情</i></span></div>
      </div>`;
    }).join(''));
    box.querySelectorAll('[data-play]').forEach(x => {
      x.onclick = () => {
        const song = songsByProgram.get(x.dataset.play);
        if (!song || !song.id) return toast('该节目没有可播放的音频');
        const songs = ncmSongs([song]);
        if (songs.length) player.playList(songs, 0);
      };
    });
    box.querySelectorAll('[data-detail]').forEach(x => {
      x.onclick = () => programDialog(x.closest('[data-pid]').dataset.pid);
    });
    offset += programs.length;
    box.querySelector('#rdProgMore')?.remove();
    if (pd.more || offset < (pd.count || 0)) {
      box.insertAdjacentHTML('beforeend',
        '<div class="cm-sq-more" id="rdProgMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
      box.querySelector('#rdProgMore mdui-button').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };
  await load(false);
}

/** 节目详情（/dj/program/detail）。 */
function programDialog(id) {
  const diag = document.createElement('mdui-dialog');
  diag.headline = '节目详情';
  diag.innerHTML = '<div id="rdProgBox"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>';
  document.body.appendChild(diag);
  diag.open = true;
  api.ncm('/dj/program/detail', { id }).then(d => {
    const p = d.program || d.data || {};
    const s = p.mainSong || {};
    const box = diag.querySelector('#rdProgBox');
    box.innerHTML = `
      <div class="cm-ev-text" style="font-weight:650">${esc(p.name || s.name || '')}</div>
      <div class="cm-detail-sub">${esc((s.ar || []).map(a => a.name).join(' / '))}${p.duration ? ` · ${Math.round(p.duration / 60000)} 分钟` : ''}</div>
      ${p.description ? `<div class="cm-al-desc">${esc(p.description)}</div>` : ''}`;
  }).catch(e => {
    const box = diag.querySelector('#rdProgBox');
    if (box) box.textContent = `加载失败：${e.message}`;
  });
}

/** 订阅者列表（/dj/subscriber）。 */
function subscribersDialog(rid) {
  const diag = document.createElement('mdui-dialog');
  diag.headline = '订阅者';
  diag.innerHTML = '<div id="rdSubsBox" class="cm-pe-list"><div class="cm-pe-hint">加载中…</div></div>';
  document.body.appendChild(diag);
  diag.open = true;
  api.ncm('/dj/subscriber', { id: rid, limit: 30, time: 0 }).then(d => {
    const users = d.subscribers || [];
    const box = diag.querySelector('#rdSubsBox');
    box.innerHTML = users.length ? users.map(u => `
      <div class="cm-pe-row"><span>${esc(u.nickname || '')} <i>${esc(u.signature || '')}</i></span></div>`).join('')
      : '<div class="cm-pe-hint">暂无订阅者</div>';
  }).catch(e => {
    const box = diag.querySelector('#rdSubsBox');
    if (box) box.textContent = `加载失败：${e.message}`;
  });
}
