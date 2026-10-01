// 消息与私信（阶段四新增）
// 读：/msg/private（会话列表）、/msg/private/history（聊天记录）、/msg/comments（评论我的）、
//    /msg/notices（通知）、/msg/forwards（转发我的）、/msg/recentcontact（最近联系人）、
//    /pl/count（未读数）
// 写：/send/text、/send/song、/send/album、/send/playlist（全部 T2，带 confirm=1）
// 全部是账号态接口：未绑定网易云直接给引导，不发请求。
import { api, auth } from '../api.js';
import { esc, toast, skelList, promptDialog } from '../ui.js';

const KEY = 'cm.msgTab';

const fmtTime = ts => {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
};

const userLine = (u = {}) => `
  <div class="cm-msg-row" data-uid="${u.userId || u.id || ''}">
    <div class="cm-msg-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=80y80" loading="lazy" onerror="this.remove()">` : '<span class="material-icons-outlined">person</span>'}</div>
    <div class="cm-msg-main">
      <div class="cm-msg-name">${esc(u.nickname || u.remarkName || '')}</div>
      <div class="cm-msg-sub">${esc(u.signature || '')}</div>
    </div>
  </div>`;

function needBind(el, text = '消息与私信跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">forum</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看消息与私信'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'private';
  const TABS = [
    { k: 'private', l: '私信' },
    { k: 'comments', l: '评论' },
    { k: 'notices', l: '通知' },
    { k: 'forwards', l: '转发' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="msgTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="msgCount" class="cm-sq-stats"><span class="material-icons-outlined">mail</span>未读统计加载中…</div>
    <div id="msgBody">${skelList(6)}</div>`;

  el.querySelectorAll('#msgTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#msgBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  // 未读数（/pl/count）：进入页面即拉一次，四个维度都显示
  api.ncm('/pl/count').then(d => {
    const box = el.querySelector('#msgCount');
    if (!box) return;
    const bits = [['私信', d.msg], ['评论', d.comment], ['通知', d.notice], ['关注', d.follow], ['转发', d.forward]]
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k} ${v || 0}`);
    box.innerHTML = `<span class="material-icons-outlined">mail</span>${bits.join(' · ') || '暂无未读'}`;
  }).catch(() => { const b = el.querySelector('#msgCount'); if (b) b.textContent = ''; });

  if (tab === 'private') {
    let offset = 0;
    const list = async append => {
      if (!append) body.innerHTML = skelList(6);
      let d;
      try { d = await api.ncm('/msg/private', { limit: 30, offset }); } catch (e) { fail(e); return; }
      const sessions = (d.msgs || []);
      if (!append) body.innerHTML = '';
      if (!sessions.length && !append) { body.innerHTML = '<div class="cm-empty small">还没有私信</div>'; return; }
      body.insertAdjacentHTML('beforeend', sessions.map(s => {
        const u = s.user || {};
        const last = s.lastMsg || (s.msgs && s.msgs[0]) || {};
        return `
          <div class="cm-msg-row" data-uid="${u.id || s.fromUserId || ''}">
            <div class="cm-msg-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=80y80" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
            <div class="cm-msg-main">
              <div class="cm-msg-name">${esc(u.nickname || s.nickname || '')}</div>
              <div class="cm-msg-sub">${esc(last.msg || last.content || s.lastMsgText || '')}</div>
            </div>
            <div class="cm-msg-time">${fmtTime(s.lastMsgTime || last.time)}</div>
          </div>`;
      }).join(''));
      body.querySelectorAll('.cm-msg-row').forEach(r => {
        if (r.dataset.bound) return;
        r.dataset.bound = '1';
        r.onclick = () => chat(r.dataset.uid);
      });
      body.querySelector('#msgMore')?.remove();
      if (d.more || sessions.length >= 30) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="msgMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#msgMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { offset += sessions.length; await list(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await list(false);

    // 最近联系人（/msg/recentcontact）：用于给没聊过的人发起私信
    const box = document.createElement('section');
    box.className = 'cm-sec';
    box.innerHTML = '<div class="cm-sec-head"><h2>最近联系人</h2><span class="cm-sec-sub">/msg/recentcontact</span></div><div id="msgRecent" class="cm-hscroll"></div>';
    body.appendChild(box);
    api.ncm('/msg/recentcontact').then(d => {
      const data = d.data || {};
      const people = [].concat(data.follow || [], data.msg || data.visitor || []);
      const box2 = body.querySelector('#msgRecent');
      if (!box2) return;
      const uniq = [];
      const seen = new Set();
      people.forEach(u => { const id = u.userId || u.id; if (id && !seen.has(id)) { seen.add(id); uniq.push(u); } });
      box2.innerHTML = uniq.length
        ? uniq.slice(0, 20).map(u => `
          <div class="cm-msg-row cm-msg-recent" data-uid="${u.userId || u.id}">
            <div class="cm-msg-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=80y80" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
            <div class="cm-msg-main"><div class="cm-msg-name">${esc(u.nickname || '')}</div></div>
          </div>`).join('')
        : '<div class="cm-empty small">暂无最近联系人</div>';
      box2.querySelectorAll('[data-uid]').forEach(r => { r.onclick = () => chat(r.dataset.uid); });
    }).catch(() => {
      const box2 = body.querySelector('#msgRecent');
      if (box2) box2.innerHTML = '<div class="cm-empty small">读取失败</div>';
    });
    return;
  }

  /** 聊天抽屉：读 /msg/private/history，写 /send/{text,song,album,playlist}。 */
  function chat(peerUid) {
    if (!peerUid) return;
    const diag = document.createElement('mdui-dialog');
    diag.headline = '私信';
    diag.style.setProperty('--mdui-dialog-width', 'min(560px, 94vw)');
    diag.innerHTML = `
      <div class="cm-chat" id="chatBox"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>
      <div class="cm-pe-inline" style="margin-top:10px">
        <input id="chatInput" placeholder="说点什么…">
        <mdui-button variant="filled" id="chatSend">发送</mdui-button>
      </div>
      <div class="cm-pe-acts">
        <mdui-button variant="text" id="chatSong">分享歌曲</mdui-button>
        <mdui-button variant="text" id="chatAlbum">分享专辑</mdui-button>
        <mdui-button variant="text" id="chatPl">分享歌单</mdui-button>
      </div>`;
    document.body.appendChild(diag);
    diag.open = true;
    let before = 0;
    const draw = async () => {
      const box = diag.querySelector('#chatBox');
      try {
        const d = await api.ncm('/msg/private/history', { uid: peerUid, limit: 30, before });
        const msgs = (d.msgs || []).slice().reverse();
        if (!msgs.length && !before) { box.innerHTML = '<div class="cm-empty small">还没有聊天记录</div>'; return; }
        box.insertAdjacentHTML(before ? 'afterbegin' : 'innerHTML',
          msgs.map(m => {
            const mine = String((m.fromUser || {}).userId) === String(uid);
            return `<div class="cm-chat-line${mine ? ' mine' : ''}">
              <div class="cm-chat-bubble">${esc(m.msg || m.content || '')}</div>
              <div class="cm-chat-time">${fmtTime(m.time)}</div></div>`;
          }).join(''));
        if (d.more && msgs.length) {
          const btn = document.createElement('div');
          btn.className = 'cm-sec-more';
          btn.textContent = '加载更早';
          btn.onclick = async () => {
            before = msgs[0].time || before;
            btn.remove();
            await draw();
          };
          box.prepend(btn);
        }
      } catch (e) {
        box.innerHTML = `<div class="cm-empty small">${/绑定|401/.test(e.message) ? '需先绑定网易云账号' : esc(e.message)}</div>`;
      }
    };
    draw();
    const send = (path, params, okMsg) => api.ncm(path, { ...params, confirm: 1 })
      .then(() => { toast(okMsg); diag.querySelector('#chatBox').innerHTML = ''; before = 0; draw(); })
      .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message));
    diag.querySelector('#chatSend').onclick = () => {
      const text = diag.querySelector('#chatInput').value.trim();
      if (!text) return toast('说点什么吧');
      send('/send/text', { user_ids: `[${peerUid}]`, msg: text }, '已发送');
      diag.querySelector('#chatInput').value = '';
    };
    diag.querySelector('#chatSong').onclick = () => promptDialog({
      title: '分享歌曲', label: '歌曲 ID', placeholder: '如 347230',
      onOk: id => send('/send/song', { id, user_ids: `[${peerUid}]`, msg: '分享一首歌' }, '已分享歌曲'),
    });
    diag.querySelector('#chatAlbum').onclick = () => promptDialog({
      title: '分享专辑', label: '专辑 ID', placeholder: '如 32311',
      onOk: id => send('/send/album', { id, user_ids: `[${peerUid}]`, msg: '分享一张专辑' }, '已分享专辑'),
    });
    diag.querySelector('#chatPl').onclick = () => promptDialog({
      title: '分享歌单', label: '歌单 ID', placeholder: '如 3778678',
      onOk: playlist => send('/send/playlist', { playlist, user_ids: `[${peerUid}]`, msg: '分享一个歌单' }, '已分享歌单'),
    });
  }
  if (tab === 'comments') {
    let before = 0;
    const load = async append => {
      let d;
      try { d = await api.ncm('/msg/comments', { uid, limit: 20, before }); } catch (e) { fail(e); return; }
      const list = d.comments || [];
      if (!append) body.innerHTML = '';
      if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">还没有人评论你</div>'; return; }
      body.insertAdjacentHTML('beforeend', list.map(c => `
        <div class="cm-lm-item">
          <div class="cm-msg-name">${esc((c.user || {}).nickname || '')}</div>
          <div class="cm-lm-lyric">${esc(c.content || '')}</div>
          <div class="cm-lm-meta"><span>${esc(c.timeStr || fmtTime(c.time))}</span>
          <span>${c.beReplied && c.beReplied.length ? '回复了你' : ''}</span></div>
        </div>`).join(''));
      body.querySelector('#msgMore')?.remove();
      if (d.more && list.length) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="msgMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#msgMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { before = list[list.length - 1].time; await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  if (tab === 'notices') {
    let lasttime = 0;
    const load = async append => {
      let d;
      try { d = await api.ncm('/msg/notices', { limit: 20, lasttime }); } catch (e) { fail(e); return; }
      const list = d.notices || [];
      if (!append) body.innerHTML = '';
      if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">没有新通知</div>'; return; }
      body.insertAdjacentHTML('beforeend', list.map(n => {
        // notice 字段是 JSON 字符串，取其中的文案与目标
        let payload = {};
        try { payload = JSON.parse(n.notice || '{}'); } catch { /* 保留原文 */ }
        return `<div class="cm-lm-item">
          <div class="cm-msg-name">${esc(payload.nickname || payload.userName || '通知')}</div>
          <div class="cm-lm-lyric">${esc(payload.comment || payload.msg || payload.notice || '')}</div>
          <div class="cm-lm-meta"><span>${fmtTime(n.time)}</span><span>${esc(n.type || '')}</span></div>
        </div>`;
      }).join(''));
      body.querySelector('#msgMore')?.remove();
      if (d.more && list.length) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="msgMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#msgMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { lasttime = list[list.length - 1].time; await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  // 转发我的（/msg/forwards）
  let offset = 0;
  const load = async append => {
    let d;
    try { d = await api.ncm('/msg/forwards', { limit: 30, offset }); } catch (e) { fail(e); return; }
    const list = d.forwards || [];
    if (!append) body.innerHTML = '';
    if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">还没有人转发你</div>'; return; }
    body.insertAdjacentHTML('beforeend', list.map(f => `
      <div class="cm-lm-item">
        <div class="cm-msg-name">${esc((f.user || {}).nickname || '')}</div>
        <div class="cm-lm-lyric">${esc(f.msg || f.content || '')}</div>
        <div class="cm-lm-meta"><span>${esc(f.timeStr || fmtTime(f.time))}</span></div>
      </div>`).join(''));
    body.querySelector('#msgMore')?.remove();
    if (d.more && list.length) {
      body.insertAdjacentHTML('beforeend',
        '<div class="cm-sq-more" id="msgMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
      body.querySelector('#msgMore mdui-button').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        try { offset += list.length; await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };
  await load(false);
}
