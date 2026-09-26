// 房间页：房主控播 + 全员同步跟随 + 点歌审批 + 成员/权限管理
import { mdui } from '../md.js';
import { auth, settings } from '../api.js';
import { esc, toast, fmtDur, getStatus, renderSongList, avatarHTML } from '../ui.js';
import { roomApi, openEventStream, estimateClockOffset, RoomSync } from '../room.js';
import { player } from '../player.js';

let cleanup = null;   // 离开页面时清理（SSE/定时器/音频）

export async function render(el) {
  if (cleanup) { cleanup(); cleanup = null; }
  if (!auth.token) { el.innerHTML = '<div class="cm-empty">请先登录</div>'; return; }

  const roomId = +location.hash.split('/')[2];
  if (!roomId) { el.innerHTML = '<div class="cm-empty">房间不存在</div>'; return; }

  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
  let detail;
  try {
    detail = await roomApi.detail(roomId);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}<div style="margin-top:12px"><mdui-button href="#/rooms">返回广场</mdui-button></div></div>`;
    return;
  }

  // 进房即加入（已在房间内则幂等）
  let me = (detail.members || []).find(m => m.userId === (auth.user && auth.user.id));
  if (!me) {
    try {
      const j = await roomApi.join(roomId, '');
      me = { role: j.role, userId: auth.user.id };
      detail = await roomApi.detail(roomId);
    } catch (e) {
      el.innerHTML = `<div class="cm-empty">${esc(e.message)}<div style="margin-top:12px"><mdui-button href="#/rooms">返回广场</mdui-button></div></div>`;
      return;
    }
  }
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const isOwner = me.role === 'owner';

  // 房间音频（独立于本地播放器）
  const audio = new Audio();
  audio.preload = 'auto';
  audio.id = 'roomAudio';
  audio.style.display = 'none';
  document.body.appendChild(audio);   // 挂进 DOM 便于调试/媒体会话

  const sync = new RoomSync(audio, roomId);
  let latestSeq = detail.latestSeq || 0;

  // ---- 页面骨架 ----
  el.innerHTML = `
    <div class="cm-rtop">
      <div class="cm-rtop-main">
        <div class="cm-rname">${esc(detail.room.name)}
          ${detail.room.hasPassword ? '<span class="material-icons-outlined" style="font-size:15px">lock</span>' : ''}
          ${detail.room.freeMode ? '<span class="cm-tag">自由点歌</span>' : ''}
        </div>
        <div class="cm-rsub">
          <span>房间号 <b id="rCode">${detail.room.code}</b></span>
          <span id="rMembers">${(detail.members || []).length} 人在线</span>
          <span id="rSync" class="cm-rsync">同步中…</span>
        </div>
      </div>
      <div class="cm-rtop-acts">
        <span class="pl-btn" id="rShare" title="复制分享链接"><span class="material-icons-outlined">share</span></span>
        ${isOwner ? '<span class="pl-btn" id="rSettings" title="房间设置"><span class="material-icons-outlined">settings</span></span>' : ''}
        <span class="pl-btn" id="rLeave" title="离开房间"><span class="material-icons-outlined">logout</span></span>
      </div>
    </div>

    <div class="cm-rnow">
      <div class="cm-rnow-cover" id="rCover"><span class="material-icons-outlined">music_note</span></div>
      <div class="cm-rnow-main">
        <div class="cm-rnow-name" id="rTrackName">等待房主开始播放…</div>
        <div class="cm-rnow-artist" id="rTrackArtist"></div>
        <div class="cm-rnow-bar"><i id="rProg"></i></div>
        <div class="cm-rnow-time"><span id="rCur">0:00</span><span id="rDur">0:00</span></div>
      </div>
    </div>

    ${isAdmin ? `<div class="cm-rctrl">
      <span class="pl-btn big" id="rPrev"><span class="material-icons-outlined">skip_previous</span></span>
      <span class="pl-btn huge" id="rPlay"><span class="material-icons-outlined">play_circle</span></span>
      <span class="pl-btn big" id="rNext"><span class="material-icons-outlined">skip_next</span></span>
      <span class="cm-rctrl-tip">你是${isOwner ? '房主' : '管理员'}，可控制全房播放</span>
    </div>` : `<div class="cm-rctrl-follow"><span class="material-icons-outlined">headphones</span>已跟随房主播放</div>`}

    <div class="cm-sec-head"><h2>点歌</h2>
      <span class="cm-sec-more" id="rAddSong"><span class="material-icons-outlined">search</span> 搜索点歌</span></div>
    <div id="rQueue"></div>

    <div class="cm-sec-head"><h2>成员（<span id="rMemberCount">${(detail.members || []).length}</span>）</h2></div>
    <div class="cm-rmembers" id="rMemberList"></div>`;

  // ---- 渲染辅助 ----
  const renderMembers = (members) => {
    const box = el.querySelector('#rMemberList');
    el.querySelector('#rMemberCount').textContent = members.length;
    el.querySelector('#rMembers').textContent = `${members.length} 人在线`;
    box.innerHTML = members.map(m => `
      <div class="cm-rmember" data-uid="${m.userId}">
        ${m.avatar || m.avatarDecoration ? avatarHTML(m, 36) : `<span class="cm-rmember-ph">${esc((m.nickname || '?')[0])}</span>`}
        <div class="cm-rmember-main">
          <div class="cm-rmember-name">${esc(m.nickname || ('用户' + m.userId))}
            ${m.role === 'owner' ? '<span class="cm-tag admin">房主</span>' : m.role === 'admin' ? '<span class="cm-tag">管理员</span>' : ''}
            ${m.userId === (auth.user && auth.user.id) ? '<span class="cm-tag">我</span>' : ''}
          </div>
        </div>
        ${isAdmin && m.role !== 'owner' && m.userId !== (auth.user && auth.user.id)
          ? `<span class="cm-rmember-act" data-uid="${m.userId}" data-role="${m.role}"><span class="material-icons-outlined">more_vert</span></span>` : ''}
      </div>`).join('');
    box.querySelectorAll('.cm-rmember-act').forEach(a => {
      a.onclick = () => memberMenu(+a.dataset.uid, a.dataset.role);
    });
  };

  const memberMenu = (uid, role) => {
    const acts = [];
    if (isOwner) acts.push({ k: role === 'admin' ? 'unadmin' : 'admin', label: role === 'admin' ? '取消管理员' : '设为管理员', icon: 'verified_user' });
    if (isOwner) acts.push({ k: 'transfer', label: '转让房主', icon: 'swap_horiz' });
    acts.push({ k: 'kick', label: '移出房间', icon: 'person_remove' });
    acts.push({ k: 'ban', label: '移出并封禁', icon: 'block' });
    const diag = mdui.dialog({
      headline: '成员操作',
      body: `<div class="cm-qm">${acts.map(a => `<div class="cm-qm-item" data-k="${a.k}"><span class="material-icons-outlined">${a.icon}</span>${a.label}</div>`).join('')}</div>`,
      actions: [{ text: '取消' }],
    });
    setTimeout(() => {
      diag.querySelectorAll('.cm-qm-item').forEach(it => {
        it.onclick = async () => {
          diag.open = false;
          try {
            const k = it.dataset.k;
            if (k === 'kick') { await roomApi.kick(roomId, uid, false); toast('已移出'); }
            else if (k === 'ban') { await roomApi.kick(roomId, uid, true); toast('已移出并封禁'); }
            else if (k === 'admin') { await roomApi.setAdmin(roomId, uid, true); toast('已设为管理员'); }
            else if (k === 'unadmin') { await roomApi.setAdmin(roomId, uid, false); toast('已取消管理员'); }
            else if (k === 'transfer') { await roomApi.transfer(roomId, uid); toast('已转让房主'); }
            refresh();
          } catch (e) { toast(e.message); }
        };
      });
    }, 0);
  };

  const renderQueue = (queue) => {
    const box = el.querySelector('#rQueue');
    if (!queue.length) { box.innerHTML = '<div class="cm-empty small">队列是空的，点右上角搜索点歌</div>'; return; }
    box.innerHTML = `<div class="cm-songs">${queue.map(q => `
      <div class="cm-rq ${q.status === 'playing' ? 'playing' : ''}" data-qid="${q.id}">
        ${q.pic ? `<img class="cm-song-pic" src="${esc(q.pic)}" loading="lazy">` : `<div class="cm-song-pic ph"><span class="material-icons-outlined">music_note</span></div>`}
        <div class="cm-song-main">
          <div class="cm-song-name">${esc(q.name)}</div>
          <div class="cm-song-sub">
            <span>${esc(q.artists || '')}</span>
            <span class="cm-rq-from">${esc(q.requester || '')}${q.mine ? '（我）' : ''}</span>
            ${q.status === 'pending' ? '<span class="cm-tag">待审批</span>' : q.status === 'playing' ? '<span class="cm-tag admin">播放中</span>' : ''}
          </div>
        </div>
        ${isAdmin && q.status === 'pending' ? `
          <span class="cm-rq-btn ok" data-act="ok" data-qid="${q.id}"><span class="material-icons-outlined">check</span></span>
          <span class="cm-rq-btn no" data-act="no" data-qid="${q.id}"><span class="material-icons-outlined">close</span></span>` : ''}
        ${(q.mine || isAdmin) && q.status !== 'playing' ? `
          <span class="cm-rq-btn" data-act="del" data-qid="${q.id}"><span class="material-icons-outlined">delete_outline</span></span>` : ''}
      </div>`).join('')}</div>`;
    box.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const qid = +b.dataset.qid;
        try {
          if (b.dataset.act === 'ok') { await roomApi.approve(roomId, qid); toast('已采纳'); }
          else if (b.dataset.act === 'no') { await roomApi.reject(roomId, qid); toast('已驳回'); }
          else { await roomApi.removeItem(roomId, qid); toast('已移除'); }
          refresh();
        } catch (e) { toast(e.message); }
      };
    });
  };

  const renderNowPlaying = (tl) => {
    const meta = tl.trackMeta || {};
    const nameEl = el.querySelector('#rTrackName');
    const artEl = el.querySelector('#rTrackArtist');
    const coverEl = el.querySelector('#rCover');
    if (!tl.trackNcmId || !meta.name) {
      nameEl.textContent = '等待房主开始播放…';
      artEl.textContent = '';
      return;
    }
    if (nameEl.textContent !== meta.name) {
      nameEl.textContent = meta.name;
      artEl.textContent = meta.artists || '';
      coverEl.innerHTML = meta.pic ? `<img src="${esc(meta.pic)}" onerror="this.remove()">` : '<span class="material-icons-outlined">music_note</span>';
    }
    const playBtn2 = el.querySelector('#rPlay');
    if (playBtn2) playBtn2.innerHTML = `<span class="material-icons-outlined">${tl.playing ? 'pause_circle' : 'play_circle'}</span>`;
  };

  const refresh = async () => {
    try {
      const d = await roomApi.detail(roomId);
      renderMembers(d.members || []);
      renderQueue(d.queue || []);
      renderNowPlaying(d.timeline);
      sync.setTimeline(d.timeline);
      if (d.timeline.trackNcmId && String(audio.dataset.ncmId) !== String(d.timeline.trackNcmId)) {
        sync.applyTrack(d.timeline);
      }
      latestSeq = Math.max(latestSeq, d.latestSeq || 0);
    } catch (e) { /* 忽略瞬时错误 */ }
  };

  // ---- 时钟同步 + 事件流 ----
  const clock = await estimateClockOffset(roomId, 5);
  sync.offset = clock.offset;
  sync.onStatus = ({ drift, position, duration }) => {
    const box = el.querySelector('#rSync');
    if (box) {
      const ms = Math.abs(drift);
      box.textContent = ms < 300 ? `同步良好（${drift > 0 ? '+' : ''}${drift}ms）` : `校准中（${drift > 0 ? '+' : ''}${drift}ms）`;
      box.className = 'cm-rsync' + (ms < 300 ? ' ok' : '');
    }
    const prog = el.querySelector('#rProg');
    if (prog && duration) prog.style.width = Math.min(100, (position / duration) * 100) + '%';
    const cur = el.querySelector('#rCur');
    if (cur) cur.textContent = fmtDur(position);
    const dur = el.querySelector('#rDur');
    if (dur) dur.textContent = fmtDur(duration);
  };

  sync.applyTrack(detail.timeline);
  sync.start();

  let stream;
  const applyTimeline = (tl) => {
    sync.setTimeline(tl);
    renderNowPlaying(tl);
    // 换歌：立即对齐
    if (tl.trackNcmId && String(audio.dataset.ncmId) !== String(tl.trackNcmId)) {
      sync.applyTrack(tl);
    }
  };

  stream = openEventStream(roomId, latestSeq, {
    onEvent: (type, payload) => {
      if (payload && payload.seq) latestSeq = Math.max(latestSeq, payload.seq);
      const p = (payload && payload.payload) || payload || {};
      if (p.timeline) applyTimeline(p.timeline);
      if (['join', 'leave', 'role', 'kick', 'transfer'].includes(type)) {
        if (type === 'close') { toast('房间已关闭'); location.hash = '#/rooms'; return; }
        refresh();
      }
      if (type === 'queue') refresh();
      if (type === 'settings') refresh();
      if (type === 'kick' && p.userId === (auth.user && auth.user.id)) {
        toast('你已被移出房间');
        location.hash = '#/rooms';
      }
    },
    onOpen: () => { el.querySelector('#rSync').textContent = '已连接'; },
    onError: () => { /* 由 EventSource 自动重连；原生桥会在 App 侧重连 */ },
  });

  const hb = setInterval(() => { roomApi.heartbeat(roomId).catch(() => {}); }, 15000);

  // ---- 交互 ----
  el.querySelector('#rLeave').onclick = async () => {
    try { await roomApi.leave(roomId); } catch { /* 忽略 */ }
    location.hash = '#/rooms';
  };
  el.querySelector('#rShare').onclick = async () => {
    const link = `${location.origin}${location.pathname}#/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(`来一起听歌！房间号 ${detail.room.code} ${link}`);
      toast('分享链接已复制');
    } catch { toast(`房间号：${detail.room.code}`); }
  };
  const playBtn = el.querySelector('#rPlay');
  if (playBtn) {
    playBtn.onclick = async () => {
      try {
        const tl = sync.timeline || {};
        if (tl.playing) await roomApi.pause(roomId);
        else await roomApi.play(roomId, Math.round((audio.currentTime || 0) * 1000));
        refresh();
      } catch (e) { toast(e.message); }
    };
    el.querySelector('#rNext').onclick = async () => { try { await roomApi.next(roomId); refresh(); } catch (e) { toast(e.message); } };
    el.querySelector('#rPrev').onclick = async () => { try { await roomApi.prev(roomId); refresh(); } catch (e) { toast(e.message); } };
  }
  const setBtn = el.querySelector('#rSettings');
  if (setBtn) setBtn.onclick = () => settingsDialog(roomId, detail.room, refresh);

  el.querySelector('#rAddSong').onclick = () => songPicker(roomId, refresh);
  renderMembers(detail.members || []);
  renderQueue(detail.queue || []);
  renderNowPlaying(detail.timeline);
  refresh();   // 首屏后主动拉一次（不依赖 SSE 首帧）

  cleanup = () => {
    try { stream && stream.close(); } catch { /* 忽略 */ }
    clearInterval(hb);
    sync.stop();
    try { audio.pause(); audio.src = ''; audio.remove(); } catch { /* 忽略 */ }
    window.__cmSseEvent = null;
    window.__cmSseState = null;
  };
}

