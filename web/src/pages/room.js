// 一起听房间：播放、点歌和成员管理。
import { mdui } from '../md.js';
import { api, auth } from '../api.js';
import { esc, toast, fmtDur, renderSongList, avatarHTML, userTags, skelRoom, confirmDialog } from '../ui.js';
import { roomApi, openEventStream, estimateClockOffset, RoomSync } from '../room.js';
import { player } from '../player.js';

let cleanup = null;

const closeMessages = {
  idle: '房间长时间无人活动，已自动归档',
  manual: '房主已归档房间',
  deleted: '房间已删除',
  removed: '你已被移出房间',
  session: '登录已失效',
  full: '房间已满',
};

export async function render(el, [roomId] = []) {
  if (cleanup) cleanup();
  if (!auth.token) {
    el.innerHTML = '<div class="cm-empty">请先登录 <mdui-button href="#/user">去登录</mdui-button></div>';
    return;
  }

  const roomHash = location.hash;
  const sessionToken = auth.token;
  const uid = auth.user?.id;
  let active = true;
  let release = () => {};
  let dialog;
  function dispose() {
    active = false;
    window.removeEventListener('hashchange', onNavigate);
    window.removeEventListener('cm-authchange', onAuthChange);
    window.removeEventListener('storage', onAuthChange);
    if (dialog) dialog.open = false;
    release();
    if (cleanup === dispose) cleanup = null;
  }
  function onNavigate() {
    if (location.hash !== roomHash) dispose();
  }
  function onAuthChange() {
    if (auth.token !== sessionToken) {
      dispose();
      if (location.hash === roomHash) location.hash = '#/rooms';
    }
  }
  cleanup = dispose;
  window.addEventListener('hashchange', onNavigate);
  window.addEventListener('cm-authchange', onAuthChange);
  window.addEventListener('storage', onAuthChange);

  const entry = (message, button = '') => {
    el.innerHTML = `<div class="cm-empty">${esc(message)}<div class="cm-room-actions">
      <mdui-button href="#/rooms">返回广场</mdui-button>${button}</div></div>`;
  };

  el.innerHTML = skelRoom();
  try {
    const detail = await roomApi.detail(roomId);
    if (!active) return;
    if (detail.room.archivedAt) {
      entry(closeMessages[detail.room.archiveReason] || '房间已归档',
        '<mdui-button variant="filled" id="rReopen">恢复房间</mdui-button>');
      el.querySelector('#rReopen').onclick = async () => {
        try {
          await roomApi.reopen(roomId);
          if (active) render(el, [roomId]);
        } catch (e) { if (active) toast(e.message); }
      };
      return;
    }
    const join = async (password) => {
      await roomApi.join(roomId, password);
      const joined = await roomApi.detail(roomId);
      if (active) enter(joined);
    };
    if (detail.role) {
      enter(detail);
    } else if (detail.room.joinLocked && detail.room.ownerId !== uid) {
      entry('房间已锁定，暂不接受新成员');
    } else if (detail.room.hasPassword && detail.room.ownerId !== uid) {
      entry(detail.room.name, `<form class="cm-room-entry" id="rJoin">
        <mdui-text-field id="rPassword" label="房间密码" maxlength="128" variant="outlined" type="password"></mdui-text-field>
        <mdui-button type="submit" variant="filled" id="rSubmitJoin">加入</mdui-button>
        <div id="rJoinError" role="status"></div>
      </form>`);
      const form = el.querySelector('#rJoin');
      const password = el.querySelector('#rPassword');
      const submit = el.querySelector('#rSubmitJoin');
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (submit.loading) return;
        const error = el.querySelector('#rJoinError');
        if (!password.value) { error.textContent = '请输入房间密码'; return; }
        submit.loading = true;
        error.textContent = '';
        try { await join(password.value); }
        catch (e) { if (active) error.textContent = e.message; }
        finally { submit.loading = false; }
      };
    } else {
      await join('');
    }
  } catch (e) {
    if (active) entry(e.message);
  }

  function enter(detail) {
    if (!detail.role || !detail.timeline) {
      entry('房间状态已变化，请重新进入');
      return;
    }
    let room = detail.room;
    let role = detail.role;
    let timelineSeq = detail.latestSeq;
    let connected = false;
    let refreshing = false;
    let refreshAgain = false;
    let changing = false;
    let renewing = false;
    let endedRevision;
    const isOwner = () => role === 'owner';
    const canControl = () => isOwner() || role === 'admin';
    const audio = new Audio();
    audio.preload = 'auto';
    if (!player.audio.paused) player.pause();

    el.innerHTML = `
      <div class="cm-rtop">
        <div class="cm-rtop-main">
          <div class="cm-rname"><span id="rName"></span> <span class="cm-tag" id="rMode" hidden></span></div>
          <div class="cm-rsub">
            <span>房间号 <b>${esc(room.code)}</b></span>
            <span id="rMembers"></span>
            <span id="rSync" class="cm-rsync" role="status">连接中…</span>
          </div>
        </div>
        <div class="cm-rtop-acts">
          <mdui-button-icon icon="share" id="rShare" title="复制邀请链接" aria-label="复制邀请链接"></mdui-button-icon>
          <mdui-button-icon icon="settings" id="rSettings" title="房间设置" aria-label="房间设置"></mdui-button-icon>
          <mdui-button-icon icon="logout" id="rLeave" title="离开房间" aria-label="离开房间"></mdui-button-icon>
        </div>
      </div>
      <div class="cm-rnow">
        <div class="cm-rnow-cover" id="rCover"><span class="material-icons-outlined">music_note</span></div>
        <div class="cm-rnow-main">
          <div class="cm-rnow-name" id="rTrackName">等待开始播放…</div>
          <div class="cm-rnow-artist" id="rTrackArtist"></div>
          <div class="cm-rnow-bar" id="rBar"><i id="rProg"></i></div>
          <div class="cm-rnow-time"><span id="rCur">0:00</span><span id="rDur">0:00</span></div>
        </div>
      </div>
      <div class="cm-rctrl" id="rControls">
        <mdui-button-icon icon="skip_previous" id="rPrev" title="上一首" aria-label="上一首"></mdui-button-icon>
        <mdui-button-icon icon="play_arrow" id="rPlay" title="播放或暂停" aria-label="播放或暂停"></mdui-button-icon>
        <mdui-button-icon icon="skip_next" id="rNext" title="下一首" aria-label="下一首"></mdui-button-icon>
        <span class="cm-rctrl-tip" id="rRole"></span>
      </div>
      <div class="cm-rctrl-follow" id="rFollow">跟随房主或管理员播放</div>
      <mdui-button id="rEnable" variant="tonal" hidden>开启房间声音</mdui-button>
      <div class="cm-sec-head"><h2>点歌队列</h2>
        <mdui-button id="rAddSong" variant="text" icon="search">搜索点歌</mdui-button></div>
      <div id="rQueue"></div>
      <div class="cm-sec-head"><h2>在线成员</h2></div>
      <div class="cm-rmembers" id="rMemberList"></div>`;

    const get = (id) => el.querySelector('#' + id);
    const sync = new RoomSync(audio, ({ drift, position, duration }) => {
      const label = get('rSync');
      const aligned = connected && Math.abs(drift) < 300;
      label.textContent = connected ? (aligned ? '已同步' : '正在校准') : '正在连接…';
      label.classList.toggle('ok', aligned);
      get('rProg').style.width = duration ? Math.min(100, position / duration * 100) + '%' : '0%';
      get('rCur').textContent = fmtDur(position);
      get('rDur').textContent = fmtDur(duration);
      if (connected && duration && position >= duration) advance();
    }, blocked => { if (active) get('rEnable').hidden = !blocked; });

    function exit(message, mine = false) {
      if (!active) return;
      if (message) toast(message);
      dispose();
      location.hash = mine ? '#/rooms?scope=mine' : '#/rooms';
    }

    function fail(e) {
      if (active && [401, 403, 404].includes(e.status)) exit(e.message);
    }

    function applyTimeline(tl, seq) {
      if (seq < timelineSeq) return;
      timelineSeq = seq;
      const meta = tl.trackMeta || {};
      get('rTrackName').textContent = meta.name || '等待开始播放…';
      get('rTrackArtist').textContent = meta.artists || '';
      const cover = get('rCover');
      if (cover.dataset.pic !== (meta.pic || '')) {
        cover.dataset.pic = meta.pic || '';
        cover.innerHTML = meta.pic ? `<img src="${esc(meta.pic)}" alt="">` : '<span class="material-icons-outlined">music_note</span>';
      }
      get('rPlay').setAttribute('icon', tl.playing ? 'pause' : 'play_arrow');
      sync.applyTimeline(tl);
    }

    function showDetails(d) {
      room = d.room;
      role = d.role;
      get('rName').textContent = room.name;
      const mode = [room.hasPassword && '密码房', room.joinLocked && '已锁定', (room.freeMode || !room.needApproval) && '免审批']
        .filter(Boolean).join(' · ');
      get('rMode').textContent = mode;
      get('rMode').hidden = !mode;
      get('rSettings').hidden = !isOwner();
      get('rControls').hidden = !canControl();
      get('rBar').classList.toggle('seekable', canControl());
      get('rFollow').hidden = canControl();
      get('rRole').textContent = isOwner() ? '房主控播' : '管理员控播';
      const members = d.members || [];
      get('rMembers').textContent = `${members.length} 人在线`;
      get('rMemberList').innerHTML = members.map(m => `
        <div class="cm-rmember">
          ${m.avatar || m.avatarDecoration ? avatarHTML(m, 36) : `<span class="cm-rmember-ph">${esc((m.nickname || '?')[0])}</span>`}
          <div class="cm-rmember-main">
            <div class="cm-rmember-name">${esc(m.nickname || ('用户' + m.userId))}${userTags(m)}
              ${m.role === 'owner' ? '<span class="cm-tag admin">房主</span>' : m.role === 'admin' ? '<span class="cm-tag">管理员</span>' : ''}
              ${m.userId === uid ? '<span class="cm-tag">我</span>' : ''}
            </div>
          </div>
          ${m.userId !== uid && (isOwner() || (canControl() && m.role === 'member'))
            ? `<mdui-button-icon icon="more_vert" aria-label="成员操作" data-member="${m.userId}"></mdui-button-icon>` : ''}
        </div>`).join('');
      get('rMemberList').querySelectorAll('[data-member]').forEach(b => {
        b.onclick = () => { dialog = memberMenu(roomId, members.find(m => m.userId === +b.dataset.member), isOwner(), refresh); };
      });
      renderQueue(get('rQueue'), d.queue || [], canControl(), async (action, item, index) => {
        if (action === 'up' || action === 'down') await roomApi.reorder(roomId, item, index);
        else await roomApi[action](roomId, item);
        refresh();
      });
      applyTimeline(d.timeline, d.latestSeq);
    }

    async function refresh() {
      if (!active) return;
      if (refreshing) { refreshAgain = true; return; }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          const d = await roomApi.detail(roomId);
          if (!active) return;
          if (d.room.archivedAt) return exit(closeMessages[d.room.archiveReason]);
          if (!d.role || !d.timeline) return exit(closeMessages.removed);
          showDetails(d);
        } while (refreshAgain);
      } catch (e) {
        fail(e);
      } finally {
        refreshing = false;
      }
    }

    async function renew() {
      const tl = sync.timeline;
      if (!tl?.trackNcmId || renewing) return;
      if (tl.stream && tl.stream.expireAt > Date.now() + sync.offset + 60_000) return;
      renewing = true;
      try {
        const d = await roomApi.renewStream(roomId);
        if (active) applyTimeline(d.timeline, d.seq);
      } catch (e) {
        fail(e);
      } finally {
        renewing = false;
      }
    }

    async function control(action, { automatic = false } = {}) {
      if (changing || !active || !canControl()) return;
      changing = true;
      try {
        if (action === 'play') await renew();
        if (!active) return;
        const d = await roomApi[action](roomId, sync.timeline?.trackRevision);
        if (active) { applyTimeline(d.timeline, d.seq); refresh(); }
      } catch (e) {
        if (active && !automatic) toast(e.message);
        refresh();
      } finally {
        changing = false;
      }
    }

    get('rEnable').onclick = () => sync.resume();
    get('rPlay').onclick = () => control(sync.timeline.playing ? 'pause' : 'play');
    get('rNext').onclick = () => control('next');
    get('rPrev').onclick = () => control('prev');
    get('rBar').onclick = async (e) => {
      const duration = sync.timeline.trackMeta?.duration;
      if (!active || !canControl() || !duration || changing) return;
      const rect = get('rBar').getBoundingClientRect();
      const position = Math.round(duration * Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
      changing = true;
      try {
        const d = await roomApi.seek(roomId, position);
        if (active) applyTimeline(d.timeline, d.seq);
      } catch (err) {
        if (active) toast(err.message);
      } finally {
        changing = false;
      }
    };
    get('rShare').onclick = async () => {
      const link = `${location.origin}${location.pathname}#/room/${roomId}`;
      try {
        await navigator.clipboard.writeText(`来一起听歌！房间号 ${room.code} ${link}`);
        if (active) toast('邀请链接已复制');
      } catch { if (active) toast(`房间号 ${room.code}`); }
    };
    get('rLeave').onclick = async () => {
      try { await roomApi.leave(roomId); exit(); }
      catch (e) { fail(e); if (active) toast(e.message); }
    };
    get('rSettings').onclick = () => { dialog = settingsDialog(roomId, room, refresh, exit, (d) => { dialog = d; }); };
    get('rAddSong').onclick = () => { dialog = songPicker(roomId, refresh); };
    function advance() {
      const tl = sync.timeline;
      if (tl?.playing && canControl() && !changing && endedRevision !== tl.trackRevision) {
        endedRevision = tl.trackRevision;
        control('next', { automatic: true });
      }
    }
    audio.addEventListener('ended', advance);

    showDetails(detail);
    sync.start();
    const stream = openEventStream(roomId, detail.latestSeq, {
      onEvent(type, event) {
        if (type === 'close') return exit(closeMessages[event.payload.reason] || '房间已关闭');
        if (type === 'kick' && event.payload.userId === uid) return exit(closeMessages.removed);
        if (type === 'reset') timelineSeq = -1;
        if (event.payload.timeline) applyTimeline(event.payload.timeline, event.seq);
        if (['join', 'leave', 'role', 'kick', 'transfer', 'queue', 'settings', 'next', 'prev', 'reset'].includes(type)) refresh();
      },
      onOpen() { connected = true; },
      onError(e) { connected = false; fail(e); },
    });
    const hb = setInterval(async () => {
      try { await roomApi.heartbeat(roomId); }
      catch (e) { if (e.status === 409) exit(e.message); else fail(e); }
      if (active) { refresh(); renew(); }
    }, 25000);
    release = () => { stream.close(); clearInterval(hb); sync.stop(); };
    estimateClockOffset(roomId, () => active).then(clock => {
      if (active && clock.ok) { sync.offset = clock.offset; sync.applyTimeline(sync.timeline); }
    });
    renew();
  }
}

