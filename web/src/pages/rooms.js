// 听歌房广场：浏览公开房间 / 房间号搜索 / 创建房间
import { mdui } from '../md.js';
import { auth } from '../api.js';
import { esc, toast, skelGrid, promptDialog } from '../ui.js';
import { roomApi } from '../room.js';

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:44px">groups</span>
      <div>登录后可创建/加入听歌房</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button>
    </div>`;
    return;
  }
  el.innerHTML = `
    <div class="cm-room-hero">
      <div class="cm-room-hero-t">一起听</div>
      <div class="cm-room-hero-s">多人实时同步播放 · 支持上百人同房</div>
      <div class="cm-room-hero-acts">
        <mdui-button variant="filled" id="createRoom"><span class="material-icons-outlined">add</span>创建房间</mdui-button>
      </div>
    </div>
    <div class="cm-adminbar">
      <mdui-text-field id="rq" label="输入房间号加入 / 搜索房间名" variant="outlined" style="flex:1"></mdui-text-field>
      <mdui-button variant="tonal" id="rqGo">进入</mdui-button>
    </div>
    <div class="cm-sec-head"><h2>房间广场</h2><span class="cm-sec-more" id="refresh"><span class="material-icons-outlined">refresh</span> 刷新</span></div>
    <div id="roomList">${skelGrid(4)}</div>`;

  const input = el.querySelector('#rq');
  const listBox = el.querySelector('#roomList');

  const load = async (query = '') => {
    listBox.innerHTML = skelGrid(4);
    try {
      const d = await roomApi.list(query);
      const rooms = d.rooms || [];
      listBox.innerHTML = rooms.length ? `<div class="cm-roomgrid">${rooms.map(r => `
        <div class="cm-roomcard" data-code="${r.code}">
          <div class="cm-roomcard-top">
            <div class="cm-roomcard-name">${esc(r.name)}</div>
            <span class="cm-roomcard-live">${r.online} 人</span>
          </div>
          <div class="cm-roomcard-sub">${r.track_meta ? '♪ ' + esc(r.track_meta.name) : '暂无播放'}${r.playing ? ' <span class="cm-roomcard-dot"></span>' : ''}</div>
          <div class="cm-roomcard-foot">
            <span class="material-icons-outlined">person</span>${esc(r.owner_name || '')}
            <span class="cm-roomcard-code">#${r.code}</span>
            ${r.free_mode ? '<span class="cm-tag">自由点歌</span>' : ''}
          </div>
        </div>`).join('')}</div>` : `<div class="cm-empty">还没有公开房间，点上面创建一个吧</div>`;
      listBox.querySelectorAll('.cm-roomcard').forEach(c => {
        c.onclick = () => joinByCode(c.dataset.code);
      });
    } catch (e) {
      listBox.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
    }
  };

  const joinByCode = async (code) => {
    try {
      const d = await roomApi.findByCode(code);
      const room = d.room;
      if (room.hasPassword) {
        promptDialog({
          title: `房间「${room.name}」需要密码`, label: '房间密码', type: 'password',
          onOk: async pw => { await doJoin(room.id, pw); },
        });
        return;
      }
      await doJoin(room.id, '');
    } catch (e) { toast(e.message); }
  };

  const doJoin = async (roomId, password) => {
    try {
      await roomApi.join(roomId, password);
      location.hash = `#/room/${roomId}`;
    } catch (e) { toast(e.message); }
  };

  el.querySelector('#refresh').onclick = () => load((input.value || '').trim());
  el.querySelector('#rqGo').onclick = () => {
    const v = (input.value || '').trim();
    if (!v) return toast('请输入房间号或房间名');
    if (/^\d{6}$/.test(v)) return joinByCode(v);
    load(v);
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#rqGo').click(); });
  el.querySelector('#createRoom').onclick = () => createRoomDialog(() => load());

  load();
}

export function createRoomDialog(onCreated) {
  const diag = mdui.dialog({
    headline: '创建听歌房',
    body: `<div class="cm-form">
      <mdui-text-field id="crName" label="房间名称" variant="outlined" style="width:100%"></mdui-text-field>
      <mdui-text-field id="crPw" label="房间密码（可留空）" variant="outlined" type="password" style="width:100%"></mdui-text-field>
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
            if (onCreated) onCreated(d.room);
            location.hash = `#/room/${d.room.id}`;
          }).catch(e => { toast(e.message); return false; });
        },
      },
    ],
  });
  return diag;
}