// ---------------- 房间设置（房主） ----------------
function settingsDialog(roomId, room, onDone) {
  const diag = mdui.dialog({
    headline: '房间设置',
    body: `<div class="cm-form">
      <div class="cm-more-row" style="padding:4px 0">
        <div><div class="cm-more-t">自由点歌</div><div class="cm-more-s">开启后全员免审批</div></div>
        <mdui-switch id="sFree" ${room.freeMode ? 'checked' : ''}></mdui-switch>
      </div>
      <div class="cm-more-row" style="padding:4px 0">
        <div><div class="cm-more-t">公开房间</div><div class="cm-more-s">在广场展示</div></div>
        <mdui-switch id="sPublic" ${room.isPublic ? 'checked' : ''}></mdui-switch>
      </div>
      <div class="cm-more-row" style="padding:4px 0">
        <div><div class="cm-more-t">房间锁定</div><div class="cm-more-s">禁止新成员加入</div></div>
        <mdui-switch id="sLock" ${room.joinLocked ? 'checked' : ''}></mdui-switch>
      </div>
      <mdui-text-field id="sPw" label="房间密码（留空=无密码）" variant="outlined" type="password" style="width:100%"></mdui-text-field>
    </div>`,
    actions: [{ text: '取消' }, {
      text: '保存',
      onClick: () => roomApi.settings(roomId, {
        freeMode: diag.querySelector('#sFree').checked,
        isPublic: diag.querySelector('#sPublic').checked,
        joinLocked: diag.querySelector('#sLock').checked,
        needApproval: !diag.querySelector('#sFree').checked,
        password: (diag.querySelector('#sPw').value || '').trim(),
      }).then(() => { toast('设置已保存'); onDone && onDone(); }).catch(e => { toast(e.message); return false; }),
    }],
  });
}

