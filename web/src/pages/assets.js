// 我的音乐资产（阶段二）：已购单曲 / 已购数字单曲 / 会员下载记录 / 本月下载
//   阅读：/song/purchased、/song/singledownlist、/song/downlist、/song/monthdownlist
// 四条都是**账号维度**接口（T1），必须用用户自己的网易云 cookie，未绑定不做请求。
//
// 注意：这几个接口的响应结构上游未公开且需要登录态，这里用**容错解析**——在常见字段名里
// 找第一个「看起来像歌曲列表」的数组，取不到就显示空态，不猜结构、不硬编码。
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast } from '../ui.js';
import { player } from '../player.js';

const TABS = [
  { key: 'purchased', label: '已购单曲', path: '/song/purchased' },
  { key: 'single', label: '已购数字单曲', path: '/song/singledownlist' },
  { key: 'down', label: '下载记录', path: '/song/downlist' },
  { key: 'month', label: '本月下载', path: '/song/monthdownlist' },
];

/** 在任意层级里找第一个「元素像歌曲」的数组。 */
function findSongList(node, depth = 0) {
  if (!node || depth > 4) return [];
  if (Array.isArray(node)) {
    const looksLikeSongs = node.some(x => x && typeof x === 'object' && (x.id || x.songId));
    if (looksLikeSongs) return node;
    for (const it of node) {
      const r = findSongList(it, depth + 1);
      if (r.length) return r;
    }
    return [];
  }
  if (typeof node === 'object') {
    for (const k of ['songs', 'data', 'list', 'records', 'songList', 'dataList']) {
      if (node[k]) { const r = findSongList(node[k], depth + 1); if (r.length) return r; }
    }
    for (const v of Object.values(node)) {
      const r = findSongList(v, depth + 1);
      if (r.length) return r;
    }
  }
  return [];
}

export async function render(el) {
  el.innerHTML = `
    <div class="cm-sec-head"><h2>我的音乐资产</h2><span class="cm-sec-sub">来自你的网易云账号</span></div>
    <div class="cm-plsort" id="asTabs">
      ${TABS.map((t, i) => `<mdui-chip ${i === 0 ? 'selected' : ''} data-k="${t.key}">${t.label}</mdui-chip>`).join('')}
    </div>
    <div id="asBody"><div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div></div>`;

  const body = el.querySelector('#asBody');
  if (!auth.token) { body.innerHTML = '<div class="cm-empty">登录后可查看</div>'; return; }

  let bound = false;
  try { bound = !!(await api.bindStatus()).bound; } catch { /* 忽略 */ }
  if (!bound) {
    body.innerHTML = '<div class="cm-empty">需先绑定网易云账号（我的 → 网易云账号）</div>';
    return;
  }

  let cur = 'purchased';
  async function load() {
    const tab = TABS.find(t => t.key === cur);
    body.innerHTML = '<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>';
    let songs = [];
    try {
      const d = await api.ncm(tab.path, { limit: 100, offset: 0 });
      songs = ncmSongs(findSongList(d));
    } catch (e) {
      body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
      return;
    }
    if (!songs.length) {
      body.innerHTML = `<div class="cm-empty small">「${esc(tab.label)}」暂无记录</div>`;
      return;
    }
    body.innerHTML = `<div class="cm-sec-sub" style="margin-bottom:6px">共 ${songs.length} 首</div><div id="asList"></div>`;
    const { renderSongList } = await import('../ui.js');
    await renderSongList(body.querySelector('#asList'), songs, {
      onPlay: i => { player.playList(songs, i); toast(`播放「${tab.label}」`); },
    });
  }

  el.querySelectorAll('#asTabs mdui-chip').forEach(ch => {
    ch.onclick = () => {
      if (ch.dataset.k === cur) return;
      cur = ch.dataset.k;
      el.querySelectorAll('#asTabs mdui-chip').forEach(c => c.toggleAttribute('selected', c === ch));
      load();
    };
  });
  load();
}
