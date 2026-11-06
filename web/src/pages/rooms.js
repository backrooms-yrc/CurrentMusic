// 一起听广场及房主管理。
import { mdui } from '../md.js';
import { auth } from '../api.js';
import { esc, toast, skelGrid, confirmDialog } from '../ui.js';
import { roomApi } from '../room.js';

export function render(el, params) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">groups</span>
      <div>登录后可创建或加入听歌房</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button>
    </div>`;
    return;
  }
  el.innerHTML = `
    <div class="cm-room-hero">
      <div class="cm-room-hero-t">一起听</div>
      <div class="cm-room-hero-s">多人实时同步播放 · 每间最多 200 人</div>
      <div class="cm-room-hero-acts">
        <mdui-button variant="filled" id="createRoom"><span class="material-icons-outlined">add</span>创建房间</mdui-button>
      </div>
    </div>
    <div class="cm-adminbar">
      <mdui-text-field id="rq" label="输入房间号或房间名" variant="outlined" maxlength="60" style="flex:1"></mdui-text-field>
      <mdui-button variant="tonal" id="rqGo">搜索</mdui-button>
    </div>
    <div class="cm-sec-head">
      <div class="cm-room-actions">
        <mdui-button id="rPublic">房间广场</mdui-button>
        <mdui-button id="rMine">我的房间</mdui-button>
      </div>
      <mdui-button-icon id="rRefresh" icon="refresh" aria-label="刷新"></mdui-button-icon>
    </div>
    <p id="roomHint" class="cm-room-hint" hidden>无人活动满 30 分钟后自动归档。归档房间可随时恢复或删除。</p>
    <div id="roomList">${skelGrid(4)}</div>
    <div class="cm-room-actions cm-room-pagination" id="rPagination" hidden>
      <mdui-button id="rBack" variant="text">上一页</mdui-button>
      <span id="rPage"></span>
      <mdui-button id="rMore" variant="text">下一页</mdui-button>
    </div>`;

  const get = id => el.querySelector('#' + id);
  const input = get('rq');
  const list = get('roomList');
  const hash = location.hash;
  let scope = params?.query?.scope === 'mine' ? 'mine' : 'public';
  let query = '';
  let offset = 0;
  let generation = 0;
  const openRoom = id => { location.hash = `#/room/${id}`; };

  async function load() {
    const run = ++generation;
    const mine = scope === 'mine';
    get('rPublic').variant = mine ? 'text' : 'tonal';
    get('rMine').variant = mine ? 'tonal' : 'text';
    get('roomHint').hidden = !mine;
    get('rPagination').hidden = true;
    list.innerHTML = skelGrid(4);
    try {
      const { rooms, total } = await roomApi.list(scope, query, offset);
      if (run !== generation || location.hash !== hash) return;
      if (!rooms.length && offset > 0) { offset -= 20; load(); return; }
      list.innerHTML = rooms.length ? `<div class="cm-roomgrid">${rooms.map(r => `
        <article class="cm-roomcard">
          <div class="cm-roomcard-top">
            <div class="cm-roomcard-name">${esc(r.name)}</div>
            <span class="cm-roomcard-live">${r.closed_at ? (r.archive_reason === 'idle' ? '自动归档' : '已归档') : r.online + ' 人'}</span>
          </div>
          <div class="cm-roomcard-sub">${r.track_meta ? '♪ ' + esc(r.track_meta.name) : '暂无曲目'}${r.playing ? ' <span class="cm-roomcard-dot"></span>' : ''}</div>
          <div class="cm-roomcard-foot">
            <span class="material-icons-outlined">person</span>${esc(r.owner_name || '')}
            ${r.has_password ? '<span class="cm-tag">密码房</span>' : ''}
            ${r.join_locked ? '<span class="cm-tag">已锁定</span>' : ''}
            <span class="cm-roomcard-code">#${esc(r.code)}</span>
          </div>
          <div class="cm-room-actions">
            <mdui-button variant="text" data-open="${r.id}">${r.closed_at ? '恢复房间' : '进入房间'}</mdui-button>
            ${mine ? `<mdui-button variant="text" data-delete="${r.id}">删除</mdui-button>` : ''}
          </div>
        </article>`).join('')}</div>` : `<div class="cm-empty">${query ? '没有找到匹配的房间' : mine ? '你还没有创建房间' : '暂无公开房间'}</div>`;
      list.querySelectorAll('[data-open]').forEach(b => {
        b.onclick = async () => {
          const room = rooms.find(r => r.id === +b.dataset.open);
          b.disabled = true;
          try {
            if (room.closed_at) await roomApi.reopen(room.id);
            if (location.hash === hash) openRoom(room.id);
          } catch (e) { toast(e.message); }
          finally { b.disabled = false; }
        };
      });
      list.querySelectorAll('[data-delete]').forEach(b => {
        b.onclick = () => confirmDialog({
          title: '永久删除房间',
          body: '房间、成员记录和点歌队列将永久删除。',
          onOk: async () => { await roomApi.delete(b.dataset.delete); toast('房间已删除'); load(); },
        });
      });
      get('rPagination').hidden = total <= 20;
      get('rBack').disabled = offset === 0;
      get('rMore').disabled = offset + 20 >= total;
      get('rPage').textContent = `${offset / 20 + 1} / ${Math.ceil(total / 20)}`;
    } catch (e) {
      if (run === generation) list.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
    }
  }

  const switchScope = (value) => { scope = value; input.value = ''; query = ''; offset = 0; load(); };
  get('rPublic').onclick = () => switchScope('public');
  get('rMine').onclick = () => switchScope('mine');
  get('rRefresh').onclick = load;
  get('rBack').onclick = () => { offset = Math.max(0, offset - 20); load(); };
  get('rMore').onclick = () => { offset += 20; load(); };
  get('rqGo').onclick = async () => {
    const value = input.value.trim();
    if (scope === 'public' && /^[0-9]{6}$/.test(value)) {
      try {
        const { room } = await roomApi.findByCode(value);
        if (location.hash === hash) openRoom(room.id);
      } catch (e) { toast(e.message); }
    } else {
      query = value;
      offset = 0;
      load();
    }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') get('rqGo').click(); });
  get('createRoom').onclick = () => createRoomDialog();
  load();
}

