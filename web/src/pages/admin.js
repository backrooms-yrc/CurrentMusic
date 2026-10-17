// 管理员面板：概览统计 / 用户管理 / 在线设备 / 系统维护（仅 is_admin 可用）
import { mdui } from '../md.js';
import { api, auth } from '../api.js';
import { esc, toast, confirmDialog, promptDialog, userTags } from '../ui.js';

const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts * 1000), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 120) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (d.toDateString() === now.toDateString()) return '今天 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

let query = '', offset = 0, PAGE = 20;

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-empty">请先登录</div>`;
    return;
  }
  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;

  let ov, users;
  try {
    [ov, users] = await Promise.all([api.adminOverview(), api.adminUsers(query, offset, PAGE)]);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}${e.status === 403 ? '（当前账号不是管理员）' : ''}</div>`;
    return;
  }
  // 角色可能刚被更高角色改过：进面板时顺手刷新本地缓存的当前用户（决定菜单里出现哪些角色操作）
  try { const me = await api.me(); if (me && me.username) auth.saveLogin(auth.token, me); } catch { /* 离线/限流忽略 */ }

  const card = (label, value, sub = '') => `
    <div class="cm-acard"><div class="cm-acard-v">${value}</div><div class="cm-acard-l">${label}</div>${sub ? `<div class="cm-acard-s">${sub}</div>` : ''}</div>`;

  el.innerHTML = `
    <div class="cm-sec-head"><h2>概览</h2><span class="cm-sec-more" id="refresh"><span class="material-icons-outlined">refresh</span> 刷新</span></div>
    <div class="cm-agrid">
      ${card('注册用户', ov.users, `今日 +${ov.usersToday} · 7日 +${ov.usersWeek}`)}
      ${card('在线设备', ov.sessions, `1 小时内活跃用户 ${ov.onlineUsers}`)}
      ${card('禁用账号', ov.disabled, `站长 ${ov.owners || 0} 人 · 超管 ${Math.max(0, (ov.supers || 0) - (ov.owners || 0))} 人 · 管理员 ${Math.max(0, (ov.admins || 0) - (ov.supers || 0))} 人`)}
      ${card('站内点赞', ov.likes)}
      ${card('自建歌单', ov.playlists, `曲目 ${ov.tracks}`)}
      ${card('播放记录', ov.plays)}
      ${card('歌曲缓存', ov.songs, `缓存条目 ${ov.cache}`)}
      ${card('当前版本', ov.release ? 'v' + ov.release.version : '—', ov.release ? '发布于 ' + fmtTime(ov.release.publishedAt) : '')}
    </div>

    <div class="cm-sec-head"><h2>弹窗公告<span id="annCount" class="cm-usub" style="font-weight:400"></span></h2>
      <span class="cm-sec-more" id="annNew"><span class="material-icons-outlined">campaign</span> 发布公告</span></div>
    <div class="cm-annrow-wrap" id="annList"><div class="cm-loading small"><mdui-circular-progress></mdui-circular-progress></div></div>

    <div class="cm-sec-head"><h2>用户管理（${users.total}）</h2>
      <span class="cm-sec-more" id="cacheClear"><span class="material-icons-outlined">cleaning_services</span> 清理缓存</span></div>
    <div class="cm-adminbar">
      <mdui-text-field id="uq" label="搜索 用户名/昵称/邮箱" variant="outlined" clearable value="${esc(query)}" style="flex:1"></mdui-text-field>
    </div>
    <div class="cm-ulist" id="ulist">
      ${users.users.map(u => `
        <div class="cm-urow" data-id="${u.id}">
          <div class="cm-umain">
            <div class="cm-uname">${esc(u.nickname || u.username)}${userTags(u)}
              ${u.disabled ? '<span class="cm-tag banned">已禁用</span>' : ''}
              ${u.username === '__internal__' ? '<span class="cm-tag">内部账户</span>' : ''}
            </div>
            <div class="cm-usub">@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.phone ? ' · ' + esc(u.phone) : ''} · 注册于 ${fmtTime(u.created_at)}</div>
            <div class="cm-usub">赞 ${u.likes} · 歌单 ${u.playlists} · 播放 ${u.plays} · 在线设备 ${u.sessions}${u.bound ? ' · 已绑网易云' : ''}</div>
          </div>
          <span class="cm-uact" data-act="menu" data-id="${u.id}"><span class="material-icons-outlined">more_vert</span></span>
        </div>`).join('') || '<div class="cm-empty small">无匹配用户</div>'}
    </div>
    <div class="cm-pager">
      <mdui-button variant="text" id="prev" ${offset === 0 ? 'disabled' : ''}>上一页</mdui-button>
      <span class="cm-pager-info">${offset + 1}–${Math.min(offset + PAGE, users.total)} / ${users.total}</span>
      <mdui-button variant="text" id="next" ${offset + PAGE >= users.total ? 'disabled' : ''}>下一页</mdui-button>
    </div>

    <div class="cm-sec-head"><h2>在线设备（全部）</h2></div>
    <div class="cm-devlist" id="devAll"><div class="cm-loading small"><mdui-circular-progress></mdui-circular-progress></div></div>`;

  // 交互
  el.querySelector('#refresh').onclick = () => render(el);
  el.querySelector('#prev').onclick = () => { offset = Math.max(0, offset - PAGE); render(el); };
  el.querySelector('#next').onclick = () => { offset += PAGE; render(el); };
  const uq = el.querySelector('#uq');
  let t = null;
  uq.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { query = (uq.value || '').trim(); offset = 0; render(el); }, 450);
  });
  el.querySelector('#cacheClear').onclick = () => confirmDialog({
    title: '清理缓存？', body: '将清除歌词、评论、详情等缓存（不影响音质档位探测缓存）。',
    onOk: async () => {
      const r = await api.adminClearCache('aux');
      toast(`已清理 ${r.cleared} 条缓存`);
      render(el);
    },
  });
  el.querySelectorAll('[data-act="menu"]').forEach(m => {
    m.onclick = () => {
      const id = +m.dataset.id;
      const u = users.users.find(x => x.id === id);
      const meOwner = !!(auth.user && auth.user.isOwner);
      const meSuper = meOwner || !!(auth.user && auth.user.isSuper);
      const self = !!(auth.user && auth.user.id === id);
      // 站长 > 超管 > 管理员：菜单里只给「当前身份管得动」的操作
      let roleActs;
      if (u.is_owner) {
        roleActs = (meOwner && !self)
          ? [{ k: 'unowner', label: '取消站长', icon: 'emoji_events' }]
          : [{ k: 'noowner', label: `站长（${self ? '不能对自己操作' : '仅站长可变更'}）`, icon: 'emoji_events' }];
      } else if (u.is_super) {
        roleActs = [
          ...(meSuper && !self
            ? [{ k: 'unsuper', label: '取消超级管理员', icon: 'workspace_premium' }]
            : [{ k: 'nosuper', label: `超级管理员（${self ? '不能对自己操作' : '仅超管可变更'}）`, icon: 'workspace_premium' }]),
          ...(meOwner ? [{ k: 'owner', label: '设为站长', icon: 'emoji_events' }] : []),
        ];
      } else {
        roleActs = [
          { k: u.is_admin ? 'unadmin' : 'admin', label: u.is_admin ? '取消管理员' : '设为管理员', icon: 'verified_user' },
          ...(meSuper ? [{ k: 'super', label: '设为超级管理员', icon: 'workspace_premium' }] : []),
          ...(meOwner ? [{ k: 'owner', label: '设为站长', icon: 'emoji_events' }] : []),
        ];
      }
      const acts = [
        { k: 'kick', label: u.sessions ? `踢下线（${u.sessions} 台设备）` : '踢下线（无在线设备）', icon: 'logout' },
        { k: 'pw', label: '重置密码', icon: 'password' },
        { k: u.disabled ? 'enable' : 'disable', label: u.disabled ? '解除禁用' : '禁用账号', icon: u.disabled ? 'lock_open' : 'block' },
        { k: 'title', label: u.title ? `修改头衔（当前：${u.title}）` : '设置头衔', icon: 'military_tech' },
        ...roleActs,
      ];
      const diag = mdui.dialog({
        headline: `${u.nickname || u.username}`,
        body: `<div class="cm-qm">${acts.map(a =>
          `<div class="cm-qm-item" data-k="${a.k}"><span class="material-icons-outlined">${a.icon}</span>${a.label}</div>`).join('')}</div>`,
        actions: [{ text: '关闭' }],
      });
      setTimeout(() => {
        diag.querySelectorAll('.cm-qm-item').forEach(it => {
          it.onclick = async () => {
            const k = it.dataset.k;
            diag.open = false;
            try {
              if (k === 'kick') { const r = await api.adminKick(id); toast(`已踢下线（${r.kicked} 个会话）`); render(el); }
              else if (k === 'disable') { await api.adminDisable(id, true); toast('已禁用，其所有会话已作废'); render(el); }
              else if (k === 'enable') { await api.adminDisable(id, false); toast('已解除禁用'); render(el); }
              else if (k === 'admin') { await api.adminSetAdmin(id, true); toast('已设为管理员'); render(el); }
              else if (k === 'nosuper') { toast('超级管理员只能由超管/站长变更，且不能对自己操作'); }
              else if (k === 'super') { await api.adminSetSuper(id, true); toast('已设为超级管理员'); render(el); }
              else if (k === 'unsuper') { await api.adminSetSuper(id, false); toast('已取消超级管理员'); render(el); }
              else if (k === 'noowner') { toast('站长只能由站长变更，且不能对自己操作'); }
              else if (k === 'owner') { await api.adminSetOwner(id, true); toast('已设为站长'); render(el); }
              else if (k === 'unowner') { await api.adminSetOwner(id, false); toast('已取消站长，回落为超级管理员'); render(el); }
              else if (k === 'unadmin') { await api.adminSetAdmin(id, false); toast('已取消管理员'); render(el); }
              else if (k === 'title') {
                const max = ov.titleMax || 16;
                promptDialog({
                  title: `设置「${u.nickname || u.username}」的头衔`,
                  label: `头衔（最多 ${max} 字，留空 = 取消）`, value: u.title || '',
                  allowEmpty: true, maxlength: max,
                  onOk: async t => { const r = await api.adminSetTitle(id, t); toast(r.title ? `头衔已设为「${r.title}」` : '已取消头衔'); render(el); },
                });
              }
              else if (k === 'pw') {
                promptDialog({
                  title: `重置「${u.username}」的密码`, label: '新密码（6~64 位）', type: 'password',
                  onOk: async pw => { await api.adminResetPassword(id, pw); toast('密码已重置，该用户需重新登录'); render(el); },
                });
              }
            } catch (e) { toast(e.message); }
          };
        });
      }, 0);
    };
  });
  // ---------- 弹窗公告 ----------
  const renderAnn = async () => {
    const box = el.querySelector('#annList');
    if (!box) return;
    let d;
    try {
      d = await api.adminAnnouncements();
    } catch (e) {
      box.innerHTML = `<div class="cm-empty small">公告加载失败：${esc(e.message)}</div>`;
      return;
    }
    const items = d.items || [];
    const live = items.filter(a => !a.removed).length;
    const c = el.querySelector('#annCount');
    if (c) c.textContent = `　${live} 条生效${items.length > live ? ` · ${items.length - live} 条已移除` : ''}${d.isOwner ? ' · 你是站长，可编辑全部' : d.isSuper ? ' · 你是超管，可编辑全部' : ''}`;
    box.innerHTML = items.length ? items.map(a => `
      <div class="cm-annrow${a.removed ? ' gone' : ''}" data-id="${a.id}">
        <div class="cm-annrow-main">
          <div class="cm-annrow-title">
            ${a.pinned && !a.removed ? '<span class="cm-tag admin">置顶</span>' : ''}
            ${a.removed ? '<span class="cm-tag banned">已移除</span>' : ''}
            ${esc(a.title)}
          </div>
          <div class="cm-annrow-sub">${esc(a.author || '—')} · 发布于 ${fmtTime(a.createdAt)}${a.updatedAt > a.createdAt ? ` · 修改于 ${fmtTime(a.updatedAt)}` : ''}${a.link ? ' · <span class="material-icons-outlined">link</span>带链接' : ''}</div>
          <div class="cm-annrow-body">${esc((a.body || '').replace(/\s+/g, ' ').slice(0, 160))}</div>
        </div>
        <div class="cm-annacts">
          ${a.canEdit ? `
            ${a.removed
              ? '<span class="material-icons-outlined" data-act="restore" title="恢复">restore_from_trash</span>'
              : `<span class="material-icons-outlined${a.pinned ? ' on' : ''}" data-act="pin" title="${a.pinned ? '取消置顶' : '置顶'}">push_pin</span>`}
            <span class="material-icons-outlined" data-act="edit" title="编辑">edit</span>
            ${a.removed ? '' : '<span class="material-icons-outlined" data-act="remove" title="移除">delete</span>'}
          ` : '<span class="cm-tag">他人发布</span>'}
        </div>
      </div>`).join('') : '<div class="cm-empty small">还没有公告。发布一条，客户端下次打开就会弹窗。</div>';

    box.querySelectorAll('.cm-annrow').forEach(row => {
      const a = items.find(x => String(x.id) === row.dataset.id);
      row.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          try {
            if (act === 'pin') { await api.pinAnnouncement(a.id, !a.pinned); toast(a.pinned ? '已取消置顶' : '已置顶'); renderAnn(); }
            else if (act === 'restore') { await api.restoreAnnouncement(a.id); toast('已恢复，客户端将重新看到'); renderAnn(); }
            else if (act === 'remove') { await api.removeAnnouncement(a.id); toast('已移除'); renderAnn(); }
            else if (act === 'edit') annDialog(a);
          } catch (e) { toast(e.message); }
        };
      });
    });
  };

  const annDialog = a => {
    const isNew = !a;
    const d = a || { title: '', body: '', link: '', pinned: false };
    const diag = mdui.dialog({
      headline: isNew ? '发布公告' : '编辑公告',
      body: `<div class="cm-form" style="display:flex;flex-direction:column;gap:12px">
        <mdui-text-field id="annTitle" label="标题" variant="outlined" value="${esc(d.title)}" maxlength="60" style="width:100%"></mdui-text-field>
        <mdui-text-field id="annBody" label="正文（支持 Markdown）" variant="outlined" type="textarea" rows="6" value="${esc(d.body)}" style="width:100%"></mdui-text-field>
        <mdui-text-field id="annLink" label="详情链接（可选，http/https）" variant="outlined" value="${esc(d.link)}" style="width:100%"></mdui-text-field>
        <div class="cm-more-s" style="opacity:.7">客户端每次打开网页 / App 都会弹窗展示生效中的公告，置顶排最前。</div>
      </div>`,
      actions: [
        { text: '取消' },
        {
          text: isNew ? '发布' : '保存',
          onClick: () => {
            (async () => {
              const payload = {
                title: (diag.querySelector('#annTitle').value || '').trim(),
                body: (diag.querySelector('#annBody').value || '').trim(),
                link: (diag.querySelector('#annLink').value || '').trim(),
                pinned: !!d.pinned,
              };
              if (!payload.title) { toast('请填写标题'); return; }
              try {
                if (isNew) await api.createAnnouncement(payload);
                else await api.updateAnnouncement(d.id, payload);
                toast(isNew ? '已发布，客户端下次打开即可看到' : '已保存');
                diag.open = false;
                renderAnn();
              } catch (e) { toast(e.message); }
            })();
            return false;   // 同步返回 false：mdui 不会因为 Promise 自动关窗
          },
        },
      ],
    });
    setTimeout(() => diag.querySelector('#annTitle')?.focus?.(), 200);
  };

  el.querySelector('#annNew').onclick = () => annDialog(null);
  renderAnn();

  // 在线设备
  api.adminSessions().then(d => {
    const box = el.querySelector('#devAll');
    if (!box) return;
    box.innerHTML = (d.sessions || []).map(s => `
      <div class="cm-dev">
        <span class="material-icons-outlined">${s.platform === 'web' ? 'language' : 'smartphone'}</span>
        <div class="cm-dev-main">
          <div>${esc(s.nickname || s.username)} <span class="cm-usub">@${esc(s.username)}</span></div>
          <div class="cm-dev-sub">${esc(s.device)} · 登录于 ${fmtTime(s.created_at)} · ${fmtTime(s.last_seen)}</div>
        </div>
        <span class="cm-dev-kick" data-sid="${s.id}" data-uid="${s.user_id}">踢出</span>
      </div>`).join('') || '<div class="cm-empty small">无在线设备</div>';
    box.querySelectorAll('.cm-dev-kick').forEach(k => {
      k.onclick = async () => {
        try {
          await api.adminKick(+k.dataset.uid);
          toast('该用户所有设备已下线');
          render(el);
        } catch (e) { toast(e.message); }
      };
    });
  }).catch(() => { const b = el.querySelector('#devAll'); if (b) b.innerHTML = '<div class="cm-empty small">设备列表加载失败</div>'; });
}
