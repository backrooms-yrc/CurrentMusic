// 搜索页：回车触发搜索 + 历史记录（不做逐字防抖——中间态查询会同时打爆上游与碎片化历史）
//
// 加载策略（本页性能的关键）：
//   上游四个类型的耗时差异极大（实测 歌手 6.1s / 专辑 4.2s / 单曲 3.0s / 歌单 2.1s），
//   而默认展示的是「单曲」。所以**首屏只请求单曲**（~3s 即可出结果），其余类型在
//   首屏渲染完成后于后台补齐，用于填 TAB 上的计数；用户切到某个 TAB 时若还没取，
//   再按需取一次。每个类型每批只取 10 条，底部给「显示更多」按需追加。
import { api } from '../api.js';
import { esc, renderSongList, toast } from '../ui.js';
import { player } from '../player.js';
import { addToPlaylist } from '../player-ui.js';

const HIST_KEY = 'cm.searchHistory';
const BATCH = 10;              // 每个类型每批取的条数（首屏与「显示更多」共用）

// TAB 定义：k 直接用作后端 type 参数，arr 是响应里的数组字段
const TABS = [
  { k: 'song', label: '单曲', arr: 'songs' },
  { k: 'album', label: '专辑', arr: 'albums' },
  { k: 'artist', label: '歌手', arr: 'artists' },
  { k: 'playlist', label: '歌单', arr: 'playlists' },
];
const ARR = Object.fromEntries(TABS.map(t => [t.k, t.arr]));

const hist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } };
const pushHist = kw => {
  const h = [kw, ...hist().filter(x => x !== kw)].slice(0, 10);
  localStorage.setItem(HIST_KEY, JSON.stringify(h));
};

// 搜索结果骨架屏：保留歌曲行结构，避免请求期间结果区跳空
const searchResultSkeleton = (n = 6) => `<div class="cm-search-result-skeleton" aria-busy="true" aria-label="搜索结果加载中">
  <div class="cm-skel-list">${Array.from({ length: n }, () => `<div class="cm-skel-song"><div class="sk sk-pic"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join('')}</div>