// ---------------- 搜索点歌 ----------------
function songPicker(roomId, onDone) {
  const diag = mdui.dialog({
    headline: '搜索点歌',
    body: `<div>
      <mdui-text-field id="pkKw" label="搜索歌曲 / 歌手" variant="outlined" style="width:100%"></mdui-text-field>
      <div id="pkRes" style="max-height:52vh;overflow-y:auto;margin-top:10px"><div class="cm-empty small">输入关键词开始搜索</div></div>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  const input = diag.querySelector('#pkKw');
  const box = diag.querySelector('#pkRes');
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const kw = (input.value || '').trim();
    if (!kw) { box.innerHTML = '<div class="cm-empty small">输入关键词开始搜索</div>'; return; }
    timer = setTimeout(async () => {
      box.innerHTML = '<div class="cm-loading small"><mdui-circular-progress></mdui-circular-progress></div>';
      try {
        const d = await (await import('../api.js')).api.search(kw, 0, 20);
        const songs = d.songs || [];
        if (!songs.length) { box.innerHTML = '<div class="cm-empty small">没有找到结果</div>'; return; }
        // onPlay 置空：点行行为完全由下方 onclick 接管（避免重复入队）
        await renderSongList(box, songs, { onPlay: () => {} });
        // 点行 = 点歌
        box.querySelectorAll('.cm-song').forEach((row, i) => {
          row.onclick = async (ev) => {
            const likeEl = ev.target.closest('[data-act="like"]');
            if (likeEl) return;
            const s = songs[i];
            try {
              const r = await roomApi.queueAdd(roomId, {
                ncm_id: s.ncm_id, name: s.name, artists: s.artists, pic: s.pic, duration: s.duration,
              });
              toast(r.auto ? `已加入队列：${s.name}` : `已提交审批：${s.name}`);
              diag.open = false;
              onDone && onDone();
            } catch (e) { toast(e.message); }
          };
        });
      } catch (e) {
        box.innerHTML = `<div class="cm-empty small">搜索失败：${esc(e.message)}</div>`;
      }
    }, 420);
  });
  setTimeout(() => input.focus(), 200);
}
