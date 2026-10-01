// 听歌足迹与播放记录（阶段四新增）
// 统计：/listen/data/total、/listen/data/report、/listen/data/realtime/report、
//      /listen/data/today/song、/listen/data/song/play/rank、/listen/data/year/report
// 记录：/record/recent/{song,album,dj,playlist,video,voice}、/recent/listen/list、
//      /history/recommend/songs、/history/recommend/songs/detail、/user/record
// 歌单：/user/playlist、/user/playlist/collect、/user/playlist/create
// 全部是 T1 账号态接口：必须用调用者自己的网易云 cookie（未绑定给引导，不发请求）。
//
// 上游已知降级：/summary/annual 实测 404（该年度总结接口已下线）→ 页面给明确说明，
// 年度维度改用 /listen/data/year/report（它返回逐年播放次数与时长）。
import { api, auth } from '../api.js';
import { esc, toast, fmtCount, fmtDur, skelList } from '../ui.js';

const KEY = 'cm.footKey';
const TAB_KEY = 'cm.footTab';

const fmtMin = ms => {
  const n = Number(ms) || 0;
  if (!n) return '0 分钟';
  if (n >= 3600000) return `${(n / 3600000).toFixed(1)} 小时`;
  return `${Math.round(n / 60000)} 分钟`;
};
const fmtDate = ts => {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

// 六类最近播放：路径**逐条写死**（不要拼 `/record/recent/${kind}`）——
// 拼接路径既让覆盖率工具无法核对前端到底调了哪几个接口，也让"新增类型忘了加路径"这类
// 改动变得不可见。这里显式列出，新增类型必须同时补路径。
const RECORD_KINDS = [
  { k: 'song', l: '歌曲', path: '/record/recent/song' },
  { k: 'playlist', l: '歌单', path: '/record/recent/playlist' },
  { k: 'album', l: '专辑', path: '/record/recent/album' },
  { k: 'dj', l: '电台', path: '/record/recent/dj' },
  { k: 'video', l: '视频', path: '/record/recent/video' },
  { k: 'voice', l: '播客', path: '/record/recent/voice' },
];

/** 统一的「未绑定」引导：T1 接口在没有绑定网易云时一定会 401。 */
function needBind(el, text = '听歌足迹与你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">insights</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) {
    needBind(el, '登录后可查看你在网易云的听歌足迹与播放记录');
    return;
  }
  // 绑定信息：uid 是 /user/* 与 /user/record 的必需参数
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'overview';
  const TABS = [
    { k: 'overview', l: '总览' },
    { k: 'recent', l: '最近播放' },
    { k: 'playlist', l: '我的歌单' },
    { k: 'year', l: '年度报告' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="ftTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="ftBody">${skelList(6)}</div>`;
  el.querySelectorAll('#ftTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#ftBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  if (tab === 'overview') {
    // 五路并行，任一路失败只影响自己那块
    const [totalR, weekR, realR, todayR, rankR, recentR, histR] = await Promise.allSettled([
      api.ncm('/listen/data/total'),
      api.ncm('/listen/data/report', { type: 'week' }),
      api.ncm('/listen/data/realtime/report', { type: 'week' }),
      api.ncm('/listen/data/today/song'),
      api.ncm('/listen/data/song/play/rank', { type: 'week' }),
      api.ncm('/recent/listen/list', { limit: 12 }),
      api.ncm('/history/recommend/songs'),
    ]);
    const dataOf = r => (r.status === 'fulfilled' ? (r.value.data || {}) : {});
    const total = dataOf(totalR);
    const week = dataOf(weekR);
    const real = dataOf(realR);
    const today = dataOf(todayR);
    const rank = dataOf(rankR);
    const recent = dataOf(recentR);
    const hist = dataOf(histR);

    const cards = [];
    if (total.totalDuration !== undefined) {
      cards.push(`<div class="cm-card cm-stat-card"><div class="cm-stat-num">${fmtMin(total.totalDuration * 1000)}</div><div class="cm-stat-l">累计听歌时长</div></div>`);
    }
    if (week.listenTimeBlock) {
      cards.push(`<div class="cm-card cm-stat-card"><div class="cm-stat-num">${fmtMin(week.listenTimeBlock.totalDuration || 0)}</div><div class="cm-stat-l">本周（${esc(week.type || 'week')}）</div></div>`);
    }
    if (real.listenTimeBlock) {
      cards.push(`<div class="cm-card cm-stat-card"><div class="cm-stat-num">${fmtMin(real.listenTimeBlock.totalDuration || 0)}</div><div class="cm-stat-l">实时统计</div></div>`);
    }
    if (today.songCount !== undefined) {
      cards.push(`<div class="cm-card cm-stat-card"><div class="cm-stat-num">${today.songCount}</div><div class="cm-stat-l">今日听歌</div></div>`);
    }
    const rankItems = (rank.songItems || []).slice(0, 10);
    const recentItems = (recent.resources || []).slice(0, 12);
    const histDates = hist.dates || [];

    body.innerHTML = `
      ${cards.length ? `<div class="cm-hscroll cm-stat-row">${cards.join('')}</div>` : ''}
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>本周听得最多</h2>
          <span class="cm-sec-sub">/listen/data/song/play/rank</span></div>
        ${rankItems.length ? `<div class="cm-stat-list">${rankItems.map(x => `
          <div class="cm-lm-item"><div class="cm-lm-lyric">${esc(x.songName || x.name || '')}</div>
          <div class="cm-lm-meta"><span>${esc(x.artistName || '')}</span><span>${fmtCount(x.playCount || x.listenCount || 0)} 次</span></div></div>`).join('')}</div>`
        : '<div class="cm-empty small">本周还没有足够的播放数据</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>最近常听</h2>
          <span class="cm-sec-sub">/recent/listen/list</span></div>
        ${recentItems.length ? `<div class="cm-hscroll">${recentItems.map(x => `
          <div class="cm-card" ${x.resourceType === 'list' ? `data-pid="${x.resourceId}"` : ''}>
            <img src="${esc(x.picUrl || (x.resource && x.resource.picUrl) || '')}?param=200y200" loading="lazy" onerror="this.classList.add('none')">
            <div class="cm-card-name">${esc(x.name || (x.resource && x.resource.name) || '')}</div>
            <div class="cm-card-sub">${esc(x.resourceType || '')}</div>
          </div>`).join('')}</div>`
        : '<div class="cm-empty small">暂无最近常听</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>历史日推</h2>
          <span class="cm-sec-more" id="ftHist">查看某天</span></div>
        <div class="cm-chips">${histDates.map(d => `<span class="cm-hot" data-d="${esc(d)}">${esc(d)}</span>`).join('') || '<span class="cm-empty small">暂无历史日推</span>'}</div>
        <div id="ftHistBox"></div>
      </section>`;
    body.querySelectorAll('[data-d]').forEach(c => {
      c.onclick = () => loadHist(c.dataset.d);
    });
    const hb = body.querySelector('#ftHist');
    if (hb) hb.onclick = () => { if (histDates[0]) loadHist(histDates[0]); };
    body.querySelectorAll('[data-pid]').forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.pid}`; };
    });

    async function loadHist(date) {
      const box = body.querySelector('#ftHistBox');
      if (!box) return;
      box.innerHTML = '<div class="cm-loading" style="padding:16px 0"><mdui-circular-progress></mdui-circular-progress></div>';
      try {
        const d = await api.ncm('/history/recommend/songs/detail', { date });
        const songs = (d.data || d.songs || []);
        box.innerHTML = songs.length
          ? `<div class="cm-empty small">${esc(date)}：${songs.length} 首</div>`
          : `<div class="cm-empty small">${esc(date)} 没有记录</div>`;
      } catch (e) { box.innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`; }
    }
    return;
  }

  if (tab === 'recent') {
    let kind = params.kind || 'song';
    body.innerHTML = `
      <div class="cm-plsort" id="ftKinds"><span class="cm-plsort-l">类型</span>
        ${RECORD_KINDS.map(k => `<mdui-chip ${k.k === kind ? 'selected' : ''} data-k="${k.k}">${k.l}</mdui-chip>`).join('')}</div>
      <div id="ftList">${skelList(6)}</div>`;
    const listBox = body.querySelector('#ftList');
    const load = async () => {
      listBox.innerHTML = skelList(6);
      try {
        const path = (RECORD_KINDS.find(x => x.k === kind) || RECORD_KINDS[0]).path;
        const d = await api.ncm(path, { limit: 50 });
        const list = (d.data || {}).list || [];
        listBox.innerHTML = list.length
          ? list.map(x => {
            const inner = x.data || x.resource || {};
            return `<div class="cm-lm-item">
              <div class="cm-lm-lyric">${esc(inner.name || inner.title || x.resourceId)}</div>
              <div class="cm-lm-meta"><span>${esc(inner.artistName || (inner.artist && inner.artist.name) || '')}</span>
              <span>${fmtDate(x.playTime)}</span></div></div>`;
          }).join('')
          : '<div class="cm-empty small">该类型还没有播放记录</div>';
      } catch (e) { fail(e); }
    };
    body.querySelectorAll('#ftKinds mdui-chip').forEach(c => {
      c.onclick = () => {
        kind = c.dataset.k;
        body.querySelectorAll('#ftKinds mdui-chip').forEach(x => x.toggleAttribute('selected', x === c));
        load();
      };
    });
    await load();

    // 播放记录（按时间轴，需要 uid）：与「最近播放」互补
    const recBox = document.createElement('section');
    recBox.className = 'cm-sec';
    recBox.innerHTML = '<div class="cm-sec-head"><h2>播放记录</h2><span class="cm-sec-sub">/user/record</span></div><div id="ftUserRec">加载中…</div>';
    body.appendChild(recBox);
    api.ncm('/user/record', { uid, type: 0 }).then(d => {
      const list = ((d.weekData || d.allData) || []).slice(0, 20);
      const box = body.querySelector('#ftUserRec');
      if (!box) return;
      box.innerHTML = list.length
        ? `<div class="cm-stat-list">${list.map(x => `
            <div class="cm-lm-item"><div class="cm-lm-lyric">${esc((x.song && x.song.name) || '')}</div>
            <div class="cm-lm-meta"><span>${esc((x.song && (x.song.ar || []).map(a => a.name).join(' / ')) || '')}</span>
            <span>${x.playCount || 0} 次</span></div></div>`).join('')}</div>`
        : '<div class="cm-empty small">暂无播放记录</div>';
    }).catch(() => {
      const box = body.querySelector('#ftUserRec');
      if (box) box.textContent = '播放记录需要绑定后才有数据';
    });
    return;
  }

  if (tab === 'playlist') {
    body.innerHTML = skelList(6);
    const [own, collect, created] = await Promise.allSettled([
      api.ncm('/user/playlist', { uid, limit: 100, offset: 0 }),
      api.ncm('/user/playlist/collect', { uid, limit: 50, offset: 0 }),
      api.ncm('/user/playlist/create', { uid, limit: 50, offset: 0 }),
    ]);
    const listsOf = r => (r.status === 'fulfilled' ? ((r.value.playlist || r.value.data || [])) : []);
    const groups = [
      { title: '我的歌单', sub: '/user/playlist', list: listsOf(own) },
      { title: '我收藏的歌单', sub: '/user/playlist/collect', list: listsOf(collect) },
      { title: '我创建的歌单', sub: '/user/playlist/create', list: listsOf(created) },
    ];
    const total = groups.reduce((n, g) => n + g.list.length, 0);
    if (!total) { body.innerHTML = '<div class="cm-empty small">读取不到歌单（上游三个维度都为空）</div>'; return; }
    body.innerHTML = groups.map(g => `
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>${g.title}</h2><span class="cm-sec-sub">${esc(g.sub)}</span></div>
        ${g.list.length ? `<div class="cm-plgrid">${g.list.map(pl => `
          <div class="cm-plcard" data-pid="${pl.id}">
            <div class="cm-plcover">${pl.coverImgUrl ? `<img src="${esc(pl.coverImgUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
            <div class="cm-plname">${esc(pl.name)}</div>
            <div class="cm-plsub">${pl.trackCount || 0} 首</div>
          </div>`).join('')}</div>` : '<div class="cm-empty small">空</div>'}
      </section>`).join('');
    body.querySelectorAll('.cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.pid}`; };
    });
    return;
  }

  // 年度报告：/listen/data/year/report 可用；/summary/annual 上游已 404（如实标注）
  body.innerHTML = skelList(6);
  const [yearR, annualR] = await Promise.allSettled([
    api.ncm('/listen/data/year/report', { year: new Date().getFullYear() }),
    api.ncm('/summary/annual', { year: new Date().getFullYear() - 1, uid }),
  ]);
  const years = yearR.status === 'fulfilled' ? (((yearR.value.data || {}).yearItems) || []) : [];
  body.innerHTML = `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>逐年听歌</h2><span class="cm-sec-sub">/listen/data/year/report</span></div>
      ${years.length ? `<div class="cm-stat-list">${years.map(y => `
        <div class="cm-lm-item"><div class="cm-lm-lyric">${y.year} 年</div>
        <div class="cm-lm-meta"><span>${y.playNum || 0} 次播放</span><span>${fmtDur(y.playDuration || 0)}</span></div></div>`).join('')}</div>`
      : '<div class="cm-empty small">暂无年度数据</div>'}
    </section>
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>年度总结</h2><span class="cm-sec-sub">/summary/annual</span></div>
      ${annualR.status === 'fulfilled'
        ? `<div class="cm-al-desc">${esc(JSON.stringify(annualR.value.data || {}).slice(0, 400))}</div>`
        : '<div class="cm-empty small">该接口在上游已下线（实测 404「接口未找到」），年度维度请用上面的逐年听歌</div>'}
    </section>`;
}
