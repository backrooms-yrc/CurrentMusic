// 用户广场：所有用户（头像/昵称/个签）· 多排序（管理员置顶）· 搜索 · 分页
import { api } from '../api.js';
import { esc, toast, avatarHTML, fmtListen } from '../ui.js';

const SORTS = [
  { key: 'reg', label: '注册最新' },
  { key: 'reg_asc', label: '注册最早' },
  { key: 'name', label: '昵称' },
  { key: 'days', label: '听歌天数' },
  { key: 'listen', label: '听歌时长' },
  { key: 'likes', label: '点赞数' },
];
const PAGE = 30;

export async function render(el, params, state = {}) {
  const query = state.query ?? ((params && params.q) || '');
  const sort = state.sort ?? (sessionStorage.getItem('cm.sqSort') || 'reg');
  // 「仅显示正在听歌」：与排序一样记住选择（会话级）
  const listening = state.listening ?? (sessionStorage.getItem('cm.sqListening') === '1');
  const users = state.users ?? null;
  const total = state.total ?? 0;

  el.innerHTML = `
    <div class="cm-sq-stats" id="sqStats"><span class="material-icons-outlined">groups</span>正在统计…</div>
    <div class="cm-search-bar">
      <mdui-text-field id="sq" label="搜索昵称 / 个签（回车）" variant="outlined" clearable style="width:100%"></mdui-text-field>
    </div>
    <div class="cm-sq-filter">
      <mdui-checkbox id="sqListening" ${listening ? 'checked' : ''}>仅显示正在听歌的用户</mdui-checkbox>
      <span class="cm-sq-filter-hint" id="sqFilterHint"></span>
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
        <div class="cm-usub">点赞 ${u.likes} · 歌单 ${u.playlists} · ${sort === 'listen' ? '时长 ' + fmtListen(u.listenMs) : '听歌 ' + u.days + ' 天'}</div>
      </div>
    </div>`;

  const renderStats = st => {
    const box = el.querySelector('#sqStats');
    if (!box || !st) return;
    box.innerHTML = `<span class="material-icons-outlined">groups</span>共 <b>${st.users}</b> 位注册用户`
      + `<i></i><span class="material-icons-outlined">graphic_eq</span>${st.listening > 0 ? `<b>${st.listening}</b> 人正在听歌` : '暂时没人在听歌'}`;
  };
  // 在线人数会随时变化：进页面后每 30s 刷新一次统计（页面切走即自动停止——元素不存在时跳过）
  let statsTimer = setInterval(async () => {
    if (!el.querySelector('#sqStats')) { clearInterval(statsTimer); return; }
    try { const d = await api.userSquare(query, sort, 0, 1, listening); renderStats(d.stats); } catch { /* 忽略 */ }
  }, 30000);

  const load = async (offset, append) => {
    if (!append) grid.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
    else grid.querySelector('#sqMore')?.remove();
    let d;
    try {
      d = await api.userSquare(query, sort, offset, PAGE, listening);
    } catch (e) {
      grid.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
    const list = d.users || [];
    renderStats(d.stats);
    if (!append) grid.innerHTML = '';
    if (!list.length && !append) {
      if (listening) {
        grid.innerHTML = `<div class="cm-empty small">${query
          ? `「${esc(query)}」里当前没有正在听歌的用户`
          : '当前没有正在听歌的用户'}</div>`;
      } else {
        grid.innerHTML = query ? `<div class="cm-empty">没有找到「${esc(query)}」相关的用户</div>` : '<div class="cm-empty small">还没有用户</div>';
      }
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
      render(el, params, { query: input.value.trim(), sort: ch.dataset.k, listening });
    };
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') render(el, params, { query: input.value.trim(), sort, listening });
  });

  // 「仅显示正在听歌」：勾选后立即重查（从第一页开始）
  const listenBox = el.querySelector('#sqListening');
  listenBox.addEventListener('change', () => {
    const on = !!listenBox.checked;
    sessionStorage.setItem('cm.sqListening', on ? '1' : '0');
    render(el, params, { query: input.value.trim(), sort, listening: on });
  });

  // 顶部提示：过滤生效时说明当前口径
  const hint = el.querySelector('#sqFilterHint');
  if (hint) hint.textContent = listening ? '（近 5 分钟内有播放）' : '';

  load(0, false);
}
