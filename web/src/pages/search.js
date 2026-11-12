// 搜索建议防抖，明确提交后才搜索并写入历史。
//
// 加载策略（本页性能的关键）：
//   上游四个类型的耗时差异极大（实测 歌手 6.1s / 专辑 4.2s / 单曲 3.0s / 歌单 2.1s），
//   而默认展示的是「单曲」。所以**首屏只请求单曲**（~3s 即可出结果），其余类型在
//   首屏渲染完成后于后台补齐，用于填 TAB 上的计数；用户切到某个 TAB 时若还没取，
//   再按需取一次。每个类型每批只取 10 条，底部给「显示更多」按需追加。
//
// 动效约定（曲线与时长跟评论区批次渐入 cmtIn 保持一致）：
//   · 切 TAB：面板内容按切换方向轻微横移 + 淡入
//   · 显示更多：只把**新增条目**阶梯渐入，已有条目保持不动
//   · TAB 栏就地更新计数而不整块重建，否则指示条的 cmTabIn 动画会被反复重播
//   · prefers-reduced-motion 下全部跳过
import { api, ncmSongs } from '../api.js';
import { esc, fmtCount, renderSongList, toast } from '../ui.js';
import { player } from '../player.js';
import { addToPlaylist } from '../player-ui.js';
import { loadingMarkup, loadingCycle } from '../loading.js';
import { searchHistory, recordSearch, removeSearch, clearSearchHistory, syncSearchHistory, watchSearchHistory } from '../search-history.js';

const BATCH = 10;              // 每个类型每批取的条数（首屏与「显示更多」共用）
const EASE = 'cubic-bezier(0.05, 0.7, 0.1, 1)';   // 与 app.css 里 cmtIn 同一曲线

// TAB 定义：k 直接用作后端 type 参数，arr 是响应里的数组字段
const TABS = [
  { k: 'song', label: '单曲', arr: 'songs' },
  { k: 'album', label: '专辑', arr: 'albums' },
  { k: 'artist', label: '歌手', arr: 'artists' },
  { k: 'playlist', label: '歌单', arr: 'playlists' },
  { k: 'lyric', label: '歌词', arr: 'songs' },
  { k: 'match', label: '多重匹配' },
];
const ARR = Object.fromEntries(TABS.map(t => [t.k, t.arr]));
const BACKGROUND_TYPES = ['album', 'artist', 'playlist'];

// 搜索结果骨架屏：保留歌曲行结构，避免请求期间结果区跳空
const searchResultSkeleton = (n = 6) => `<div class="cm-search-result-skeleton" aria-busy="true" aria-label="搜索结果加载中">
  <div class="cm-expressive-loading cm-search-loading" role="status" aria-label="正在搜索">${loadingMarkup()}</div>
  <div class="cm-skel-list">${Array.from({ length: n }, () => `<div class="cm-skel-song"><div class="sk sk-pic"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join('')}</div>
</div>`;

const suggestionSkeleton = `<div class="cm-sug cm-skeleton" role="status" aria-label="搜索候选加载中">
  ${[110, 155, 95].map(width => `<div class="cm-sug-item" aria-hidden="true">
    <span class="sk cm-sug-placeholder-icon"></span><span class="sk cm-sug-placeholder-text" style="width:${width}px"></span>
  </div>`).join('')}
