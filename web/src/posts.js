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
import { esc, avatarHTML, toast, confirmDialog } from './ui.js';
import { renderMarkdown, applyToolbar } from './markdown.js';
import { player } from './player.js';

const PAGE = 10;                     // 每批条数
const MAX_ATTACH = 5;

const fmtAgo = ts => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - (ts || 0));
  if (d < 60) return '刚刚';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
  if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
  const t = new Date((ts || 0) * 1000);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

const TYPE_LABEL = { song: '单曲', album: '专辑', artist: '歌手', playlist: '歌单' };
const TYPE_ICON = { song: 'music_note', album: 'album', artist: 'person', playlist: 'queue_music' };

/** 附带内容：卡片 + 点击行为（单曲直接播放，其余跳详情页）。 */
function attachHTML(list) {
  if (!list || !list.length) return '';
  return `<div class="cm-post-atts">` + list.map((a, i) => `
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

function bindAttach(box, list) {
  box.querySelectorAll('.cm-post-att').forEach(el => {
    el.onclick = async () => {
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

/** 一片帖子（含作者、正文、附带、互动按钮）。 */
function postHTML(p) {
  const a = p.author || {};
  const name = a.nickname || `用户${a.id}`;
  const tag = a.isSuper ? '<span class="cm-tag super">超级管理员</span>'
    : a.isAdmin ? '<span class="cm-tag admin">管理员</span>' : '';
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
            <div class="cm-pcmt-who"><b data-uid="${c.author.id}">${esc(c.author.nickname || '用户' + c.author.id)}</b>
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

/** 发帖编辑器：工具栏 + 编辑区 + 实时预览 + 附带内容选择（最多 5）。 */
export function openEditor(onDone) {
  if (!auth.token) return toast('登录后才能发帖');
  const atts = [];
  const diag = mdui.dialog({
    headline: '发帖',
    body: `<div class="cm-peditor">
      <div class="cm-peditor-tools">
        ${[['h', '标题', 'title'], ['bold', '加粗', 'format_bold'], ['italic', '斜体', 'format_italic'],
           ['code', '代码', 'code'], ['quote', '引用', 'format_quote'], ['ul', '列表', 'format_list_bulleted'],
           ['ol', '序号', 'format_list_numbered'], ['link', '链接', 'link'], ['hr', '分割线', 'horizontal_rule']]
          .map(([k, label, icon]) => `<span class="cm-peditor-tool" data-k="${k}" title="${label}">
            <span class="material-icons-outlined">${icon}</span></span>`).join('')}
        <span class="cm-peditor-sp"></span>
        <span class="cm-peditor-tool" id="pPreviewBtn" title="预览"><span class="material-icons-outlined">visibility</span></span>
      </div>
      <textarea id="pText" class="cm-peditor-text" placeholder="写点什么…（支持 Markdown：# 标题、**加粗**、- 列表、> 引用、\`代码\`）"></textarea>
      <div class="cm-peditor-preview" id="pPreview" hidden></div>
      <div class="cm-peditor-atts">
        <div class="cm-peditor-atts-head">
          <span>附带内容</span>
          <span class="cm-peditor-atts-n" id="pAttN">0/${MAX_ATTACH}</span>
          <mdui-button variant="text" id="pAttAdd">添加</mdui-button>
        </div>
        <div class="cm-peditor-atts-list" id="pAttList"><span class="cm-peditor-empty">可添加单曲 / 专辑 / 歌手 / 歌单，最多 5 项</span></div>
      </div>
    </div>`,
    actions: [
      { text: '取消' },
      { text: '发布', onClick: async () => {
        const text = (diag.querySelector('#pText').value || '').trim();
        if (!text) { toast('内容不能为空'); return false; }
        try {
          await api.postCreate(text, atts);
          toast('已发布');
          diag.open = false;
          onDone && onDone();
        } catch (e) { toast('发布失败：' + e.message); return false; }
      } },
    ],
  });

  const ta = diag.querySelector('#pText');
  const pv = diag.querySelector('#pPreview');
  const attList = diag.querySelector('#pAttList');
  const attN = diag.querySelector('#pAttN');

  const drawAtts = () => {
    attN.textContent = `${atts.length}/${MAX_ATTACH}`;
    attList.innerHTML = atts.length ? atts.map((a, i) => `
      <span class="cm-peditor-att" data-i="${i}">
        ${esc(TYPE_LABEL[a.type] || '')}·${esc(a.name || '')}
        <span class="material-icons-outlined" data-del="${i}">close</span>
      </span>`).join('') : '<span class="cm-peditor-empty">可添加单曲 / 专辑 / 歌手 / 歌单，最多 5 项</span>';
    attList.querySelectorAll('[data-del]').forEach(x => {
      x.onclick = () => { atts.splice(+x.dataset.del, 1); drawAtts(); };
    });
  };

  let previewing = false;
  diag.querySelector('#pPreviewBtn').onclick = () => {
    previewing = !previewing;
    if (previewing) {
      pv.innerHTML = renderMarkdown(ta.value) || '<p class="cm-peditor-empty">（还没有内容）</p>';
      pv.hidden = false; ta.hidden = true;
    } else { pv.hidden = true; ta.hidden = false; }
    diag.querySelector('#pPreviewBtn').classList.toggle('on', previewing);
  };

  diag.querySelectorAll('.cm-peditor-tool[data-k]').forEach(t => {
    t.onclick = () => {
      const r = applyToolbar(ta.value, ta.selectionStart, ta.selectionEnd, t.dataset.k);
      ta.value = r.value;
      ta.focus();
      ta.setSelectionRange(r.selStart, r.selEnd);
      if (previewing) pv.innerHTML = renderMarkdown(ta.value);
    };
  });

  diag.querySelector('#pAttAdd').onclick = () => {
    if (atts.length >= MAX_ATTACH) return toast(`最多添加 ${MAX_ATTACH} 项`);
    openAttachPicker(picked => {
      const room = MAX_ATTACH - atts.length;
      picked.slice(0, room).forEach(x => atts.push(x));
      if (picked.length > room) toast(`最多 ${MAX_ATTACH} 项，已忽略多余的`);
      drawAtts();
    });
  };
  drawAtts();
  setTimeout(() => ta.focus(), 100);
}

/** 附带内容选择器：类型切换 + 搜索（复用 /ncm/search）。 */
function openAttachPicker(onPick) {
  const state = { type: 'song', list: [], sel: [], offset: 0, loading: false };
  const diag = mdui.dialog({
    headline: '添加附带内容',
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
  // 注意：**单曲对象的 id 字段是 ncm_id**（专辑/歌手/歌单才是 id）。
  // 曾因统一取 x.id 导致所有歌曲 id 都是 undefined → 选择比较 undefined===undefined
  // 恒真 → 一选就"全选"。这里按类型取正确的 id。
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
