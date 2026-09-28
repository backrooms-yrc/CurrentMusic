// 轻量 Markdown 渲染（无第三方依赖）。
//
// **安全第一**：先把整段文本做 HTML 转义，再做语法替换——因此原文里的
// <script>/<img onerror> 之类会被转成实体，不可能被解析成标签。
// 链接另外限制协议（只允许 http/https），挡住 javascript: 之类的伪协议。
//
// 支持：标题、粗体、斜体、行内代码、围栏代码块、引用、有序/无序列表、
// 分割线、链接、段落与换行。刻意不支持原始 HTML 与图片（避免任意外链与 XSS）。

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 行内语法：粗体 / 斜体 / 行内代码 / 链接。输入必须是**已转义**的文本。 */
function inline(s) {
  let t = s;
  // 行内代码先处理：其内部不再做其它语法（用占位符保护）
  const codes = [];
  t = t.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  // 链接：只放行 http/https（相对路径也允许，站内跳转用）
  t = t.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (!/^(https?:\/\/|\/|#)/i.test(h)) return text;      // 伪协议：只留文本
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  t = t.replace(/\u0000C(\d+)\u0000/g, (m, i) => `<code>${codes[+i]}</code>`);
  return t;
}

/** 把 markdown 渲染成安全的 HTML。 */
export function renderMarkdown(src) {
  const raw = String(src || '').replace(/\r\n?/g, '\n');
  const lines = esc(raw).split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    // 围栏代码块
    if (/^\s*```/.test(line)) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;   // 吃掉结束的 ```
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); const n = h[1].length; out.push(`<h${n}>${inline(h[2].trim())}</h${n}>`); i++; continue; }
    // 分割线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }
    // 引用（连续多行合并）
    if (/^\s*&gt;\s?/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, '')); i++;
      }
      out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    // 列表（有序 / 无序，支持一层嵌套缩进）
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushPara();
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    // 空行 → 段落结束
    if (!line.trim()) { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('\n');
}

/** 纯文本摘要（列表折叠预览用）：去掉语法标记，截断到 n 字。 */
export function plainSummary(src, n = 90) {
  const t = String(src || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\-]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 编辑器工具栏：在光标处包裹/插入语法，返回新的 {value, selStart, selEnd}。 */
export function applyToolbar(value, start, end, kind) {
  const wrap = (before, after = before, placeholder = '') => {
    const sel = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + sel + after + value.slice(end);
    return {
      value: next,
      selStart: start + before.length,
      selEnd: start + before.length + sel.length,
    };
  };
  const linePrefix = prefix => {
    // 行首插入（引用/列表/标题）：对选中的每一行都加
    const ls = value.lastIndexOf('\n', start - 1) + 1;
    const le = value.indexOf('\n', end) === -1 ? value.length : value.indexOf('\n', end);
    const block = value.slice(ls, le) || '';
    const lines = (block || '').split('\n');
    const next = lines.map(l => prefix + l).join('\n');
    const nv = value.slice(0, ls) + next + value.slice(le);
    return { value: nv, selStart: ls, selEnd: ls + next.length };
  };
  switch (kind) {
    case 'bold': return wrap('**', '**', '粗体');
    case 'italic': return wrap('*', '*', '斜体');
    case 'code': return value.slice(start, end).includes('\n')
      ? wrap('```\n', '\n```', '代码')
      : wrap('`', '`', '代码');
    case 'quote': return linePrefix('> ');
    case 'ul': return linePrefix('- ');
    case 'ol': return linePrefix('1. ');
    case 'h': return linePrefix('## ');
    case 'link': return wrap('[', '](https://)', '链接文字');
    case 'hr': {
      const next = value.slice(0, start) + '\n---\n' + value.slice(end);
      return { value: next, selStart: start + 5, selEnd: start + 5 };
    }
    default: return { value, selStart: start, selEnd: end };
  }
}