</div>`;

const panelLoading = () => '<div class="cmt-more-loading"><mdui-circular-progress></mdui-circular-progress> 加载中…</div>';
const playSong = (songs, index) => player.playList(songs, index, { shuffleStart: false });

/** 是否应减少动效。实时查询，用户改系统设置后无需重载页面。 */
const reduceMotion = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 新条目阶梯渐入。fill:'backwards' 保证延迟期间不可见，不会先闪一下再开始动。 */
function animateIn(els, { y = 8, stagger = 26, cap = 160 } = {}) {
  if (!els.length || reduceMotion() || !els[0].animate) return;
  els.forEach((el, i) => el.animate(
    [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 260, delay: Math.min(i * stagger, cap), easing: EASE, fill: 'backwards' }));
}

let seq = 0;

export async function render(el, params = []) {
  // 翱翔鸟Music：搜索框走 SwiftUI 样式（灰底圆角 + 放大镜），其余皮肤仍是 MD3 outlined
  const sbTheme = document.documentElement.getAttribute('data-ui-preset') === 'soaringbird';
  el.innerHTML = `
    <form class="cm-search-bar cm-search-submit">
      ${sbTheme
        ? `<label class="sb-search" for="kw">
             <span class="sb-search__icon material-icons-outlined" aria-hidden="true">search</span>
             <input id="kw" type="search" placeholder="搜索歌曲 / 歌手 / 专辑" maxlength="100" enterkeyhint="search" autocomplete="off" spellcheck="false" aria-label="搜索歌曲 / 歌手 / 专辑">
           </label>`
        : `<mdui-text-field id="kw" label="搜索歌曲 / 歌手 / 专辑" variant="outlined" maxlength="100" enterkeyhint="search" clearable></mdui-text-field>`}
      <mdui-button type="submit" variant="filled"${reduceMotion() ? ' no-ripple' : ''}>
        <span slot="icon" class="material-icons-outlined" aria-hidden="true">search</span>搜索
      </mdui-button>
    </form>
    <div id="sugBox"></div>
    <div id="histBox"></div>
    <details id="matchLocal" class="cm-search-local">
      <summary>本地歌曲信息匹配</summary>
      <form id="matchForm" class="cm-search-match-form">
        <label>歌曲标题<input name="title" required placeholder="文件属性中的标题"></label>
        <label>歌手<input name="artist"></label>
        <label>专辑<input name="album"></label>
        <label>时长（秒）<input name="duration" type="number" min="0.01" step="any" required></label>
        <label>文件 MD5<input name="md5" pattern="[0-9a-fA-F]{32}" maxlength="32" required placeholder="32 位十六进制"></label>
        <button class="cm-search-go" type="submit">匹配</button>
      </form>
      <div id="matchBox"></div>
    </details>
    <div id="resultBox"></div>`;

  const input = el.querySelector('#kw');
  const sugBox = el.querySelector('#sugBox');
  const histBox = el.querySelector('#histBox');
  const resultBox = el.querySelector('#resultBox');
  let historyVisible = true;
  const hotBox = document.createElement('section');
  hotBox.className = 'cm-hot-chart';
  hotBox.setAttribute('aria-labelledby', 'searchHotTitle');
  hotBox.hidden = true;
  histBox.after(hotBox);

  // 翱翔鸟Music：参考图二的 Apple Music 搜索页 —— 搜索框下方先给「类别浏览」彩色网格。
  // 仅该主题渲染；其余主题保持原搜索页结构不变。
  const SB_CATS = [
    ['2026年度最佳', '#9a9aa0', '#3c3c40'],
    ['国际流行', '#ff7a9c', '#b21e4b'],
    ['C-Pop', '#ff8f68', '#9e1f18'],
    ['电子', '#4fd1c5', '#0b5d59'],
    ['国语流行', '#ff6b6b', '#8c1111'],
    ['K-Pop', '#f78fb3', '#a31a5b'],
    ['粤语流行', '#ffab76', '#a63b12'],
    ['嘻哈/说唱', '#6aa8ff', '#123a80'],
    ['R&B', '#b39ddb', '#4a2385'],
    ['睡眠', '#7d8bd6', '#1d2a6b'],
    ['瞩目之星', '#ff9a9e', '#a3162c'],
    ['工作时间', '#86c88a', '#1f5c2a'],
    ['古典音乐', '#aab4e2', '#303b7a'],
    ['减压', '#63c7bd', '#0e5a55'],
    ['空间音频', '#84b7ff', '#123e7a'],
    ['儿童', '#ffd15c', '#9a5a00'],
    ['健身', '#ffb066', '#9a3d00'],
  ];
  const catBox = document.createElement('div');
  sugBox.after(catBox);
  const isSoar = () => document.documentElement.getAttribute('data-ui-preset') === 'soaringbird';
  function renderCats() {
    if (!isSoar()) { catBox.innerHTML = ''; return; }
    catBox.innerHTML = `<div class="cm-sec-head"><h2>类别浏览</h2></div>
      <div class="sb-cats">${SB_CATS.map(([name, g1, g2]) =>
        `<button type="button" class="sb-cat" data-k="${esc(name)}" style="--g1:${g1};--g2:${g2}"><span>${esc(name)}</span></button>`).join('')}</div>`;
    catBox.querySelectorAll('.sb-cat').forEach(b => {
      b.onclick = () => { input.value = b.dataset.k; input.blur(); doSearch(b.dataset.k); };
    });
  }
  renderCats();

  // 本地匹配只提交歌曲信息和已有 MD5。
  const local = el.querySelector('#matchLocal');
  const matchForm = el.querySelector('#matchForm');
  const matchButton = matchForm.querySelector('button');
  const matchBox = el.querySelector('#matchBox');
  matchForm.onsubmit = async e => {
    e.preventDefault();
    if (matchButton.disabled) return;
    const fields = new FormData(matchForm);
    const query = Object.fromEntries(['title', 'artist', 'album', 'duration', 'md5'].map(k => [k, fields.get(k).trim()]));
    if (!query.title) { toast('请输入歌曲标题'); return; }
    matchButton.disabled = true;
    matchBox.innerHTML = panelLoading();
    try {
      const data = await api.ncm('/search/match', query);
      const songs = ncmSongs(data.result?.songs || []);
      if (songs.length) await renderSongList(matchBox, songs, { deferStatus: true, onPlay: i => playSong(songs, i) });
      else matchBox.innerHTML = '<div class="cm-empty">没有匹配到歌曲，请核对文件信息</div>';
    } catch (e) { matchBox.innerHTML = `<div class="cm-empty">匹配失败：${esc(e.message)}</div>`; }
    finally { matchButton.disabled = false; }
  };

  // 默认搜索关键词（占位提示）：失败保持原 label，不影响使用
  let defaultKeyword = '';
  api.searchDefault().then(d => {
    defaultKeyword = (d.data?.realkeyword || d.data?.showKeyword || '').trim();
    if (defaultKeyword) {
      const hint = `试试「${d.data?.showKeyword || defaultKeyword}」`;
      if (input.tagName === 'INPUT') input.placeholder = hint;
      else input.setAttribute('placeholder', hint);
    }
  }).catch(() => {});

  let hotRequest;
  async function hotKeywords() {
    const detail = await api.searchHotDetail().catch(() => null);
    const rows = Array.isArray(detail?.data) ? detail.data.filter(item => item?.searchWord) : [];
    if (rows.length) return rows;
    const simple = await api.ncm('/search/hot').catch(() => null);
    return (simple?.result?.hots || []).filter(item => item?.first).map(item => ({ searchWord: item.first }));
  }
  async function renderHot() {
    if (!historyVisible || (input.value || '').trim()) return;
    hotRequest ||= hotKeywords().catch(() => []);
    const rows = (await hotRequest).slice(0, 12);
    if (!rows.length || !hotBox.isConnected || !historyVisible || (input.value || '').trim()) return;
    hotBox.hidden = false;
    if (hotBox.firstElementChild) return;
    hotBox.innerHTML = `
      <header class="cm-hot-head">
        <span class="material-icons-outlined cm-hot-icon" aria-hidden="true">trending_up</span>
        <div><h2 id="searchHotTitle">搜索热榜</h2><p>网易云音乐热门搜索</p></div>
        <span class="cm-hot-count">TOP ${rows.length}</span>
      </header>
      <ol class="cm-hot-list" id="searchHotList" role="list">${rows.map(({ searchWord, content, score }, i) => `
        <li${i >= 6 ? ' hidden' : ''}>
          <button type="button" class="cm-hot" data-k="${esc(searchWord)}" title="${esc(searchWord)}">
            <b class="cm-hot-rank">${String(i + 1).padStart(2, '0')}</b>
            <span class="cm-hot-copy"><strong>${esc(searchWord)}</strong>${content ? `<small>${esc(content)}</small>` : ''}</span>
            ${Number.isFinite(Number(score)) && Number(score) > 0 ? `<span class="cm-hot-score" title="热度 ${esc(score)}"><span class="material-icons-outlined" aria-hidden="true">local_fire_department</span>${fmtCount(Number(score))}</span>` : ''}
            <span class="material-icons-outlined cm-hot-arrow" aria-hidden="true">chevron_right</span>
          </button>
        </li>`).join('')}</ol>
      ${rows.length > 6 ? `<button type="button" class="cm-hot-more" aria-controls="searchHotList" aria-expanded="false">展开全部 ${rows.length} 项<span class="material-icons-outlined" aria-hidden="true">expand_more</span></button>` : ''}`;
    hotBox.querySelectorAll('.cm-hot').forEach(c => { c.onclick = () => doSearch(c.dataset.k); });
    const more = hotBox.querySelector('.cm-hot-more');
    const extra = hotBox.querySelectorAll('.cm-hot-list li:nth-child(n+7)');
    if (more) more.onclick = event => {
      const expanded = more.getAttribute('aria-expanded') !== 'true';
      extra.forEach(row => { row.hidden = !expanded; });
      more.setAttribute('aria-expanded', String(expanded));
      more.firstChild.textContent = expanded ? '收起榜单' : `展开全部 ${rows.length} 项`;
      if (expanded && event.detail === 0) extra[0].querySelector('button').focus();
    };
  }

  const renderHist = () => {
    const h = searchHistory();
    if (!h.length) { histBox.innerHTML = ''; renderHot(); return; }   // 无历史也要出热搜
    histBox.innerHTML = `<div class="cm-sec-head"><h2>搜索历史</h2><span class="cm-sec-more" id="clearHist">清空</span></div>
      <div class="cm-chips">${h.map(k =>
        `<span class="cm-hist"><span class="cm-hist-k" data-k="${esc(k)}">${esc(k)}</span><i class="cm-hist-x" data-x="${esc(k)}"><span class="material-icons-outlined">close</span></i></span>`).join('')}</div>`;
    histBox.querySelector('#clearHist').onclick = () => { clearSearchHistory(); renderHist(); renderHot(); };
    histBox.querySelectorAll('.cm-hist-k').forEach(c => { c.onclick = () => doSearch(c.dataset.k); });
    histBox.querySelectorAll('.cm-hist-x').forEach(x => {
      x.onclick = e => {
        e.stopPropagation();
        removeSearch(x.dataset.x);
        renderHist();
      };
    });
    renderHot();
  };
  watchSearchHistory(el, () => { if (historyVisible) renderHist(); });
  renderHist();
  void syncSearchHistory();

  /* ---------- 一次搜索的状态 ---------- */
  let S = null, searchCycle = null;                // { kw, items, total, more, loaded, loading, cur }
  const newState = kw => ({ kw, items: {}, total: {}, more: {}, loaded: {}, loading: {}, pending: {}, offsets: {}, cur: 'song' });

  const panel = () => resultBox.querySelector('#srchPanel');
  const loadedCount = t => (S.items[t] || []).length;

  /** 取某一类型的一页（offset 为 0 时覆盖，否则追加）。返回本次新增条数。 */
  async function load(t, offset, state = S) {
    if (t === 'match') {
      const { result = {} } = await api.ncm('/search/multimatch', { keywords: state.kw });
      const songs = ncmSongs(result.song || result.songs || []);
      const types = [
        ['artist', '歌手', 'artist'],
        ['album', '专辑', 'album'],
        ['playlist', '歌单', 'ncmpl'],
      ];
      state.items.match = songs.map(song => ({ song }));
      for (const [key, label, route] of types) {
        for (const item of result[key] || []) {
          if (/^[1-9]\d*$/.test(String(item.id)) && item.name) {
            state.items.match.push({ label, name: item.name, href: `#/${route}/${item.id}` });
          }
        }
      }
      state.loaded.match = true;
      return;
    }
    const d = await api.search(state.kw, offset, BATCH, t);
    const got = d[ARR[t]] || [];
    state.offsets[t] = offset + got.length; // 补充的专辑曲目不消耗上游分页位置。
    if (t === 'song') {
      if (!offset) state.catalogSongs = d.catalogSongs || [];
      const all = offset ? (state.items[t] || []).concat(got) : (state.catalogSongs || []).concat(got);
      const seen = new Set();
      state.items[t] = all.filter(s => { const id = String(s.ncm_id); if (seen.has(id)) return false; seen.add(id); return true; });
    } else state.items[t] = offset ? (state.items[t] || []).concat(got) : got;
    const countKey = t === 'lyric' ? 'song' : t;
    state.total[t] = (d.totals?.[countKey] || state.offsets[t]) + (t === 'song' ? (state.catalogSongs || []).length : 0);
    state.more[t] = got.length > 0 && !!d.hasMore?.[countKey];
    state.loaded[t] = true;
    return got.length;
  }

  function firstPage(t, state = S) {
    if (state.loaded[t]) return Promise.resolve();
    return state.pending[t] ||= load(t, 0, state).finally(() => { delete state.pending[t]; });
  }

  /** TAB 条数：未加载的类型不显示数字（避免先显示 0 再跳变）。 */
  const tabCount = t => (S.loaded[t] ? (S.total[t] || loadedCount(t)) : '');

  /**
   * 绘制 TAB 栏。
   * 可见集合没变时**就地更新**计数与选中态——整块重建会让 `.on` 上那条指示条的
   * cmTabIn 动画被反复重播（后台补齐计数时尤其明显，看起来像整条 TAB 栏在闪）。
   */
  function renderTabs() {
    const box = resultBox.querySelector('#srchTabs');
    if (!box) return;
    if (box.children.length === TABS.length) {
      TABS.forEach((t, i) => {
        const btn = box.children[i];
        btn.classList.toggle('on', t.k === S.cur);
        btn.setAttribute('aria-pressed', String(t.k === S.cur));
        const n = tabCount(t.k);
        const badge = btn.querySelector('i');
        if (n === '') { if (badge) badge.remove(); }
        else if (badge) { badge.textContent = n; }
        else { btn.insertAdjacentHTML('beforeend', `<i>${n}</i>`); }
      });
      return;
    }
    box.innerHTML = TABS.map(t => {
      const n = tabCount(t.k);
      return `<button type="button" class="cm-srchtab${t.k === S.cur ? ' on' : ''}" data-k="${t.k}" aria-pressed="${t.k === S.cur}">${t.label}${n !== '' ? `<i>${n}</i>` : ''}</button>`;
    }).join('');
    box.querySelectorAll('.cm-srchtab').forEach(b => { b.onclick = () => selectTab(b.dataset.k); });
  }

  /** 「显示更多」按钮（沿用 square.js 的按钮与进度写法）。 */
  function moreButtonHTML(t) {
    if (!S.more[t]) return '';
    const shown = loadedCount(t), total = S.total[t] || shown;
    return `<div class="cm-sq-more" data-more-wrap="${t}"><mdui-button variant="tonal" data-more="${t}">显示更多（${shown}/${total}）</mdui-button></div>`;
  }

  /** 把底部按钮换到面板末尾（并重新绑定）。追加后计数变了，整块替换最简单。 */
  function refreshMore(t) {
    const p = panel();
    if (!p) return;
    p.querySelectorAll('[data-more-wrap]').forEach(x => x.remove());
    const html = moreButtonHTML(t);
    if (html) p.insertAdjacentHTML('beforeend', html);
    bindMore(t);
  }

  function bindMore(t) {
    const btn = panel()?.querySelector(`[data-more="${t}"]`);
    if (!btn) return;
    btn.onclick = async () => {
      if (S.loading[t]) return;
      S.loading[t] = true;
      btn.disabled = true;
      btn.innerHTML = `<span class="cm-expressive-loading cm-loading-inline cm-loading-small" aria-hidden="true">${loadingMarkup()}</span> 加载中…`;
      const my = seq;
      const state = S;
      const before = loadedCount(t);           // 追加前的条数 = 本次渲染的起点
      try {
        await load(t, S.offsets?.[t] ?? before);
        if (my !== seq) return;
        renderTabs();
        if (S.cur !== t) return;
        renderPanel(before, { items: true });  // 只画新增的那一批
      } catch (e) {
        if (my !== seq) return;
        toast('加载失败：' + e.message);
        btn.disabled = false;
        btn.textContent = `显示更多（${loadedCount(t)}/${S.total[t] || loadedCount(t)}）`;
      } finally {
        state.loading[t] = false;
      }
    };
  }

  /* ---------- 各类型面板 ----------
     约定：from = 0 建容器并画第一批；from > 0 只追加新增条目。
     items 为真时才给条目加渐入动画（切 TAB 由面板整体动画负责，避免双重动效）。 */

  async function renderSongPanel(from, items, type) {
    const p = panel();
    const songs = S.items[type] || [];
    if (!from) {
      p.innerHTML = `<div class="cm-sec-head"><h2>${type === 'lyric' ? '歌词命中' : '单曲'}</h2>
        <span class="cm-sec-more" id="addAll"><span class="material-icons-outlined">playlist_add</span> 全部收入歌单</span></div>
        <div id="songList"></div>`;
      p.querySelector('#addAll').onclick = () => addToPlaylist(S.items[type] || []);
      refreshMore(type);
    }
    const list = p.querySelector('#songList');
    const rows = await renderSongList(list, songs,
      { from, deferStatus: true, showLyric: type === 'lyric', onPlay: i => playSong(S.items[type], i) });
    if (!list.isConnected || S?.cur !== type) return;
    // 追加时动画新增行；首次出结果时也渐入（那时没有面板整体动画）
    if (from) { animateIn(rows); refreshMore(type); }
    else if (items) animateIn(rows);
  }

  function renderAlbumPanel(from, items) {
    const p = panel();
    const all = S.items.album || [];
    if (!from) {
      p.innerHTML = `<div class="cm-sec-head"><h2>专辑</h2><span class="cm-sec-sub">点击整专辑播放</span></div>
        <div class="cm-hscroll cm-album-row" id="srchAlbum"></div>`;
      refreshMore('album');
    }
    const box = p.querySelector('#srchAlbum');
    const added = all.slice(from);
    if (!added.length) return;
    box.insertAdjacentHTML('beforeend', added.map(a => `
      <div class="cm-card cm-album-card" data-id="${a.id}" title="播放专辑「${esc(a.name)}」">
        <img src="${esc(a.pic)}?param=300y300" loading="lazy" onerror="this.classList.add('none')">
        <div class="cm-card-name">${esc(a.name)}</div>
        <div class="cm-card-sub">${esc(a.artist)}</div>
      </div>`).join(''));
    const els = [...box.querySelectorAll('.cm-album-card')].slice(-added.length);
    els.forEach(c => {
      c.onclick = () => { location.hash = `#/album/${c.dataset.id}`; };
    });
    if (from) { animateIn(els); refreshMore('album'); }
    else if (items) animateIn(els);
  }

  function renderArtistPanel(from, items) {
    const p = panel();
    const all = S.items.artist || [];
    if (!from) {
      p.innerHTML = `<div class="cm-sec-head"><h2>歌手</h2><span class="cm-sec-sub">点击查看全部作品</span></div>
        <div class="cm-hscroll cm-artist-row" id="srchArtist"></div>`;
      refreshMore('artist');
    }
    const box = p.querySelector('#srchArtist');
    const added = all.slice(from);
    if (!added.length) return;
    box.insertAdjacentHTML('beforeend', added.map(a => `
      <div class="cm-artist-card" data-id="${a.id}">
        <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div class="cm-artist-name">${esc(a.name)}</div>
        ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
      </div>`).join(''));
    const els = [...box.querySelectorAll('.cm-artist-card')].slice(-added.length);
    els.forEach(c => {
      c.onclick = () => { location.hash = `#/artist/${c.dataset.id}`; };
    });
    if (from) { animateIn(els); refreshMore('artist'); }
    else if (items) animateIn(els);
  }

  const fmtPlay = n => n >= 100000000 ? (n / 100000000).toFixed(1) + ' 亿'
    : n >= 10000 ? Math.round(n / 10000) + ' 万' : String(n || 0);

  function renderPlaylistPanel(from, items) {
    const p = panel();
    const all = S.items.playlist || [];
    if (!from) {
      p.innerHTML = `<div class="cm-sec-head"><h2>歌单</h2><span class="cm-sec-sub">点击查看歌单内容</span></div>
        <div class="cm-plgrid" id="srchPls"></div>`;
      refreshMore('playlist');
    }
    const box = p.querySelector('#srchPls');
    const added = all.slice(from);
    if (!added.length) return;
    box.insertAdjacentHTML('beforeend', added.map(pl => `
      <div class="cm-plcard" data-id="${pl.id}">
        <div class="cm-plcover">${pl.pic ? `<img src="${esc(pl.pic)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">queue_music</span></div>
        <div class="cm-plname">${esc(pl.name)}</div>
        <div class="cm-plsub">${pl.trackCount} 首 · ${fmtPlay(pl.playCount)}播放</div>
      </div>`).join(''));
    const els = [...box.querySelectorAll('.cm-plcard')].slice(-added.length);
    els.forEach(c => {
      c.onclick = () => { location.hash = `#/ncmpl/${c.dataset.id}`; };
    });
    if (from) { animateIn(els); refreshMore('playlist'); }
    else if (items) animateIn(els);
  }

  function renderMatchPanel() {
    const p = panel();
    const items = S.items.match;
    const songs = items.filter(item => item.song).map(item => item.song);
    p.innerHTML = `<div class="cm-sec-head"><h2>关键词匹配</h2></div>
      ${songs.length ? '<div id="matchSongs"></div>' : ''}
      <div class="cm-search-links">${items.filter(item => !item.song).map(item =>
        `<a href="${item.href}"><small>${item.label}</small><span>${esc(item.name)}</span></a>`).join('')}</div>`;
    if (songs.length) renderSongList(p.querySelector('#matchSongs'), songs, { deferStatus: true, onPlay: i => playSong(songs, i) });
  }

  const RENDERERS = { song: renderSongPanel, lyric: renderSongPanel, album: renderAlbumPanel,
    artist: renderArtistPanel, playlist: renderPlaylistPanel, match: renderMatchPanel };

  function renderPanel(from = 0, { items = false } = {}) {
    const type = S.cur;
    if (!loadedCount(type)) {
      panel().innerHTML = `<div class="cm-empty">没有找到「${esc(S.kw)}」的${type === 'match' ? '匹配结果' : TABS.find(tab => tab.k === type).label}</div>`;
      return;
    }
    RENDERERS[type](from, items, type);
  }

  /** 切 TAB：内容按切换方向轻微横移 + 淡入（左右顺序决定方向）。 */
  function animatePanel(dir) {
    const p = panel();
    if (!dir || !p || reduceMotion() || !p.animate) return;
    p.animate(
      [{ opacity: 0, transform: `translateX(${dir * 16}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 230, easing: EASE });
  }

  let tabRun = 0;
  async function selectTab(k, retry = false) {
    if (!S || (S.cur === k && !retry)) return;
    const order = TABS.map(t => t.k);
    const dir = order.indexOf(k) > order.indexOf(S.cur) ? 1 : -1;
    S.cur = k;
    const run = ++tabRun;
    renderTabs();
    if (!S.loaded[k]) {
      // 切到尚未取过的类型：按需取一次（首屏为了速度没有预取完）
      panel().innerHTML = panelLoading();
      const my = seq;
      try {
        await firstPage(k);
      } catch (e) {
        if (my !== seq || run !== tabRun || !el.isConnected) return;
        renderSearchError(k, e);
        return;
      }
      if (my !== seq || run !== tabRun || !el.isConnected) return;
      renderTabs();
    }
    renderPanel(0, { items: false });
    animatePanel(dir);
  }

  function renderSearchError(type, e) {
    const p = panel();
    p.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}
      <mdui-button id="searchRetry" variant="text">重试</mdui-button></div>`;
    p.querySelector('#searchRetry').onclick = () => selectTab(type, true);
  }

  function renderShell(error) {
    resultBox.innerHTML = `
      <div class="cm-srchtabs" id="srchTabs"></div>
      <div id="srchPanel"></div>`;
    renderTabs();
    if (error) renderSearchError('song', error);
    else renderPanel(0, { items: true });
  }

  async function doSearch(kw) {
    kw = kw.trim().slice(0, 100);
    if (!kw) { input.focus(); return; }
    hideSuggestions();
    input.value = kw;
    input.blur();
    if (searchCycle && S?.kw === kw) return;
    const my = ++seq;
    if (searchCycle) searchCycle.cancel();
    historyVisible = true;
    recordSearch(kw);
    renderHist();
    hotBox.hidden = true;
    catBox.style.display = 'none';
    local.hidden = true;
    resultBox.innerHTML = searchResultSkeleton(6);
    const cycle = loadingCycle(resultBox.querySelector('.cm-search-loading'));
    searchCycle = cycle;
    S = newState(kw);

    // 首屏只等「单曲」：上游「歌手」实测可达 6s+，没必要让它拖住首屏
    let error;
    try { await firstPage('song'); } catch (e) { error = e; }
    if (my !== seq) return;
    await cycle.finish();
    if (my !== seq || !el.isConnected) return;
    searchCycle = null;
    renderShell(error);
    // 歌词与多重匹配只在用户打开对应标签时请求。
    setTimeout(() => {
      if (my !== seq || !el.isConnected) return;
      BACKGROUND_TYPES.forEach(t => {
        firstPage(t).then(() => { if (my === seq && el.isConnected) renderTabs(); }).catch(() => {});
      });
    }, 300);
  }

  let composing = false;
  function editQuery() {
    const kw = (input.value || '').trim();
    historyVisible = !kw;
    local.hidden = !!kw;
    if (!kw) {
      seq++;
      if (searchCycle) searchCycle.cancel();
      searchCycle = null;
      S = null;
      resultBox.innerHTML = '';
      hideSuggestions();
      catBox.style.display = '';
      renderHist();
      return;
    }
    catBox.style.display = 'none';
    histBox.innerHTML = ''; hotBox.hidden = true;
    queueSuggest(kw);
  }
  input.addEventListener('compositionstart', () => { composing = true; hideSuggestions(); });
  input.addEventListener('compositionend', () => { composing = false; editQuery(); });
  input.addEventListener('input', e => { if (!composing && !e.isComposing) editQuery(); });
  const submitSearch = () => doSearch((input.value || '').trim() || defaultKeyword);
  el.querySelector('.cm-search-submit').addEventListener('submit', e => {
    e.preventDefault();
    if (!composing) submitSearch();
  });
  input.addEventListener('keydown', e => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); submitSearch(); }
    if (e.key === 'Escape') hideSuggestions();
    const first = e.key === 'ArrowDown' && sugBox.querySelector('button');
    if (first) {
      e.preventDefault();
      first.focus();
    }
  });

  /* ---------- 搜索建议 ---------- */
  let sugTimer = null, sugSeq = 0;
  function hideSuggestions() {
    clearTimeout(sugTimer);
    sugSeq++;
    sugBox.innerHTML = '';
  }
  function queueSuggest(kw) {
    hideSuggestions();
    const my = sugSeq;
    const isCurrent = () => my === sugSeq && el.isConnected && (input.value || '').trim() === kw;
    sugBox.innerHTML = suggestionSkeleton;
    sugTimer = setTimeout(async () => {
      try {
        const mobile = await api.searchSuggest(kw).catch(() => null);
        if (!isCurrent()) return;
        let words = (mobile?.result?.allMatch || []).map(x => x.keyword).filter(Boolean);
        if (!words.length) {
          const pc = await api.ncm('/search/suggest/pc', { keyword: kw });
          words = (pc?.data?.suggests || []).map(x => x.keyword).filter(Boolean);
        }
        if (!isCurrent()) return;
        if (!words.length) { hideSuggestions(); return; }
        words = [...new Set(words)].slice(0, 10);
        sugBox.innerHTML = `<div class="cm-sug" role="group" aria-label="搜索候选">${words.map(w =>
          `<button type="button" class="cm-sug-item" data-k="${esc(w)}" aria-label="搜索 ${esc(w)}">` +
          `<span class="material-icons-outlined" aria-hidden="true">search</span><span class="k">${esc(w)}</span></button>`).join('')}</div>`;
        sugBox.querySelectorAll('[data-k]').forEach(c => {
          c.onclick = () => doSearch(c.dataset.k);
          c.onkeydown = e => {
            if (e.key === 'Escape') { hideSuggestions(); input.focus(); }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              const target = e.key === 'ArrowUp' ? c.previousElementSibling || input : c.nextElementSibling;
              target?.focus();
            }
          };
        });
      } catch { if (isCurrent()) hideSuggestions(); }
    }, 300);
  }

  // 从发现页等入口带关键词直达（#/search?q=xxx）
  const preset = ((params && params.query) || {}).q || '';
  if (preset.trim()) doSearch(preset);

  // 桌面端自动聚焦。触屏设备上程序化聚焦既弹不出键盘（iOS 需要用户手势），
  // 还会把页面滚到输入框、顶穿固定顶栏——反而添乱，只在有鼠标的设备上聚焦。
  if (!preset.trim() && matchMedia('(hover: hover) and (pointer: fine)').matches) {
    setTimeout(() => { if (input.isConnected && !S) input.focus(); }, 100);
  }
}
