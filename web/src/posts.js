// 发现页「帖子」：列表 + 发帖（markdown 可视化编辑）+ 评论 + 点赞 + 附带内容。
//
// 设计要点：
//   · 帖子正文以 **markdown 原文**存服务端，渲染在本模块用 markdown.js 完成
//     （先转义再解析 → 不可能被注入标签；链接只放行 http/https/站内）
//   · 附带内容最多 5 项，支持单曲/专辑/歌手/歌单；点击按类型跳转或直接播放
//   · 头像复用 ui.js 的 avatarHTML（自带挂件叠加），昵称点击进用户主页
//   · 评论用底部弹层（mdui dialog）呈现，与「当前播放列表」等既有交互一致
import { mdui } from './md.js';
import { api, auth } from './api.js';
import { esc, avatarHTML, toast, confirmDialog, userTags } from './ui.js';
import { renderMarkdown, applyToolbar } from './markdown.js';
import { attachHTML, bindAttach } from './attach.js';

const PAGE = 10;                     // 每批条数

const fmtAgo = ts => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - (ts || 0));
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  const t = new Date((ts || 0) * 1000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};


/** 一片帖子（含作者、正文、附带、互动按钮）。 */
function postHTML(p) {
  const a = p.author || {};
  const name = a.nickname || `用户${a.id}`;
  const tag = userTags(a);
  return `
  <article class="cm-post" data-id="${p.id}">
    <header class="cm-post-head">
      <span class="cm-post-ava" data-uid="${a.id}">${avatarHTML({ ...a, avatarDecoration: a.avatarDecoration }, 40)}</span>
      <div class="cm-post-who">
        <div class="cm-post-name" data-uid="${a.id}">${esc(name)}${tag}</div>
        <div class="cm-post-time">${fmtAgo(p.createdAt)}</div>
      </div>
      <span class="cm-post-more material-icons-outlined" data-act="more" title="更多">more_horiz</span>
    </header>
    <div class="cm-post-body">${renderMarkdown(p.content)}</div>
    ${attachHTML(p.attachments)}
    <footer class="cm-post-foot">
      <span class="cm-post-act ${p.likedByMe ? 'on' : ''}" data-act="like" title="点赞">
        <span class="material-icons-outlined">${p.likedByMe ? 'favorite' : 'favorite_border'}</span>
        <i>${p.likeCount || ''}</i>
      </span>
      <span class="cm-post-act" data-act="comment" title="评论">
        <span class="material-icons-outlined">chat_bubble_outline</span>
        <i>${p.commentCount || ''}</i>
      </span>
      <span class="cm-post-act" data-act="copy" title="复制正文">
        <span class="material-icons-outlined">content_copy</span>
      </span>
    </footer>
  </article>`;
}

