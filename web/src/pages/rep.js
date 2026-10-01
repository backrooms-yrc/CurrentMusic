// 网易云「云小编」与审核任务（阶段五新增）
// 曲库贡献 / 考试与任务 / 抽奖 / 审核
//
// 活动：/rep/ugc/activity/get、/rep/ugc/activity/collect（T2）
// 考核：/rep/ugc/exam/info/get、/rep/ugc/exam/question/single/get、/rep/ugc/exam/result/get、
//      /rep/ugc/exam/start（T2）、/rep/ugc/exam/submit（T2）
// 权益：/rep/ugc/user/get、/rep/ugc/user/vip、/rep/ugc/user/collect-vip（T2）、
//      /rep/ugc/user/sign（T2）
// 抽奖：/middle/play/lottery/remain/chance、/middle/play/do/lottery（T2）
// 审核：/thinktank/audit/resource/detail、/thinktank/audit/resource/update（T2）
//
// 这族接口的上游返回结构是"活动驱动的"，字段随活动变化，所以统一用 kvHTML 如实摊平，
// 不硬编码字段名；考试的作答流程按 start → question → submit → result 四步走。
import { api, auth } from '../api.js';
import { esc, toast, skelList, confirmDialog, promptDialog } from '../ui.js';

const KEY = 'cm.repTab';

const pretty = k => String(k).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
const fmtVal = v => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
};
function kvHTML(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return '';
  const rows = [];
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (typeof v[0] !== 'object') { rows.push(`<div class="cm-si-row"><b>${esc(pretty(k))}</b><span>${esc(v.join(' / ').slice(0, 140))}</span></div>`); return; }
      rows.push(`<div class="cm-si-row"><b>${esc(pretty(k))}</b><span>${v.length} 项</span></div>`);
      v.slice(0, 3).forEach((item, i) => {
        const inner = kvHTML(item, depth + 1);
        if (inner) rows.push(`<div class="cm-kv-sub">#${i + 1}${inner}</div>`);
      });
      return;
    }
    if (typeof v === 'object') {
      const inner = kvHTML(v, depth + 1);
      if (inner) rows.push(`<div class="cm-kv-sub"><b>${esc(pretty(k))}</b>${inner}</div>`);
      return;
    }
    rows.push(`<div class="cm-si-row"><b>${esc(pretty(k))}</b><span>${esc(fmtVal(v))}</span></div>`);
  });
  return rows.join('');
}

