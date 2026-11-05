import './songinfo.css';
// 歌曲详情抽屉（阶段二）：把「单曲维度」的接口聚到一个面板里
// 音质档位 / 副歌时间 / 红心数 / 创作者 / 音乐百科 / 相似歌曲 / 乐谱 / 评论统计
// 音质、副歌、其他版本使用结构化 API；其他资料沿用 NCM 网关。
import { api, auth, ncmSongs } from './api.js';
import { esc, toast } from './ui.js';
import { player } from './player.js';
import { isCasting } from './cast.js';
import { mdui } from './md.js';

const sec = (title, body, extra = '') =>
  `<div class="cm-si-sec"><div class="cm-si-sec-h">${esc(title)}${extra}</div>${body}</div>`;

const loading = '<div class="cm-si-load"><mdui-circular-progress></mdui-circular-progress></div>';
const empty = m => `<div class="cm-si-empty">${esc(m)}</div>`;

/** 文件档位只代表资料存在，实际播放档位仍以解析结果为准。 */
function qualityHTML(d) {
  const rows = (d.qualities || []).map(v => {
    const br = v.br ? `${Math.round(v.br / 1000)} kbps` : '';
    const sr = v.sr ? `${(v.sr / 1000).toFixed(1)} kHz` : '';
    const size = v.size ? `${(v.size / 1024 / 1024).toFixed(1)} MB` : '';
    const variants = (v.variants || []).map(x => x.immerseType).join(' / ');
    return `<div class="cm-si-row"><b>${esc(v.label)}</b><span>${[br, sr, size, esc(variants)].filter(Boolean).join(' · ')}</span></div>`;
  });
  return rows.length ? rows.join('') + '<div class="cm-si-empty">以上为音质文件资料，播放时将按版权、账号与设备条件获取实际音质。</div>' : empty('该曲无音质详情');
}

