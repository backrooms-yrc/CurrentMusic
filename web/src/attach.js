// 内容引用卡片（单曲 / 专辑 / 歌手 / 歌单）——帖子与聊天共用。
//
// 从 posts.js 抽出（v1.28.45）：帖子用它展示附件，Chat 用它引用内容。
// 选择器复用 /ncm/search；卡片点击行为统一为「单曲直接播、其余跳详情页」。
import { mdui } from './md.js';
import { api } from './api.js';
import { esc, toast } from './ui.js';
import { player } from './player.js';

export const MAX_ATTACH = 5;
export const TYPE_LABEL = { song: '单曲', album: '专辑', artist: '歌手', playlist: '歌单' };
const TYPE_ICON = { song: 'music_note', album: 'album', artist: 'person', playlist: 'queue_music' };

/** 附带内容卡片。compact=true 用于聊天气泡下方（更小的图标与内边距）。 */
export function attachHTML(list, { compact = false } = {}) {
  if (!list || !list.length) return '';
  return `<div class="cm-post-atts${compact ? ' compact' : ''}">` + list.map((a, i) => `
    <div class="cm-post-att" data-i="${i}" title="${esc(TYPE_LABEL[a.type] || '')}·${esc(a.name || '')}">
      <div class="cm-post-att-pic">${a.pic
        ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy" onerror="this.remove()">`
        : `<span class="material-icons-outlined">${TYPE_ICON[a.type] || 'link'}</span>`}</div>
      <div class="cm-post-att-t">
        <div class="cm-post-att-name">${esc(a.name || '')}</div>
        <div class="cm-post-att-sub">${esc(TYPE_LABEL[a.type] || '')}${a.sub ? ' · ' + esc(a.sub) : ''}</div>
      </div>
    </div>`).join('') + `</div>`;
}

/** 绑定卡片点击：单曲直接播放，其余跳详情页。box 内可含多组卡片时请按消息分别调用。 */
export function bindAttach(box, list) {
  if (!box || !list || !list.length) return;
  box.querySelectorAll('.cm-post-att').forEach(el => {
    el.onclick = () => {
      const a = list[+el.dataset.i];
      if (!a) return;
      if (a.type === 'song') {
        player.playList([{ ncm_id: a.id, name: a.name, artists: a.sub || '', album: '', pic: a.pic || '', duration: 0 }], 0);
        toast('开始播放：' + a.name);
        return;
      }
      if (a.type === 'playlist') { location.hash = `#/ncmpl/${a.id}`; return; }
      if (a.type === 'artist') { location.hash = `#/artist/${a.id}`; return; }
      if (a.type === 'album') { location.hash = `#/album/${a.id}`; return; }
    };
  });
}

/** 引用选择器：类型切换 + 搜索（复用 /ncm/search），支持多选。 */
export function openAttachPicker(onPick) {
  const state = { type: 'song', list: [], sel: [], offset: 0, loading: false };
  const diag = mdui.dialog({
    headline: '添加引用内容',
    body: `<div class="cm-picker">
      <div class="cm-picker-tabs">
        ${Object.keys(TYPE_LABEL).map(k => `<mdui-chip ${k === state.type ? 'selected' : ''} data-k="${k}">${TYPE_LABEL[k]}</mdui-chip>`).join('')}
      </div>
      <div class="cm-picker-search">
        <mdui-text-field id="pkQ" label="搜索（回车）" variant="outlined" style="width:100%"></mdui-text-field>
      </div>
      <div class="cm-picker-list" id="pkList"><div class="cm-peditor-empty">输入关键词搜索</div></div>
    </div>`,
    actions: [
      { text: '取消' },
      { text: '确定', onClick: () => { if (!state.sel.length) { toast('还没有选择'); return false; } onPick(state.sel); } },
    ],
  });
  const listBox = diag.querySelector('#pkList');
  const input = diag.querySelector('#pkQ');

  const ARR = { song: 'songs', album: 'albums', artist: 'artists', playlist: 'playlists' };
  // 单曲对象的 id 字段是 ncm_id（专辑/歌手/歌单才是 id）——统一取 x.id 会得到 undefined。
  const norm = (t, x) => ({
    type: t,
    id: t === 'song' ? (x.ncm_id != null ? x.ncm_id : x.id) : x.id,
    name: x.name,
    sub: t === 'song' ? (x.artists || '') : (x.artist || x.alias || `${x.trackCount || 0} 首`),
    pic: x.pic || '',
  });

  async function search() {
    const kw = (input.value || '').trim();
    if (!kw) return;
    listBox.innerHTML = '<div class="cm-loading small"><mdui-circular-progress></mdui-circular-progress></div>';
    try {
      const d = await api.search(kw, 0, 12, state.type);
      state.list = (d[ARR[state.type]] || []).map(x => norm(state.type, x));
      draw();
    } catch (e) { listBox.innerHTML = `<div class="cm-empty small">搜索失败：${esc(e.message)}</div>`; }
  }
  function draw() {
    if (!state.list.length) { listBox.innerHTML = '<div class="cm-empty small">没有找到</div>'; return; }
    listBox.innerHTML = state.list.map((x, i) => {
      const on = state.sel.some(s => s.type === x.type && s.id === x.id);
      return `<div class="cm-picker-item ${on ? 'on' : ''}" data-i="${i}">
        <div class="cm-picker-pic">${x.pic ? `<img src="${esc(x.pic)}?param=80y80" loading="lazy" onerror="this.remove()">`
          : `<span class="material-icons-outlined">${TYPE_ICON[x.type]}</span>`}</div>
        <div class="cm-picker-t"><div class="cm-picker-name">${esc(x.name)}</div>
          <div class="cm-picker-sub">${esc(x.sub)}</div></div>
        <span class="material-icons-outlined cm-picker-check">${on ? 'check_circle' : 'add_circle_outline'}</span>
      </div>`;
    }).join('');
    listBox.querySelectorAll('.cm-picker-item').forEach(el => {
      el.onclick = () => {
        const x = state.list[+el.dataset.i];
        const i = state.sel.findIndex(s => s.type === x.type && s.id === x.id);
        if (i >= 0) state.sel.splice(i, 1); else state.sel.push(x);
        draw();
      };
    });
  }
  diag.querySelectorAll('.cm-picker-tabs mdui-chip').forEach(ch => {
    ch.onclick = () => {
      state.type = ch.dataset.k;
      diag.querySelectorAll('.cm-picker-tabs mdui-chip').forEach(c => c.classList.toggle('selected', c === ch));
      state.list = []; state.sel = [];
      listBox.innerHTML = '<div class="cm-peditor-empty">输入关键词搜索</div>';
      input.focus();
    };
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
  setTimeout(() => input.focus(), 100);
}
