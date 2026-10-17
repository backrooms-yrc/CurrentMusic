// 发帖页（v1.28.45：从弹窗改为独立页面）。
// 复用 posts.js 的 Markdown 工具栏与 attach.js 的引用选择器；发布后回到发现页「帖子」TAB。
import { api, auth } from '../api.js';
import { esc, toast } from '../ui.js';
import { renderMarkdown, applyToolbar } from '../markdown.js';
import { MAX_ATTACH, TYPE_LABEL, openAttachPicker } from '../attach.js';

const TOOLS = [
  ['h', '标题', 'title'], ['bold', '加粗', 'format_bold'], ['italic', '斜体', 'format_italic'],
  ['code', '代码', 'code'], ['quote', '引用', 'format_quote'], ['ul', '列表', 'format_list_bulleted'],
  ['ol', '序号', 'format_list_numbered'], ['link', '链接', 'link'], ['hr', '分割线', 'horizontal_rule'],
];

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-page cm-peditor-page">
      <div class="cm-empty" style="padding:48px 0">登录后才能发帖
        <div style="margin-top:16px"><mdui-button variant="filled" href="#/user">去登录</mdui-button></div>
      </div></div>`;
    return;
  }
  const atts = [];
  el.innerHTML = `
    <div class="cm-page cm-peditor-page">
      <div class="cm-sec-head"><h2>发布帖子</h2><span class="cm-sec-more" id="pCancel">取消</span></div>
      <div class="cm-peditor">
        <div class="cm-peditor-tools">
          ${TOOLS.map(([k, label, icon]) => `<span class="cm-peditor-tool" data-k="${k}" title="${label}">
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
          <div class="cm-peditor-atts-list" id="pAttList"></div>
        </div>
      </div>
      <div class="cm-peditor-actions">
        <mdui-button variant="filled" id="pPublish" full-width>发布</mdui-button>
      </div>
    </div>`;

  const ta = el.querySelector('#pText');
  const pv = el.querySelector('#pPreview');
  const attList = el.querySelector('#pAttList');
  const attN = el.querySelector('#pAttN');
  const publishBtn = el.querySelector('#pPublish');

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
  el.querySelector('#pPreviewBtn').onclick = () => {
    previewing = !previewing;
    if (previewing) {
      pv.innerHTML = renderMarkdown(ta.value) || '<p class="cm-peditor-empty">（还没有内容）</p>';
      pv.hidden = false; ta.hidden = true;
    } else { pv.hidden = true; ta.hidden = false; }
    el.querySelector('#pPreviewBtn').classList.toggle('on', previewing);
  };

  el.querySelectorAll('.cm-peditor-tool[data-k]').forEach(t => {
    t.onclick = () => {
      const r = applyToolbar(ta.value, ta.selectionStart, ta.selectionEnd, t.dataset.k);
      ta.value = r.value;
      ta.focus();
      ta.setSelectionRange(r.selStart, r.selEnd);
      if (previewing) pv.innerHTML = renderMarkdown(ta.value);
    };
  });

  el.querySelector('#pAttAdd').onclick = () => {
    if (atts.length >= MAX_ATTACH) return toast(`最多添加 ${MAX_ATTACH} 项`);
    openAttachPicker(picked => {
      const room = MAX_ATTACH - atts.length;
      picked.slice(0, room).forEach(x => atts.push(x));
      if (picked.length > room) toast(`最多 ${MAX_ATTACH} 项，已忽略多余的`);
      drawAtts();
    });
  };

  const back = () => {
    sessionStorage.setItem('cm.sqTab', 'posts');
    location.hash = '#/square';
  };
  el.querySelector('#pCancel').onclick = () => back();
  publishBtn.onclick = async () => {
    const text = (ta.value || '').trim();
    if (!text) return toast('内容不能为空');
    publishBtn.setAttribute('loading', '');
    try {
      await api.postCreate(text, atts);
      toast('已发布');
      back();
    } catch (e) {
      toast('发布失败：' + e.message);
    } finally { publishBtn.removeAttribute('loading'); }
  };

  drawAtts();
  setTimeout(() => ta.focus(), 100);
}