/** 渲染帖子 TAB 到给定容器；返回一个「重载」函数供外部刷新。 */
export function mountPosts(box) {
  let state = { offset: 0, posts: [], total: 0, loading: false, done: false, loaded: false };

  box.innerHTML = `
    <div class="cm-post-bar">
      <mdui-button variant="filled" id="postNew">
        <span class="material-icons-outlined" slot="icon">edit</span>发帖
      </mdui-button>
      <span class="cm-post-hint" id="postHint"></span>
    </div>
    <div id="postList"></div>
    <div id="postMore"></div>`;

  const listEl = box.querySelector('#postList');
  const moreEl = box.querySelector('#postMore');
  const hintEl = box.querySelector('#postHint');

  const canPost = () => !!auth.token;

  function paint() {
    const loading = !state.loaded && !state.posts.length;
    listEl.innerHTML = state.posts.map(postHTML).join('') || (loading
      ? '<div class="cm-loading"><mdui-linear-progress style="width:140px"></mdui-linear-progress></div>'
      : `<div class="cm-empty"><span class="material-icons-outlined">forum</span>还没有帖子，来发第一条吧</div>`);
    hintEl.textContent = state.total ? `共 ${state.total} 条` : (canPost() ? '' : '登录后可发帖与互动');
    listEl.querySelectorAll('.cm-post').forEach(card => bindCard(card));
    moreEl.innerHTML = state.done || !state.posts.length ? ''
      : `<div class="cm-sq-more"><mdui-button variant="tonal" id="postMoreBtn">加载更多（${state.posts.length}/${state.total}）</mdui-button></div>`;
    const btn = moreEl.querySelector('#postMoreBtn');
    if (btn) btn.onclick = () => loadMore();
  }

  async function loadMore() {
    if (state.loading || state.done) return;
    state.loading = true;
    const btn = moreEl.querySelector('#postMoreBtn');
    if (btn) { btn.disabled = true; btn.textContent = '加载中…'; }
    try {
      const d = await api.posts(state.offset, PAGE);
      const got = d.posts || [];
      state.total = d.total || state.posts.length + got.length;
      state.posts = state.posts.concat(got);
      state.offset += got.length;
      if (!got.length || state.posts.length >= state.total) state.done = true;
      state.loaded = true;
      paint();
    } catch (e) {
      state.loaded = true;
      toast('加载失败：' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '重试'; }
    } finally {
      state.loading = false;
    }
  }

  function reload() {
    state = { offset: 0, posts: [], total: 0, loading: false, done: false, loaded: false };
    paint();
    return loadMore();
  }

  /** 单条卡片上的交互：点赞 / 评论 / 复制 / 更多 / 点头像与昵称进主页。 */
  function bindCard(card) {
    const id = +card.dataset.id;
    const find = () => state.posts.find(x => x.id === id);

    bindAttach(card, (find() || {}).attachments || []);

    card.querySelectorAll('[data-uid]').forEach(el => {
      el.onclick = () => { location.hash = `#/u/${el.dataset.uid}`; };
    });

    card.querySelector('[data-act="copy"]').onclick = async () => {
      const p = find();
      if (!p) return;
      try {
        await navigator.clipboard.writeText(p.content);
        toast('正文已复制');
      } catch { toast('复制失败，请长按选择'); }
    };

    card.querySelector('[data-act="more"]').onclick = () => {
      const p = find();
      if (!p) return;
      const diag = mdui.dialog({
        headline: '帖子操作',
        body: `<div class="cm-more">
          <div class="cm-more-row" data-k="copy"><div><div class="cm-more-t">复制正文</div>
            <div class="cm-more-s">markdown 原文</div></div><span class="material-icons-outlined">content_copy</span></div>
          ${p.canDelete ? '<div class="cm-more-row" data-k="del"><div><div class="cm-more-t">删除帖子</div>'
            + '<div class="cm-more-s">不可恢复</div></div><span class="material-icons-outlined">delete</span></div>' : ''}
        </div>`,
        actions: [{ text: '关闭' }],
      });
      setTimeout(() => {
        diag.querySelectorAll('.cm-more-row').forEach(row => {
          row.onclick = async () => {
            diag.open = false;
            if (row.dataset.k === 'copy') {
              try { await navigator.clipboard.writeText(p.content); toast('正文已复制'); }
              catch { toast('复制失败'); }
              return;
            }
            if (row.dataset.k === 'del') {
              confirmDialog({ title: '删除帖子', body: '删除后不可恢复，确定吗？', onOk: async () => {
                try {
                  await api.postDelete(id);
                  state.posts = state.posts.filter(x => x.id !== id);
                  state.total = Math.max(0, state.total - 1);
                  state.offset = Math.max(0, state.offset - 1);
                  paint();
                  toast('已删除');
                } catch (e) { toast('删除失败：' + e.message); }
              } });
            }
          };
        });
      }, 0);
    };

    card.querySelector('[data-act="like"]').onclick = async () => {
      const p = find();
      if (!p) return;
      if (!auth.token) return toast('登录后可点赞');
      const on = !p.likedByMe;
      p.likedByMe = on;                                  // 乐观更新
      p.likeCount = Math.max(0, (p.likeCount || 0) + (on ? 1 : -1));
      const el = card.querySelector('[data-act="like"]');
      el.classList.toggle('on', on);
      el.querySelector('.material-icons-outlined').textContent = on ? 'favorite' : 'favorite_border';
      el.querySelector('i').textContent = p.likeCount || '';
      try { await api.postLike(id, on); }
      catch (e) {
        p.likedByMe = !on; p.likeCount = Math.max(0, p.likeCount + (on ? -1 : 1));
        el.classList.toggle('on', !on);
        el.querySelector('.material-icons-outlined').textContent = !on ? 'favorite' : 'favorite_border';
        el.querySelector('i').textContent = p.likeCount || '';
        toast('操作失败：' + e.message);
      }
    };

    card.querySelector('[data-act="comment"]').onclick = () => openComments(id, () => {
      const p = find();
      if (p) { p.commentCount = (p.commentCount || 0) + 1;
        card.querySelector('[data-act="comment"] i').textContent = p.commentCount; }
    });
  }

  /** 评论弹层：列表 + 输入框。 */
  async function openComments(postId, onAdded) {
    const diag = mdui.dialog({
      headline: '评论',
      body: `<div class="cm-pcmt">
        <div class="cm-pcmt-list" id="pcmtList"><div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div></div>
        <div class="cm-pcmt-input">
          <mdui-text-field id="pcmtText" label="${auth.token ? '说点什么…' : '登录后可评论'}" variant="outlined"
            ${auth.token ? '' : 'disabled'} style="width:100%"></mdui-text-field>
          <mdui-button variant="filled" id="pcmtSend" ${auth.token ? '' : 'disabled'}>发送</mdui-button>
        </div>
      </div>`,
      actions: [{ text: '关闭' }],
    });
    const listBox = diag.querySelector('#pcmtList');
    const draw = list => {
      listBox.innerHTML = list.length ? list.map(c => `
        <div class="cm-pcmt-item" data-id="${c.id}">
          <span class="cm-pcmt-ava" data-uid="${c.author.id}">${avatarHTML(c.author, 32)}</span>
          <div class="cm-pcmt-main">
            <div class="cm-pcmt-who"><b data-uid="${c.author.id}">${esc(c.author.nickname || '用户' + c.author.id)}</b>${userTags(c.author)}
              <span>${fmtAgo(c.createdAt)}</span></div>
            <div class="cm-pcmt-text">${esc(c.content)}</div>
          </div>
        </div>`).join('') : `<div class="cm-empty small">还没有评论，来说第一句</div>`;
      listBox.querySelectorAll('[data-uid]').forEach(el => {
        el.onclick = () => { diag.open = false; location.hash = `#/u/${el.dataset.uid}`; };
      });
    };
    try {
      const d = await api.postComments(postId);
      draw(d.comments || []);
    } catch (e) { listBox.innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`; }

    const send = async () => {
      const tf = diag.querySelector('#pcmtText');
      const text = (tf.value || '').trim();
      if (!text) return;
      const btn = diag.querySelector('#pcmtSend');
      btn.disabled = true;
      try {
        await api.postComment(postId, text);
        tf.value = '';
        const d = await api.postComments(postId);
        draw(d.comments || []);
        onAdded && onAdded();
        toast('已评论');
      } catch (e) { toast('评论失败：' + e.message); }
      finally { btn.disabled = false; }
    };
    diag.querySelector('#pcmtSend').onclick = send;
    const tf = diag.querySelector('#pcmtText');
    if (tf) tf.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  box.querySelector('#postNew').onclick = () => openEditor(reload);
  paint();
  loadMore();          // ← 必须真正拉一次：原先只 paint，首次进 TAB 永远是空态
  return { reload, loadMore };
}

/** 发帖：独立页面（v1.28.45 从弹窗改为页面，附件选择逻辑在 attach.js 共用）。 */
export function openEditor() {
  if (!auth.token) return toast('登录后才能发帖');
  location.hash = '#/post/new';
}
