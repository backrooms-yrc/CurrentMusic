import { mdui } from './md.js';
import { api, auth } from './api.js';
import { esc, avatarHTML, toast, confirmDialog, userTags, skelPosts } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { attachHTML, bindAttach } from './attach.js';
import { copyText, postUrl } from './share.js';

const PAGE = 10;
const ICON = name => `<span class="material-icons-outlined" aria-hidden="true">${name}</span>`;
const nickname = user => user.nickname || `用户${user.id}`;

function fmtAgo(ts) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN');
}

function excerpt(content) {
  const template = document.createElement('template');
  template.innerHTML = renderMarkdown(content).replace(/<br>|<\/(?:p|h[1-6]|li|pre|blockquote)>/g, '$& ');
  const text = template.content.textContent.replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > 180 ? chars.slice(0, 180).join('') + '…' : text;
}

export function postHTML(post, { detail = false, author = null } = {}) {
  const user = post.author;
  const href = `#/post/${post.id}${author ? `?from=${author}` : ''}`;
  const title = esc(post.title || '');
  const summary = detail ? '' : esc(excerpt(post.content));
  return `<article class="cm-post" data-id="${post.id}">
    <header class="cm-post-head">
      <a class="cm-post-ava" href="#/u/${user.id}" aria-label="${esc(nickname(user))}的主页">${avatarHTML(user, 40)}</a>
      <div class="cm-post-who">
        <a class="cm-post-name" href="#/u/${user.id}">${esc(nickname(user))}</a>${userTags(user)}
        <div class="cm-post-time">${fmtAgo(post.createdAt)}</div>
      </div>
      <button type="button" class="cm-post-more material-icons-outlined" data-act="more" aria-label="帖子操作">more_horiz</button>
    </header>
    ${detail ? `<h1 class="cm-post-title">${title || '帖子'}</h1>
         <div class="cm-post-body">${renderMarkdown(post.content)}</div>`
      : `<a class="cm-post-summary" href="${href}">
           ${title ? `<h2 class="cm-post-title">${title}</h2>` : ''}
           <span class="cm-post-excerpt">${summary || '查看正文'}</span>
         </a>`}
    ${attachHTML(post.attachments, { compact: !detail })}
    <footer class="cm-post-foot">
      <button type="button" class="cm-post-act${post.likedByMe ? ' on' : ''}" aria-label="点赞" aria-pressed="${!!post.likedByMe}" data-act="like">
        ${ICON(post.likedByMe ? 'favorite' : 'favorite_border')}<span data-count>${post.likeCount || 0}</span>
      </button>
      ${detail ? '<button type="button" class="cm-post-act" data-act="comments" aria-label="查看评论">'
        : `<a class="cm-post-act" href="${href}${author ? '&' : '?'}comments=1" aria-label="查看评论">`}
        ${ICON('chat_bubble_outline')}<span data-comment-count>${post.commentCount || 0}</span>
      ${detail ? '</button>' : '</a>'}
      ${detail ? `<button type="button" class="cm-post-act" data-act="share" aria-label="复制帖子链接">${ICON('share')}</button>` : ''}
    </footer>
  </article>`;
}

async function copyPostLink(id) {
  const url = postUrl(id);
  if (await copyText(url)) return toast('帖子链接已复制');
  const dialog = mdui.dialog({
    headline: '复制帖子链接',
    body: '<input class="cm-community-input" aria-label="帖子链接" readonly>',
    actions: [{ text: '关闭' }],
  });
  const input = dialog.querySelector('input');
  input.value = url;
  input.onfocus = () => input.select();
}

