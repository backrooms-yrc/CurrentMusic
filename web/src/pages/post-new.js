import { api, auth, settings } from '../api.js';
import { confirmDialog, esc, toast } from '../ui.js';
import { renderMarkdown, applyToolbar } from '../markdown.js';
import { attachHTML, MAX_ATTACH, TYPE_LABEL, openAttachPicker } from '../attach.js';

const SQUARE = '#/square?tab=posts';
const MAX_TITLE = 80;
const MAX_BODY = 5000;
const TOOLS = [
  ['h', '标题', 'title'], ['bold', '加粗', 'format_bold'], ['italic', '斜体', 'format_italic'],
  ['code', '代码', 'code'], ['quote', '引用', 'format_quote'], ['ul', '列表', 'format_list_bulleted'],
  ['ol', '序号', 'format_list_numbered'], ['link', '链接', 'link'], ['hr', '分割线', 'horizontal_rule'],
];

function readDraft(key) {
  try {
    const draft = JSON.parse(localStorage.getItem(key));
    if (typeof draft?.title === 'string' && typeof draft.content === 'string' && Array.isArray(draft.attachments)) {
      return draft;
    }
  } catch { /* 存储不可用时仍可发帖 */ }
  return { title: '', content: '', attachments: [] };
}

export async function render(el) {
  const token = auth.token;
  if (!token) {
    el.innerHTML = `<div class="cm-peditor-page">
      <div class="cm-empty">登录后才能发帖
        <div><mdui-button variant="filled" href="#/user">去登录</mdui-button></div>
      </div></div>`;
    return;
  }

  const user = auth.user || await api.me();
  if (!el.isConnected || auth.token !== token) return;
  const base = settings.base;
  const key = `cm.postDraft:${encodeURIComponent(base)}:${encodeURIComponent(user.username)}`;
  const draft = readDraft(key);
  let attachments = draft.attachments.filter(a => a && Object.prototype.hasOwnProperty.call(TYPE_LABEL, a.type)).slice(0, MAX_ATTACH);
  let previewing = false, publishing = false, stored = null;
  const sameSession = () => token === auth.token && base === settings.base && el.isConnected;

  el.innerHTML = `
    <div class="cm-peditor-page">
      <div class="cm-sec-head"><h2>发布帖子</h2><a class="cm-community-link" href="${SQUARE}">返回帖子</a></div>
      <div class="cm-post-draft" data-draft hidden>
        <span data-draft-status role="status"></span>
        <button type="button" class="cm-community-link" data-discard>丢弃草稿</button>
      </div>
      <form class="cm-peditor">
        <div class="cm-post-form-label"><label for="pTitle">标题（选填）</label><span data-title-count></span></div>
        <input class="cm-community-input" type="text" id="pTitle">
        <div class="cm-post-form-label"><label for="pText">正文</label><span data-body-count></span></div>
        <div class="cm-post-editor-modes" aria-label="正文显示方式">
          <button type="button" data-mode="edit" aria-pressed="true">编辑</button>
          <button type="button" data-mode="preview" aria-pressed="false">预览</button>
        </div>
        <div class="cm-peditor-tools" aria-label="Markdown 工具">
          ${TOOLS.map(([key, label, icon]) => `<button type="button" class="cm-peditor-tool" data-tool="${key}" aria-label="${label}" title="${label}">
            <span class="material-icons-outlined" aria-hidden="true">${icon}</span></button>`).join('')}
        </div>
        <textarea id="pText" class="cm-peditor-text cm-community-input" placeholder="写点什么… 支持 Markdown"></textarea>
        <div class="cm-peditor-preview" data-preview hidden></div>
        <div class="cm-peditor-atts">
          <div class="cm-peditor-atts-head">
            <span>音乐附件</span>
            <span class="cm-peditor-atts-n" data-att-count></span>
            <mdui-button variant="text" data-att-add>添加</mdui-button>
          </div>
          <div class="cm-peditor-atts-list" data-att-list></div>
        </div>
        <div class="cm-peditor-actions"><button class="cm-community-submit" type="submit">发布帖子</button></div>
      </form>
    </div>`;

  const form = el.querySelector('form');
  const title = form.querySelector('#pTitle');
  const body = form.querySelector('#pText');
  const preview = form.querySelector('[data-preview]');
  const tools = form.querySelector('.cm-peditor-tools');
  const attList = form.querySelector('[data-att-list]');
  const draftBar = el.querySelector('[data-draft]');
  const draftStatus = el.querySelector('[data-draft-status]');
  const discard = el.querySelector('[data-discard]');
  const publish = form.querySelector('[type="submit"]');
  const add = form.querySelector('[data-att-add]');
  title.value = draft.title;
  body.value = draft.content;

  function updateCounts() {
    const values = [
      [form.querySelector('[data-title-count]'), title.value, MAX_TITLE],
      [form.querySelector('[data-body-count]'), body.value, MAX_BODY],
    ];
    for (const [label, text, max] of values) {
      const count = Array.from(text.trim()).length;
      label.textContent = `${count}/${max}`;
      label.classList.toggle('cm-community-limit', count > max);
    }
  }

  function removeStoredDraft() {
    try {
      if (localStorage.getItem(key) === stored) localStorage.removeItem(key);
    } catch { /* 存储可能在编辑期间被禁用 */ }
  }

  function saveDraft() {
    updateCounts();
    if (!sameSession()) return;
    const hasDraft = !!(title.value || body.value || attachments.length);
    draftBar.hidden = !hasDraft;
    if (!hasDraft) {
      removeStoredDraft();
      return;
    }
    try {
      const value = JSON.stringify({ title: title.value, content: body.value, attachments, updatedAt: Date.now() });
      localStorage.setItem(key, value);
      stored = value;
      draftStatus.textContent = '草稿已保存到此设备';
    } catch { draftStatus.textContent = '无法在此设备保存草稿'; }
  }

  function drawAttachments() {
    form.querySelector('[data-att-count]').textContent = `${attachments.length}/${MAX_ATTACH}`;
    add.disabled = publishing || previewing || attachments.length >= MAX_ATTACH;
    attList.innerHTML = previewing ? attachHTML(attachments) : attachments.map((item, index) => `
      <span class="cm-peditor-att">${esc(TYPE_LABEL[item.type])} · ${esc(item.name || '')}
        <button type="button" class="cm-community-link" data-del="${index}" aria-label="移除附件" ${publishing ? 'disabled' : ''}>
          <span class="material-icons-outlined" aria-hidden="true">close</span>
        </button>
      </span>`).join('');
  }

  function setMode(mode) {
    previewing = mode === 'preview';
    tools.hidden = body.hidden = previewing;
    preview.hidden = !previewing;
    form.querySelectorAll('[data-mode]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    });
    preview.innerHTML = previewing ? `
      ${title.value.trim() ? `<h3 class="cm-post-title">${esc(title.value.trim())}</h3>` : ''}
      <div class="cm-post-body">${renderMarkdown(body.value) || '<p class="cm-peditor-empty">还没有正文</p>'}</div>` : '';
    title.readOnly = publishing || previewing;
    drawAttachments();
  }

  form.querySelectorAll('[data-mode]').forEach(button => {
    button.onclick = () => setMode(button.dataset.mode);
  });
  form.querySelectorAll('[data-tool]').forEach(button => {
    button.onmousedown = e => e.preventDefault();
    button.onclick = () => {
      if (publishing) return;
      const edit = applyToolbar(body.value, body.selectionStart, body.selectionEnd, button.dataset.tool);
      body.value = edit.value;
      body.focus();
      body.setSelectionRange(edit.selStart, edit.selEnd);
      saveDraft();
    };
  });
  title.oninput = body.oninput = saveDraft;
  attList.onclick = event => {
    const target = event.target.closest('[data-del]');
    if (!target || publishing) return;
    attachments.splice(Number(target.dataset.del), 1);
    drawAttachments();
    saveDraft();
  };
  add.onclick = () => openAttachPicker(picked => {
    if (publishing || previewing || !sameSession()) return;
    const room = MAX_ATTACH - attachments.length;
    attachments.push(...picked.slice(0, room));
    if (picked.length > room) toast(`最多可添加 ${MAX_ATTACH} 项附件`);
    drawAttachments();
    saveDraft();
  });
  discard.onclick = () => confirmDialog({
    title: '丢弃草稿', body: '将清空这篇草稿的标题、正文和音乐附件。',
    onOk: () => {
      if (publishing || !sameSession()) return;
      title.value = body.value = '';
      attachments = [];
      setMode('edit');
      saveDraft();
      title.focus();
    },
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (publishing) return;
    if (!sameSession()) return toast('登录状态已变化，请重新打开编辑器');
    const heading = title.value.trim();
    const text = body.value.trim();
    if (Array.from(heading).length > MAX_TITLE || /[\x0b\x0c\x1c-\x1e\x85\r\n\u2028\u2029]/.test(heading)) {
      return toast(`标题须为单行，最多 ${MAX_TITLE} 字`);
    }
    if (!text) return toast('请填写正文');
    if (Array.from(text).length > MAX_BODY) return toast(`正文最多 ${MAX_BODY} 字`);
    saveDraft();
    publishing = publish.disabled = discard.disabled = body.readOnly = true;
    publish.textContent = '发布中…';
    setMode(previewing ? 'preview' : 'edit');
    try {
      const result = await api.postCreate(text, attachments, heading);
      removeStoredDraft();
      toast('帖子已发布');
      if (sameSession() && location.hash.split('?')[0] === '#/post/new') location.replace(`#/post/${result.id}`);
    } catch (e) { toast('发布失败：' + e.message); }
    finally {
      publishing = publish.disabled = discard.disabled = body.readOnly = false;
      publish.textContent = '发布帖子';
      setMode(previewing ? 'preview' : 'edit');
    }
  };

  updateCounts();
  setMode('edit');
  if (title.value || body.value || attachments.length) {
    try { stored = localStorage.getItem(key); } catch { /* 存储不可用 */ }
    draftBar.hidden = false;
    draftStatus.textContent = '已恢复此设备上的草稿';
  }
}