function fmtTime(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 等到目标音频就绪再定位；切歌或解析失败时不跳动其他曲目。 */
export async function seekSongChorus(meta, ms) {
  if (!Number.isFinite(ms) || ms < 0) return false;
  const sameSong = () => String(player.meta?.ncm_id) === String(meta.ncm_id);
  if (!sameSong()) {
    if (isCasting()) { toast('请先投屏这首歌，再跳到副歌'); return false; }
    const i = player.queue.findIndex(s => String(s.ncm_id) === String(meta.ncm_id));
    if (i >= 0) await player.playAt(i);
    else { player.queue = [meta]; await player.playAt(0); player.persist(); }
  }
  if (!sameSong() || player.loading || (!player.urlInfo && !isCasting())) return false;
  const info = player.urlInfo;
  if (!isCasting() && player.audio.readyState < 1) {
    const ready = await new Promise(resolve => {
      const audio = player.audio;
      const finish = ok => {
        clearTimeout(timer);
        audio.removeEventListener('loadedmetadata', loaded);
        audio.removeEventListener('error', failed);
        resolve(ok);
      };
      const loaded = () => finish(true), failed = () => finish(false);
      const timer = setTimeout(failed, 8000);
      audio.addEventListener('loadedmetadata', loaded, { once: true });
      audio.addEventListener('error', failed, { once: true });
    });
    if (!ready) return false;
  }
  if (!sameSong() || player.urlInfo !== info) return false;
  const end = player.durMs();
  if (end > 0 && ms >= end) return false;
  player.seek(ms / 1000);
  return true;
}

/**
 * 打开歌曲详情抽屉。
 * @param {object} meta 播放器/列表里的歌曲对象（需 ncm_id）
 */
export async function openSongInfo(meta) {
  if (!meta || !meta.ncm_id) return toast('缺少歌曲信息');
  const sid = meta.ncm_id;

  const diag = mdui.dialog({
    headline: meta.name || '歌曲详情',
    body: `<div class="cm-si">
      <div class="cm-si-head">
        ${meta.pic ? `<img src="${esc(meta.pic)}?param=120y120" alt="">` : ''}
        <div><div class="cm-si-name">${esc(meta.name || '')}</div>
          <div class="cm-si-sub">${esc(meta.artists || '')}${meta.album ? ` · ${esc(meta.album)}` : ''}</div></div>
      </div>
      <div id="siBody">${loading}</div>
      <div class="cm-si-acts">
        <mdui-button variant="filled" id="siHeart">心动模式播放</mdui-button>
        <mdui-button variant="tonal" id="siLike">同步红心到网易云</mdui-button>
        <mdui-button variant="tonal" id="siShare">分享到网易云动态</mdui-button>
      </div>
    </div>`,
    actions: [{ text: '关闭' }],
  });

  const body = diag.querySelector('#siBody');

  // 心动模式：以这首歌为种子开播并持续智能续播（等价于私人 FM 的「智能续播」，
  // 但种子由用户自己选）。关闭对话再开播，避免弹窗挡住播放页。
  diag.querySelector('#siHeart').onclick = async () => {
    diag.open = false;
    await player.startHeart(meta);
  };

  // 账号维度写操作（T2，均带 confirm=1）：未绑定会 401，给出明确提示
  diag.querySelector('#siLike').onclick = async () => {
    // 旧版 /song/like 需要 uid；拿不到（未绑定）就走新版 /like/v1
    let uid = 0;
    try { const b = await api.bindStatus(); uid = (b.profile && b.profile.uid) || 0; } catch { /* 未绑定 */ }
    try {
      if (uid) await api.ncm('/song/like', { id: sid, like: true, uid, confirm: 1 });
      else await api.ncm('/like/v1', { id: sid, like: true, confirm: 1 });
      toast('已同步红心到网易云');
    } catch (e) { toast(e.message.includes('绑定') || /401/.test(e.message) ? '需先绑定网易云账号' : e.message); }
  };
  diag.querySelector('#siShare').onclick = async () => {
    const msg = prompt('分享到网易云动态（可写一句话，留空则只分享歌曲）', '');
    if (msg == null) return;
    try {
      await api.ncm('/share/resource', { id: sid, type: 'song', msg: msg || '', confirm: 1 });
      toast('已分享到网易云动态');
    } catch (e) { toast(e.message.includes('绑定') || /401/.test(e.message) ? '需先绑定网易云账号' : e.message); }
  };

  // 并行取数：任一失败只影响自己的分区（不整页报错）
  const [ql, cho, red, cre, wiki, simi, sheet, cinfo, cpr, wikiSum, dynCover, simi2, vec] = await Promise.allSettled([
    api.songQualities(sid),
    api.songChorus(sid),
    api.ncm('/song/red/count', { ids: sid }),
    api.ncm('/song/creators', { id: sid }),
    api.ncm('/song/wiki/info', { id: sid }),
    api.ncm('/song/simi/get', { id: sid }),
    api.ncm('/sheet/list', { id: sid }),
    api.ncm('/comment/info/list', { id: sid, type: 0 }),
    api.songVersions(sid),
    api.ncm('/song/wiki/summary', { id: sid }),
    api.ncm('/song/dynamic/cover', { id: sid }),
    // /simi/song 与 /song/simi/get 是两个不同维度的「相似」来源，合并去重后一起展示
    api.ncm('/simi/song', { id: sid, limit: 10, offset: 0 }),
    // 歌曲向量（相似度模型）
    api.ncm('/playmode/song/vector', { ids: String(sid) }),
  ]);

  const parts = [];

  parts.push(sec('音质档位', ql.status === 'fulfilled' ? qualityHTML(ql.value) : empty('音质资料暂时不可用，请稍后重试')));

  // 每个副歌段落都可选择；未播放此曲时先加载目标音频。
  if (cho.status === 'fulfilled') {
    const list = cho.value.segments || [];
    parts.push(sec('副歌时间', list.length ? list.map(c =>
      `<div class="cm-si-row"><b>${fmtTime(c.startMs)} – ${fmtTime(c.endMs)}</b>
        <mdui-button variant="text" class="cm-si-chorus" data-t="${c.startMs}">播放副歌</mdui-button></div>`
    ).join('') : empty('未识别到副歌段落')));
  } else parts.push(sec('副歌时间', empty('副歌信息暂时不可用，请稍后重试')));

  if (red.status === 'fulfilled') {
    const d = red.value.data || {};
    parts.push(sec('红心数量', `<div class="cm-si-row"><b>${d.count ?? 0}</b><span>${esc(d.countDesc || '人')}</span></div>`));
  }

  if (cre.status === 'fulfilled') {
    const vos = ((cre.value.data || {}).songCreatorsRoleVos) || [];
    const rows = vos.flatMap(v => (v.songCreators || []).map(p => ({ role: v.roleName || v.titleName || '', name: p.name || p.nickname || '' })))
      .filter(x => x.name);
    parts.push(sec('创作者', rows.length
      ? rows.map(x => `<div class="cm-si-row"><b>${esc(x.name)}</b><span>${esc(x.role)}</span></div>`).join('')
      : empty('暂无创作者信息')));
  }

  // 百科：blocks 里挑出正文文本（结构随上游变化，做容错提取）
  if (wiki.status === 'fulfilled') {
    const blocks = ((wiki.value.data || {}).blocks) || [];
    const texts = [];
    const walk = o => {
      if (!o) return;
      if (typeof o === 'string') { if (o.trim().length > 1) texts.push(o); return; }
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (typeof o === 'object') {
        if (typeof o.text === 'string') texts.push(o.text);
        else if (typeof o.title === 'string') texts.push(o.title);
        Object.values(o).forEach(walk);
      }
    };
    blocks.forEach(walk);
    const uniq = [...new Set(texts)].filter(t => !/^https?:/.test(t)).slice(0, 6);
    if (uniq.length) {
      parts.push(sec('音乐百科', `<div class="cm-si-wiki">${uniq.map(t => `<p>${esc(t)}</p>`).join('')}</div>`));
    } else if (wikiSum.status === 'fulfilled') {
      const texts2 = [];
      const walk2 = o => {
        if (!o) return;
        if (typeof o === 'string') { if (o.trim().length > 1) texts2.push(o); return; }
        if (Array.isArray(o)) { o.forEach(walk2); return; }
        if (typeof o === 'object') { if (typeof o.text === 'string') texts2.push(o.text); else Object.values(o).forEach(walk2); }
      };
      walk2(((wikiSum.value.data || {}).blocks) || []);
      const u2 = [...new Set(texts2)].filter(t => !/^https?:/.test(t)).slice(0, 4);
      parts.push(sec('音乐百科', u2.length
        ? `<div class="cm-si-wiki">${u2.map(t => `<p>${esc(t)}</p>`).join('')}</div>`
        : empty('暂无百科信息')));
    } else {
      parts.push(sec('音乐百科', empty('暂无百科信息')));
    }
  }

  // 动态封面（部分歌曲有）：是短视频封面，图片列表里给了就展示预览图
  if (dynCover.status === 'fulfilled') {
    const arr = dynCover.value.data || [];
    const img = Array.isArray(arr) && arr.length
      ? (arr[0].url || arr[0].imageUrl || (arr[0].images && arr[0].images[0])) : null;
    if (img) parts.push(sec('动态封面', `<div class="cm-si-sheet-imgs"><img src="${esc(String(img).replace(/^http:/, 'https:'))}" loading="lazy" alt="动态封面"></div>`));
  }

  let sheetVos = [];
  let altSongs = [];
  if (sheet.status === 'fulfilled') {
    sheetVos = ((sheet.value.data || {}).musicSheetSimpleInfoVOS) || [];
    parts.push(sec('乐谱', sheetVos.length
      ? sheetVos.slice(0, 6).map((s2, i) => `<div class="cm-si-row cm-si-sheet" data-sheet="${i}">
          <b>${esc(s2.name || '乐谱')}</b><span>${esc(s2.difficulty || '')} · 查看谱面 <span class="material-icons-outlined" style="font-size:calc(14px * var(--cm-fs, 1));vertical-align:-2px">chevron_right</span></span>
        </div>`).join('')
      : empty('暂无乐谱')));
  }

  // 上游 rcmd 才是推荐版本，原曲不会再次作为替代项显示。
  if (cpr.status === 'fulfilled') {
    altSongs = cpr.value.songs || [];
    parts.push(sec('其他版本', altSongs.length ? `<div class="cm-si-simi" id="siAlt">${altSongs.map((alt, i) =>
      `<button type="button" class="cm-si-simi-i cm-si-version" data-i="${i}">
        ${alt.pic ? `<img src="${esc(alt.pic)}?param=80y80" loading="lazy" alt="">` : ''}
        <div><div class="cm-si-simi-n">${esc(alt.name)}</div><div class="cm-si-simi-a">${esc(alt.artists)} · ${esc(alt.album)}</div></div>
      </button>`).join('')}</div><div class="cm-si-empty">选择其他版本将播放该版本，实际可用性以播放结果为准。</div>`
      : empty('暂无其他版本推荐')));
  } else parts.push(sec('其他版本', empty('其他版本推荐暂时不可用，请稍后重试')));

  if (cinfo.status === 'fulfilled') {
    const d = ((cinfo.value.data || [])[0]) || {};
    parts.push(sec('评论统计', `<div class="cm-si-row"><b>${d.commentCount ?? 0}</b><span>${esc(d.commentCountDesc || '条评论')}</span></div>`));
  }

  // 歌曲向量（/playmode/song/vector）：上游用向量给出相似度分数，直接展示分数与曲目
  if (vec.status === 'fulfilled') {
    const raw = vec.value.data || vec.value;
    const items = Array.isArray(raw) ? raw : (raw.list || raw.vectors || []);
    if (items.length) {
      parts.push(sec('向量相似', `<div class="cm-si-simi">${items.slice(0, 6).map(x => `
        <div class="cm-si-simi-i"><div><div class="cm-si-simi-n">${esc(x.name || x.songName || `歌曲 ${x.id || x.songId || ''}`)}</div>
        <div class="cm-si-simi-a">${x.score !== undefined || x.similarity !== undefined
          ? `相似度 ${Number(x.score ?? x.similarity).toFixed(3)}` : ''}</div></div></div>`).join('')}</div>`));
    }
  }

  // 媒体地址仅在用户选择打开时使用，不通过 JSON 接口预取音频流。
  const stream302 = `${location.origin}/song/url/v1/302?id=${encodeURIComponent(sid)}&level=exhigh`;
  parts.push(sec('外部播放器', `<div class="cm-si-acts">
    <mdui-button variant="text" id="si302copy">复制音乐地址</mdui-button>
    <mdui-button variant="text" id="si302play">用系统播放器打开</mdui-button>
  </div>`));

  // 相似歌曲：可直接播放
  let simiSongs = [];
  {
    const seen = new Set([String(sid)]);
    const push = arr => arr.forEach(x => {
      const s2 = ncmSongs([x])[0];
      if (!s2 || seen.has(String(s2.ncm_id))) return;
      seen.add(String(s2.ncm_id));
      simiSongs.push(s2);
    });
    if (simi.status === 'fulfilled') {
      const list = (((simi.value.data || {}).commonResourceList) || []);
      push(list.map(x => x.song || x.creative || x));
    }
    if (simi2.status === 'fulfilled') push(simi2.value.songs || []);
    parts.push(sec('相似歌曲', simiSongs.length
      ? `<div class="cm-si-simi" id="siSimi">${simiSongs.slice(0, 8).map((s2, i) =>
          `<div class="cm-si-simi-i" data-i="${i}">
             <img src="${esc(s2.pic)}?param=80y80" loading="lazy" onerror="this.remove()">
             <div><div class="cm-si-simi-n">${esc(s2.name)}</div><div class="cm-si-simi-a">${esc(s2.artists)}</div></div>
           </div>`).join('')}</div>`
      : empty('暂无相似歌曲')));
  }

  // 账号维度接口（T1）：未登录/未绑定会 401，逐项静默跳过，不影响其它分区
  if (auth.token) {
    // 该曲是否已红心（上游账号维度）
    try {
      const lk = await api.ncm('/song/like/check', { ids: String(sid) });
      const arr = ((lk.data || {}).songs) || ((lk.data || {}).data) || [];
      const hit = Array.isArray(arr) && arr[0];
      if (hit) {
        const liked = !!(hit.liked || hit.like);
        parts.push(sec('网易云红心', `<div class="cm-si-row"><b>${liked ? '已红心' : '未红心'}</b><span>${liked ? '已同步到网易云' : ''}</span></div>`));
      }
    } catch { /* 未绑定 */ }
    // 回忆坐标：第一次听这首歌的记录
    try {
      const fc = await api.ncm('/music/first/listen/info', { songId: sid });
      const d = fc.data || {};
      const first = d.firstListenTime || d.firstListenDate || d.listenTime;
      if (first) parts.push(sec('回忆坐标', `<div class="cm-si-row"><b>${esc(String(first))}</b><span>第一次听这首歌</span></div>`));
    } catch { /* 无记录/未绑定 */ }
    // 该曲的歌词摘录（区别于「我的歌词本」全量列表）
    try {
      const mk = await api.ncm('/song/lyrics/mark', { id: sid });
      const arr = Array.isArray(mk.data) ? mk.data : ((mk.data || {}).data || []);
      if (Array.isArray(arr) && arr.length) {
        parts.push(sec('我的摘录', arr.slice(0, 4).map(m =>
          `<div class="cm-si-row"><b>${esc(m.lyric || m.content || '')}</b><span>${esc(m.nickname || '')}</span></div>`).join('')));
      }
    } catch { /* 未绑定 */ }
  }

  body.innerHTML = parts.join('') || empty('暂无详情');

  diag.querySelector('#si302copy').onclick = async () => {
    try { await navigator.clipboard.writeText(stream302); toast('已复制音乐地址'); }
    catch { toast('复制失败，请检查浏览器剪贴板权限'); }
  };
  diag.querySelector('#si302play').onclick = () => window.open(stream302, '_blank', 'noopener');

  diag.querySelectorAll('.cm-si-chorus').forEach(button => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const ms = Number(button.dataset.t);
        const ok = await seekSongChorus(meta, ms);
        toast(ok ? `已跳到副歌 ${fmtTime(ms)}` : '暂时无法跳转，请等待播放就绪后重试');
      } catch { toast('暂时无法跳转，请稍后重试'); }
      finally { button.disabled = false; }
    };
  });
  diag.querySelectorAll('#siSimi .cm-si-simi-i').forEach(el => {
    el.onclick = () => { player.playList(simiSongs, +el.dataset.i); diag.open = false; };
  });
  diag.querySelectorAll('#siAlt .cm-si-version').forEach(button => {
    button.onclick = () => { player.playList(altSongs, Number(button.dataset.i)); diag.open = false; };
  });
  // 乐谱：点开才拉谱面图片（/sheet/preview），避免打开抽屉就下载几十张图
  diag.querySelectorAll('.cm-si-sheet').forEach(el => {
    el.onclick = async () => {
      const s2 = sheetVos[+el.dataset.sheet];
      if (!s2) return;
      el.querySelector('span').innerHTML = '加载谱面中…';
      try {
        const d = await api.ncm('/sheet/preview', { id: s2.id });
        const pages = (Array.isArray(d.data) ? d.data : []).filter(p => p.url);
        if (!pages.length) { el.querySelector('span').textContent = '暂无谱面'; return; }
        el.insertAdjacentHTML('afterend',
          `<div class="cm-si-sheet-imgs">${pages.map(pg =>
            `<img src="${esc(String(pg.url).replace(/^http:/, 'https:'))}" loading="lazy" alt="谱面 ${pg.pageNumber || ''}">`).join('')}</div>`);
        el.querySelector('span').textContent = `${pages.length} 页谱面`;
      } catch (e) { el.querySelector('span').textContent = '谱面加载失败'; }
    };
  });
}
