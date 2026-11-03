// 歌曲分享（v1.28.46）：分享图（实时生成可下载）/ 分享链接 / 分享歌曲信息。
//
// 分享图在客户端用 canvas 实时绘制：1080×1440，生成前选择方块或沉浸式封面。
// 封面走网易云 CDN（带 CORS 头）；App 的 WebView 是 file:// 页面，若封面加载/画布导出
// 失败（tainted canvas），自动降级为「渐变占位封面」再画一遍——保证任何环境都能出图。
import { mdui } from './md.js';
import { settings } from './api.js';
import { esc, toast } from './ui.js';
import qrcode from 'qrcode-generator';
import brandIcon from '../../assets/brand/apple-touch-icon.png';

const W = 1080, H = 1440;
const FONT = '"PingFang SC","Microsoft YaHei",system-ui,-apple-system,sans-serif';
const IMAGE_STYLES = {
  square: { label: '方块封面', icon: 'crop_square', description: '独立封面，搭配渐变背景' },
  immersive: { label: '沉浸式封面', icon: 'wallpaper', description: '封面铺满，背景自然融合' },
};

/** 站点 base：Web 用当前页面地址，App（file://）用 API 站点 + /app/。 */
function siteOrigin() {
  try { return new URL(settings.base).origin; } catch { return location.origin; }
}
function appBase() {
  if (location.protocol === 'file:') return `${siteOrigin()}/app/`;
  return location.href.split('#')[0];
}
const KIND_UI = {
  song: { headline: '分享歌曲', icon: 'music_note', textLabel: '分享歌曲信息',
          brand: 'MUSIC SHARE', cta: '在 CurrentMusic 收听', verb: '收听' },
  playlist: { headline: '分享歌单', icon: 'queue_music', textLabel: '分享歌单信息',
              brand: 'PLAYLIST SHARE', cta: '在 CurrentMusic 打开歌单', verb: '打开' },
  'local-playlist': { headline: '分享歌单', icon: 'queue_music', textLabel: '分享歌单信息',
                      brand: 'PLAYLIST SHARE', cta: '在 CurrentMusic 打开歌单', verb: '打开' },
  artist: { headline: '分享歌手', icon: 'person', textLabel: '分享歌手信息',
            brand: 'ARTIST SHARE', cta: '在 CurrentMusic 查看歌手', verb: '查看' },
  album: { headline: '分享专辑', icon: 'album', textLabel: '分享专辑信息',
           brand: 'ALBUM SHARE', cta: '在 CurrentMusic 打开专辑', verb: '打开' },
};
function kindOf(meta) { return (meta && meta.type) || 'song'; }
function entityId(meta) { return Number(meta && (meta.id || meta.ncm_id) || 0); }
function uiOf(meta) { return KIND_UI[kindOf(meta)] || KIND_UI.song; }

/** 分享落地页地址：歌曲 / 网易云歌单 / 站内歌单 / 歌手 / 专辑。 */
export function entityUrl(meta) {
  const kind = kindOf(meta), id = entityId(meta);
  const path = kind === 'song' ? 'song'
    : kind === 'playlist' ? 'ncmpl'
      : kind === 'local-playlist' ? 'pl'
        : kind === 'artist' ? 'artist' : 'album';
  return `${appBase()}#/${path}/${id}`;
}
// 兼容旧的歌曲分享调用。
export function songUrl(meta) { return `${appBase()}#/song/${meta.ncm_id}`; }