function memberMenu(roomId, member, owner, refresh) {
  const run = async (operation) => {
    try { await operation(); refresh(); }
    catch (e) { toast(e.message); return false; }
  };
  const actions = [
    { text: '取消' },
    { text: '移出', onClick: () => run(() => roomApi.kick(roomId, member.userId)) },
    { text: '移出并封禁', onClick: () => run(() => roomApi.kick(roomId, member.userId, true)) },
  ];
  if (owner) actions.push(
    { text: member.role === 'admin' ? '取消管理员' : '设为管理员',
      onClick: () => run(() => roomApi.setAdmin(roomId, member.userId, member.role !== 'admin')) },
    { text: '转让房主', onClick: () => run(() => roomApi.transfer(roomId, member.userId)) },
  );
  return mdui.dialog({ headline: '成员操作', body: esc(member.nickname), actions });
}

function renderQueue(box, queue, admin, run) {
  if (!queue.length) {
    box.innerHTML = '<div class="cm-empty small">队列是空的，搜索歌曲开始点歌</div>';
    return;
  }
  const button = (action, label, icon, item, index = 0) => `<mdui-button-icon icon="${icon}" title="${label}"
    aria-label="${label}" data-act="${action}" data-qid="${item.id}" data-index="${index}"></mdui-button-icon>`;
  const queued = queue.filter(q => q.status === 'queued');
  const row = q => {
    const idx = queued.indexOf(q);
    return `<div class="cm-rq ${q.status === 'playing' ? 'playing' : ''}">
      ${q.pic ? `<img class="cm-song-pic" src="${esc(q.pic)}" alt="" loading="lazy">` : '<div class="cm-song-pic ph"><span class="material-icons-outlined">music_note</span></div>'}
      <div class="cm-song-main">
        <div class="cm-song-name">${esc(q.name)}</div>
        <div class="cm-song-sub"><span>${esc(q.artists || '')}</span>
          <span class="cm-rq-from">${esc(q.requester || '')}${q.mine ? '（我）' : ''}</span>
          ${q.status === 'playing' ? '<span class="cm-tag admin">当前歌曲</span>' : ''}
        </div>
      </div>
      <div class="cm-room-actions">
        ${admin && q.status === 'pending' ? button('approve', '采纳', 'check', q) + button('reject', '驳回', 'close', q) : ''}
        ${admin && idx > 0 ? button('up', '上移', 'arrow_upward', q, idx - 1) : ''}
        ${admin && idx >= 0 && idx < queued.length - 1 ? button('down', '下移', 'arrow_downward', q, idx + 1) : ''}
        ${(q.mine || admin) && q.status !== 'playing' ? button('removeItem', '移除', 'delete_outline', q) : ''}
      </div>
    </div>`;
  };
  const section = (title, items) => items.length ? `<h3 class="cm-room-queue-title">${title}（${items.length}）</h3>${items.map(row).join('')}` : '';
  const history = queue.filter(q => q.status === 'played');
  const historyOpen = box.querySelector('details')?.open;
  box.innerHTML = queue.filter(q => q.status === 'playing').map(row).join('')
    + section('待播放', queued) + section('待审批', queue.filter(q => q.status === 'pending'))
    + (history.length ? `<details ${historyOpen ? 'open' : ''}><summary>播放历史（${history.length}）</summary>${history.map(row).join('')}</details>` : '');
  box.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = async () => {
      b.disabled = true;
      try { await run(b.dataset.act, +b.dataset.qid, +b.dataset.index); }
      catch (e) { toast(e.message); }
      finally { b.disabled = false; }
    };
  });
}

