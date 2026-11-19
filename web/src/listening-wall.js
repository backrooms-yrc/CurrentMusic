import { mdui } from './md.js';
import { esc } from './ui.js';
import { drawCover, loadCover } from './share.js';

const LAYOUTS = {
  grid: { label: '方形封面墙', width: 1080, height: 1080, columns: 3, count: 9, gap: 12, ink: '#17261f', paper: '#e4eee7' },
  poster: { label: '竖版海报', width: 1080, height: 1440, columns: 3, count: 12, gap: 18, ink: '#fff9ea', paper: '#1c2824' },
  wallpaper: { label: '手机壁纸', width: 1080, height: 1920, columns: 3, count: 15, gap: 8, ink: '#fff9ea', paper: '#18201f' },
};

function coverUrl(value) {
  try {
    const url = new URL(String(value).replace(/^http:/, 'https:'));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function openListeningWall(tracks, label, active) {
  let albumPromise;
  let revision = 0;
  const layoutOptions = Object.entries(LAYOUTS).map(([key, item]) => `<option value="${key}">${esc(item.label)}</option>`).join('');
  const dialog = mdui.dialog({
    headline: '生成唱片墙',
    body: `<div class="cm-form">
      <label>图片样式 <select id="listeningWallLayout">${layoutOptions}</select></label>
      <div class="cm-share-preview"><img id="listeningWallPreview" alt="唱片墙预览" hidden></div>
      <p id="listeningWallStatus" role="status"></p>
      <mdui-button variant="filled" id="listeningWallSave" disabled>保存 PNG</mdui-button>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  const selector = dialog.querySelector('#listeningWallLayout');
  const preview = dialog.querySelector('#listeningWallPreview');
  const status = dialog.querySelector('#listeningWallStatus');
  const save = dialog.querySelector('#listeningWallSave');
  let image = '';

  async function paint() {
    const own = ++revision;
    const layout = LAYOUTS[selector.value];
    if (!layout) return;
    status.textContent = '正在生成唱片墙…';
    save.disabled = true;
    try {
      albumPromise ||= Promise.resolve(tracks()).then(list => {
        // One tile per album cover. Songs with missing covers retain their own text tiles.
        const seen = new Set();
        return list.flatMap(track => {
          const url = coverUrl(track.pic);
          const key = url || track.name + '・' + track.artists;
          if (seen.has(key)) return [];
          seen.add(key);
          return [{ ...track, url }];
        }).slice(0, 15);
      }).then(items => Promise.all(items.map(async item => ({
        ...item, cover: item.url ? await loadCover(item.url, 3000) : null,
      }))));
      const items = await albumPromise;
      if (own !== revision || !dialog.open || !active()) return;
      const shown = items.slice(0, layout.count);
      const canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || !shown.length) throw new Error('当前还没有足够的听歌记录。');
      ctx.fillStyle = layout.paper;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = layout.ink;
      ctx.font = '600 58px system-ui, sans-serif';
      ctx.fillText('唱片墙', 54, 118);
      ctx.font = '26px system-ui, sans-serif';
      ctx.fillText(label, 54, 166);
      const rows = Math.ceil(shown.length / layout.columns);
      const size = Math.floor(Math.min((canvas.width - 108 - layout.gap * (layout.columns - 1)) / layout.columns,
        (canvas.height - 360 - layout.gap * (rows - 1)) / rows));
      const startY = 222 + Math.max(0, Math.floor((canvas.height - 362 - rows * (size + layout.gap)) / 2));
      shown.forEach((item, index) => {
        const x = 54 + (index % layout.columns) * (size + layout.gap);
        const y = startY + Math.floor(index / layout.columns) * (size + layout.gap);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, size, size);
        ctx.clip();
        if (item.cover) drawCover(ctx, item.cover, x, y, size, size);
        else {
          ctx.fillStyle = `hsl(${(index * 43 + 150) % 360}, 22%, 27%)`;
          ctx.fillRect(x, y, size, size);
          ctx.fillStyle = '#fff';
          ctx.font = '600 30px system-ui, sans-serif';
          ctx.fillText(item.name || '单曲', x + 18, y + size / 2, size - 36);
          ctx.font = '22px system-ui, sans-serif';
          ctx.fillText(item.artists || '', x + 18, y + size / 2 + 34, size - 36);
        }
        ctx.restore();
      });
      ctx.fillStyle = layout.ink;
      ctx.font = '26px system-ui, sans-serif';
      ctx.fillText('CurrentMusic', 54, canvas.height - 58);
      image = canvas.toDataURL('image/png');
      preview.src = image;
      preview.hidden = false;
      status.textContent = shown.some(item => !item.cover) ? '部分封面不可用，已保留对应曲目。' : '';
      save.disabled = false;
    } catch (error) {
      if (own === revision && dialog.open && active()) status.textContent = error.message || '生成失败';
    }
  }

  selector.onchange = paint;
  save.onclick = () => {
    if (!image || !active()) return;
    const link = document.createElement('a');
    link.href = image;
    link.download = `CurrentMusic-唱片墙-${selector.value}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };
  paint();
}
