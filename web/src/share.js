// 歌曲分享（v1.28.46）：分享图（实时生成可下载）/ 分享链接 / 分享歌曲信息。
//
// 分享图在客户端用 canvas 实时绘制：1080×1440 卡片，封面 + 歌名/歌手/专辑 + 站点链接。
// 封面走网易云 CDN（带 CORS 头）；App 的 WebView 是 file:// 页面，若封面加载/画布导出
// 失败（tainted canvas），自动降级为「渐变占位封面」再画一遍——保证任何环境都能出图。
import { mdui } from './md.js';
import { settings } from './api.js';
import { esc, toast } from './ui.js';

const W = 1080, H = 1440;
const FONT = '"PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif';

/** 站点 base：Web 用当前页面地址，App（file://）用 API 站点 + /app/。 */
function siteOrigin() {
  try { return new URL(settings.base).origin; } catch { return location.origin; }
}
function appBase() {
  if (location.protocol === 'file:') return `${siteOrigin()}/app/`;
  return location.href.split('#')[0];
}
export function songUrl(meta) {
  return `${appBase()}#/song/${meta.ncm_id}`;
}
function songText(meta) {
  const lines = [`🎵 ${meta.name}${meta.artists ? ' - ' + meta.artists : ''}`];
  if (meta.album) lines.push(`专辑：${meta.album}`);
  lines.push('', `在 CurrentMusic 收听：${songUrl(meta)}`);
  return lines.join('\n');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadCover(url, timeout = 5000) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish(null), timeout);
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

function fitText(ctx, text, maxWidth) {
  let str = String(text || '');
  if (ctx.measureText(str).width <= maxWidth) return str;
  while (str.length && ctx.measureText(str + '…').width > maxWidth) str = str.slice(0, -1);
  return str + '…';
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      out.push(line);
      line = ch;
      if (out.length >= maxLines - 1) break;
    } else line += ch;
  }
  if (line && out.length < maxLines) out.push(line);
  const consumed = out.join('').length;
  if (consumed < String(text || '').length && out.length) out[out.length - 1] += '…';
  return out.length ? out : [''];
}