function shareText(meta) {
  const kind = kindOf(meta), ui = uiOf(meta), url = entityUrl(meta);
  const name = meta.name || '';
  if (kind === 'song') {
    const lines = [`🎵 ${name}${meta.artists ? ' - ' + meta.artists : ''}`];
    if (meta.album) lines.push(`专辑：${meta.album}`);
    lines.push('', `${ui.cta}：${url}`);
    return lines.join('\n');
  }
  if (kind === 'playlist' || kind === 'local-playlist') {
    const lines = [`🎵 歌单：${name}`];
    if (meta.sub) lines.push(kind === 'playlist' ? `创建者：${meta.sub}` : meta.sub);
    if (meta.sub2) lines.push(meta.sub2);
    lines.push('', `${ui.cta}：${url}`);
    return lines.join('\n');
  }
  if (kind === 'artist') {
    const lines = [`🎤 歌手：${name}`];
    if (meta.sub && meta.sub !== '歌手') lines.push(meta.sub);
    if (meta.sub2) lines.push(meta.sub2);
    lines.push('', `${ui.cta}：${url}`);
    return lines.join('\n');
  }
  const lines = [`💿 专辑：${name}${meta.sub ? ' - ' + meta.sub : ''}`];
  if (meta.sub2) lines.push(meta.sub2);
  lines.push('', `${ui.cta}：${url}`);
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
  const str = String(text || '');
  if (ctx.measureText(str).width <= maxWidth) return str;
  const chars = Array.from(str);
  while (chars.length && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
  return chars.join('') + '…';
}

function wrapLines(ctx, text, maxWidth, maxLines) {
  const chars = Array.from(String(text || '')), out = [];
  let line = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      out.push(line);
      if (out.length >= maxLines - 1) {
        out.push(fitText(ctx, chars.slice(i).join(''), maxWidth));
        return out;
      }
      line = ch;
    } else line += ch;
  }
  if (line && out.length < maxLines) out.push(line);
  return out.length ? out : [''];
}

function drawCover(ctx, cover, x, y, width, height) {
  const scale = Math.max(width / cover.naturalWidth, height / cover.naturalHeight);
  const w = cover.naturalWidth * scale, h = cover.naturalHeight * scale;
  ctx.drawImage(cover, x + (width - w) / 2, y + (height - h) / 2, w, h);
}

