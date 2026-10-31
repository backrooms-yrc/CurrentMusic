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
    <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">podcasts</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看播客与私人 FM'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }

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
    const fallback = {
      modes: [
        { code: 'DEFAULT', title: '默认模式', subtitle: '沿着目前喜好继续聆听' },
        { code: 'FAMILIAR', title: '熟悉模式', subtitle: '喜欢过的歌曲与相似推荐' },
        { code: 'EXPLORE', title: '探索模式', subtitle: '偏好曲风与潜力好歌' },
        { code: 'PUZZLE_MODE_RCMD', title: '拼图模式', subtitle: '边听歌边拼歌曲封面' },
      ],
      scenes: [
        { code: 'NIGHT_EMO', title: '伤感' }, { code: 'EXERCISE', title: '运动' },
        { code: 'SLEEP_HELP', title: '助眠' }, { code: 'RELAX', title: '放松' },
        { code: 'FOCUS', title: '专注' }, { code: 'COMMUTE', title: '出行' },
      ],
    };
    let catalog = fallback;
    try { catalog = await api.roamingCatalog(); } catch { /* 使用内置目录兜底 */ }
    const modes = (catalog.modes && catalog.modes.length ? catalog.modes : fallback.modes)
      .map(x => ({ ...x, key: `mode:${x.code}`, scene: false }));
    const scenes = (catalog.scenes && catalog.scenes.length ? catalog.scenes : fallback.scenes)
      .map(x => ({ ...x, key: `scene:${x.code}`, scene: true }));
    const choices = modes.concat(scenes);
    let choice = choices.find(x => x.key === sessionStorage.getItem('cm.roamChoice')) || choices[0];
    let songs = [], seen = new Set(), loading = false;

    body.innerHTML = `
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>私人漫游</h2><span class="cm-sec-sub" id="roamNow">${esc(choice.title)}</span></div>
        <div class="cm-pe-hint">按你的喜好连续推荐；切换模式会重新开始。</div>
        <div class="cm-chips" id="roamModes">${modes.map(x =>
          `<span class="cm-hot${x.key === choice.key ? ' on' : ''}" data-roam="${x.key}" title="${esc(x.subtitle || '')}">${esc(x.title)}</span>`).join('')}</div>
        <div class="cm-detail-sub" style="margin-top:14px">场景模式</div>
        <div class="cm-chips" id="roamScenes">${scenes.map(x =>
          `<span class="cm-hot${x.key === choice.key ? ' on' : ''}" data-roam="${x.key}">${esc(x.title)}</span>`).join('')}</div>
        <div id="roamList" style="margin-top:14px"></div>
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="roamPlay">播放全部</mdui-button>
          <mdui-button variant="tonal" id="roamReload">换一批</mdui-button>
        </div>
        <div class="cm-pe-hint" id="roamHint"></div>
      </section>`;

    const hint = body.querySelector('#roamHint');
    const list = body.querySelector('#roamList');
    const paint = () => {
      body.querySelectorAll('[data-roam]').forEach(el => el.classList.toggle('on', el.dataset.roam === choice.key));
      const now = body.querySelector('#roamNow');
      if (now) now.textContent = choice.title;
    };
    const paintSongs = () => {
      if (!songs.length) {
        list.innerHTML = '<div class="cm-empty small">这个模式暂时没有推荐，换一批或切换模式试试</div>';
        return;
      }
      list.innerHTML = songs.map((s, i) => `
        <div class="cm-lm-item" data-i="${i}">
          <div class="cm-lm-lyric">${esc(s.name)}</div>
          <div class="cm-lm-meta"><span>${esc(s.artists || '')}${s.album ? ' · ' + esc(s.album) : ''}</span>
            <span><i class="cm-si-act" data-trash="${s.ncm_id}">不喜欢</i></span></div>
        </div>`).join('');
      list.querySelectorAll('[data-i]').forEach(el => {
        el.onclick = ev => { if (!ev.target.closest('[data-trash]')) player.playList(songs, +el.dataset.i); };
      });
      list.querySelectorAll('[data-trash]').forEach(el => {
        el.onclick = () => confirmDialog({
          title: '不喜欢这首歌？', body: '会从网易云私人漫游推荐中移除。',
          onOk: async () => {
            try {
              await api.roamingTrash(el.dataset.trash);
              songs = songs.filter(x => String(x.ncm_id) !== String(el.dataset.trash));
              paintSongs();
              toast('已从漫游推荐中移除');
            } catch (e) { toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message); }
          },
        });
      });
    };
    const load = async (reset = true) => {
      if (loading || !choice) return;
      loading = true;
      hint.textContent = '正在获取推荐…';
      try {
        const d = await api.roamingSongs(choice.scene ? 'SCENE_RCMD' : choice.code,
          choice.scene ? choice.code : '', 20, reset ? [] : [...seen]);
        const fresh = d.songs || [];
        if (reset) { songs = fresh; seen = new Set(songs.map(x => x.ncm_id)); }
        else { songs = songs.concat(fresh); fresh.forEach(x => seen.add(x.ncm_id)); }
        sessionStorage.setItem('cm.roamChoice', choice.key);
        paint();
        paintSongs();
        hint.textContent = fresh.length ? `已加载 ${fresh.length} 首` : '暂时没有新的推荐，可换一批或切换模式';
      } catch (e) {
        if (reset) { songs = []; paintSongs(); }
        hint.textContent = /绑定|401/.test(e.message || '') ? '请先绑定网易云账号' : `获取推荐失败：${e.message}`;
      } finally { loading = false; }
    };

    body.querySelectorAll('[data-roam]').forEach(el => {
      el.onclick = () => {
        if (loading) return;
        choice = choices.find(x => x.key === el.dataset.roam) || choice;
        paint();
        load(true);
      };
    });
    body.querySelector('#roamPlay').onclick = () => songs.length ? player.playList(songs, 0) : toast('暂无推荐');
    body.querySelector('#roamReload').onclick = () => load(false);
    await load(true);
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