async function drawCard(meta, withCover) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1a0f2e');
  bg.addColorStop(0.55, '#2a1646');
  bg.addColorStop(1, '#3d1d4b');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 背景装饰：两个大柔光圆
  const g1 = ctx.createRadialGradient(880, 180, 0, 880, 180, 520);
  g1.addColorStop(0, 'rgba(143,90,255,.30)'); g1.addColorStop(1, 'rgba(143,90,255,0)');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);
  const g2 = ctx.createRadialGradient(160, 1300, 0, 160, 1300, 560);
  g2.addColorStop(0, 'rgba(255,96,180,.22)'); g2.addColorStop(1, 'rgba(255,96,180,0)');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);

  // 品牌
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.font = `700 42px ${FONT}`;
  ctx.fillText('CurrentMusic', 90, 118);
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText('MUSIC SHARE', 90, 160);

  // 封面
  const size = 760, x = (W - size) / 2, y = 230;
  const cover = withCover && meta.pic ? await loadCover(`${meta.pic}?param=760y760`) : null;
  ctx.save();
  roundRect(ctx, x, y, size, size, 34);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, x, y, size, size);
  } else {
    const cg = ctx.createLinearGradient(x, y, x + size, y + size);
    cg.addColorStop(0, '#7a52c9');
    cg.addColorStop(1, '#3a2456');
    ctx.fillStyle = cg;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.font = `260px serif`;
    ctx.textAlign = 'center';
    ctx.fillText('♪', W / 2, y + size / 2 + 92);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // 歌名 / 歌手 / 专辑
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 58px ${FONT}`;
  const lines = wrapLines(ctx, meta.name || '', 900, 2);
  let ty = 1100;
  lines.forEach(l => { ctx.fillText(l, 90, ty); ty += 72; });

  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = `500 34px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.artists, 900), 90, ty + 8);
  if (meta.album) {
    ctx.fillStyle = 'rgba(255,255,255,.46)';
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.album, 900), 90, ty + 56);
  }

  // 底部分隔与链接
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(90, 1300); ctx.lineTo(W - 90, 1300); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('在 CurrentMusic 收听', 90, 1352);
  ctx.fillStyle = 'rgba(255,255,255,.82)';
  ctx.font = `500 24px ui-monospace,Menlo,monospace`;
  ctx.fillText(fitText(ctx, songUrl(meta).replace(/^https?:\/\//, ''), 900), 90, 1392);

  return cv;
}

/** 生成分享图（PNG dataURL）。封面失败或画布被污染时自动重画无封面版本。 */
export async function makeShareImage(meta) {
  try {
    const cv = await drawCard(meta, true);
    return cv.toDataURL('image/png');            // 污染画布会在这里抛 SecurityError
  } catch (e) {
    const cv = await drawCard(meta, false);
    return cv.toDataURL('image/png');
  }
}

function safeName(meta) {
  const n = String(meta.name || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  return `CurrentMusic-${n}-${meta.ncm_id || 0}.png`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* 回退到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function saveImage(dataUrl, meta) {
  const name = safeName(meta);
  const n = window.NativeApi;
  if (n && typeof n.saveImage === 'function') {
    try { n.saveImage(dataUrl, name); return; } catch { /* 回退浏览器下载 */ }
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 分享入口：分享图 / 链接 / 歌曲信息。 */
export function openShare(meta) {
  if (!meta || !meta.ncm_id) return toast('这首歌暂时无法分享');
  const cover = meta.pic
    ? `<img class="cm-share-cover" src="${esc(meta.pic)}?param=120y120" alt="">`
    : '<span class="cm-share-cover ph material-icons-outlined">music_note</span>';

  const diag = mdui.dialog({
    headline: '分享歌曲',
    body: `<div class="cm-share">
      <div class="cm-share-song">${cover}
        <div class="cm-share-meta"><b>${esc(meta.name || '')}</b>
          <span>${esc(meta.artists || '')}${meta.album ? ' · ' + esc(meta.album) : ''}</span></div>
      </div>
      <div class="cm-share-opts">
        <button class="cm-share-opt" data-k="img">
          <span class="material-icons-outlined">image</span><b>分享图</b><i>实时生成卡片，可保存到相册</i>
        </button>
        <button class="cm-share-opt" data-k="link">
          <span class="material-icons-outlined">link</span><b>分享链接</b><i>复制歌曲页面链接</i>
        </button>
        <button class="cm-share-opt" data-k="text">
          <span class="material-icons-outlined">notes</span><b>分享歌曲信息</b><i>复制歌名 / 歌手 / 专辑与链接</i>
        </button>
      </div>
    </div>`,
    actions: [{ text: '关闭' }],
  });

  diag.querySelectorAll('.cm-share-opt').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.k;
      if (k === 'link') {
        const ok = await copyText(songUrl(meta));
        toast(ok ? '链接已复制' : '复制失败，请手动复制');
        return;
      }
      if (k === 'text') {
        const ok = await copyText(songText(meta));
        toast(ok ? '歌曲信息已复制' : '复制失败，请手动复制');
        return;
      }
      // 分享图
      diag.open = false;
      toast('正在生成分享图…');
      try {
        const dataUrl = await makeShareImage(meta);
        const preview = mdui.dialog({
          headline: '分享图',
          body: `<div class="cm-share-preview"><img src="${dataUrl}" alt="分享图预览"></div>`,
          actions: [
            { text: '关闭' },
            { text: '保存图片', onClick: () => { saveImage(dataUrl, meta); } },
          ],
        });
        preview.addEventListener('closed', () => { /* 释放大字符串不发生额外动作 */ });
      } catch (e) {
        toast('分享图生成失败：' + ((e && e.message) || '未知错误'));
      }
    };
  });
}