function needBind(el, text = '云小编与审核任务跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">badge</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看云小编权益与任务'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }

  const tab = params.tab || sessionStorage.getItem(KEY) || 'user';
  const TABS = [
    { k: 'user', l: '我的权益' },
    { k: 'activity', l: '活动' },
    { k: 'exam', l: '考核' },
    { k: 'audit', l: '审核' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="repTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="repBody">${skelList(5)}</div>`;
  el.querySelectorAll('#repTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#repBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };
  const sec = (title, sub, inner) => `<section class="cm-sec">
    <div class="cm-sec-head"><h2>${esc(title)}</h2><span class="cm-sec-sub">${esc(sub)}</span></div>${inner}</section>`;

  if (tab === 'user') {
    body.innerHTML = skelList(4);
    const [uR, vipR, chanceR] = await Promise.allSettled([
      api.ncm('/rep/ugc/user/get'),
      api.ncm('/rep/ugc/user/vip'),
      api.ncm('/middle/play/lottery/remain/chance', { activityId: 0 }),
    ]);
    const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
    body.innerHTML = `
      ${sec('云小编资料', '/rep/ugc/user/get', kvHTML(of(uR)) || '<div class="cm-empty small">上游未返回（该身份面向云小编/曲库贡献者）</div>')}
      ${sec('云小编会员', '/rep/ugc/user/vip', `
        ${kvHTML(of(vipR)) || '<div class="cm-empty small">上游未返回</div>'}
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="repVip">领取云小编会员</mdui-button>
          <mdui-button variant="tonal" id="repSign">云小编签到</mdui-button>
        </div>`)}
      ${sec('抽奖机会', '/middle/play/lottery/remain/chance · /middle/play/do/lottery', `
        ${kvHTML(of(chanceR)) || '<div class="cm-empty small">上游未返回抽奖机会</div>'}
        <div class="cm-pe-acts"><mdui-button variant="filled" id="repDraw">抽一次</mdui-button></div>`)}`;
    body.querySelector('#repVip').onclick = () => confirmDialog({
      title: '领取云小编会员？', body: '',
      onOk: () => api.ncm('/rep/ugc/user/collect-vip', { confirm: 1 })
        .then(() => { toast('已领取'); render(el, { tab: 'user' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#repSign').onclick = () => confirmDialog({
      title: '云小编签到？', body: '',
      onOk: () => api.ncm('/rep/ugc/user/sign', { confirm: 1 })
        .then(() => { toast('已签到'); render(el, { tab: 'user' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#repDraw').onclick = () => promptDialog({
      title: '抽奖', label: '活动 ID（activityId）', placeholder: '如 123456',
      onOk: activityId => api.ncm('/middle/play/do/lottery', { activityId, drawCount: 1, confirm: 1 })
        .then(d => { toast(d.message || d.msg || '已抽奖'); render(el, { tab: 'user' }); })
        .catch(e => toast(e.message)),
    });
    return;
  }

  if (tab === 'activity') {
    body.innerHTML = skelList(4);
    try {
      const d = await api.ncm('/rep/ugc/activity/get');
      const data = d.data || d;
      body.innerHTML = sec('曲库贡献活动', '/rep/ugc/activity/get', `
        ${kvHTML(data) || '<div class="cm-empty small">上游未返回活动</div>'}
        <div class="cm-pe-acts"><mdui-button variant="filled" id="repJoin">报名参加</mdui-button></div>`);
      body.querySelector('#repJoin').onclick = () => promptDialog({
        title: '报名活动', label: '活动 ID（activityId）', placeholder: '如 123456',
        onOk: activityId => api.ncm('/rep/ugc/activity/collect', { activityId, confirm: 1 })
          .then(() => toast('已报名'))
          .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
      });
    } catch (e) { fail(e); }
    return;
  }

  if (tab === 'exam') {
    body.innerHTML = skelList(4);
    let examType = 1;
    const draw = (info, result) => {
      body.innerHTML = sec('考核信息', '/rep/ugc/exam/info/get', `
        ${kvHTML(info) || '<div class="cm-empty small">上游未返回考核信息</div>'}
        <div class="cm-pe-field"><label>考核类型 examType</label><input id="repType" value="${examType}"></div>
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="repStart">开始考核</mdui-button>
          <mdui-button variant="tonal" id="repQ">取一道题</mdui-button>
          <mdui-button variant="tonal" id="repResult">查结果</mdui-button>
        </div>
        ${result ? `<div class="cm-kv-sub"><b>最近一次结果</b>${kvHTML(result)}</div>` : ''}`);
      const type = () => body.querySelector('#repType').value.trim() || '1';
      body.querySelector('#repStart').onclick = () => confirmDialog({
        title: '开始考核？', body: '会消耗一次考核机会（如上游有次数限制）。',
        onOk: () => api.ncm('/rep/ugc/exam/start', { examType: type(), confirm: 1 })
          .then(d => { toast(d.message || d.msg || '已开始'); load(); })
          .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
      });
      body.querySelector('#repQ').onclick = async () => {
        try {
          const d = await api.ncm('/rep/ugc/exam/question/single/get', { examType: type(), taskId: '' });
          const q = d.data || {};
          promptDialog({
            title: q.question || q.title || '题目',
            label: `答案（questionId=${q.questionId || ''}／taskId=${q.taskId || ''}）`,
            onOk: async v => {
              await api.ncm('/rep/ugc/exam/submit', {
                examType: type(), questionId: q.questionId || '', taskId: q.taskId || '',
                answer: v, confirm: 1,
              });
              toast('已提交答案');
            },
          });
        } catch (e) { toast(e.message); }
      };
      body.querySelector('#repResult').onclick = async () => {
        try {
          const d = await api.ncm('/rep/ugc/exam/result/get', { examType: type(), taskId: '' });
          toast(d.message || d.msg || '已获取结果');
          load();
        } catch (e) { toast(e.message); }
      };
    };
    const load = async () => {
      try {
        const [infoR, resR] = await Promise.allSettled([
          api.ncm('/rep/ugc/exam/info/get', { examType }),
          api.ncm('/rep/ugc/exam/result/get', { examType, taskId: '' }),
        ]);
        draw(infoR.status === 'fulfilled' ? (infoR.value.data || infoR.value) : {},
          resR.status === 'fulfilled' ? (resR.value.data || null) : null);
      } catch (e) { fail(e); }
    };
    await load();
    return;
  }

  // 审核任务（thinktank）
  body.innerHTML = skelList(4);
  let type = 1;
  const load = async () => {
    body.innerHTML = '<div class="cm-loading" style="padding:16px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    try {
      const d = await api.ncm('/thinktank/audit/resource/detail', { type });
      const data = d.data || d;
      const list = Array.isArray(data) ? data : (data.list || data.tasks || [data]);
      body.innerHTML = sec('待审资源', '/thinktank/audit/resource/detail', `
        <div class="cm-pe-field"><label>资源类型 type（1 歌手 / 2 专辑 / 3 歌曲 / 4 MV / 5 歌词）</label>
          <input id="repAuditType" value="${type}"></div>
        <div class="cm-pe-acts"><mdui-button variant="tonal" id="repAuditLoad">按类型刷新</mdui-button></div>
        ${list.filter(Boolean).length ? list.filter(Boolean).slice(0, 10).map((t, i) => `
          <div class="cm-kv-sub"><b>#${i + 1} taskId=${esc(String(t.taskId || ''))}</b>
            ${kvHTML(t, 1)}
            <div class="cm-pe-acts">
              <mdui-button variant="tonal" data-pass="${esc(String(t.taskId || ''))}">通过</mdui-button>
              <mdui-button variant="text" data-reject="${esc(String(t.taskId || ''))}">驳回</mdui-button>
            </div></div>`).join('')
        : '<div class="cm-empty small">上游未返回待审任务（该身份面向审核员）</div>'}`);
      body.querySelector('#repAuditLoad').onclick = () => {
        type = Number(body.querySelector('#repAuditType').value.trim() || 1);
        load();
      };
      body.querySelectorAll('[data-pass]').forEach(x => {
        x.onclick = () => judge(x.dataset.pass, 1);
      });
      body.querySelectorAll('[data-reject]').forEach(x => {
        x.onclick = () => judge(x.dataset.reject, 0);
      });
    } catch (e) { fail(e); }
  };
  const judge = (taskId, pass) => confirmDialog({
    title: pass ? `通过任务 ${taskId}？` : `驳回任务 ${taskId}？`, body: '',
    onOk: () => api.ncm('/thinktank/audit/resource/update', {
      taskId, type, judgement: pass, confirm: 1,
    }).then(() => { toast('已提交'); load(); })
      .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
  });
  await load();
}
