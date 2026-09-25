// 用户广场：所有用户（头像/昵称/个签）· 多排序（管理员置顶）· 搜索 · 分页
import { api } from '../api.js';
import { esc, toast, avatarHTML } from '../ui.js';

const SORTS = [
  { key: 'reg', label: '注册最新' },
  { key: 'reg_asc', label: '注册最早' },
  { key: 'name', label: '昵称' },
  { key: 'days', label: '听歌天数' },
  { key: 'likes', label: '点赞数' },
];
const PAGE = 30;

export async function render(el, params, state = {}) {
  const query = state.query ?? ((params && params.q) || '');
  const sort = state.sort ?? (sessionStorage.getItem('cm.sqSort') || 'reg');
  const users = state.users ?? null;
  const total = state.total ?? 0;

  el.innerHTML = `
    <div class="cm-search-bar">
      <mdui-text-field id="sq" label="搜索昵称 / 个签（回车）" variant="outlined" clearable style="width:100%"></mdui-text-field>
    </div>
    <div class="cm-plsort" id="sqSort">
      <span class="cm-plsort-l"><span class="material-icons-outlined">sort</span>排序</span>
      ${SORTS.map(s => `<mdui-chip ${s.key === sort ? 'selected' : ''} data-k="${s.key}">${s.label}</mdui-chip>`).join('')}
    </div>
    <div id="sqGrid" class="cm-sq-grid"></div>`;

  const grid = el.querySelector('#sqGrid');
  const input = el.querySelector('#sq');
  input.value = query;

  const card = u => `
    <div class="cm-ucard" data-id="${u.id}">
      <div class="cm-uava">${avatarHTML(u, 52)}</div>
      <div class="cm-umain">
        <div class="cm-uname">${esc(u.nickname || `用户${u.id}`)}${u.is_super ? '<span class="cm-tag super">超级管理员</span>' : u.is_admin ? '<span class="cm-tag admin">管理员</span>' : ''}</div>
        <div class="cm-ubio">${esc(u.bio || '这个人很懒，什么都没写')}</div>
        <div class="cm-usub">点赞 ${u.likes} · 歌单 ${u.playlists} · 听歌 ${u.days} 天</div>
      </div>
    </div>`;

  const load = async (offset, append) => {
    if (!append) grid.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
    else grid.querySelector('#sqMore')?.remove();
    let d;
    try {
      d = await api.userSquare(query, sort, offset, PAGE);
    } catch (e) {
      grid.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
    const list = d.users || [];
    if (!append) grid.innerHTML = '';
    if (!list.length && !append) {
      grid.innerHTML = query ? `<div class="cm-empty">没有找到「${esc(query)}」相关的用户</div>` : '<div class="cm-empty small">还没有用户</div>';
      return;
    }
    grid.insertAdjacentHTML(append ? 'beforeend' : 'afterbegin',
      append ? list.map(card).join('') : list.map(card).join(''));
    const shown = grid.querySelectorAll('.cm-ucard').length;
    if (shown < d.total) {
      grid.insertAdjacentHTML('beforeend',
        `<div class="cm-sq-more"><mdui-button variant="tonal" id="sqMore">加载更多（${shown}/${d.total}）</mdui-button></div>`);
      grid.querySelector('#sqMore').onclick = () => load(shown, true);
    }
    grid.querySelectorAll('.cm-ucard').forEach(c => {
      c.onclick = () => { location.hash = `#/u/${c.dataset.id}`; };
    });
  };

  // 排序/搜索沿用「明确动作」交互：回车搜索、点击切换排序
  el.querySelectorAll('#sqSort mdui-chip').forEach(ch => {
    ch.onclick = () => {
      sessionStorage.setItem('cm.sqSort', ch.dataset.k);
      render(el, params, { query: input.value.trim(), sort: ch.dataset.k });
    };
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') render(el, params, { query: input.value.trim(), sort });
  });
  load(0, false);
}
