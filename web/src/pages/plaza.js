// 歌单广场（阶段三新增）
// 浏览：/playlist/catlist（全部分类）、/playlist/category/list（按分类取歌单）、
//      /playlist/highquality/tags、/playlist/hot（标签维度）
// 我的：/playlist/mylike（我收藏的歌单，T1）、/playlist/video/recent（最近播放视频，T1）
// 写：  /playlist/create（T2）；导入与编辑在 playlist-edit.js 里
import { api, auth } from '../api.js';
import { esc, toast, skelGrid, fmtCount, promptDialog } from '../ui.js';

const KEY = 'cm.plazaTab';
const PAGE = 30;

const plCard = pl => `
  <div class="cm-plcard" data-pid="${pl.id}">
    <div class="cm-plcover">${(pl.coverImgUrl || pl.picUrl) ? `<img src="${esc(pl.coverImgUrl || pl.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
    <div class="cm-plname">${esc(pl.name)}</div>
    <div class="cm-plsub">${pl.trackCount || pl.playCount ? `${pl.trackCount || 0} 首 · ${fmtCount(pl.playCount || 0)}播放` : ''}</div>
  </div>`;

export async function render(el, params = {}) {
  const tab = params.tab || sessionStorage.getItem(KEY) || 'cat';
  const TABS = [
    { k: 'cat', l: '分类歌单' },
    { k: 'tag', l: '标签精选' },
    { k: 'mylike', l: '我的收藏' },
    { k: 'video', l: '最近视频' },
  ];

  el.innerHTML = `
    <div class="cm-sqtabs" id="pzTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div class="cm-sec-head"><h2>歌单广场</h2>
      <span class="cm-sec-more" id="pzCreate"><span class="material-icons-outlined">add</span> 新建歌单</span></div>
    <div id="pzFilter"></div>
    <div id="pzBody"></div>`;

  el.querySelectorAll('#pzTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#pzBody');
  const filter = el.querySelector('#pzFilter');

  // 新建歌单（T2 写：/playlist/create）
  el.querySelector('#pzCreate').onclick = () => promptDialog({
    title: '新建网易云歌单', label: '歌单名', placeholder: '例如：深夜电台',
    onOk: async name => {
      const r = await api.ncm('/playlist/create', { name, privacy: 0, confirm: 1 });
      const pid = r.id || (r.playlist && r.playlist.id) || r.pid;
      toast(pid ? `已创建歌单 ${pid}` : '已创建');
      if (pid) location.hash = `#/ncmpl/${pid}`;
    },
  });

  const paint = list => {
    body.innerHTML = list.length ? `<div class="cm-plgrid">${list.map(plCard).join('')}</div>`
      : '<div class="cm-empty small">暂无歌单</div>';
    body.querySelectorAll('.cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.pid}`; };
    });
  };

  if (tab === 'cat') {
    body.innerHTML = skelGrid(6);
    let cats = [], cur = '全部', offset = 0;
    try {
      const d = await api.ncm('/playlist/catlist');
      cats = [{ name: '全部' }].concat((d.sub || []).map(x => ({ name: x.name })));
    } catch { /* 分类拉不到时仍可按「全部」浏览 */ }
    const drawChips = () => {
      filter.innerHTML = `<div class="cm-plsort"><span class="cm-plsort-l">分类</span>
        ${cats.slice(0, 40).map(c => `<mdui-chip ${c.name === cur ? 'selected' : ''} data-c="${esc(c.name)}">${esc(c.name)}</mdui-chip>`).join('')}</div>`;
      filter.querySelectorAll('[data-c]').forEach(ch => {
        ch.onclick = () => { cur = ch.dataset.c; offset = 0; drawChips(); load(true).catch(e => toast(e.message)); };
      });
    };
    const load = async reset => {
      const d = await api.ncm('/playlist/category/list', { cat: cur, limit: PAGE, offset: reset ? 0 : offset });
      const list = d.playlists || [];
      offset = reset ? list.length : offset + list.length;
      if (reset) paint(list);
      else {
        const grid = body.querySelector('.cm-plgrid');
        if (grid) {
          grid.insertAdjacentHTML('beforeend', list.map(plCard).join(''));
          grid.querySelectorAll('.cm-plcard').forEach(c => {
            if (c.dataset.bound) return;
            c.dataset.bound = '1';
            c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.pid}`; };
          });
        } else {
          paint(list);
        }
      }
      body.querySelector('#pzMore')?.remove();
      if (list.length >= PAGE) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="pzMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#pzMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { await load(false); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    drawChips();
    try { await load(true); } catch (e) { body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`; }
    return;
  }

  if (tab === 'tag') {
    // 精品标签（/playlist/highquality/tags）与热门标签（/playlist/hot）合并成一个标签云；
    // 点标签后用 /playlist/category/list 按同名分类取歌单（上游分类名与标签名一致的部分）
    body.innerHTML = skelGrid(6);
    filter.innerHTML = '<div class="cm-plsort"><span class="cm-plsort-l">标签</span><span id="pzTags">加载中…</span></div>';
    try {
      const [hq, hot] = await Promise.allSettled([api.ncm('/playlist/highquality/tags'), api.ncm('/playlist/hot')]);
      const tags = [];
      if (hq.status === 'fulfilled') tags.push(...(hq.value.tags || []).map(t => ({ name: t.name, hot: false })));
      if (hot.status === 'fulfilled') tags.push(...(hot.value.tags || []).map(t => ({ name: t.name, hot: true })));
      const uniq = [];
      const seen = new Set();
      tags.forEach(t => { if (t.name && !seen.has(t.name)) { seen.add(t.name); uniq.push(t); } });
      const box = el.querySelector('#pzTags');
      if (!uniq.length) { box.textContent = '暂无标签'; paint([]); return; }
      box.innerHTML = uniq.slice(0, 40).map(t => `<mdui-chip ${t.hot ? 'selected' : ''} data-t="${esc(t.name)}">${esc(t.name)}</mdui-chip>`).join('');
      const loadTag = async tag => {
        body.innerHTML = skelGrid(6);
        const d = await api.ncm('/playlist/category/list', { cat: tag, limit: PAGE, offset: 0 });
        paint(d.playlists || []);
      };
      box.querySelectorAll('[data-t]').forEach(ch => {
        ch.onclick = () => {
          box.querySelectorAll('mdui-chip').forEach(x => x.removeAttribute('selected'));
          ch.setAttribute('selected', '');
          loadTag(ch.dataset.t).catch(e => { body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`; });
        };
      });
      await loadTag(uniq[0].name);
    } catch (e) {
      body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
    }
    return;
  }

  if (tab === 'mylike') {
    if (!requireBound(el, body, '我收藏的歌单与你的网易云账号同步，需先绑定')) return;
    body.innerHTML = skelGrid(6);
    try {
      const d = await api.ncm('/playlist/mylike', { limit: PAGE, time: 0 });
      const list = d.playlists || d.data || [];
      if (!list.length) { body.innerHTML = '<div class="cm-empty small">还没有收藏的歌单</div>'; return; }
      paint(list.map(pl => ({ id: pl.id, name: pl.name, coverImgUrl: pl.coverImgUrl, trackCount: pl.trackCount })));
    } catch (e) { body.innerHTML = boundError(e); }
    return;
  }

  // 最近播放的视频（T1）
  if (!requireBound(el, body, '最近播放的视频与你的网易云账号同步，需先绑定')) return;
  body.innerHTML = skelGrid(6);
  try {
    const d = await api.ncm('/playlist/video/recent');
    const list = (d.data && (d.data.list || d.data.records)) || d.list || [];
    if (!list.length) { body.innerHTML = '<div class="cm-empty small">最近没有播放过视频</div>'; return; }
    body.innerHTML = `<div class="cm-plgrid">${list.map(v => `
      <div class="cm-plcard" data-vid="${esc(v.data ? (v.data.vid || '') : (v.vid || ''))}">
        <div class="cm-plcover cm-cover-16x9">${(v.data && v.data.coverUrl) || v.coverUrl ? `<img src="${esc((v.data && v.data.coverUrl) || v.coverUrl)}?param=400y225" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">play_circle</span></div>
        <div class="cm-plname">${esc((v.data && v.data.title) || v.title || '')}</div>
      </div>`).join('')}</div>`;
    body.querySelectorAll('.cm-plcard').forEach(c => {
      if (c.dataset.vid) c.onclick = () => { location.hash = `#/video/${c.dataset.vid}`; };
    });
  } catch (e) { body.innerHTML = boundError(e); }
}

function requireBound(el, body, text) {
  if (auth.token) return true;
  body.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:40px">cloud_off</span>
    <div>${esc(text)}</div><mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
  return false;
}

const boundError = e => /401|绑定/.test(e.message)
  ? '<div class="cm-empty">需先绑定网易云账号</div>'
  : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
