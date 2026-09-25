// 管理员面板：概览统计 / 用户管理 / 在线设备 / 系统维护（仅 is_admin 可用）
import { mdui } from '../md.js';
import { api, auth } from '../api.js';
import { esc, toast, confirmDialog, promptDialog } from '../ui.js';

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

  const card = (label, value, sub = '') => `
    <div class="cm-acard"><div class="cm-acard-v">${value}</div><div class="cm-acard-l">${label}</div>${sub ? `<div class="cm-acard-s">${sub}</div>` : ''}</div>`;

  el.innerHTML = `
    <div class="cm-sec-head"><h2>概览</h2><span class="cm-sec-more" id="refresh"><span class="material-icons-outlined">refresh</span> 刷新</span></div>
    <div class="cm-agrid">
      ${card('注册用户', ov.users, `今日 +${ov.usersToday} · 7日 +${ov.usersWeek}`)}
      ${card('在线设备', ov.sessions, `1 小时内活跃用户 ${ov.onlineUsers}`)}
      ${card('禁用账号', ov.disabled, `管理员 ${ov.admins} 人`)}
      ${card('站内点赞', ov.likes)}
      ${card('自建歌单', ov.playlists, `曲目 ${ov.tracks}`)}
      ${card('播放记录', ov.plays)}
      ${card('歌曲缓存', ov.songs, `缓存条目 ${ov.cache}`)}
      ${card('当前版本', ov.release ? 'v' + ov.release.version : '—', ov.release ? '发布于 ' + fmtTime(ov.release.publishedAt) : '')}
    </div>

    <div class="cm-sec-head"><h2>用户管理（${users.total}）</h2>
      <span class="cm-sec-more" id="cacheClear"><span class="material-icons-outlined">cleaning_services</span> 清理缓存</span></div>
    <div class="cm-adminbar">
      <mdui-text-field id="uq" label="搜索 用户名/昵称/邮箱" variant="outlined" clearable value="${esc(query)}" style="flex:1"></mdui-text-field>
    </div>
    <div class="cm-ulist" id="ulist">
      ${users.users.map(u => `
        <div class="cm-urow" data-id="${u.id}">
          <div class="cm-umain">
            <div class="cm-uname">${esc(u.nickname || u.username)}
              ${u.is_admin ? '<span class="cm-tag admin">管理员</span>' : ''}
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
      const acts = [
        { k: 'kick', label: u.sessions ? `踢下线（${u.sessions} 台设备）` : '踢下线（无在线设备）', icon: 'logout' },
        { k: 'pw', label: '重置密码', icon: 'password' },
        { k: u.disabled ? 'enable' : 'disable', label: u.disabled ? '解除禁用' : '禁用账号', icon: u.disabled ? 'lock_open' : 'block' },
        { k: u.is_admin ? 'unadmin' : 'admin', label: u.is_admin ? '取消管理员' : '设为管理员', icon: 'verified_user' },
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
              else if (k === 'unadmin') { await api.adminSetAdmin(id, false); toast('已取消管理员'); render(el); }
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
