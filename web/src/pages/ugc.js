// 网易云百科（UGC）页（阶段三新增）
// 我的贡献：/ugc/detail（按纠错类型与审核状态筛选 + 翻页）、/ugc/user/devote（积分/云贝）
// 词条查询：/ugc/artist/search（搜歌手）→ /ugc/artist/get（歌手百科）
//          /ugc/song/get（歌曲百科，按歌曲 id 查询）
// 全部是 T1 账号态接口：未绑定网易云会 401，页面直接给绑定引导。
import { api, auth } from '../api.js';
import { esc, toast, fmtCount } from '../ui.js';

// 上游 type 枚举（曲库纠错 / 曲库补充）
const TYPES = [
  { k: 1, l: '歌手' }, { k: 2, l: '专辑' }, { k: 3, l: '歌曲' }, { k: 4, l: 'MV' },
  { k: 5, l: '歌词' }, { k: 6, l: '翻译歌词' }, { k: 101, l: '专辑补充' }, { k: 103, l: 'MV补充' },
];
const AUDIT = [
  { k: '', l: '全部' }, { k: 5, l: '已通过' }, { k: 1, l: '审核中' }, { k: 4, l: '部分通过' },
  { k: 0, l: '待审核' }, { k: -5, l: '未采纳' },
];

const KEY = 'cm.ugcTab';

