// 歌曲分享（v1.28.46）：分享图（实时生成可下载）/ 分享链接 / 分享歌曲信息。
//
// 分享图在客户端用 canvas 实时绘制：1080×1440 卡片，封面 + 歌名/歌手/专辑 + 站点链接。
// 封面走网易云 CDN（带 CORS 头）；App 的 WebView 是 file:// 页面，若封面加载/画布导出
// 失败（tainted canvas），自动降级为「渐变占位封面」再画一遍——保证任何环境都能出图。
import { mdui } from './md.js';
import { settings } from './api.js';
import { esc, toast } from './ui.js';
import qrcode from 'qrcode-generator';

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

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 1e-6) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

/** 从封面提取主色（按饱和度/中间亮度加权，忽略近黑近白与灰）。失败返回 null。 */
function extractPalette(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 40;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, 40, 40);
    const d = x.getImageData(0, 0, 40, 40).data;      // 画布被污染会在这里抛出
    const bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
      if (l < 0.12 || l > 0.9 || s < 0.12) continue;
      const key = Math.floor(h / 15) % 24;
      const w = s * (0.35 + Math.min(1, l * 1.6)) * (1 - Math.abs(l - 0.52));
      const cur = bins.get(key) || { w: 0, h: 0 };
      cur.w += w; cur.h += h * w;
      bins.set(key, cur);
    }
    let best = null;
    for (const v of bins.values()) if (!best || v.w > best.w) best = v;
    if (!best || best.w <= 0) return null;
    return { h: best.h / best.w };
  } catch { return null; }
}

/** 背景：主色 → 深色渐变 + 同色系柔光；无封面时退回品牌紫。 */
function paintBackground(ctx, pal) {
  const h = pal ? pal.h : 268;
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, `hsl(${h.toFixed(1)}, 52%, 8%)`);
  bg.addColorStop(0.55, `hsl(${((h + 18) % 360).toFixed(1)}, 46%, 13%)`);
  bg.addColorStop(1, `hsl(${((h + 42) % 360).toFixed(1)}, 42%, 17%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const g1 = ctx.createRadialGradient(880, 160, 0, 880, 160, 540);
  g1.addColorStop(0, `hsla(${h.toFixed(1)}, 90%, 62%, .26)`);
  g1.addColorStop(1, `hsla(${h.toFixed(1)}, 90%, 62%, 0)`);
  ctx.fillStyle = g1; ctx.fillRect(0, 0, W, H);

  const g2 = ctx.createRadialGradient(140, 1320, 0, 140, 1320, 560);
  g2.addColorStop(0, `hsla(${((h + 50) % 360).toFixed(1)}, 80%, 58%, .20)`);
  g2.addColorStop(1, `hsla(${((h + 50) % 360).toFixed(1)}, 80%, 58%, 0)`);
  ctx.fillStyle = g2; ctx.fillRect(0, 0, W, H);
}

/** 画二维码（白底 + 4 模块静区），居中于 (cx, cy)，maxSide 为含静区的最大边长。 */
function drawQRCode(ctx, text, cx, cy, maxSide) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = Math.max(2, Math.floor(maxSide / (n + 8)));   // 4 模块静区 ×2
  const side = cell * (n + 8);
  const x = Math.round(cx - side / 2), y = Math.round(cy - side / 2);

  ctx.save();
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, side, side, 18);
  ctx.fill();
  ctx.restore();

  const ox = x + cell * 4, oy = y + cell * 4;
  ctx.fillStyle = '#111111';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
    }
  }
}

async function drawCard(meta, withCover) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // 封面先加载：既用于绘制，也用于取色
  const cover = withCover && meta.pic ? await loadCover(`${meta.pic}?param=800y800`) : null;
  const pal = cover ? extractPalette(cover) : null;
  paintBackground(ctx, pal);

  // 品牌
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.font = `700 42px ${FONT}`;
  ctx.fillText('CurrentMusic', 90, 112);
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText('MUSIC SHARE', 90, 152);

  // 封面
  const size = 620, x = (W - size) / 2, y = 180;
  ctx.save();
  roundRect(ctx, x, y, size, size, 32);
  ctx.clip();
  if (cover) {
    ctx.drawImage(cover, x, y, size, size);
  } else {
    const cg = ctx.createLinearGradient(x, y, x + size, y + size);
    cg.addColorStop(0, pal ? `hsl(${pal.h}, 60%, 48%)` : '#7a52c9');
    cg.addColorStop(1, pal ? `hsl(${(pal.h + 40) % 360}, 50%, 26%)` : '#3a2456');
    ctx.fillStyle = cg;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255,255,255,.26)';
    ctx.font = '220px serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', W / 2, y + size / 2 + 78);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // 歌名 / 歌手 / 专辑
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 54px ${FONT}`;
  const lines = wrapLines(ctx, meta.name || '', 900, 2);
  let ty = 880;
  lines.forEach(l => { ctx.fillText(l, 90, ty); ty += 70; });

  ctx.fillStyle = 'rgba(255,255,255,.74)';
  ctx.font = `500 32px ${FONT}`;
  ctx.fillText(fitText(ctx, meta.artists, 900), 90, ty + 6);
  if (meta.album) {
    ctx.fillStyle = 'rgba(255,255,255,.46)';
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText(fitText(ctx, meta.album, 900), 90, ty + 48);
  }

  // 分隔线
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(90, 1090); ctx.lineTo(W - 90, 1090); ctx.stroke();

  // 左侧：文案与链接
  ctx.fillStyle = 'rgba(255,255,255,.5)';
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText('在 CurrentMusic 收听', 90, 1170);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = '500 22px ui-monospace,Menlo,monospace';
  ctx.fillText(fitText(ctx, songUrl(meta).replace(/^https?:\/\//, ''), 610), 90, 1216);
  ctx.fillStyle = 'rgba(255,255,255,.42)';
  ctx.font = `400 20px ${FONT}`;
  ctx.fillText('扫码或访问链接', 90, 1256);
  ctx.fillStyle = 'rgba(255,255,255,.52)';
  ctx.font = `400 19px ${FONT}`;
  ctx.fillText(fitText(ctx, `也可打开 CurrentMusicX 搜索「${meta.name}」收听`, 610), 90, 1296);

  // 右侧：二维码（含 4 模块静区，扫码可用）
  drawQRCode(ctx, songUrl(meta), 860, 1250, 258);

  return cv;
}

/** 生成分享图（PNG dataURL）。封面失败或画布被污染时自动重画无封面版本。 */
export async function makeShareImage(meta) {
  try {
    const cv = await drawCard(meta, true);
    return cv.toDataURL('image/jpeg', 0.92);     // 污染画布会在这里抛 SecurityError
  } catch (e) {
    const cv = await drawCard(meta, false);
    return cv.toDataURL('image/jpeg', 0.92);
  }
}

function safeName(meta) {
  const n = String(meta.name || 'song').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  return `CurrentMusic-${n}-${meta.ncm_id || 0}.jpg`;
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
