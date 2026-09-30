// 播客、广播与私人 FM / 场景（阶段五新增）
// 播客：/voicelist/my/created（我的播客）、/voicelist/detail、/voicelist/list（节目单）、
//      /voicelist/search、/voicelist/list/search、/program/recommend、
//      /voice/detail、/voice/lyric、/voice/upload（T2，走网关的 multipart 白名单）、
//      /voice/delete（T2）、/voicelist/trans（T2）
// 广播：/broadcast/category/region/get、/broadcast/channel/list、/broadcast/channel/currentinfo、
//      /broadcast/channel/collect/list（T1）、/broadcast/sub（T2）
// 私人 FM 与场景：/personal_fm、/personal/fm/mode、/fm_trash（T2）、
//      /aidj/content/rcmd、/playmode/intelligence/list、/radio/sport/get
import { api, auth, ncmSongs } from '../api.js';
import { esc, toast, fmtCount, skelGrid, confirmDialog, promptDialog } from '../ui.js';
import { player } from '../player.js';

const KEY = 'cm.podTab';

function needBind(el, text = '播客与私人 FM 跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:44px">podcasts</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看播客与私人 FM'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'fm';
  const TABS = [
    { k: 'fm', l: '私人 FM' },
    { k: 'podcast', l: '我的播客' },
    { k: 'find', l: '发现播客' },
    { k: 'broadcast', l: '广播电台' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="podTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="podBody">${skelGrid(4)}</div>`;
  el.querySelectorAll('#podTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#podBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  if (tab === 'fm') {
    body.innerHTML = skelGrid(4);
    // 私人 FM（/personal_fm）与「场景/心情」推荐（/aidj/content/rcmd）都是账号态读；
    // 播放模式智能列表（/playmode/intelligence/list）按当前曲目给出续播推荐。
    const [fmR, modeR, aidjR, sportR] = await Promise.allSettled([
      api.ncm('/personal_fm'),
      api.ncm('/personal/fm/mode', { mode: 'Standard', submode: 'NORMAL', limit: 1 }),
      api.ncm('/aidj/content/rcmd', { latitude: 39.90, longitude: 116.40 }),
      api.ncm('/radio/sport/get', { bpm: 120 }),
    ]);
    const songs = fmR.status === 'fulfilled' ? ncmSongs(fmR.value.data || []) : [];
    const mode = modeR.status === 'fulfilled' ? (modeR.value.data || {}) : {};
    const aidj = aidjR.status === 'fulfilled' ? (aidjR.value.data || []) : [];
    const sport = sportR.status === 'fulfilled' ? (sportR.value.data || []) : [];

    body.innerHTML = `
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>私人 FM</h2><span class="cm-sec-sub">/personal_fm</span></div>
        ${songs.length ? `<div id="fmList"></div>
          <div class="cm-pe-acts">
            <mdui-button variant="filled" id="fmPlay">播放全部</mdui-button>
            <mdui-button variant="tonal" id="fmReload">换一批</mdui-button>
          </div>` : '<div class="cm-empty small">上游没有返回私人 FM 内容</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>FM 模式</h2><span class="cm-sec-sub">/personal/fm/mode</span></div>
        <div class="cm-chips">${['Standard', 'FAMILIAR', 'EXPLORE', 'SCENE_RCMD'].map(m =>
          `<span class="cm-hot" data-mode="${m}">${m}</span>`).join('')}</div>
        <div class="cm-pe-hint" id="fmModeHint">${mode.mode ? `当前：${esc(mode.mode)} / ${esc(mode.submode || '')}` : '点上面的模式切换（上游返回为空表示该模式无内容）'}</div>
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>心动模式（智能续播）</h2><span class="cm-sec-sub">/playmode/intelligence/list</span></div>
        <div class="cm-pe-hint">心动模式 = 以「我喜欢的音乐」为池、以种子曲目起播，持续智能续播：
          点下面任一首即以此开播，队列快见底会自动续上；播放页的 ✨ 开关可随时关闭。</div>
        <div id="fmIntel"><div class="cm-empty small">${songs.length
          ? '按第一首私人 FM 曲目取续播推荐…'
          : '绑定网易云账号后可用（心动模式走账号态推荐）'}</div></div>
        ${songs.length ? `<div class="cm-pe-acts">
          <mdui-button variant="filled" id="fmHeart">以这首开启心动模式</mdui-button>
        </div>` : ''}
      </section>
      ${aidj.length ? `<section class="cm-sec">
        <div class="cm-sec-head"><h2>场景推荐</h2><span class="cm-sec-sub">/aidj/content/rcmd</span></div>
        <div class="cm-plgrid">${aidj.slice(0, 9).map(x => `
          <div class="cm-plcard" ${x.id ? `data-pid="${x.id}"` : ''}>
            <div class="cm-plcover">${x.picUrl ? `<img src="${esc(x.picUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">explore</span></div>
            <div class="cm-plname">${esc(x.name || '')}</div>
          </div>`).join('')}</div>
      </section>` : ''}
      ${sport.length ? `<section class="cm-sec">
        <div class="cm-sec-head"><h2>运动电台（按 BPM 120）</h2><span class="cm-sec-sub">/radio/sport/get</span></div>
        <div id="sportBox"></div>
      </section>` : ''}`;

    if (songs.length) {
      const list = body.querySelector('#fmList');
      list.innerHTML = songs.slice(0, 20).map((s, i) => `
        <div class="cm-lm-item" data-i="${i}">
          <div class="cm-lm-lyric">${esc(s.name)}</div>
          <div class="cm-lm-meta"><span>${esc(s.artists)}</span>
            <span><i class="cm-si-act" data-trash="${s.ncm_id}">不喜欢</i></span></div>
        </div>`).join('');
      list.querySelectorAll('[data-i]').forEach(x => {
        x.onclick = ev => { if (!ev.target.closest('[data-trash]')) player.playList(songs, +x.dataset.i); };
      });
      list.querySelectorAll('[data-trash]').forEach(x => {
        x.onclick = () => confirmDialog({
          title: '把这首歌丢进垃圾桶？', body: '网易云会减少推荐同类歌曲。',
          onOk: () => api.ncm('/fm_trash', { id: x.dataset.trash, time: Date.now(), confirm: 1 })
            .then(() => { toast('已丢进垃圾桶'); render(el, { tab: 'fm' }); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      });
      body.querySelector('#fmPlay').onclick = () => player.playList(songs, 0);
      body.querySelector('#fmReload').onclick = () => render(el, { tab: 'fm' });
    }
    body.querySelectorAll('[data-mode]').forEach(c => {
      c.onclick = async () => {
        const hint = body.querySelector('#fmModeHint');
        hint.textContent = '切换中…';
        try {
          const d = await api.ncm('/personal/fm/mode', { mode: c.dataset.mode, submode: 'NORMAL', limit: 20 });
          const list = ncmSongs((d.data && (d.data.songs || d.data)) || []);
          hint.textContent = list.length ? `已切到 ${c.dataset.mode}，${list.length} 首` : `${c.dataset.mode} 暂无内容`;
          if (list.length) {
            const box = body.querySelector('#fmList');
            if (box) {
              box.innerHTML = list.slice(0, 20).map((s, i) => `
                <div class="cm-lm-item" data-i="${i}"><div class="cm-lm-lyric">${esc(s.name)}</div>
                <div class="cm-lm-meta"><span>${esc(s.artists)}</span></div></div>`).join('');
              box.querySelectorAll('[data-i]').forEach(x => { x.onclick = () => player.playList(list, +x.dataset.i); });
            }
          }
        } catch (e) { hint.textContent = `切换失败：${e.message}`; }
      };
    });
    // 智能续播：以第一首私人 FM 曲目为种子（上游要 id + sid，pid 可空）
    if (songs.length) {
      // 复用播放器的心动模式取数：上游只认「我喜欢的音乐」歌单（pid 必填）且
      // 歌曲包在 songInfo 里，这两点都由 player.heartList 统一处理。
      player.heartList(songs[0].ncm_id, 8).then(list => {
        const box = body.querySelector('#fmIntel');
        if (!box) return;
        box.innerHTML = list.length
          ? `<div class="cm-chips">${list.map((x, i) => `<span class="cm-hot" data-intel="${i}">${esc(x.name)}</span>`).join('')}</div>`
          : '<div class="cm-empty small">上游没有返回续播推荐</div>';
        box.querySelectorAll('[data-intel]').forEach(c => {
          c.onclick = () => player.startHeart(list[+c.dataset.intel]);
        });
        const hb = body.querySelector('#fmHeart');
        if (hb) hb.onclick = () => player.startHeart(songs[0]);
      }).catch(e => {
        const box = body.querySelector('#fmIntel');
        if (box) {
          box.textContent = /绑定/.test(e.message || '')
            ? '绑定网易云账号后可用（心动模式走账号态推荐）'
            : `续播推荐加载失败：${e.message}`;
        }
      });
    }
    if (sport.length) {
      const sportSongs = ncmSongs(sport);
      const box = body.querySelector('#sportBox');
      box.innerHTML = sportSongs.slice(0, 10).map((s, i) => `
        <div class="cm-lm-item" data-i="${i}"><div class="cm-lm-lyric">${esc(s.name)}</div>
        <div class="cm-lm-meta"><span>${esc(s.artists)}</span></div></div>`).join('');
      box.querySelectorAll('[data-i]').forEach(x => { x.onclick = () => player.playList(sportSongs, +x.dataset.i); });
    }
    void uid;
    return;
  }

  if (tab === 'podcast') {
    body.innerHTML = skelGrid(4);
    let mine = [];
    try {
      const d = await api.ncm('/voicelist/my/created', { limit: 50 });
      mine = d.data || d.voiceLists || [];
    } catch (e) { fail(e); return; }
    if (!mine.length) {
      body.innerHTML = `<div class="cm-empty small">你还没有创建播客<br>
        <span class="cm-empty-sub">在上游 App 创建后会出现在这里（本页只读你自己的播客：上游对 /voicelist/* 限定 owner）</span></div>`;
      return;
    }
    let cur = mine[0];
    body.innerHTML = `
      <div class="cm-plsort"><span class="cm-plsort-l">播客</span>
        ${mine.slice(0, 20).map(v => `<mdui-chip ${v.id === cur.id ? 'selected' : ''} data-v="${v.id}">${esc(v.name || '未命名')}</mdui-chip>`).join('')}</div>
      <div id="vlBox"></div>
      <div class="cm-pe-acts">
        <mdui-button variant="tonal" id="vlUpload">上传声音</mdui-button>
        <input type="file" id="vlFile" accept="audio/*" hidden>
      </div>
      <div class="cm-pe-hint" id="vlHint">声音上传走网关的 multipart 白名单（/voice/upload，字段 songFile）</div>`;
    const draw = async () => {
      const box = body.querySelector('#vlBox');
      box.innerHTML = '<div class="cm-loading" style="padding:16px 0"><mdui-circular-progress></mdui-circular-progress></div>';
      const [detR, listR] = await Promise.allSettled([
        api.ncm('/voicelist/detail', { id: cur.id }),
        api.ncm('/voicelist/list', { voiceListId: cur.id, limit: 30, offset: 0 }),
      ]);
      const det = detR.status === 'fulfilled' ? (detR.value.data || {}) : {};
      const voices = listR.status === 'fulfilled' ? (listR.value.data || []) : [];
      box.innerHTML = `
        <section class="cm-sec">
          <div class="cm-sec-head"><h2>${esc(det.name || cur.name || '我的播客')}</h2>
            <span class="cm-sec-sub">/voicelist/detail · /voicelist/list</span></div>
          <div class="cm-detail-sub">${esc(det.description || '')}${det.voiceCount ? ` · ${det.voiceCount} 期` : ''}</div>
          ${voices.length ? voices.map(v => `
            <div class="cm-lm-item" data-vid="${v.id || v.voiceId || ''}">
              <div class="cm-lm-lyric">${esc(v.name || v.title || '')}</div>
              <div class="cm-lm-meta"><span>${v.duration ? `${Math.round(v.duration / 1000)} 秒` : ''}</span>
              <span><i class="cm-si-act" data-vdetail="1">详情</i><i class="cm-si-act" data-vlyric="1">歌词</i><i class="cm-si-act" data-trans="1">转文字</i><i class="cm-si-act" data-vdel="1">删除</i></span></div>
            </div>`).join('') : '<div class="cm-empty small">该播客还没有声音</div>'}
        </section>`;
      box.querySelectorAll('[data-vdetail]').forEach(x => {
        x.onclick = async () => {
          const vid = x.closest('[data-vid]').dataset.vid;
          try {
            const d = await api.ncm('/voice/detail', { id: vid });
            toast(d.data ? `详情已获取（${(d.data.name || '')}）` : (d.message || '上游未返回详情'));
          } catch (e) { toast(e.message); }
        };
      });
      box.querySelectorAll('[data-vlyric]').forEach(x => {
        x.onclick = async () => {
          const vid = x.closest('[data-vid]').dataset.vid;
          try {
            const d = await api.ncm('/voice/lyric', { id: vid });
            const lrc = (d.data && (d.data.lyric || d.data.lrc)) || '';
            toast(lrc ? lrc.split('\n').slice(0, 2).join(' / ') : (d.msg || d.message || '上游未返回歌词'));
          } catch (e) { toast(e.message); }
        };
      });
      box.querySelectorAll('[data-trans]').forEach(x => {
        x.onclick = () => {
          const vid = x.closest('[data-vid]').dataset.vid;
          confirmDialog({
            title: '把这个声音转成文字？', body: '会在网易云侧生成文字稿。',
            onOk: () => api.ncm('/voicelist/trans', { programId: vid, radioId: cur.id, limit: 100, offset: 0, position: 0, confirm: 1 })
              .then(() => toast('已提交转文字'))
              .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
          });
        };
      });
      box.querySelectorAll('[data-vdel]').forEach(x => {
        x.onclick = () => {
          const vid = x.closest('[data-vid]').dataset.vid;
          confirmDialog({
            title: '删除这个声音？', body: '删除后不可恢复。',
            onOk: () => api.ncm('/voice/delete', { ids: `[${vid}]`, confirm: 1 })
              .then(() => { toast('已删除'); draw(); })
              .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
          });
        };
      });
    };
    body.querySelectorAll('[data-v]').forEach(c => {
      c.onclick = () => {
        cur = mine.find(v => String(v.id) === c.dataset.v);
        body.querySelectorAll('[data-v]').forEach(x => x.toggleAttribute('selected', x === c));
        draw().catch(e => toast(e.message));
      };
    });
    body.querySelector('#vlUpload').onclick = () => body.querySelector('#vlFile').click();
    body.querySelector('#vlFile').onchange = async ev => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const hint = body.querySelector('#vlHint');
      hint.textContent = '上传中…';
      try {
        await api.ncmUpload('/voice/upload', {
          voiceListId: cur.id, songName: file.name.replace(/\.[^.]+$/, ''),
          categoryId: 0, secondCategoryId: 0, privacy: 0, publishTime: 0, orderNo: 0,
          autoPublish: false, composedSongs: '[]',
        }, file);
        hint.textContent = '上传完成';
        draw();
      } catch (e) {
        hint.textContent = `上传失败：${/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message}`;
      } finally { ev.target.value = ''; }
    };
    await draw();
    return;
  }

  if (tab === 'find') {
    body.innerHTML = `
      <div class="cm-search-bar"><mdui-text-field id="podKw" label="搜索播客（回车）" variant="outlined" clearable style="width:100%"></mdui-text-field></div>
      <div class="cm-sec-head"><h2>节目推荐</h2><span class="cm-sec-sub">/program/recommend</span></div>
      <div id="podRec">${skelGrid(4)}</div>
      <div class="cm-sec-head"><h2>搜索结果</h2><span class="cm-sec-sub">/voicelist/search · /voicelist/list/search</span></div>
      <div id="podRes"><div class="cm-empty small">输入关键词后回车</div></div>`;
    try {
      const d = await api.ncm('/program/recommend', { limit: 12, offset: 0, type: 0 });
      const programs = d.programs || [];
      const box = body.querySelector('#podRec');
      box.innerHTML = programs.length ? programs.map(p => {
        const s = p.mainSong || {};
        return `<div class="cm-plcard" data-pid="${p.id || ''}" data-sid="${s.id || ''}">
          <div class="cm-plcover">${(p.coverUrl || p.cover) ? `<img src="${esc(p.coverUrl || p.cover)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">mic</span></div>
          <div class="cm-plname">${esc(p.name || s.name || '')}</div>
          <div class="cm-plsub">${esc((s.ar || []).map(a => a.name).join(' / '))}</div>
        </div>`;
      }).join('') : '<div class="cm-empty small">上游未返回节目推荐</div>';
      box.querySelectorAll('.cm-plcard').forEach(c => {
        c.onclick = () => {
          if (!c.dataset.sid) return toast('该节目没有可播放音频');
          const songs = ncmSongs([{ id: Number(c.dataset.sid), name: c.querySelector('.cm-plname').textContent, ar: [] }]);
          if (songs.length) player.playList(songs, 0);
        };
      });
    } catch (e) {
      body.querySelector('#podRec').innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`;
    }
    body.querySelector('#podKw').addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const kw = body.querySelector('#podKw').value.trim();
      if (!kw) return;
      const box = body.querySelector('#podRes');
      box.innerHTML = '<div class="cm-loading" style="padding:12px 0"><mdui-circular-progress></mdui-circular-progress></div>';
      const [byKw, byName] = await Promise.allSettled([
        api.ncm('/voicelist/search', { keyword: kw, limit: 20, offset: 0 }),
        api.ncm('/voicelist/list/search', { name: kw, limit: 20, offset: 0, type: 0, displayStatus: 0, voiceFeeType: 0, voiceListId: 0 }),
      ]);
      const a = byKw.status === 'fulfilled' ? (((byKw.value.data || {}).resources) || []) : [];
      const b = byName.status === 'fulfilled' ? ((byName.value.data || []) ) : [];
      const rows = a.map(r => ({
        id: r.resourceId,
        name: ((r.uiElement || {}).mainTitle || {}).title || r.name || '',
        sub: ((r.uiElement || {}).subTitle || {}).title || '',
      })).concat((Array.isArray(b) ? b : []).map(x => ({ id: x.id || x.voiceListId, name: x.name || '', sub: x.description || '' })));
      box.innerHTML = rows.length ? rows.map(r => `
        <div class="cm-pe-row"><span>${esc(r.name)} <i>${esc(r.sub)}</i></span>
        ${r.id ? `<span class="cm-si-act" data-open="${r.id}">打开</span>` : ''}</div>`).join('')
        : '<div class="cm-empty small">没有找到相关播客</div>';
      box.querySelectorAll('[data-open]').forEach(x => {
        x.onclick = () => toast('播客详情限定 owner（上游 /voicelist/detail 只允许操作自己的播客），可在「我的播客」里查看');
      });
    });
    return;
  }

  // 广播电台
  body.innerHTML = skelGrid(4);
  const [catR, listR, collectR] = await Promise.allSettled([
    api.ncm('/broadcast/category/region/get'),
    api.ncm('/broadcast/channel/list', { limit: 30 }),
    api.ncm('/broadcast/channel/collect/list', { limit: 30 }),
  ]);
  const cats = catR.status === 'fulfilled' ? (((catR.value.data || {}).categoryList) || []) : [];
  const regions = catR.status === 'fulfilled' ? (((catR.value.data || {}).regionList) || []) : [];
  const channels = listR.status === 'fulfilled' ? (((listR.value.data || {}).list) || []) : [];
  const collected = collectR.status === 'fulfilled' ? (((collectR.value.data || {}).list) || []) : [];
  let curCat = null;
  const drawChannels = list => {
    const box = body.querySelector('#bcList');
    if (!box) return;
    box.innerHTML = list.length ? `<div class="cm-plgrid">${list.map(c => `
      <div class="cm-plcard" data-cid="${c.id}">
        <div class="cm-plcover">${c.coverUrl ? `<img src="${esc(c.coverUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">radio</span></div>
        <div class="cm-plname">${esc(c.name)}</div>
        <div class="cm-plsub">${esc(c.regionName || '')}<i class="cm-si-act" data-bsub="${c.id}" data-on="${c.subed ? 1 : 0}">${c.subed ? '取消订阅' : '订阅'}</i></div>
      </div>`).join('')}</div>` : '<div class="cm-empty small">该条件下没有电台</div>';
    box.querySelectorAll('[data-bsub]').forEach(x => {
      x.onclick = ev => {
        ev.stopPropagation();
        const on = x.dataset.on === '1';
        confirmDialog({
          title: on ? '取消订阅该电台？' : '订阅该电台？', body: '',
          onOk: () => api.ncm('/broadcast/sub', { id: x.dataset.bsub, t: on ? 0 : 1, confirm: 1 })
            .then(() => { toast(on ? '已取消订阅' : '已订阅'); render(el, { tab: 'broadcast' }); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    box.querySelectorAll('[data-cid]').forEach(c => {
      c.onclick = async () => {
        try {
          const d = await api.ncm('/broadcast/channel/currentinfo', { id: c.dataset.cid });
          toast(d.data ? `正在播：${d.data.name || ''}` : (d.message || '该电台暂无在播信息'));
        } catch (e) { toast(e.message); }
      };
    });
  };
  body.innerHTML = `
    <div class="cm-plsort"><span class="cm-plsort-l">分类</span>
      <mdui-chip selected data-cat="">全部</mdui-chip>
      ${cats.slice(0, 12).map(c => `<mdui-chip data-cat="${c.id}">${esc(c.name)}</mdui-chip>`).join('')}</div>
    ${regions.length ? `<div class="cm-plsort"><span class="cm-plsort-l">地区</span>
      <mdui-chip selected data-reg="">全部</mdui-chip>
      ${regions.slice(0, 12).map(r => `<mdui-chip data-reg="${r.id}">${esc(r.name)}</mdui-chip>`).join('')}</div>` : ''}
    <div id="bcList"></div>
    ${collected.length ? `<section class="cm-sec">
      <div class="cm-sec-head"><h2>我收藏的电台</h2><span class="cm-sec-sub">/broadcast/channel/collect/list</span></div>
      <div class="cm-chips">${collected.slice(0, 20).map(c =>
        `<span class="cm-hot" data-cid2="${c.id}">${esc(c.name || '')}</span>`).join('')}</div>
    </section>` : ''}`;
  drawChannels(channels);
  const reload = async (catId, regionId) => {
    const box = body.querySelector('#bcList');
    box.innerHTML = '<div class="cm-loading" style="padding:14px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    try {
      const d = await api.ncm('/broadcast/channel/list', { limit: 30, categoryId: catId || '', regionId: regionId || '' });
      drawChannels(((d.data || {}).list) || []);
    } catch (e) { box.innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`; }
  };
  let regionId = null;
  body.querySelectorAll('[data-cat]').forEach(c => {
    c.onclick = () => {
      curCat = c.dataset.cat || null;
      body.querySelectorAll('[data-cat]').forEach(x => x.toggleAttribute('selected', x === c));
      reload(curCat, regionId);
    };
  });
  body.querySelectorAll('[data-reg]').forEach(c => {
    c.onclick = () => {
      regionId = c.dataset.reg || null;
      body.querySelectorAll('[data-reg]').forEach(x => x.toggleAttribute('selected', x === c));
      reload(curCat, regionId);
    };
  });
  body.querySelectorAll('[data-cid2]').forEach(x => {
    x.onclick = async () => {
      try {
        const d = await api.ncm('/broadcast/channel/currentinfo', { id: x.dataset.cid2 });
        toast(d.data ? `正在播：${d.data.name || ''}` : (d.message || '该电台暂无在播信息'));
      } catch (e) { toast(e.message); }
    };
  });
  void promptDialog;
  void fmtCount;
}