function settingsDialog(roomId, room, refresh, exit, setDialog) {
  const toggle = (id, label, checked) => `<div class="cm-more-row"><span>${label}</span><mdui-switch
    id="${id}" aria-label="${label}" ${checked ? 'checked' : ''}></mdui-switch></div>`;
  const diag = mdui.dialog({
    headline: '房间设置',
    body: `<div class="cm-form">
      <mdui-text-field id="sName" label="房间名称" value="${esc(room.name)}" maxlength="60" variant="outlined"></mdui-text-field>
      ${toggle('sFree', '自由点歌', room.freeMode)}
      ${toggle('sApproval', '普通成员点歌需审批', room.needApproval)}
      ${toggle('sPublic', '在房间广场展示', room.isPublic)}
      ${toggle('sLock', '禁止新成员加入', room.joinLocked)}
      ${toggle('sChangePw', '修改或移除密码', false)}
      <mdui-text-field id="sPw" label="新密码（留空移除）" maxlength="128" variant="outlined" type="password" disabled></mdui-text-field>
      <div class="cm-room-actions">
        <mdui-button id="sBans" variant="text">封禁名单</mdui-button>
        <mdui-button id="sArchive" variant="text">归档房间</mdui-button>
        <mdui-button id="sDelete" variant="text">永久删除</mdui-button>
      </div>
    </div>`,
    actions: [{ text: '取消' }, {
      text: '保存',
      async onClick() {
        const fields = {
          name: get('sName').value.trim(), freeMode: get('sFree').checked,
          isPublic: get('sPublic').checked, joinLocked: get('sLock').checked,
          needApproval: get('sApproval').checked,
        };
        if (get('sChangePw').checked) fields.password = get('sPw').value.trim();
        try { await roomApi.settings(roomId, fields); refresh(); toast('设置已保存'); }
        catch (e) { toast(e.message); return false; }
      },
    }],
  });
  const get = id => diag.querySelector('#' + id);
  get('sChangePw').addEventListener('change', () => { get('sPw').disabled = !get('sChangePw').checked; });
  get('sArchive').onclick = () => {
    diag.open = false;
    setDialog(confirmDialog({ title: '归档房间', body: '结束当前听歌，保留房间号、设置和队列。房主可以从「我的房间」恢复。',
      onOk: async () => { await roomApi.close(roomId); exit('房间已归档', true); } }));
  };
  get('sDelete').onclick = () => {
    diag.open = false;
    setDialog(confirmDialog({ title: '永久删除房间', body: '房间、成员记录和点歌队列将永久删除。',
      onOk: async () => { await roomApi.delete(roomId); exit('房间已删除', true); } }));
  };
  get('sBans').onclick = async () => {
    try {
      const { bans } = await roomApi.bans(roomId);
      if (!diag.open) return;
      diag.open = false;
      const list = mdui.dialog({
        headline: '封禁名单',
        body: bans.length ? bans.map(b => `<div class="cm-more-row">
          <span>${esc(b.nickname || ('用户 ' + b.userId))}</span>
          <mdui-button variant="text" data-unban="${b.userId}">解除封禁</mdui-button></div>`).join('') : '当前没有封禁成员',
        actions: [{ text: '关闭' }],
      });
      setDialog(list);
      list.querySelectorAll('[data-unban]').forEach(button => {
        button.onclick = async () => {
          try { await roomApi.unban(roomId, +button.dataset.unban); button.closest('.cm-more-row').remove(); }
          catch (e) { toast(e.message); }
        };
      });
    } catch (e) { toast(e.message); }
  };
  return diag;
}

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
  let timer;
  let generation = 0;
  let submitting = false;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const run = ++generation;
    const kw = input.value.trim();
    if (!kw) { box.innerHTML = '<div class="cm-empty small">输入关键词开始搜索</div>'; return; }
    timer = setTimeout(async () => {
      box.innerHTML = '<div class="cm-loading small"><mdui-circular-progress></mdui-circular-progress></div>';
      try {
        const d = await api.search(kw, 0, 20, 'song');
        if (run !== generation || !diag.open) return;
        const songs = d.songs || [];
        if (!songs.length) { box.innerHTML = '<div class="cm-empty small">没有找到结果</div>'; return; }
        await renderSongList(box, songs, { deferStatus: true, onPlay: async (index) => {
          if (submitting || !diag.open || run !== generation) return;
          const song = songs[index];
          submitting = true;
          try {
            const r = await roomApi.queueAdd(roomId, {
              ncm_id: song.ncm_id, name: song.name, artists: song.artists, pic: song.pic, duration: song.duration,
            });
            toast(r.auto ? '已加入队列' : '已提交审批');
            diag.open = false;
            onDone();
          } catch (e) { toast(e.message); }
          finally { submitting = false; }
        } });
      } catch (e) {
        if (run === generation && diag.open) box.innerHTML = `<div class="cm-empty small">搜索失败：${esc(e.message)}</div>`;
      }
    }, 420);
  });
  return diag;
}
