// 关注与用户状态（阶段四新增）
// 关系链：/user/follows（我关注的人）、/user/followeds（我的粉丝）、
//        /user/follow/mixed（混合关注流，含歌手）、/get/userids（按昵称查用户）、
//        /user/mutualfollow/get（是否互关）、/follow（关注/取关，T2）
// 状态：  /user/social/status（当前状态）、/user/social/status/edit（设置，T2）、
//        /user/social/status/rcmd（推荐）、/user/social/status/support（可用状态列表）
import { api, auth } from '../api.js';
import { esc, toast, skelList, promptDialog, confirmDialog } from '../ui.js';

const KEY = 'cm.followTab';

const userCard = (u, extra = '') => `
  <div class="cm-msg-row" data-uid="${u.userId || u.id || ''}">
    <div class="cm-msg-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=80y80" loading="lazy" onerror="this.remove()">` : '<span class="material-icons-outlined">person</span>'}</div>
    <div class="cm-msg-main">
      <div class="cm-msg-name">${esc(u.nickname || u.name || '')}</div>
      <div class="cm-msg-sub">${esc(u.signature || u.py || '')}</div>
    </div>
    ${extra}
  </div>`;

function needBind(el, text = '关注关系跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:44px">group</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看关注与用户状态'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'follows';
  const TABS = [
    { k: 'follows', l: '我的关注' },
    { k: 'followeds', l: '我的粉丝' },
    { k: 'mixed', l: '混合关注' },
    { k: 'status', l: '用户状态' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="fwTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="fwBody">${skelList(6)}</div>`;
  el.querySelectorAll('#fwTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#fwBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  /** 按昵称查 uid（/get/userids）再跳用户页 —— 网易云侧的用户 id 与本地 id 不同源。 */
  const searchBar = (ph) => `
    <div class="cm-search-bar"><mdui-text-field id="fwSearch" label="${esc(ph)}" variant="outlined" clearable style="width:100%"></mdui-text-field></div>`;

  if (tab === 'follows' || tab === 'followeds') {
    const path = tab === 'follows' ? '/user/follows' : '/user/followeds';
    const field = tab === 'follows' ? 'follow' : 'followeds';
    let offset = 0;
    body.innerHTML = searchBar('按昵称查用户（回车）') + '<div id="fwList"></div>';
    const listBox = body.querySelector('#fwList');
    const search = body.querySelector('#fwSearch');
    search.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const nick = search.value.trim();
      if (!nick) return;
      listBox.innerHTML = skelList(3);
      try {
        const d = await api.ncm('/get/userids', { nicknames: nick });
        const map = d.nicknames || {};
        const ids = Object.values(map);
        listBox.innerHTML = ids.length
          ? ids.map(id => userCard({ userId: id, nickname: nick })).join('')
          : '<div class="cm-empty small">没有找到该昵称对应的用户</div>';
        listBox.querySelectorAll('[data-uid]').forEach(r => { r.onclick = () => openUser(r.dataset.uid); });
      } catch (e2) { fail(e2); }
    });

    const load = async append => {
      if (!append) listBox.innerHTML = skelList(6);
      try {
        const d = await api.ncm(path, { uid, limit: 30, offset });
        const list = d[field] || d.follow || d.followeds || [];
        if (!append) listBox.innerHTML = '';
        if (!list.length && !append) {
          listBox.innerHTML = `<div class="cm-empty small">${tab === 'follows' ? '还没有关注任何人' : '还没有粉丝'}</div>`;
          return;
        }
        listBox.insertAdjacentHTML('beforeend', list.map(u => userCard(u, tab === 'follows'
          ? '<mdui-button variant="text" data-unfollow="1">取关</mdui-button>' : '')).join(''));
        listBox.querySelectorAll('[data-uid]').forEach(r => {
          if (r.dataset.bound) return;
          r.dataset.bound = '1';
          r.onclick = ev => {
            if (ev.target.closest('[data-unfollow]')) return;
            openUser(r.dataset.uid);
          };
        });
        listBox.querySelectorAll('[data-unfollow]').forEach(btn => {
          btn.onclick = ev => {
            ev.stopPropagation();
            const row = ev.target.closest('[data-uid]');
            confirmDialog({
              title: '取消关注？', body: '',
              onOk: () => api.ncm('/follow', { id: row.dataset.uid, t: 0, confirm: 1 })
                .then(() => { row.remove(); toast('已取消关注'); })
                .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
            });
          };
        });
        listBox.querySelector('#fwMore')?.remove();
        if (d.more || list.length >= 30) {
          listBox.insertAdjacentHTML('beforeend',
            '<div class="cm-sq-more" id="fwMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
          listBox.querySelector('#fwMore mdui-button').onclick = async ev => {
            const btn = ev.currentTarget;
            btn.loading = true;
            try { offset += list.length; await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
          };
        }
      } catch (e) { fail(e); }
    };
    await load(false);
    return;
  }

  if (tab === 'mixed') {
    // 混合关注流：一次给出关注的人 + 歌手（上游 records 里 type 区分）
    let cursor = 0;
    const load = async append => {
      if (!append) body.innerHTML = skelList(6);
      let d;
      try { d = await api.ncm('/user/follow/mixed', { cursor, scene: 0, size: 30 }); } catch (e) { fail(e); return; }
      const recs = ((d.data || {}).records) || [];
      if (!append) body.innerHTML = '';
      if (!recs.length && !append) { body.innerHTML = '<div class="cm-empty small">没有关注记录</div>'; return; }
      body.insertAdjacentHTML('beforeend', recs.map(r => {
        if (r.artistInfo) {
          return `<div class="cm-msg-row" data-aid="${r.artistInfo.id}">
            <div class="cm-msg-ava">${r.artistInfo.picUrl ? `<img src="${esc(r.artistInfo.picUrl)}?param=80y80" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
            <div class="cm-msg-main"><div class="cm-msg-name">${esc(r.artistInfo.name)}</div>
            <div class="cm-msg-sub">歌手</div></div></div>`;
        }
        const u = r.userProfile || {};
        return userCard(u, `<mdui-button variant="text" data-mutual="${u.userId || ''}">看互关</mdui-button>`);
      }).join(''));
      body.querySelectorAll('[data-aid]').forEach(x => { x.onclick = () => { location.hash = `#/artist/${x.dataset.aid}`; }; });
      body.querySelectorAll('[data-uid]').forEach(x => { x.onclick = () => openUser(x.dataset.uid); });
      body.querySelectorAll('[data-mutual]').forEach(b => {
        b.onclick = async ev => {
          ev.stopPropagation();
          const id = ev.target.dataset.mutual;
          if (!id) return;
          try {
            const d2 = await api.ncm('/user/mutualfollow/get', { uid: id });
            toast(d2.data ? '你们互相关注' : '对方还没有关注你');
          } catch (e) { toast(e.message); }
        };
      });
      cursor = (d.data || {}).cursor || cursor + recs.length;
      body.querySelector('#fwMore')?.remove();
      if ((d.data || {}).more || recs.length >= 30) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="fwMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#fwMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  // 用户状态：读当前状态 + 可选状态列表（/user/social/status{,/rcmd,/support}），写 /user/social/status/edit
  body.innerHTML = skelList(4);
  const [curR, supR, rcmdR] = await Promise.allSettled([
    api.ncm('/user/social/status', { uid }),
    api.ncm('/user/social/status/support'),
    api.ncm('/user/social/status/rcmd'),
  ]);
  const cur = curR.status === 'fulfilled' ? (curR.value.data || {}) : {};
  const support = supR.status === 'fulfilled' ? (supR.value.data || []) : [];
  const rcmd = rcmdR.status === 'fulfilled' ? (rcmdR.value.data || []) : [];
  const options = [].concat(Array.isArray(support) ? support : [], Array.isArray(rcmd) ? rcmd : [])
    .filter(x => x && (x.content || x.type));
  body.innerHTML = `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>我的当前状态</h2><span class="cm-sec-sub">/user/social/status</span></div>
      ${cur.content
        ? `<div class="cm-si-row"><b>${esc(cur.content)}</b><span>${esc(cur.type || '')}</span></div>`
        : '<div class="cm-empty small">还没有设置状态</div>'}
      <div class="cm-pe-acts">
        <mdui-button variant="filled" id="fwSetStatus">设置状态</mdui-button>
        <mdui-button variant="text" id="fwClearStatus">清空</mdui-button>
      </div>
    </section>
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>可用状态</h2>
        <span class="cm-sec-sub">/user/social/status/support · /rcmd</span></div>
      ${options.length ? `<div class="cm-chips">${options.map((o, i) =>
        `<span class="cm-hot" data-i="${i}">${esc(o.content || o.type)}</span>`).join('')}</div>`
      : '<div class="cm-empty small">上游没有返回可用状态</div>'}
    </section>`;

  const setStatus = (content, type, iconUrl = '', actionUrl = '') => api.ncm('/user/social/status/edit', {
    content, type, iconUrl, actionUrl, confirm: 1,
  }).then(() => { toast('状态已更新'); render(el, { tab: 'status' }); })
    .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message));

  body.querySelector('#fwSetStatus').onclick = () => promptDialog({
    title: '设置我的状态', label: '状态文案', value: cur.content || '', placeholder: '如：最近在听歌',
    onOk: v => setStatus(v, cur.type || 'LISTENING', cur.iconUrl || ''),
  });
  body.querySelector('#fwClearStatus').onclick = () => confirmDialog({
    title: '清空状态？', body: '',
    onOk: () => setStatus('', '', ''),
  });
  body.querySelectorAll('[data-i]').forEach(c => {
    c.onclick = () => {
      const o = options[+c.dataset.i];
      setStatus(o.content || '', o.type || '', o.iconUrl || '', o.actionUrl || '');
    };
  });

  /** 网易云用户详情（用 /user/detail 展示，避免直接跳到本地用户路由）。 */
  function openUser(id) {
    if (!id) return;
    const diag = document.createElement('mdui-dialog');
    diag.headline = '用户';
    diag.innerHTML = '<div id="fwUserBox"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>';
    document.body.appendChild(diag);
    diag.open = true;
    api.ncm('/user/detail', { uid: id }).then(d => {
      const p = d.profile || d.data || {};
      const box = diag.querySelector('#fwUserBox');
      box.innerHTML = `
        <div class="cm-detail-head">
          <div class="cm-detail-cover cm-user-ava">${p.avatarUrl ? `<img src="${esc(p.avatarUrl)}?param=200y200">` : ''}</div>
          <div><h2>${esc(p.nickname || '')}</h2>
          <div class="cm-detail-sub">${esc(p.signature || '')}</div>
          <div class="cm-detail-sub">粉丝 ${p.followeds || 0} · 关注 ${p.follows || 0}</div>
          <div class="cm-detail-actions">
            <mdui-button variant="tonal" id="fwFollow">关注 / 取关</mdui-button>
            <mdui-button variant="text" id="fwMutual">是否互关</mdui-button>
          </div></div>
        </div>`;
      box.querySelector('#fwFollow').onclick = () => confirmDialog({
        title: p.followed ? '取消关注这个用户？' : '关注这个用户？',
        body: p.followed ? '取消后不再收到对方的动态。' : '关注后会同步到你的网易云账号。',
        onOk: () => api.ncm('/follow', { id, t: p.followed ? 0 : 1, confirm: 1 })
          .then(() => { toast(p.followed ? '已取消关注' : '已关注'); diag.open = false; })
          .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
      });
      box.querySelector('#fwMutual').onclick = () => api.ncm('/user/mutualfollow/get', { uid: id })
        .then(d2 => toast(d2.data ? '你们互相关注' : '对方还没有关注你'))
        .catch(e => toast(e.message));
    }).catch(e => {
      const box = diag.querySelector('#fwUserBox');
      if (box) box.textContent = `加载失败：${e.message}`;
    });
  }
}
