// 歌手分类浏览（阶段三新增）：/artist/list 按 类型 / 地区 / 首字母 三个维度筛选 + 分页
import { api } from '../api.js';
import { esc, toast, skelGrid } from '../ui.js';

const TYPES = [{ k: -1, l: '全部' }, { k: 1, l: '男歌手' }, { k: 2, l: '女歌手' }, { k: 3, l: '乐队' }];
const AREAS = [{ k: -1, l: '全部' }, { k: 7, l: '华语' }, { k: 96, l: '欧美' }, { k: 8, l: '日本' }, { k: 16, l: '韩国' }, { k: 0, l: '其他' }];
const INITIALS = [{ k: -1, l: '热门' }].concat('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => ({ k: c.toLowerCase(), l: c })));

const KEY = 'cm.artistsFilter';
const PAGE = 30;

function loadFilter() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

export async function render(el, params = {}) {
  const saved = loadFilter();
  const state = { type: params.type ?? saved.type ?? -1, area: params.area ?? saved.area ?? -1, initial: params.initial ?? saved.initial ?? -1 };

  el.innerHTML = `
    <div class="cm-plsort" id="afType"><span class="cm-plsort-l">类型</span>
      ${TYPES.map(t => `<mdui-chip ${t.k === state.type ? 'selected' : ''} data-v="${t.k}">${t.l}</mdui-chip>`).join('')}</div>
    <div class="cm-plsort" id="afArea"><span class="cm-plsort-l">地区</span>
      ${AREAS.map(t => `<mdui-chip ${t.k === state.area ? 'selected' : ''} data-v="${t.k}">${t.l}</mdui-chip>`).join('')}</div>
    <div class="cm-plsort" id="afInit"><span class="cm-plsort-l">首字母</span>
      ${INITIALS.map(t => `<mdui-chip ${t.k === state.initial ? 'selected' : ''} data-v="${t.k}">${t.l}</mdui-chip>`).join('')}</div>
    <div class="cm-artist-grid" id="afGrid">${skelGrid(12)}</div>`;

  const grid = el.querySelector('#afGrid');
  const paint = () => {
    localStorage.setItem(KEY, JSON.stringify(state));
    el.querySelectorAll('#afType mdui-chip').forEach(c => c.toggleAttribute('selected', Number(c.dataset.v) === state.type));
    el.querySelectorAll('#afArea mdui-chip').forEach(c => c.toggleAttribute('selected', Number(c.dataset.v) === state.area));
    el.querySelectorAll('#afInit mdui-chip').forEach(c => c.toggleAttribute('selected', c.dataset.v === String(state.initial)));
  };

  const load = async (offset, append) => {
    if (!append) grid.innerHTML = skelGrid(12);
    let d;
    try {
      d = await api.ncm('/artist/list', { type: state.type, area: state.area, initial: state.initial, limit: PAGE, offset });
    } catch (e) {
      grid.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
    const list = d.artists || [];
    if (!append) grid.innerHTML = '';
    if (!list.length && !append) { grid.innerHTML = '<div class="cm-empty small">该筛选下暂无歌手</div>'; return; }
    grid.insertAdjacentHTML('beforeend', list.map(a => `
      <div class="cm-artist-card" data-aid="${a.id}">
        <div class="cm-artist-ava">${a.picUrl ? `<img src="${esc(a.picUrl)}?param=160y160" loading="lazy" onerror="this.remove()">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div class="cm-artist-name">${esc(a.name)}</div>
        ${a.fansCount ? `<div class="cm-artist-sub">${a.fansCount >= 10000 ? (a.fansCount / 10000).toFixed(1) + '万粉丝' : a.fansCount + '粉丝'}</div>` : ''}
      </div>`).join(''));
    grid.querySelectorAll('.cm-artist-card').forEach(c => {
      if (c.dataset.bound) return;
      c.dataset.bound = '1';
      c.onclick = () => { location.hash = `#/artist/${c.dataset.aid}`; };
    });
    grid.querySelector('#afMore')?.remove();
    if (list.length >= PAGE) {
      grid.insertAdjacentHTML('beforeend',
        '<div class="cm-sq-more" id="afMore" style="grid-column:1/-1"><mdui-button variant="tonal">加载更多</mdui-button></div>');
      grid.querySelector('#afMore mdui-button').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        try { await load(offset + list.length, true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };

  const bindRow = (sel, key) => {
    el.querySelectorAll(`${sel} mdui-chip`).forEach(c => {
      c.onclick = () => {
        state[key] = sel === '#afInit' ? c.dataset.v : Number(c.dataset.v);
        paint();
        load(0, false);
      };
    });
  };
  bindRow('#afType', 'type');
  bindRow('#afArea', 'area');
  bindRow('#afInit', 'initial');
  paint();
  await load(0, false);
}
