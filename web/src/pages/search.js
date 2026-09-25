// 搜索页：回车触发搜索 + 历史记录（不做逐字防抖——中间态查询会同时打爆上游与碎片化历史）
import { api, auth } from '../api.js';
import { esc, renderSongList, toast, skelList } from '../ui.js';

// 搜索结果专用骨架屏：保留歌曲行结构，避免请求期间结果区跳空
const searchResultSkeleton = (n = 8) => `<div class="cm-search-result-skeleton" aria-busy="true" aria-label="搜索结果加载中">
  <div class="cm-skel-list">${Array.from({ length: n }, () => `<div class="cm-skel-song"><div class="sk sk-pic"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join('')}</div>
</div>`;
import { api as _api } from '../api.js';
import { player } from '../player.js';
import { addToPlaylist } from '../player-ui.js';

const HIST_KEY = 'cm.searchHistory';
const hist = () => { try { return JSON.parse(localStorage.getItem(HIST_KEY)) || []; } catch { return []; } };
const pushHist = kw => {
  const h = [kw, ...hist().filter(x => x !== kw)].slice(0, 10);
  localStorage.setItem(HIST_KEY, JSON.stringify(h));
};

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

  async function doSearch(kw) {
    const my = ++seq;
    pushHist(kw);
    renderHist();
    hotBox.innerHTML = '';   // 有搜索内容后隐藏热搜
    resultBox.innerHTML = searchResultSkeleton(8);
    let songs = [];
    try {
      songs = (await api.search(kw, 0, 30)).songs || [];
    } catch (e) {
      if (my === seq) resultBox.innerHTML = `<div class="cm-empty">搜索失败：${esc(e.message)}</div>`;
      return;
    }
    if (my !== seq) return;
    if (!songs.length) { resultBox.innerHTML = `<div class="cm-empty">没有找到「${esc(kw)}」的相关结果</div>`; return; }
    const head = document.createElement('div');
    head.className = 'cm-sec-head';
    head.innerHTML = `<h2>「${esc(kw)}」的搜索结果</h2>
      <span class="cm-sec-more" id="addAll"><span class="material-icons-outlined">playlist_add</span> 全部收入歌单</span>`;
    resultBox.innerHTML = '';
    resultBox.appendChild(head);
    const list = document.createElement('div');
    resultBox.appendChild(list);
    await renderSongList(list, songs, { onPlay: i => player.playList(songs, i) });
    head.querySelector('#addAll').onclick = () => addToPlaylist(songs);
  }

  // 输入不触发搜索：只有回车（或点击热搜/历史词条这类明确动作）才发起请求
  input.addEventListener('input', () => {
    if (!(input.value || '').trim()) { seq++; resultBox.innerHTML = ''; renderHist(); renderHot(); }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const kw = (input.value || '').trim(); if (kw) doSearch(kw); }
  });
  setTimeout(() => input.focus(), 100);
}
