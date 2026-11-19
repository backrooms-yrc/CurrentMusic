import { api, auth } from '../api.js';
import { avatarHTML, esc, skelPosts, toast, userTags } from '../ui.js';
import { bindPostCard, postHTML } from '../posts.js';

const SQUARE = '#/square?tab=posts';

function commentHTML(comment, signedIn) {
  const author = comment.author;
  const name = author.nickname || `用户${author.id}`;
  const time = new Date(comment.createdAt * 1000);
  return `<article class="cm-pcmt-item" data-comment-id="${comment.id}" tabindex="-1">
    <a class="cm-pcmt-ava" href="#/u/${author.id}" aria-label="${esc(name)}的主页">${avatarHTML(author, 32)}</a>
    <div class="cm-pcmt-main">
      <div class="cm-pcmt-who">
        <a href="#/u/${author.id}">${esc(name)}</a>${userTags(author)}
        <time datetime="${time.toISOString()}">${time.toLocaleString('zh-CN')}</time>
      </div>
      ${comment.replyTo ? `<button type="button" class="cm-pcmt-rto cm-community-link" data-parent="${comment.replyTo.id}">
        回复 @${esc(comment.replyTo.nickname || `用户${comment.replyTo.userId}`)}
      </button>` : ''}
      <div class="cm-pcmt-text">${esc(comment.content)}</div>
      ${signedIn ? `<button type="button" class="cm-pcmt-reply cm-community-link" data-reply="${comment.id}" data-name="${esc(name)}">回复</button>` : ''}
    </div>
  </article>`;
}

function mountComments(section, post, card) {
  const list = section.querySelector('[data-comment-list]');
  const more = section.querySelector('[data-comment-more]');
  const status = section.querySelector('[data-comment-status]');
  const form = section.querySelector('form');
  const input = form?.querySelector('textarea');
  const send = form?.querySelector('button[type="submit"]');
  const replyBar = form?.querySelector('[data-reply-bar]');
  const token = auth.token;
  let cursor = 0, hasMore = true, loading = false, sending = false, reply = null;

  function setReply(value) {
    reply = value;
    replyBar.hidden = !reply;
    replyBar.querySelector('span').textContent = reply ? '回复 @' + reply.name : '';
  }

  async function load() {
    if (loading) return;
    loading = true;
    more.disabled = true;
    status.textContent = '正在加载评论…';
    try {
      const data = await api.postComments(post.id, cursor);
      if (!section.isConnected) return;
      if (data.comments.length) {
        list.insertAdjacentHTML('beforeend', data.comments.map(item => commentHTML(item, !!token)).join(''));
        cursor = data.comments[data.comments.length - 1].id;
      }
      hasMore = data.nextAfter != null;
      more.hidden = !hasMore;
      more.textContent = '加载更多评论';
      status.textContent = cursor ? '' : '还没有评论';
    } catch (e) {
      status.textContent = '加载评论失败：' + e.message;
      more.hidden = false;
      more.textContent = '重试';
    } finally {
      loading = false;
      more.disabled = false;
    }
  }

  more.onclick = load;
  list.onclick = event => {
    const parent = event.target.closest('[data-parent]');
    if (parent) {
      const comment = list.querySelector(`[data-comment-id="${parent.dataset.parent}"]`);
      if (comment) comment.focus();
      else toast('该评论当前不可见');
    }
    const target = event.target.closest('[data-reply]');
    if (target && form) {
      setReply({ id: Number(target.dataset.reply), name: target.dataset.name });
      input.focus();
    }
  };
  if (form) {
    form.querySelector('[data-cancel-reply]').onclick = () => setReply(null);
    form.onsubmit = async event => {
      event.preventDefault();
      if (sending) return;
      if (token !== auth.token) return toast('账号已切换，请重新打开帖子');
      const content = input.value.trim();
      if (!content) return toast('请输入评论');
      if (Array.from(content).length > 500) return toast('评论最多 500 字');
      sending = send.disabled = input.readOnly = true;
      const wasReply = !!reply;
      try {
        await api.postComment(post.id, content, reply?.id);
        input.value = '';
        setReply(null);
        post.commentCount++;
        card.querySelector('[data-comment-count]').textContent = post.commentCount;
        toast(wasReply ? '已回复' : '已评论');
        if (!hasMore) await load();
      } catch (e) { toast('发送失败：' + e.message); }
      finally { sending = send.disabled = input.readOnly = false; }
    };
  }
  return load();
}

export async function render(el, params) {
  const [id] = params;
  const from = params.query?.from;
  const back = /^\d+$/.test(from) ? `#/u/${from}?tab=posts` : SQUARE;
  const backLink = `<a class="cm-post-back" href="${back}"><span class="material-icons-outlined" aria-hidden="true">arrow_back</span>${back === SQUARE ? '发现 · 帖子' : '主页 · 帖子'}</a>`;
  el.innerHTML = skelPosts(1);
  let post;
  try { ({ post } = await api.post(id)); }
  catch (e) {
    el.innerHTML = `<div class="cm-post-detail">${backLink}<div class="cm-empty">${esc(e.message)}
      ${e.status === 404 ? '' : '<div><mdui-button variant="tonal" data-retry>重试</mdui-button></div>'}
      </div></div>`;
    el.querySelector('[data-retry]')?.addEventListener('click', () => render(el, params));
    return;
  }
  if (!el.isConnected) return;
  el.innerHTML = `<div class="cm-post-detail">
    ${backLink}
    ${postHTML(post, { detail: true })}
    <section class="cm-post-comments" aria-labelledby="postCommentsTitle">
      <h2 id="postCommentsTitle" tabindex="-1">评论</h2>
      ${auth.token ? `<form class="cm-post-comment-form">
        <div class="cm-pcmt-rbar" data-reply-bar hidden>
          <span></span><button type="button" class="cm-community-link" data-cancel-reply>取消回复</button>
        </div>
        <label for="postCommentText">写评论</label>
        <textarea class="cm-community-input" id="postCommentText" rows="2"></textarea>
        <button type="submit" class="cm-community-submit">发送</button>
      </form>` : '<a class="cm-community-link" href="#/user">登录后可参与讨论</a>'}
      <div class="cm-post-comment-list" data-comment-list></div>
      <div class="cm-post-comment-status" data-comment-status role="status"></div>
      <button type="button" class="cm-community-link" data-comment-more hidden>加载更多评论</button>
    </section>
  </div>`;
  const card = el.querySelector('.cm-post');
  const section = el.querySelector('.cm-post-comments');
  const heading = section.querySelector('h2');
  bindPostCard(card, post, () => { if (el.isConnected) location.replace(back); });
  const showComments = () => heading.focus();
  card.querySelector('[data-act="comments"]').onclick = showComments;
  if (params.query?.comments) requestAnimationFrame(() => { if (el.isConnected) showComments(); });
  await mountComments(section, post, card);
}