export function bindPostCard(card, post, onDelete) {
  bindAttach(card, post.attachments);
  let liking = false;
  const like = card.querySelector('[data-act="like"]');
  function paintLike() {
    like.classList.toggle('on', post.likedByMe);
    like.setAttribute('aria-pressed', String(post.likedByMe));
    like.querySelector('.material-icons-outlined').textContent = post.likedByMe ? 'favorite' : 'favorite_border';
    like.querySelector('[data-count]').textContent = post.likeCount;
  }
  like.onclick = async () => {
    if (liking) return;
    if (!auth.token) return toast('登录后可点赞');
    const previous = { likedByMe: post.likedByMe, likeCount: post.likeCount };
    const on = !post.likedByMe;
    liking = true;
    post.likedByMe = on;
    post.likeCount = Math.max(0, (post.likeCount || 0) + (on ? 1 : -1));
    paintLike();
    try { post.likeCount = (await api.postLike(post.id, on)).likeCount; }
    catch (e) { Object.assign(post, previous); toast('点赞失败：' + e.message); }
    finally { liking = false; paintLike(); }
  };

  const share = card.querySelector('[data-act="share"]');
  if (share) share.onclick = () => copyPostLink(post.id);
  card.querySelector('[data-act="more"]').onclick = () => {
    const actions = [
      { text: '复制链接', onClick: () => copyPostLink(post.id) },
      { text: '复制正文', onClick: async () => toast(await copyText(post.content) ? '正文已复制' : '复制失败，请长按选择') },
    ];
    if (post.canDelete) actions.push({ text: '删除', onClick: () => confirmDialog({
      title: '删除帖子', body: '删除后不可恢复，确定吗？', onOk: async () => {
        try { await api.postDelete(post.id); onDelete(); toast('帖子已删除'); }
        catch (e) { toast('删除失败：' + e.message); }
      },
    }) });
    mdui.dialog({ headline: '帖子操作', actions });
  };
}

export function mountPosts(box, { author = null } = {}) {
  let offset = 0, total = 0, loading = false;
  const seen = new Set();
  box.innerHTML = `
    ${author ? '' : `<div class="cm-post-bar">
      <mdui-button variant="filled" href="#/post/new"><span class="material-icons-outlined" slot="icon">edit</span>发帖</mdui-button>
      <span class="cm-post-hint" data-total></span>
    </div>`}
    <div data-post-list>${skelPosts(3)}</div>
    <div class="cm-sq-more" data-more hidden><mdui-button variant="tonal">加载更多</mdui-button></div>`;
  const list = box.querySelector('[data-post-list]');
  const more = box.querySelector('[data-more]');
  const button = more.querySelector('mdui-button');
  const hint = box.querySelector('[data-total]');
  const empty = author ? '还没有发布帖子' : '还没有帖子，来发第一条吧';

  function showCount() {
    if (hint) hint.textContent = total ? `共 ${total} 条` : '';
    more.hidden = offset >= total;
    button.textContent = '加载更多';
  }

  function append(post) {
    list.insertAdjacentHTML('beforeend', postHTML(post, { author }));
    const card = list.lastElementChild;
    seen.add(post.id);
    bindPostCard(card, post, () => {
      card.remove();
      seen.delete(post.id);
      offset--;
      total = Math.max(0, total - 1);
      if (!seen.size) list.innerHTML = `<div class="cm-empty">${empty}</div>`;
      showCount();
    });
  }

  async function load() {
    if (loading) return;
    loading = true;
    button.loading = true;
    try {
      const data = await api.posts(offset, PAGE, author);
      if (!box.isConnected) return;
      const posts = data.posts || [];
      if (!seen.size) list.replaceChildren();
      posts.filter(post => !seen.has(post.id)).forEach(append);
      offset += posts.length;
      total = data.total;
      showCount();
      if (!posts.length) more.hidden = true;
      if (!seen.size) list.innerHTML = `<div class="cm-empty">${empty}</div>`;
    } catch (e) {
      if (!box.isConnected) return;
      if (!seen.size) list.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      else toast('加载失败：' + e.message);
      more.hidden = false;
      button.textContent = '重试';
    } finally {
      loading = false;
      button.loading = false;
    }
  }

  button.onclick = load;
  load();
}