</div>`;

const panelLoading = () => '<div class="cmt-more-loading"><mdui-circular-progress></mdui-circular-progress> 加载中…</div>';

let seq = 0;

export async function render(el) {
  el.innerHTML = `
    <div class="cm-search-bar">
      <mdui-text-field id="kw" label="搜索歌曲 / 歌手 / 专辑" variant="outlined" clearable style="width:100%"></mdui-text-field>
    </div>
    <div id="histBox"></div>
    <div id="resultBox"></div>`;

  const input = el.querySelector('#kw');
  const histBox = el.querySelector('#histBox');
  const resultBox = el.querySelector('#resultBox');
  const hotBox = document.createElement('div');
  histBox.after(hotBox);

  async function renderHot() {
    if ((input.value || '').trim() || (hotBox.dataset.for ?? '') !== '') return;
    hotBox.innerHTML = '<div class="cm-loading"><mdui-linear-progress style="width:120px"></mdui-linear-progress></div>';
    try {
      const list = (await api.hotSearch()).list || [];
      hotBox.innerHTML = list.length ? `<div class="cm-sec-head"><h2>热门搜索</h2></div>
        <div class="cm-chips">${list.map((x, i) =>
          `<span class="cm-hot" data-k="${esc(x.name)}"><b>${i + 1}</b>${esc(x.name)}</span>`).join('')}</div>` : '';
      hotBox.querySelectorAll('.cm-hot').forEach(c => { c.onclick = () => { input.value = c.dataset.k; doSearch(c.dataset.k); }; });
    } catch { hotBox.innerHTML = ''; }
  }

  const renderHist = () => {
    const h = hist();
    if (!h.length) { histBox.innerHTML = ''; renderHot(); return; }   // 无历史也要出热搜
    histBox.innerHTML = `<div class="cm-sec-head"><h2>搜索历史</h2><span class="cm-sec-more" id="clearHist">清空</span></div>
      <div class="cm-chips">${h.map(k =>
        `<span class="cm-hist"><span class="cm-hist-k" data-k="${esc(k)}">${esc(k)}</span><i class="cm-hist-x" data-x="${esc(k)}"><span class="material-icons-outlined">close</span></i></span>`).join('')}</div>`;
    histBox.querySelector('#clearHist').onclick = () => { localStorage.removeItem(HIST_KEY); renderHist(); renderHot(); };
    histBox.querySelectorAll('.cm-hist-k').forEach(c => { c.onclick = () => { input.value = c.dataset.k; doSearch(c.dataset.k); }; });
    histBox.querySelectorAll('.cm-hist-x').forEach(x => {
      x.onclick = e => {
        e.stopPropagation();
        localStorage.setItem(HIST_KEY, JSON.stringify(hist().filter(v => v !== x.dataset.x)));
        renderHist();
      };
    });
    renderHot();
  };
  renderHist();

  /* ---------- 一次搜索的状态 ---------- */
  let S = null;                                   // { kw, items, total, more, loaded, loading, cur }
  const newState = kw => ({ kw, items: {}, total: {}, more: {}, loaded: {}, loading: {}, cur: 'song' });

  const panel = () => resultBox.querySelector('#srchPanel');
  const loadedCount = t => (S.items[t] || []).length;

  /** 取某一类型的一页（offset 为 0 时覆盖，否则追加）。返回本次新增条数。 */
  async function load(t, offset) {
    const d = await api.search(S.kw, offset, BATCH, t);
    const got = d[ARR[t]] || [];
    S.items[t] = offset ? (S.items[t] || []).concat(got) : got;
    S.total[t] = (d.totals && d.totals[t]) || S.items[t].length;
    S.more[t] = !!(d.hasMore && d.hasMore[t]);
    S.loaded[t] = true;
    return got.length;
  }

  /** TAB 条数：未加载的类型不显示数字（避免先显示 0 再跳变）。 */
  const tabCount = t => (S.loaded[t] ? (S.total[t] || loadedCount(t)) : '');

  /** 已加载且为空的类型不占 TAB 位；当前选中的始终保留。 */
  const visibleTabs = () => TABS.filter(t =>
    !S.loaded[t.k] || loadedCount(t.k) > 0 || t.k === S.cur);

  function renderTabs() {
    const box = resultBox.querySelector('#srchTabs');
    if (!box) return;
    box.innerHTML = visibleTabs().map(t => {
      const n = tabCount(t.k);
      return `<button class="cm-srchtab${t.k === S.cur ? ' on' : ''}" data-k="${t.k}">${t.label}${n !== '' ? `<i>${n}</i>` : ''}</button>`;
    }).join('');
    box.querySelectorAll('.cm-srchtab').forEach(b => { b.onclick = () => selectTab(b.dataset.k); });
  }

  /** 「显示更多」：追加一批（沿用 square.js 的按钮与进度写法）。 */
  function moreButton(t) {
    if (!S.more[t]) return '';
    const shown = loadedCount(t), total = S.total[t] || shown;
    return `<div class="cm-sq-more"><mdui-button variant="tonal" data-more="${t}">显示更多（${shown}/${total}）</mdui-button></div>`;
  }

  function bindMore(t) {
    const btn = panel()?.querySelector(`[data-more="${t}"]`);
    if (!btn) return;
    btn.onclick = async () => {
      if (S.loading[t]) return;
      S.loading[t] = true;
      btn.disabled = true;
      btn.textContent = '加载中…';
      const my = seq;
      try {
        await load(t, loadedCount(t));
        if (my !== seq) return;
        renderTabs();
        renderPanel();
      } catch (e) {
        if (my !== seq) return;
        toast('加载失败：' + e.message);
        btn.disabled = false;
        btn.textContent = `显示更多（${loadedCount(t)}/${S.total[t] || loadedCount(t)}）`;
      } finally {
        S.loading[t] = false;
      }
    };
  }

  /* ---------- 各类型面板 ---------- */

  function renderSongPanel() {
    panel().innerHTML = `<div class="cm-sec-head"><h2>单曲</h2>
      <span class="cm-sec-more" id="addAll"><span class="material-icons-outlined">playlist_add</span> 全部收入歌单</span></div>
      <div id="songList"></div>${moreButton('song')}`;
    renderSongList(panel().querySelector('#songList'), S.items.song || [], {
      onPlay: i => player.playList(S.items.song, i),
    });
    panel().querySelector('#addAll').onclick = () => addToPlaylist(S.items.song || []);
    bindMore('song');
  }

  function renderAlbumPanel() {
    panel().innerHTML = `<div class="cm-sec-head"><h2>专辑</h2><span class="cm-sec-sub">点击整专辑播放</span></div>
      <div class="cm-hscroll cm-album-row">${(S.items.album || []).map(a => `
        <div class="cm-card cm-album-card" data-id="${a.id}" title="播放专辑「${esc(a.name)}」">
          <img src="${esc(a.pic)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
          <div class="cm-card-name">${esc(a.name)}</div>
          <div class="cm-card-sub">${esc(a.artist)}</div>
        </div>`).join('')}</div>${moreButton('album')}`;
    panel().querySelectorAll('.cm-album-card').forEach(c => {
      c.onclick = async () => {
        toast('正在打开专辑…');
        try {
          const al = await api.album(c.dataset.id);
          if (!al.songs || !al.songs.length) return toast('专辑暂无曲目');
          player.playList(al.songs, 0);
        } catch (e) { toast('打开专辑失败：' + e.message); }
      };
    });
    bindMore('album');
  }

  function renderArtistPanel() {
    panel().innerHTML = `<div class="cm-sec-head"><h2>歌手</h2><span class="cm-sec-sub">点击查看全部作品</span></div>
      <div class="cm-hscroll cm-artist-row">${(S.items.artist || []).map(a => `
        <div class="cm-artist-card" data-id="${a.id}">
          <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
          <div class="cm-artist-name">${esc(a.name)}</div>
          ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
        </div>`).join('')}</div>${moreButton('artist')}`;
    panel().querySelectorAll('.cm-artist-card').forEach(c => {
      c.onclick = () => { location.hash = `#/artist/${c.dataset.id}`; };
    });
    bindMore('artist');
  }

  const fmtPlay = n => n >= 100000000 ? (n / 100000000).toFixed(1) + ' 亿'
    : n >= 10000 ? Math.round(n / 10000) + ' 万' : String(n || 0);

  function renderPlaylistPanel() {
    panel().innerHTML = `<div class="cm-sec-head"><h2>歌单</h2><span class="cm-sec-sub">点击查看歌单内容</span></div>
      <div class="cm-plgrid" id="srchPls">${(S.items.playlist || []).map(p => `
        <div class="cm-plcard" data-id="${p.id}">
          <div class="cm-plcover">${p.pic ? `<img src="${esc(p.pic)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
          <div class="cm-plname">${esc(p.name)}</div>
          <div class="cm-plsub">${p.trackCount} 首 · ${fmtPlay(p.playCount)}播放</div>
        </div>`).join('')}</div>${moreButton('playlist')}`;
    panel().querySelectorAll('#srchPls .cm-plcard').forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; };
    });
    bindMore('playlist');
  }

  const RENDERERS = { song: renderSongPanel, album: renderAlbumPanel, artist: renderArtistPanel, playlist: renderPlaylistPanel };

  function renderPanel() {
    const fn = RENDERERS[S.cur];
    if (fn) fn();
  }

  async function selectTab(k) {
    if (!S) return;
    S.cur = k;
    renderTabs();
    if (!S.loaded[k]) {
      // 切到尚未取过的类型：按需取一次（首屏为了速度没有预取完）
      panel().innerHTML = panelLoading();
      const my = seq;
      try {
        await load(k, 0);
      } catch (e) {
        if (my !== seq) return;
        panel().innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
        return;
      }
      if (my !== seq) return;
      renderTabs();
    }
    renderPanel();
  }

  function renderShell() {
    resultBox.innerHTML = `
      <div class="cm-srchtabs" id="srchTabs"></div>
      <div id="srchPanel"></div>`;
    renderTabs();
    renderPanel();
  }

  const anyResult = () => TABS.some(t => loadedCount(t.k) > 0);

  async function doSearch(kw) {
    const my = ++seq;
    pushHist(kw);
    renderHist();
    hotBox.innerHTML = '';   // 有搜索内容后隐藏热搜
    resultBox.innerHTML = searchResultSkeleton(6);
    S = newState(kw);

    // 首屏只等「单曲」：上游「歌手」实测可达 6s+，没必要让它拖住首屏
    try {
      await load('song', 0);
    } catch (e) {
      if (my === seq) resultBox.innerHTML = `<div class="cm-empty">搜索失败：${esc(e.message)}</div>`;
      return;
    }
    if (my !== seq) return;

    const others = TABS.filter(t => t.k !== 'song').map(t => t.k);
    if (!loadedCount('song')) {
      // 单曲为空：先把其余类型取回来再判断，避免先闪一下「没有结果」
      await Promise.allSettled(others.map(t => load(t, 0)));
      if (my !== seq) return;
      const hit = TABS.find(t => loadedCount(t.k) > 0);
      if (!hit) {
        resultBox.innerHTML = `<div class="cm-empty">没有找到「${esc(kw)}」的相关结果</div>`;
        return;
      }
      S.cur = hit.k;
    }

    renderShell();
    if (!anyResult()) {
      resultBox.innerHTML = `<div class="cm-empty">没有找到「${esc(kw)}」的相关结果</div>`;
      return;
    }

    // 首屏已经出内容了，再在后台补齐其余类型（只为填 TAB 计数，不挡首屏）
    if (loadedCount('song')) {
      setTimeout(() => {
        if (my !== seq) return;
        others.forEach(t => {
          if (S.loaded[t]) return;
          load(t, 0).then(() => { if (my === seq) renderTabs(); }).catch(() => {});
        });
      }, 300);
    }
  }

  // 输入不触发搜索：只有回车（或点击热搜/历史词条这类明确动作）才发起请求
  input.addEventListener('input', () => {
    if (!(input.value || '').trim()) { seq++; S = null; resultBox.innerHTML = ''; renderHist(); renderHot(); }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const kw = (input.value || '').trim(); if (kw) doSearch(kw); }
  });
  setTimeout(() => input.focus(), 100);
}
