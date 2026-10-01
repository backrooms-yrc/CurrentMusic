// 动态与话题（阶段四新增）
// 读：/event（动态广场）、/topic/detail（话题详情）、/topic/detail/event/hot（话题热动态）、
//    /topic/sublist（我订阅的话题）、/user/event、/user/event/all（我的动态）、
//    /user/comment/history（我的评论历史）
// 写：/event/forward（转发）、/event/del（删除）、/event/privacy（改可见性）—— 均 T2
import { api, auth } from '../api.js';
import { esc, toast, skelList, confirmDialog, fmtCount } from '../ui.js';

const KEY = 'cm.evTab';

const fmtTime = ts => {
  const n = Number(ts);
  if (!n) return '';
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 动态正文在 `json` 字段里是**字符串**（不是对象），要再解一层。 */
function eventBody(ev) {
  try {
    const j = typeof ev.json === 'string' ? JSON.parse(ev.json) : (ev.json || {});
    return j.msg || j.text || j.title || '';
  } catch { return ''; }
}

function eventPics(ev) {
  return (ev.pics || []).map(p => p.originUrl || p.squareUrl || p.url).filter(Boolean).slice(0, 9);
}

function eventCard(ev, { mine = false, onAction } = {}) {
  const u = ev.user || {};
  const body = eventBody(ev);
  const pics = eventPics(ev);
  const info = ev.info || {};
  return `
    <div class="cm-ev-card" data-id="${ev.id || ''}" data-privacy="${ev.privacySetting ?? ''}" data-thread="${esc(ev.threadId || (info.commentThread && info.commentThread.id) || '')}">
      <div class="cm-ev-head">
        <div class="cm-msg-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=80y80" loading="lazy" onerror="this.remove()">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div class="cm-msg-main">
          <div class="cm-msg-name">${esc(u.nickname || '')}</div>
          <div class="cm-msg-sub">${fmtTime(ev.showTime || ev.eventTime)}${ev.actName ? ` · ${esc(ev.actName)}` : ''}</div>
        </div>
        ${mine ? '<span class="cm-si-act" data-privacy="1">可见性</span><span class="cm-si-act" data-del="1">删除</span>' : ''}
      </div>
      ${body ? `<div class="cm-ev-text">${esc(body)}</div>` : ''}
      ${pics.length ? `<div class="cm-ev-pics">${pics.map(p => `<img src="${esc(p)}?param=300y300" loading="lazy" onerror="this.remove()">`).join('')}</div>` : ''}
      <div class="cm-ev-foot">
        <span>${fmtCount(info.likedCount || 0)} 赞</span>
        <span>${fmtCount(info.commentCount || 0)} 评论</span>
        <span>${fmtCount(ev.forwardCount || 0)} 转发</span>
        ${ev.actId ? `<span class="cm-si-act" data-topic="${ev.actId}">话题</span>` : ''}
        <span class="cm-si-act" data-cmt="1">评论</span>
        <span class="cm-si-act" data-fwd="1">转发</span>
      </div>
    </div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">dynamic_feed</span>
      <div>动态与话题跟你的网易云账号绑定，请先登录并绑定网易云</div>
      <mdui-button variant="filled" href="#/user">去绑定</mdui-button></div>`;
    return;
  }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">dynamic_feed</span>
      <div>动态与话题跟你的网易云账号绑定，请先绑定</div>
      <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
    return;
  }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'square';
  const TABS = [
    { k: 'square', l: '动态广场' },
    { k: 'topic', l: '我的话题' },
    { k: 'mine', l: '我的动态' },
    { k: 'history', l: '评论历史' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="evTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="evBody">${skelList(6)}</div>`;
  el.querySelectorAll('#evTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#evBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  /** 绑定卡片上的动作：评论 / 转发 / 删除 / 看话题。 */
  const bindCard = (scope, { mine = false } = {}) => {
    scope.querySelectorAll('[data-cmt]').forEach(x => {
      x.onclick = () => {
        const card = x.closest('.cm-ev-card');
        import('../comments.js')
          .then(m => m.openComments({ type: 6, id: card.dataset.thread, title: '动态评论' }))
          .catch(() => toast('评论加载失败'));
      };
    });
    scope.querySelectorAll('[data-fwd]').forEach(x => {
      x.onclick = () => {
        const card = x.closest('.cm-ev-card');
        confirmDialog({
          title: '转发这条动态？', body: '会转发到你的网易云动态。',
          onOk: () => api.ncm('/event/forward', { evId: card.dataset.id, uid, forwards: '[]', confirm: 1 })
            .then(() => toast('已转发'))
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    scope.querySelectorAll('[data-privacy]').forEach(x => {
      x.onclick = () => {
        const card = x.closest('.cm-ev-card');
        // 上游 privacy: 0 公开 / 1 仅自己可见（同一条动态再次调用即切换）
        const to = (card.dataset.privacy === '1') ? 0 : 1;
        confirmDialog({
          title: to === 1 ? '把这条动态改为「仅自己可见」？' : '把这条动态改为公开？', body: '',
          onOk: () => api.ncm('/event/privacy', { evId: card.dataset.id, privacy: to, confirm: 1 })
            .then(() => { card.dataset.privacy = String(to); toast('可见性已更新'); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    scope.querySelectorAll('[data-del]').forEach(x => {
      x.onclick = () => {
        const card = x.closest('.cm-ev-card');
        confirmDialog({
          title: '删除这条动态？', body: '删除后不可恢复。',
          onOk: () => api.ncm('/event/del', { evId: card.dataset.id, confirm: 1 })
            .then(() => { card.remove(); toast('已删除'); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    scope.querySelectorAll('[data-topic]').forEach(x => {
      x.onclick = () => openTopic(x.dataset.topic);
    });
    void mine;
  };

  if (tab === 'square') {
    let lasttime = 0;
    const load = async append => {
      if (!append) body.innerHTML = skelList(6);
      let d;
      try { d = await api.ncm('/event', { pagesize: 20, lasttime }); } catch (e) { fail(e); return; }
      const list = d.event || [];
      if (!append) body.innerHTML = '';
      if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">暂时没有动态</div>'; return; }
      body.insertAdjacentHTML('beforeend', list.map(ev => eventCard(ev)).join(''));
      bindCard(body);
      lasttime = d.lasttime || (list[list.length - 1] || {}).showTime || lasttime;
      body.querySelector('#evMore')?.remove();
      if (d.more && list.length) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="evMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#evMore mdui-button').onclick = async ev2 => {
          const btn = ev2.currentTarget;
          btn.loading = true;
          try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  if (tab === 'topic') {
    let offset = 0;
    body.innerHTML = skelList(4);
    try {
      const d = await api.ncm('/topic/sublist', { limit: 30, offset });
      const list = d.data || [];
      body.innerHTML = list.length
        ? `<div class="cm-plgrid">${list.map(t => `
            <div class="cm-plcard" data-act="${t.actId || t.id}">
              <div class="cm-plcover">${(t.coverUrl || t.picUrl) ? `<img src="${esc(t.coverUrl || t.picUrl)}?param=300y300" loading="lazy">` : '<span class="material-icons-outlined">tag</span>'}</div>
              <div class="cm-plname">${esc(t.name || t.title || '')}</div>
              <div class="cm-plsub">${t.participateCount ? fmtCount(t.participateCount) + ' 人参与' : ''}</div>
            </div>`).join('')}</div>`
        : '<div class="cm-empty small">还没有订阅话题（上游该维度常为空）</div>';
      body.querySelectorAll('[data-act]').forEach(c => { c.onclick = () => openTopic(c.dataset.act); });
    } catch (e) { fail(e); }
    return;
  }

  if (tab === 'mine') {
    // 我的动态：/user/event（最近）+ /user/event/all（全部，用于取回不可见/历史）
    body.innerHTML = skelList(4);
    const [recentR, allR] = await Promise.allSettled([
      api.ncm('/user/event', { uid, limit: 30, lasttime: 0 }),
      api.ncm('/user/event/all'),
    ]);
    const events = [];
    const push = arr => arr.forEach(ev => { if (ev && ev.id && !events.some(x => x.id === ev.id)) events.push(ev); });
    if (recentR.status === 'fulfilled') push(recentR.value.events || []);
    if (allR.status === 'fulfilled') push(allR.value.events || []);
    body.innerHTML = events.length
      ? events.map(ev => eventCard(ev, { mine: true })).join('')
      : '<div class="cm-empty small">还没有发过动态</div>';
    bindCard(body, { mine: true });
    return;
  }

  // 评论历史（/user/comment/history）
  let time = 0;
  const load = async append => {
    let d;
    try { d = await api.ncm('/user/comment/history', { uid, limit: 20, time }); } catch (e) { fail(e); return; }
    const data = d.data || {};
    const list = data.comments || [];
    if (!append) body.innerHTML = '';
    if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">还没有评论记录</div>'; return; }
    body.insertAdjacentHTML('beforeend', list.map(c => `
      <div class="cm-lm-item">
        <div class="cm-lm-lyric">${esc(c.content || '')}</div>
        <div class="cm-lm-meta"><span>${esc(c.resourceType === 4 ? '动态' : c.resourceType === 6 ? '话题' : `类型 ${c.resourceType}`)}</span>
        <span>${fmtTime(c.time)}</span></div>
      </div>`).join(''));
    time = list[list.length - 1].time || time;
    body.querySelector('#evMore')?.remove();
    if (data.hasMore && list.length) {
      body.insertAdjacentHTML('beforeend',
        '<div class="cm-sq-more" id="evMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
      body.querySelector('#evMore mdui-button').onclick = async ev2 => {
        const btn = ev2.currentTarget;
        btn.loading = true;
        try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
      };
    }
  };
  await load(false);
}

/** 话题详情抽屉：/topic/detail 给资料，/topic/detail/event/hot 给热动态。 */
function openTopic(actid) {
  if (!actid) return;
  const diag = document.createElement('mdui-dialog');
  diag.headline = '话题';
  diag.style.setProperty('--mdui-dialog-width', 'min(600px, 94vw)');
  diag.innerHTML = '<div id="evTopicBox" style="max-height:62vh;overflow:auto"><div class="cm-loading" style="padding:20px 0"><mdui-circular-progress></mdui-circular-progress></div></div>';
  document.body.appendChild(diag);
  diag.open = true;
  const box = diag.querySelector('#evTopicBox');
  Promise.allSettled([
    api.ncm('/topic/detail', { actid }),
    api.ncm('/topic/detail/event/hot', { actid }),
  ]).then(([detR, hotR]) => {
    const act = detR.status === 'fulfilled' ? (detR.value.act || {}) : {};
    const events = hotR.status === 'fulfilled' ? (hotR.value.events || []) : [];
    box.innerHTML = `
      <div class="cm-ev-text" style="font-weight:650">${esc(act.title || '话题')}</div>
      ${act.description ? `<div class="cm-al-desc">${esc(act.description)}</div>` : ''}
      <div class="cm-detail-sub">${act.participateCount ? fmtCount(act.participateCount) + ' 人参与' : ''} ${act.readCount ? `· ${fmtCount(act.readCount)} 阅读` : ''}</div>
      <div class="cm-sec-head" style="margin-top:12px"><h2>热动态</h2></div>
      ${events.length ? events.slice(0, 10).map(ev => eventCard(ev)).join('') : '<div class="cm-empty small">暂无热动态</div>'}`;
    box.querySelectorAll('[data-cmt]').forEach(x => {
      x.onclick = () => {
        const card = x.closest('.cm-ev-card');
        import('../comments.js')
          .then(m => m.openComments({ type: 6, id: card.dataset.thread, title: '动态评论' }))
          .catch(() => toast('评论加载失败'));
      };
    });
  }).catch(e => {
    if (box) box.textContent = `话题加载失败：${e.message}`;
  });
}
