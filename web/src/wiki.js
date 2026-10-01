// 歌曲百科：播放页右上角「更多」里的独立入口。
//
// 数据来自本地 `/song/wiki`（服务端已把上游页级拼装结构归一化成
// 「章节 + 字段 + 正文」，见 cm_ncm.song_wiki），因此这里只做展示，不做结构猜测。
import { mdui } from './md.js';
import { api } from './api.js';
import { esc, toast } from './ui.js';

function sectionHTML(sec) {
  const fields = (sec.fields || []).map(([k, v]) =>
    `<div class="cm-wiki-field"><span class="cm-wiki-k">${esc(k)}</span><span class="cm-wiki-v">${esc(v)}</span></div>`).join('');
  const desc = sec.desc
    ? `<div class="cm-wiki-desc">${esc(sec.desc).split('\n').map(t => t.trim()).filter(Boolean).map(t => `<p>${t}</p>`).join('')}</div>`
    : '';
  return `<div class="cm-wiki-sec"><div class="cm-wiki-sec-t">${esc(sec.name)}</div>${fields}${desc}</div>`;
}

/**
 * 打开歌曲百科。
 * @param meta 播放器当前曲目（需含 ncm_id）
 */
export async function openWiki(meta) {
  const id = meta && meta.ncm_id;
  if (!id) { toast('当前没有正在播放的歌曲'); return; }
  const diag = mdui.dialog({
    headline: '歌曲百科',
    body: `<div class="cm-wiki" id="cmWikiBody"><div class="cm-wiki-loading">正在加载…</div></div>`,
    actions: [{ text: '关闭' }],
  });
  const box = diag.querySelector('#cmWikiBody');
  try {
    const d = await api.songWiki(id);
    const sections = d.sections || [];
    const head = `
      <div class="cm-wiki-head">
        ${d.cover ? `<img class="cm-wiki-cover" src="${esc(d.cover)}" loading="lazy" onerror="this.remove()">` : ''}
        <div class="cm-wiki-meta">
          <div class="cm-wiki-name">${esc(d.name || meta.name || '')}</div>
          <div class="cm-wiki-sub">${esc(d.artist || meta.artists || '')}${d.album ? ' · ' + esc(d.album) : ''}</div>
        </div>
      </div>`;
    box.innerHTML = head + (sections.length
      ? sections.map(sectionHTML).join('')
      : `<div class="cm-wiki-empty">这首歌暂时没有百科内容</div>`);
  } catch (e) {
    box.innerHTML = `<div class="cm-wiki-empty">百科加载失败：${esc((e && e.message) || '未知错误')}</div>`;
  }
}