/** 封面等比铺满画布、居中裁切，图片本身就是整张海报的背景。 */
function paintImmersiveBackground(ctx, cover) {
  ctx.fillStyle = '#21152f';
  ctx.fillRect(0, 0, W, H);
  if (cover) {
    drawCover(ctx, cover, 0, 0, W, H);
  } else {
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#7953a9');
    bg.addColorStop(0.55, '#493064');
    bg.addColorStop(1, '#21152f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(820, 280, 0, 820, 280, 780);
    glow.addColorStop(0, 'rgba(204,165,255,.38)');
    glow.addColorStop(1, 'rgba(204,165,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.22)';
    ctx.font = '320px serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', W / 2, 650);
    ctx.restore();
  }

  // 上下遮罩与封面自然融合，亮色封面上也能读清品牌、标题和底部信息。
  const top = ctx.createLinearGradient(0, 0, 0, 520);
  top.addColorStop(0, 'rgba(8,9,15,.8)');
  top.addColorStop(0.35, 'rgba(8,9,15,.7)');
  top.addColorStop(1, 'rgba(8,9,15,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H);
  const bottom = ctx.createLinearGradient(0, 0, 0, H);
  bottom.addColorStop(0, 'rgba(8,9,15,0)');
  bottom.addColorStop(0.34, 'rgba(8,9,15,0)');
  bottom.addColorStop(0.56, 'rgba(8,9,15,.36)');
  bottom.addColorStop(0.67, 'rgba(8,9,15,.82)');
  bottom.addColorStop(1, 'rgba(8,9,15,.96)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, 0, W, H);
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

/** 方块版沿用封面主色渐变；读取失败或封面无彩色时使用品牌紫。 */
function coverHue(cover) {
  if (!cover) return 268;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 40;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(cover, 0, 0, 40, 40);
    const pixels = ctx.getImageData(0, 0, 40, 40).data, bins = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 200) continue;
      const [h, s, l] = rgb2hsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      if (l < 0.12 || l > 0.9 || s < 0.12) continue;
      const key = Math.floor(h / 15) % 24;
      const w = s * (0.35 + Math.min(1, l * 1.6)) * (1 - Math.abs(l - 0.52));
      const bin = bins.get(key) || { w: 0, h: 0 };
      bin.w += w; bin.h += h * w;
      bins.set(key, bin);
    }
    let best = null;
    for (const bin of bins.values()) if (!best || bin.w > best.w) best = bin;
    return best ? best.h / best.w : 268;
  } catch { return 268; }
}

function paintSquareBackground(ctx, cover) {
  const h = coverHue(cover);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, `hsl(${h}, 52%, 8%)`);
  bg.addColorStop(0.55, `hsl(${(h + 18) % 360}, 46%, 13%)`);
  bg.addColorStop(1, `hsl(${(h + 42) % 360}, 42%, 17%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  for (const [x, y, radius, hue, opacity] of [[880, 160, 540, h, .26], [140, 1320, 560, (h + 50) % 360, .2]]) {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `hsla(${hue}, 90%, 62%, ${opacity})`);
    glow.addColorStop(1, `hsla(${hue}, 90%, 62%, 0)`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);
  }

  const size = 620, x = (W - size) / 2, y = 180;
  ctx.save();
  roundRect(ctx, x, y, size, size, 32);
  ctx.clip();
  if (cover) drawCover(ctx, cover, x, y, size, size);
  else {
    const placeholder = ctx.createLinearGradient(x, y, x + size, y + size);
    placeholder.addColorStop(0, '#7a52c9');
    placeholder.addColorStop(1, '#3a2456');
    ctx.fillStyle = placeholder;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = 'rgba(255,255,255,.26)';
    ctx.font = '220px serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', W / 2, y + size / 2 + 78);
  }
  ctx.restore();
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

async function drawCard(meta, withCover, style) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const square = style === 'square', inset = square ? 90 : 80;
  const textWidth = W - inset * 2, footerOffset = square ? -30 : 0;

  // 保留原有查询参数；较大尺寸用于全幅海报，非 HTTP 图片地址保持原样。
  let coverUrl = meta.pic;
  if (withCover && coverUrl) {
    try {
      const url = new URL(coverUrl, location.href);
      if (/^https?:$/.test(url.protocol)) {
        url.searchParams.set('param', '1200y1200');
        coverUrl = url.href;
      }
    } catch { /* 无效地址交给加载失败占位处理 */ }
  }
  // Logo 随代码内嵌，离线及封面降级重绘时也可显示，不引入画布跨域污染。
  const [cover, logo] = await Promise.all([
    withCover && coverUrl ? loadCover(coverUrl) : null,
    loadCover(brandIcon),
  ]);
  if (square) paintSquareBackground(ctx, cover);
  else paintImmersiveBackground(ctx, cover);

  // 品牌
  const ui = uiOf(meta);
  if (logo) ctx.drawImage(logo, 72, 56, 112, 112);
  const brandX = logo ? 208 : 80;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,.94)';
  ctx.font = `700 42px ${FONT}`;
  ctx.fillText('CurrentMusic', brandX, 112);
  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = `600 22px ${FONT}`;
  ctx.fillText(ui.brand, brandX, 152);

  // 主标题 / 副标题 / 补充信息
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${square ? 54 : 64}px ${FONT}`;
  const lines = wrapLines(ctx, meta.name || '', textWidth, 2);
  let ty = square ? 880 : 900;
  lines.forEach(l => { ctx.fillText(l, inset, ty); ty += square ? 70 : 78; });

  const sub = meta.sub || meta.artists || '';
  const sub2 = meta.sub2 || meta.album || '';
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  ctx.font = `500 32px ${FONT}`;
  if (sub) ctx.fillText(fitText(ctx, sub, textWidth), inset, ty + 6);
  if (sub2) {
    ctx.fillStyle = 'rgba(255,255,255,.68)';
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText(fitText(ctx, sub2, textWidth), inset, ty + 48);
  }

  // 分隔线
  ctx.strokeStyle = 'rgba(255,255,255,.16)';
  ctx.lineWidth = 2;
  const dividerY = square ? 1090 : 1150;
  ctx.beginPath(); ctx.moveTo(inset, dividerY); ctx.lineTo(W - inset, dividerY); ctx.stroke();

  // 左侧：文案与链接
  const shareUrl = entityUrl(meta);
  ctx.fillStyle = 'rgba(255,255,255,.78)';
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(ui.cta, inset, 1200 + footerOffset);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.font = '500 22px ui-monospace,Menlo,monospace';
  ctx.fillText(fitText(ctx, shareUrl.replace(/^https?:\/\//, ''), 610), inset, 1246 + footerOffset);
  ctx.fillStyle = 'rgba(255,255,255,.64)';
  ctx.font = `400 20px ${FONT}`;
  ctx.fillText('扫码或访问链接', inset, 1286 + footerOffset);
  ctx.fillStyle = 'rgba(255,255,255,.64)';
  ctx.font = `400 19px ${FONT}`;
  ctx.fillText(fitText(ctx, `也可打开 CurrentMusicX 搜索「${meta.name || ''}」${ui.verb}`, 610), inset, 1326 + footerOffset);

  // 右侧：二维码（含 4 模块静区，扫码可用）
  drawQRCode(ctx, shareUrl, square ? 860 : 880, square ? 1250 : 1260, square ? 258 : 240);

  return cv;
}

/** 生成分享图（JPEG dataURL）。封面失败或画布被污染时自动重画无封面版本。 */
export async function makeShareImage(meta, style = 'immersive') {
  try {
    const cv = await drawCard(meta, true, style);
    return cv.toDataURL('image/jpeg', 0.92);     // 污染画布会在这里抛 SecurityError
  } catch (e) {
    const cv = await drawCard(meta, false, style);
    return cv.toDataURL('image/jpeg', 0.92);
  }
}

function safeName(meta, style) {
  const n = String(meta.name || 'share').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  return `CurrentMusic-${n}-${kindOf(meta)}-${entityId(meta)}-${style}.jpg`;
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

function saveImage(dataUrl, meta, style) {
  const name = safeName(meta, style);
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

async function previewShareImage(meta, style) {
  toast('正在生成分享图…');
  try {
    const dataUrl = await makeShareImage(meta, style);
    mdui.dialog({
      headline: `分享图 · ${IMAGE_STYLES[style].label}`,
      body: `<div class="cm-share-preview"><img src="${dataUrl}" alt="${IMAGE_STYLES[style].label}分享图预览"></div>`,
      actions: [
        { text: '关闭' },
        { text: '保存图片', onClick: () => { saveImage(dataUrl, meta, style); } },
      ],
    });
  } catch (e) {
    toast('分享图生成失败：' + ((e && e.message) || '未知错误'));
  }
}

function chooseShareImageStyle(meta) {
  const dialog = mdui.dialog({
    headline: '选择分享图样式',
    body: `<div class="cm-share-opts">${Object.entries(IMAGE_STYLES).map(([style, ui]) => `
      <button class="cm-share-opt" data-share-style="${style}">
        <span class="material-icons-outlined">${ui.icon}</span><b>${ui.label}</b><i>${ui.description}</i>
      </button>`).join('')}</div>`,
    closeOnEsc: true,
    closeOnOverlayClick: true,
    actions: [{ text: '取消' }],
  });
  let selected = false;
  dialog.querySelectorAll('[data-share-style]').forEach(btn => {
    btn.onclick = () => {
      if (selected) return;
      selected = true;
      dialog.open = false;
      previewShareImage(meta, btn.dataset.shareStyle);
    };
  });
}

/** 分享入口：分享图 / 链接 / 信息；歌曲、歌单、歌手、专辑共用。 */
export function openShare(meta) {
  if (!meta || !entityId(meta)) return toast('暂时无法分享');
  const kind = kindOf(meta), ui = uiOf(meta);
  const cover = meta.pic
    ? `<img class="cm-share-cover" src="${esc(meta.pic)}?param=120y120" alt="">`
    : `<span class="cm-share-cover ph material-icons-outlined">${ui.icon}</span>`;
  const sub = meta.sub || meta.artists || '';
  const sub2 = meta.sub2 || meta.album || '';

  const diag = mdui.dialog({
    headline: ui.headline,
    body: `<div class="cm-share">
      <div class="cm-share-song">${cover}
        <div class="cm-share-meta"><b>${esc(meta.name || '')}</b>
          <span>${esc(sub)}${sub2 ? ' · ' + esc(sub2) : ''}</span></div>
      </div>
      <div class="cm-share-opts">
        <button class="cm-share-opt" data-k="img">
          <span class="material-icons-outlined">image</span><b>分享图</b><i>选择方块或沉浸式封面</i>
        </button>
        <button class="cm-share-opt" data-k="link">
          <span class="material-icons-outlined">link</span><b>分享链接</b><i>复制${ui.headline.replace('分享', '')}页面链接</i>
        </button>
        <button class="cm-share-opt" data-k="text">
          <span class="material-icons-outlined">notes</span><b>${ui.textLabel}</b><i>复制名称、补充信息与链接</i>
        </button>
      </div>
    </div>`,
    actions: [{ text: '关闭' }],
  });

  diag.querySelectorAll('.cm-share-opt').forEach(btn => {
    btn.onclick = async () => {
      const k = btn.dataset.k;
      if (k === 'link') {
        const ok = await copyText(entityUrl(meta));
        toast(ok ? '链接已复制' : '复制失败，请手动复制');
        return;
      }
      if (k === 'text') {
        const ok = await copyText(shareText(meta));
        toast(ok ? '分享信息已复制' : '复制失败，请手动复制');
        return;
      }
      // 分享图
      btn.disabled = true;
      diag.open = false;
      chooseShareImageStyle(meta);
    };
  });
}