export function createRoomDialog() {
  const diag = mdui.dialog({
    headline: '创建听歌房',
    body: `<div class="cm-form">
      <mdui-text-field id="crName" label="房间名称" maxlength="60" variant="outlined" style="width:100%"></mdui-text-field>
      <mdui-text-field id="crPw" label="房间密码（可留空）" maxlength="128" variant="outlined" type="password" style="width:100%"></mdui-text-field>
      <div class="cm-more-row" style="padding:4px 0">
        <div><div class="cm-more-t">公开房间</div><div class="cm-more-s">在房间广场展示</div></div>
        <mdui-switch id="crPublic" checked></mdui-switch>
      </div>
      <div class="cm-more-row" style="padding:4px 0">
        <div><div class="cm-more-t">自由点歌</div><div class="cm-more-s">开启后全员免审批点歌</div></div>
        <mdui-switch id="crFree"></mdui-switch>
      </div>
    </div>`,
    actions: [
      { text: '取消' },
      {
        text: '创建',
        onClick: () => {
          const name = (diag.querySelector('#crName').value || '').trim();
          if (!name) { toast('请填写房间名称'); return false; }
          return roomApi.create({
            name,
            password: (diag.querySelector('#crPw').value || '').trim(),
            isPublic: diag.querySelector('#crPublic').checked,
            freeMode: diag.querySelector('#crFree').checked,
            needApproval: !diag.querySelector('#crFree').checked,
          }).then(d => {
            toast(`房间已创建：${d.room.code}`);
            location.hash = `#/room/${d.room.id}`;
          }).catch(e => { toast(e.message); return false; });
        },
      },
    ],
  });
  return diag;
}
