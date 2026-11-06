// 通用网易云评论抽屉。排序与楼层分页使用服务端统一响应。
import { api } from './api.js';
import { esc, fmtCount, toast, skelComments } from './ui.js';
import { renderEmoticons, fmtCmtTime } from './commentutil.js';

const SORTS = { recommended: '推荐', hot: '最热', latest: '最新' };
export const COMMENT_TYPE = { song: 0, mv: 1, playlist: 2, album: 3, dj: 4, video: 5, event: 6 };
let dismissComments;

export async function openComments({ type = 0, id, title = '' } = {}) {
  if (!Object.values(COMMENT_TYPE).includes(type) || !id) return toast('缺少评论对象');
  dismissComments?.(true);
  const ov = document.createElement('div');
  ov.id = 'commentOverlay';
  ov.innerHTML = `
    <div class="cmt-page">
      <header class="cmt-top">
        <button type="button" class="pl-btn cmt-action" id="cmtClose" aria-label="关闭评论"><span class="material-icons-outlined" aria-hidden="true">keyboard_arrow_down</span></button>
        <div class="cmt-title">评论区 · ${esc(title)}</div>
        <span class="cmt-top-spacer" aria-hidden="true"></span>
      </header>
      <div class="cmt-modes" role="group" aria-label="评论排序">
        ${Object.entries(SORTS).map(([key, label]) =>
          `<button type="button" class="cmt-mode cmt-action" data-sort="${key}" aria-pressed="false">${label}</button>`).join('')}
        <span class="cmt-total"></span>
      </div>
      <div class="cmt-list" id="cmtList">
        <div class="cmt-items"></div>
        <div class="cmt-list-status" role="status"></div>
        <button type="button" class="cmt-page-more cmt-action" id="cmtMore" hidden></button>
      </div>
      <div class="cmt-composer">
        <div id="cmtReplyBar" hidden><span></span><button type="button" class="cmt-action" id="cmtReplyCancel" aria-label="取消回复"><span class="material-icons-outlined" aria-hidden="true">close</span></button></div>
        <input id="cmtInput" type="text" maxlength="140" aria-label="网易云评论内容" placeholder="绑定网易云账号后可发评" disabled>
        <mdui-button variant="filled" id="cmtSend" disabled>发送</mdui-button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  document.dispatchEvent(new Event('cm-comments-visibility'));

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const entered = reduced ? Promise.resolve() : new Promise(resolve => {
    const finish = () => { clearTimeout(timer); ov.removeEventListener('animationend', end); resolve(); };
    const end = event => { if (event.target === ov) finish(); };
    const timer = setTimeout(finish, 280);
    ov.addEventListener('animationend', end);
  });
  let closing = false;
  const active = () => !closing && ov.isConnected;
  function close(immediate = false) {
    if (closing && !immediate) return;
    closing = true;
    window.removeEventListener('cm-authchange', authChanged);
    ov.classList.add('closing');
    const remove = () => {
      if (!ov.isConnected) return;
      ov.remove();
      if (dismissComments === close) dismissComments = null;
      document.dispatchEvent(new Event('cm-comments-visibility'));
    };
    if (immediate || reduced) remove();
    else setTimeout(remove, 240);
  }
  function authChanged() { close(true); }
  window.addEventListener('cm-authchange', authChanged);
  dismissComments = close;

  const input = ov.querySelector('#cmtInput');
  const sendButton = ov.querySelector('#cmtSend');
  const replyBar = ov.querySelector('#cmtReplyBar');
  const list = ov.querySelector('#cmtList');
  const items = list.querySelector('.cmt-items');
  const status = list.querySelector('.cmt-list-status');
  const moreButton = list.querySelector('#cmtMore');
  const total = ov.querySelector('.cmt-total');
  const resource = { type, id };
  const writeResource = type === COMMENT_TYPE.event ? { type, threadId: id } : resource;
  const floors = new WeakMap();
  const reactions = new Map();
  const liking = new Set();
  let current, meUid = '', replyTo = null, sending = false;

  function setReply(target) {
    replyTo = target;
    replyBar.hidden = !target;
    replyBar.firstElementChild.textContent = target ? `回复 @${target.nickname}` : '';
    input.placeholder = target ? `回复 @${target.nickname}…` : meUid
      ? '以网易云账号发表评论…' : '绑定网易云账号后可发评';
  }

  function updateComposer(uid) {
    const next = uid ? String(uid) : '';
    if (meUid === next) return;
    meUid = next;
    input.disabled = !meUid;
    sendButton.disabled = !meUid;
    if (!meUid) setReply(null);
    else setReply(replyTo);
  }

  function requireBinding() {
    if (meUid) return true;
    toast('请先登录并绑定网易云账号');
    return false;
  }

  function icon(name) {
    return `<span class="material-icons-outlined" aria-hidden="true">${name}</span>`;
  }

  function rowHTML(c, nested) {
    const mine = !!meUid && String(c.userId) === meUid;
    const { liked, count } = reactions.get(c.id) || { liked: c.likedByMe, count: Number(c.liked) || 0 };
    const replies = Number(c.replyCount) || 0;
    return `
      <article class="cmt-item${nested ? ' cmt-floor-item' : ''}" data-cid="${esc(c.id)}">
        ${c.avatar ? `<img src="${esc(c.avatar)}" alt="" loading="lazy">` : `<div class="cmt-avaph">${icon('person')}</div>`}
        <div class="cmt-main">
          <div class="cmt-head">
            <span class="cmt-nick">${esc(c.nickname || '网易云用户')}</span>
            ${mine ? '<span class="cmt-mine">我</span><button type="button" class="cmt-del cmt-action" data-action="delete">删除</button>' : ''}
          </div>
          ${c.beNickname ? `<div class="cmt-be">回复 <strong>@${esc(c.beNickname)}</strong>${c.beContent ? ` · ${renderEmoticons(esc(c.beContent))}` : ' · 原评论已删除'}</div>` : ''}
          <div class="cmt-content">${renderEmoticons(esc(c.content))}</div>
          <div class="cmt-foot">
            <span class="cmt-time">${fmtCmtTime(c.time)}</span>
            <button type="button" class="cmt-action cmt-reply" data-action="reply">回复</button>
            ${!nested && type === COMMENT_TYPE.song ? `<button type="button" class="cmt-action cmt-hug" data-action="hug" data-uid="${esc(c.userId)}">抱一抱</button>` : ''}
            ${nested ? '' : '<button type="button" class="cmt-action cmt-report" data-action="report">举报</button>'}
            <button type="button" class="cmt-action cmt-like${liked ? ' on' : ''}" data-action="like" data-id="${esc(c.id)}"
              data-count="${count}" aria-label="点赞 ${count}" aria-pressed="${!!liked}" ${liking.has(c.id) ? 'disabled' : ''}>
              ${icon(liked ? 'thumb_up' : 'thumb_up_off_alt')}<span class="cmt-like-count">${count ? fmtCount(count) : '赞'}</span>
            </button>
          </div>
          ${nested ? '' : `
            <button type="button" class="cmt-action cmt-floor-btn" data-action="floor" data-count="${replies}"
              aria-expanded="false" aria-controls="floor-${esc(c.id)}" ${replies ? '' : 'hidden'}>${icon('expand_more')}<span class="cmt-floor-label">展开 ${fmtCount(replies)} 条回复</span></button>
            <div class="cmt-floor" id="floor-${esc(c.id)}" data-parent="${esc(c.id)}" hidden>
              <div class="cmt-floor-items"></div>
              <div class="cmt-floor-status" role="status"></div>
              <button type="button" class="cmt-action cmt-floor-more" data-action="floor-more" hidden></button>
            </div>`}
        </div>
      </article>`;
  }

  function appendRows(box, rows, seen, nested = false) {
    const fresh = rows.filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    });
    if (fresh.length) box.insertAdjacentHTML('beforeend', `<div class="${nested ? 'cmt-floor-batch' : 'cmt-batch'}">${fresh.map(row => rowHTML(row, nested)).join('')}</div>`);
  }

  function switchSort(sort) {
    current = { sort, page: 1, cursor: null, more: true, pending: false, seen: new Set() };
    for (const button of ov.querySelectorAll('[data-sort]')) {
      const selected = button.dataset.sort === sort;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
    list.scrollTop = 0;
    items.innerHTML = skelComments(5);
    total.textContent = '';
    return loadPage(current);
  }

  async function loadPage(state) {
    if (state.pending || !state.more) return;
    state.pending = true;
    list.setAttribute('aria-busy', 'true');
    moreButton.hidden = true;
    status.textContent = state.page > 1 ? '正在加载更多评论…' : '';
    try {
      const data = await api.commentPage({ ...resource, sort: state.sort, page: state.page,
        ...(state.cursor ? { cursor: state.cursor } : {}) });
      await entered;
      if (!active() || current !== state) return;
      updateComposer(data.meUid);
      if (state.page === 1) items.innerHTML = '';
      appendRows(items, data.comments, state.seen);
      total.textContent = data.total ? `${fmtCount(data.total)} 条评论` : '';
      status.textContent = state.seen.size ? '' : '还没有评论';
      state.page += 1;
      state.cursor = data.nextCursor;
      state.more = data.more;
      moreButton.textContent = '加载更多评论';
      moreButton.hidden = !state.more;
    } catch (error) {
      if (!active() || current !== state) return;
      if (state.page === 1) items.innerHTML = '';
      status.textContent = `评论加载失败 · ${error.message}`;
      moreButton.textContent = '重新加载';
      moreButton.hidden = false;
    } finally {
      state.pending = false;
      if (active() && current === state) list.removeAttribute('aria-busy');
    }
  }

  function paintFloor(toggle, floor, count = Number(toggle.dataset.count)) {
    toggle.dataset.count = count;
    toggle.hidden = !count && floor.hidden;
    toggle.setAttribute('aria-expanded', String(!floor.hidden));
    toggle.querySelector('.cmt-floor-label').textContent = floor.hidden ? `展开 ${fmtCount(count)} 条回复` : '收起回复';
  }

  async function loadFloor(floor) {
    let state = floors.get(floor);
    if (!state) {
      state = { seen: new Set(), cursor: null, more: true, pending: false };
      floors.set(floor, state);
      floor.querySelector('.cmt-floor-items').innerHTML = '';
    }
    if (state.pending || !state.more) return;
    state.pending = true;
    const note = floor.querySelector('.cmt-floor-status');
    const button = floor.querySelector('.cmt-floor-more');
    const isCurrent = () => active() && floor.isConnected && floors.get(floor) === state;
    note.textContent = '正在加载回复…';
    button.hidden = true;
    try {
      const data = await api.commentReplies({ ...resource, commentId: floor.dataset.parent,
        ...(state.cursor ? { cursor: state.cursor } : {}) });
      if (!isCurrent()) return;
      updateComposer(data.meUid);
      appendRows(floor.querySelector('.cmt-floor-items'), data.comments, state.seen, true);
      state.cursor = data.nextCursor;
      state.more = data.more;
      note.textContent = state.seen.size ? '' : '暂无回复';
      button.textContent = '加载更多回复';
      button.hidden = !state.more;
    } catch (error) {
      if (!isCurrent()) return;
      note.textContent = `回复加载失败 · ${error.message}`;
      button.textContent = '重试加载回复';
      button.hidden = false;
    } finally {
      state.pending = false;
    }
  }

  function paintLikes(cid, reaction) {
    list.querySelectorAll(`[data-action="like"][data-id="${cid}"]`).forEach(button => {
      button.disabled = liking.has(cid);
      if (!reaction) return;
      const { liked, count } = reaction;
      button.classList.toggle('on', liked);
      button.dataset.count = count;
      button.setAttribute('aria-label', `点赞 ${count}`);
      button.setAttribute('aria-pressed', String(liked));
      button.querySelector('.material-icons-outlined').textContent = liked ? 'thumb_up' : 'thumb_up_off_alt';
      button.querySelector('.cmt-like-count').textContent = count ? fmtCount(count) : '赞';
    });
  }

  async function toggleLike(button, cid) {
    if (liking.has(cid) || !requireBinding()) return;
    const liked = button.getAttribute('aria-pressed') !== 'true';
    const count = Math.max(0, Number(button.dataset.count) + (liked ? 1 : -1));
    liking.add(cid);
    paintLikes(cid);
    try {
      await api.writeComment({ ...writeResource, cid, t: liked ? 1 : 0 }, true);
      reactions.set(cid, { liked, count });
    } catch (error) {
      if (active()) toast(error.message);
    } finally {
      liking.delete(cid);
      if (active()) paintLikes(cid, reactions.get(cid));
    }
  }

  function adjustFloor(floor, delta) {
    const toggle = floor.previousElementSibling;
    paintFloor(toggle, floor, Math.max(0, Number(toggle.dataset.count) + delta));
  }

  async function deleteComment(button, row) {
    if (!requireBinding() || !confirm('删除这条网易云评论？')) return;
    button.disabled = true;
    const cid = row.dataset.cid;
    try {
      await api.writeComment({ ...writeResource, t: 0, commentId: cid });
      if (!active()) return;
      if (replyTo?.id === cid) setReply(null);
      const floor = row.closest('.cmt-floor');
      if (floor) adjustFloor(floor, -1);
      list.querySelectorAll(`[data-cid="${cid}"]`).forEach(item => item.remove());
      toast('评论已删除');
    } catch (error) {
      if (active()) toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function send() {
    if (sending || !meUid) return;
    const draft = input.value;
    const content = draft.trim();
    if (!content) return;
    const target = replyTo;
    sending = true;
    sendButton.loading = true;
    try {
      await api.writeComment({ ...writeResource, content, t: target ? 2 : 1,
        ...(target ? { commentId: target.id } : {}) });
      if (!active()) return;
      if (input.value === draft) input.value = '';
      if (replyTo === target) setReply(null);
      if (target) {
        const floor = list.querySelector(`#floor-${target.parent}`);
        if (floor) {
          adjustFloor(floor, 1);
          floors.delete(floor);
          if (!floor.hidden) void loadFloor(floor);
        }
        toast('回复已同步到网易云');
      } else {
        toast('评论已同步到网易云');
        void switchSort('latest');
      }
    } catch (error) {
      if (active()) toast(error.message);
    } finally {
      sending = false;
      sendButton.loading = false;
    }
  }

  async function otherAction(action, cid, button) {
    if (!requireBinding()) return;
    try {
      if (action === 'hug') {
        await api.ncm('/hug/comment', { sid: id, cid, uid: button.dataset.uid, type, confirm: 1 });
        toast('已抱一抱');
        const data = await api.ncm('/comment/hug/list', { sid: id, cid, uid: button.dataset.uid, type, pageSize: 30 });
        const users = data.data?.data || data.data?.users;
        const names = Array.isArray(users) ? users.slice(0, 12).map(user => user.nickname || user.userName).filter(Boolean) : [];
        if (active() && names.length) toast(`抱过的有：${names.join('、')}`);
      } else {
        const reason = prompt('举报原因（取消可返回）', '');
        if (reason === null) return;
        await api.ncm('/comment/report', { id, cid, reason: reason || '其他', confirm: 1 });
        toast('已提交举报');
      }
    } catch (error) {
      if (active()) toast(error.message);
    }
  }

  ov.querySelector('#cmtClose').onclick = () => close();
  sendButton.onclick = send;
  input.onkeydown = event => {
    if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) void send();
  };
  ov.querySelector('#cmtReplyCancel').onclick = () => setReply(null);
  ov.querySelector('.cmt-modes').onclick = event => {
    const button = event.target.closest('[data-sort]');
    if (button && button.dataset.sort !== current.sort) void switchSort(button.dataset.sort);
  };
  moreButton.onclick = () => loadPage(current);
  list.onclick = event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const row = button.closest('.cmt-item');
    const cid = row.dataset.cid;
    if (action === 'like') void toggleLike(button, cid);
    else if (action === 'delete') void deleteComment(button, row);
    else if (action === 'reply') {
      if (!requireBinding()) return;
      const parent = row.closest('.cmt-floor')?.dataset.parent || cid;
      setReply({ id: cid, parent, nickname: row.querySelector('.cmt-nick').textContent });
      input.focus();
    } else if (action === 'floor') {
      const floor = button.nextElementSibling;
      floor.hidden = !floor.hidden;
      paintFloor(button, floor);
      if (!floor.hidden && !floors.has(floor)) void loadFloor(floor);
    } else if (action === 'floor-more') void loadFloor(button.closest('.cmt-floor'));
    else void otherAction(action, cid, button);
  };

  await switchSort('recommended');
}
