// 弹窗公告（v1.28.22）
//
// 每次打开网页 / App 启动时拉一次 /announcements，有内容就弹窗——这是产品级公告，
// 不做「不再提示」记忆（需求如此：每次打开都要看到）。置顶的排最前，由服务端排序。
//
// 内容用 renderMarkdown 渲染：它是**先转义再解析**的，公告正文里写 <script> 也不会被执行。
import { mdui } from './md.js';
import { api } from './api.js';
import { esc, toast } from './ui.js';
import { renderMarkdown } from './markdown.js';

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单条公告卡片。 */
function itemHTML(a) {
  return `
    <article class="cm-ann-item${a.pinned ? ' pinned' : ''}">
      <div class="cm-ann-head">
        ${a.pinned ? '<span class="cm-ann-pin"><span class="material-icons-outlined">push_pin</span>置顶</span>' : ''}
        <h3 class="cm-ann-title">${esc(a.title)}</h3>
      </div>
      <div class="cm-ann-meta">${esc(a.author || 'CurrentStation')} · ${fmtTime(a.createdAt)}</div>
      <div class="cm-ann-body">${renderMarkdown(a.body || '')}</div>
      ${a.link ? `<a class="cm-ann-link" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer">
        <span class="material-icons-outlined">open_in_new</span>查看详情</a>` : ''}
    </article>`;
}

/** 展示公告弹窗（供启动时调用；也可手动调用做预览）。 */
export function showAnnouncements(items) {
  const list = (items || []).filter(a => a && a.title);
  if (!list.length) return null;
  const diag = mdui.dialog({
    headline: list.length > 1 ? `公告（${list.length}）` : '公告',
    body: `<div class="cm-ann">${list.map(itemHTML).join('')}</div>`,
    actions: [{ text: '知道了' }],
  });
  // 弹窗内容里可能有图片/长文：让滚动落在弹窗体内而不是背景页
  setTimeout(() => {
    const box = diag.querySelector('.cm-ann');
    if (box) box.scrollTop = 0;
  }, 0);
  return diag;
}

/** 启动时拉取并弹窗。失败静默（公告不该影响主流程）。 */
export async function initAnnouncements() {
  try {
    const d = await api.announcements();
    const items = (d && d.items) || [];
    if (!items.length) return;
    showAnnouncements(items);
  } catch (e) {
    // 公告拉取失败不打扰用户；开发时可在控制台看到原因
    try { console.warn('[announce] 拉取失败：', e && e.message); } catch { /* 忽略 */ }
  }
}

void toast;