export async function render(el, params = {}) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:44px">menu_book</span>
      <div>百科贡献与你的网易云账号绑定，请先登录并绑定网易云</div>
      <mdui-button variant="filled" href="#/user">去绑定</mdui-button></div>`;
    return;
  }
  const tab = params.tab || sessionStorage.getItem(KEY) || 'mine';
  el.innerHTML = `
    <div class="cm-sqtabs" id="ugcTabs">
      <button class="cm-sqtab${tab === 'mine' ? ' on' : ''}" data-k="mine">我的贡献</button>
      <button class="cm-sqtab${tab === 'search' ? ' on' : ''}" data-k="search">词条查询</button>
    </div>
    <div id="ugcStats"></div>
    <div id="ugcFilter"></div>
    <div id="ugcBody"><div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div></div>`;
  el.querySelectorAll('#ugcTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#ugcBody');
  const filter = el.querySelector('#ugcFilter');

  // 贡献概览（/ugc/user/devote）：积分 / 云贝 / 条目数
  api.ncm('/ugc/user/devote').then(d => {
    const box = el.querySelector('#ugcStats');
    if (!box) return;
    const o = d.data || d;
    const bits = [];
    if (o.devoteCount !== undefined) bits.push(`贡献 ${o.devoteCount} 条`);
    if (o.score !== undefined) bits.push(`积分 ${o.score}`);
    if (o.yunbei !== undefined) bits.push(`云贝 ${fmtCount(o.yunbei)}`);
    box.innerHTML = bits.length
      ? `<div class="cm-sq-stats"><span class="material-icons-outlined">menu_book</span>${bits.join(' · ')}</div>`
      : '';
  }).catch(() => {});

  if (tab === 'search') {
    filter.innerHTML = `
      <div class="cm-search-bar"><mdui-text-field id="ugcKw" label="按歌手名或歌手 ID 查百科" variant="outlined" clearable style="width:100%"></mdui-text-field></div>
      <div class="cm-pe-field"><label>或按歌曲 ID 查歌曲百科</label>
        <div class="cm-pe-inline"><input id="ugcSongId" placeholder="如 347230"><mdui-button variant="tonal" id="ugcSongBtn">查询</mdui-button></div>
      </div>`;
    const input = el.querySelector('#ugcKw');
    input.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const kw = input.value.trim();
      if (!kw) return;
      body.innerHTML = '<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>';
      try {
        const d = await api.ncm('/ugc/artist/search', { keyword: kw, limit: 20 });
        const list = d.data || d.artists || [];
        body.innerHTML = list.length ? list.map(a => `
          <div class="cm-pe-row" data-aid="${a.artistId || a.id}">
            <span>${esc(a.artistName || a.name || '')}</span>
            <span class="cm-si-act" data-detail="${a.artistId || a.id}">看百科</span>
          </div>`).join('') : '<div class="cm-empty small">没有匹配的歌手词条</div>';
        body.querySelectorAll('[data-detail]').forEach(x => {
          x.onclick = ev => { ev.stopPropagation(); showArtistWiki(x.dataset.detail); };
        });
      } catch (e) {
        body.innerHTML = errHTML(e);
      }
    });
    el.querySelector('#ugcSongBtn').onclick = async () => {
      const sid = el.querySelector('#ugcSongId').value.trim();
      if (!sid) return toast('请填歌曲 ID');
      body.innerHTML = '<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>';
      try {
        const d = await api.ncm('/ugc/song/get', { id: sid });
        body.innerHTML = wikiHTML('歌曲百科', d.data || d);
      } catch (e) { body.innerHTML = errHTML(e); }
    };
    body.innerHTML = '<div class="cm-empty small">输入歌手名后回车，或按歌曲 ID 查询</div>';
    return;
  }

  // 我的贡献
  let type = params.type ?? 1, audit = params.audit ?? '', offset = 0;
  const chips = () => {
    filter.innerHTML = `
      <div class="cm-plsort"><span class="cm-plsort-l">类型</span>
        ${TYPES.map(t => `<mdui-chip ${t.k === type ? 'selected' : ''} data-t="${t.k}">${t.l}</mdui-chip>`).join('')}</div>
      <div class="cm-plsort"><span class="cm-plsort-l">状态</span>
        ${AUDIT.map(a => `<mdui-chip ${String(a.k) === String(audit) ? 'selected' : ''} data-s="${a.k}">${a.l}</mdui-chip>`).join('')}</div>`;
    filter.querySelectorAll('[data-t]').forEach(c => {
      c.onclick = () => { type = Number(c.dataset.t); offset = 0; chips(); load(0).catch(e => toast(e.message)); };
    });
    filter.querySelectorAll('[data-s]').forEach(c => {
      c.onclick = () => { audit = c.dataset.s; offset = 0; chips(); load(0).catch(e => toast(e.message)); };
    });
  };
  const load = async off => {
    const d = await api.ncm('/ugc/detail', { type, auditStatus: audit, limit: 20, offset: off, order: 'desc', sortBy: 'createTime' });
    const list = d.data || d.list || [];
    if (!off) body.innerHTML = '';
    if (!list.length && !off) { body.innerHTML = '<div class="cm-empty small">该筛选下没有贡献记录</div>'; return; }
    body.insertAdjacentHTML('beforeend', list.map(x => `
      <div class="cm-lm-item">
        <div class="cm-lm-lyric">${esc(x.targetName || x.name || x.title || '(未命名词条)')}</div>
        <div class="cm-lm-meta"><span>${esc(x.typeName || `类型 ${x.type ?? type}`)} · ${esc(x.auditStatusName || statusLabel(x.auditStatus))}</span>
        <span>${x.createTime ? new Date(x.createTime).toLocaleDateString('zh-CN') : ''}</span></div>
      </div>`).join(''));
    body.querySelector('#ugcMore')?.remove();
    if (list.length >= 20) {
      body.insertAdjacentHTML('beforeend',
        '<div class="cm-sq-more" id="ugcMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
      body.querySelector('#ugcMore mdui-button').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        try { await load(off + list.length); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };
  chips();
  try { await load(0); } catch (e) { body.innerHTML = errHTML(e); }
}

const statusLabel = s => ({ 5: '已通过', 1: '审核中', 4: '部分通过', 0: '待审核', '-5': '未采纳' }[String(s)] || '未知状态');

const errHTML = e => /401|绑定/.test(e.message)
  ? '<div class="cm-empty">需先绑定网易云账号</div>'
  : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;

/** 把上游百科返回的嵌套结构摊平成可读的键值列表。 */
function wikiHTML(title, data) {
  const rows = [];
  const walk = (o, depth) => {
    if (o === null || o === undefined || depth > 3) return;
    if (typeof o === 'string' || typeof o === 'number') return;
    if (Array.isArray(o)) { o.forEach(x => walk(x, depth + 1)); return; }
    Object.entries(o).forEach(([k, v]) => {
      if (v === null || v === '') return;
      if (typeof v === 'string' || typeof v === 'number') rows.push(`<div class="cm-si-row"><b>${esc(k)}</b><span>${esc(String(v))}</span></div>`);
      else walk(v, depth + 1);
    });
  };
  walk(data, 0);
  return `<div class="cm-si-sec"><div class="cm-si-sec-h">${esc(title)}</div>${rows.slice(0, 40).join('') || '<div class="cm-si-empty">暂无词条内容</div>'}</div>`;
}

function showArtistWiki(artistId) {
  const diag = document.createElement('mdui-dialog');
  diag.headline = '歌手百科';
  diag.innerHTML = '<div id="ugcAwBox" style="max-height:60vh;overflow:auto"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>';
  document.body.appendChild(diag);
  diag.open = true;
  api.ncm('/ugc/artist/get', { id: artistId }).then(d => {
    const box = diag.querySelector('#ugcAwBox');
    if (box) box.innerHTML = wikiHTML('歌手百科', d.data || d);
  }).catch(e => {
    const box = diag.querySelector('#ugcAwBox');
    if (box) box.innerHTML = errHTML(e);
  });
}
