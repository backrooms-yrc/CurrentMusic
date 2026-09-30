// MLOG 播放抽屉（阶段三新增）
// MLOG 是网易云的「音乐动态视频」，id 与正式视频 vid 不同：
//   播放地址走 /mlog/url；若上游已把它转成正式视频，则用 /mlog/to/video 换 vid 后跳视频页。
// 歌手页的「视频」与 MV 页的「同曲 MLOG」共用本模块，避免两处各写一套降级逻辑。
import { api } from './api.js';
import { esc } from './ui.js';

export function openMlog(mlogId, cover) {
  const diag = document.createElement('mdui-dialog');
  diag.headline = 'MLOG';
  diag.innerHTML = '<div class="cm-media-box" id="mlogBox"><div class="cm-loading" style="padding:30px 0"><mdui-circular-progress></mdui-circular-progress></div></div>';
  document.body.appendChild(diag);
  diag.open = true;
  const box = diag.querySelector('#mlogBox');
  api.ncm('/mlog/url', { id: mlogId, res: 1080 }).then(d => {
    const url = (d.data || {}).url;
    if (!url) throw new Error((d.message && d.message !== 'ok') ? d.message : '无播放地址');
    box.innerHTML = `<video class="cm-media" controls playsinline preload="metadata"${cover ? ` poster="${esc(cover)}"` : ''}></video>`;
    const v = box.querySelector('video');
    v.src = url;
    v.onerror = () => { box.innerHTML = '<div class="cm-empty small">播放失败</div>'; };
  }).catch(() => {
    // 退路：MLOG 若已被上游转成正式视频，则跳视频详情页
    api.ncm('/mlog/to/video', { id: mlogId }).then(d => {
      const vid = d.data && (d.data.vid || (d.data.data && d.data.data.vid));
      if (vid) { diag.open = false; location.hash = `#/video/${vid}`; return; }
      box.innerHTML = '<div class="cm-empty small">该 MLOG 暂无可用播放地址</div>';
    }).catch(e => {
      box.innerHTML = `<div class="cm-empty small">MLOG 播放失败：${esc(e.message)}</div>`;
    });
  });
}
