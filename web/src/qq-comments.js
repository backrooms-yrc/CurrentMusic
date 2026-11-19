import { mdui } from './md.js';
import { esc, fmtCount } from './ui.js';
import { qqRequest } from './qqmusic.js';

export function openQqComments(song) {
  if (!/^\d{1,16}$/.test(song?.qq_id || '')) return;
  const dialog = mdui.dialog({
    headline: 'QQ 音乐评论',
    body: `<div class="cm-form">
      <div class="cm-chips"><button type="button" class="cm-hot" data-order="hot">最热</button>
        <button type="button" class="cm-hot" data-order="new">最新</button></div>
      <div id="qqCommentList"></div>
      <p id="qqCommentStatus" role="status"></p>
      <mdui-button variant="text" id="qqCommentMore" hidden>加载更多</mdui-button>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  const status = dialog.querySelector('#qqCommentStatus');
  const list = dialog.querySelector('#qqCommentList');
  const more = dialog.querySelector('#qqCommentMore');
  let order = 'hot', offset = 0, controller;
  const limit = 20;

  async function load(append = false) {
    controller?.abort();
    const own = controller = new AbortController();
    if (!append) list.textContent = '';
    more.hidden = true;
    dialog.querySelectorAll('[data-order]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.order === order));
    });
    status.textContent = '正在加载评论…';
    const at = append ? offset + limit : 0;
    try {
      const path = order === 'hot' ? '/native/comment/hot' : '/native/comment/new';
      const response = await qqRequest(path, {
        query: { id: song.qq_id, limit, offset: at }, withSession: false, signal: own.signal,
      });
      if (own.signal.aborted || !dialog.open) return;
      const rows = Array.isArray(response.comments) ? response.comments : [];
      list.insertAdjacentHTML('beforeend', rows.map(row => `<div class="cm-lm-item">
        <div class="cm-lm-lyric">${esc(row.content || '')}</div>
        <div class="cm-lm-meta"><span>${esc(row.nick || 'QQ 音乐用户')}</span><span>${fmtCount(row.praiseCount || 0)} 赞</span></div>
      </div>`).join(''));
      offset = at;
      status.textContent = !rows.length && !append ? '暂无评论' : '';
      more.textContent = '加载更多';
      more.hidden = !response.more || !rows.length;
      more.onclick = () => load(true);
    } catch (error) {
      if (own.signal.aborted || !dialog.open) return;
      status.textContent = error.message;
      more.textContent = '重试';
      more.hidden = false;
      more.onclick = () => load(append);
    }
  }

  dialog.querySelectorAll('[data-order]').forEach(button => {
    button.onclick = () => { order = button.dataset.order; load(); };
  });
  dialog.addEventListener('close', () => controller?.abort(), { once: true });
  load();
}
