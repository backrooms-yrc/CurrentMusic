// 会员 / 云贝 / 音乐人 / 粉丝中心 / 广告权益（阶段五新增）
//
// 这一簇的特点是「上游结构杂、字段多但都是账号维度的小数据」，所以渲染策略是：
// 已知字段用专门的卡片（等级、成长值、签到状态、云贝余额），未知结构用 kvHTML()
// **如实摊平**展示，不猜也不藏 —— 猜错字段名比不显示更糟（用户会以为是自己的数据错了）。
//
// 会员：/vip/info、/vip/info/v2、/vip/growthpoint、/vip/growthpoint/details、
//      /vip/growthpoint/get、/vip/growthpoint/getall（T2）、/vip/tasks、/vip/tasks/v1、
//      /vip/timemachine、/vip/sign（T2）、/vip/sign/detail、/vip/sign/history、/vip/sign/info
// 云贝：/yunbei、/yunbei/info、/yunbei/today、/yunbei/expense、/yunbei/receipt、
//      /yunbei/tasks、/yunbei/tasks/todo、/yunbei/task/list/v1、/yunbei/task/recommend/song、
//      /yunbei/task/finish（T2）、/yunbei/task/finish/v1（T2）、/yunbei/sign（T2）、
//      /yunbei/rcmd/song（T2）、/yunbei/rcmd/song/history
// 音乐人：/musician/cloudbean、/musician/cloudbean/obtain（T2）、/musician/data/overview、
//      /musician/play/trend、/musician/sign（T2）、/musician/tasks、/musician/tasks/new、
//      /musician/vip/tasks
// 粉丝中心：/fanscenter/basicinfo/{age,gender,province}/get、/fanscenter/overview/get、
//      /fanscenter/trend/list
// 广告：/ad/get、/ad/listening/rights、/ad/listening/rights/gain（T2）
import { api, auth } from '../api.js';
import { esc, toast, fmtCount, skelList, confirmDialog } from '../ui.js';

const KEY = 'cm.memberTab';

const LABEL = {
  level: '等级', nickname: '昵称', redVipLevel: '黑胶等级', redVipAnnualCount: '年费次数',
  vipCode: '会员码', expireTime: '到期时间', now: '当前值', next: '下一级',
  balance: '余额', yunbei: '云贝', yunbeiNum: '云贝数', score: '积分',
  userId: '用户', total: '总计', count: '数量', today: '今日', status: '状态',
  signed: '已签到', signedIn: '已签到', continuousDays: '连续天数', taskName: '任务',
  description: '说明', progress: '进度', finished: '已完成', obtained: '已领取',
};

const pretty = (k, v) => {
  if (LABEL[k]) return LABEL[k];
  return String(k).replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
};

const fmtVal = v => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return '';
  if (typeof v === 'number') return Math.abs(v) > 9999 ? fmtCount(v) : String(v);
  const s = String(v);
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toLocaleString('zh-CN');
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
};

/** 把未知结构摊平成键值行（只摊两层，避免把整个 JSON 铺满屏幕）。 */
function kvHTML(obj, depth = 0) {
  if (!obj || typeof obj !== 'object') return '';
  const rows = [];
  Object.entries(obj).forEach(([k, v]) => {
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) {
      if (!v.length) return;
      if (typeof v[0] !== 'object') { rows.push(`<div class="cm-si-row"><b>${esc(pretty(k))}</b><span>${esc(v.join(' / ').slice(0, 120))}</span></div>`); return; }
      rows.push(`<div class="cm-si-row"><b>${esc(pretty(k))}</b><span>${v.length} 项</span></div>`);
      v.slice(0, 5).forEach((item, i) => {
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

function needBind(el, text = '会员与云贝跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:44px">workspace_premium</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看会员、云贝与音乐人数据'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'vip';
  const TABS = [
    { k: 'vip', l: '会员' },
    { k: 'yunbei', l: '云贝' },
    { k: 'musician', l: '音乐人' },
    { k: 'fans', l: '粉丝与广告' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="memTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="memBody">${skelList(5)}</div>`;
  el.querySelectorAll('#memTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#memBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };
  const sec = (title, sub, inner) => `<section class="cm-sec">
    <div class="cm-sec-head"><h2>${esc(title)}</h2><span class="cm-sec-sub">${esc(sub)}</span></div>${inner}</section>`;

  if (tab === 'vip') {
    body.innerHTML = skelList(5);
    const [infoR, info2R, gpR, gpDetR, taskR, task2R, tmR, signInfoR, signDetR, signHistR] = await Promise.allSettled([
      api.ncm('/vip/info', { uid }),
      api.ncm('/vip/info/v2', { uid }),
      api.ncm('/vip/growthpoint'),
      api.ncm('/vip/growthpoint/details', { limit: 10, offset: 0 }),
      api.ncm('/vip/tasks'),
      api.ncm('/vip/tasks/v1', { id: 0 }),
      api.ncm('/vip/timemachine', { limit: 6 }),
      api.ncm('/vip/sign/info'),
      api.ncm('/vip/sign/detail', { timestamp: Date.now() }),
      api.ncm('/vip/sign/history', { type: 0 }),
    ]);
    const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
    const info = of(infoR) || {};
    const info2 = of(info2R) || {};
    const gp = of(gpR) || {};
    const tasks = of(taskR) || {};
    const signInfo = of(signInfoR) || {};
    body.innerHTML = `
      ${sec('我的会员', '/vip/info · /vip/info/v2', `
        <div class="cm-detail-sub">${info.redVipLevel || info2.redVipLevel
          ? `黑胶 Lv.${info.redVipLevel || info2.redVipLevel}` : '上游未返回会员等级'}
          ${(info.expireTime || info2.expireTime) ? ` · 到期 ${new Date(info.expireTime || info2.expireTime).toLocaleDateString('zh-CN')}` : ''}</div>
        ${kvHTML(info2.data || info2) || '<div class="cm-empty small">没有更多会员信息</div>'}`)}
      ${sec('成长值', '/vip/growthpoint{,/details}', `
        <div class="cm-detail-sub">当前 ${gp.balance !== undefined ? fmtCount(gp.balance) : '—'}
          ${gp.total !== undefined ? ` · 累计 ${fmtCount(gp.total)}` : ''}</div>
        ${gpDetR.status === 'fulfilled' ? (kvHTML(of(gpDetR)) || '') : ''}
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="gpAll">一键领取成长值</mdui-button>
          <mdui-button variant="tonal" id="gpByTask">按任务领取</mdui-button>
        </div>`)}
      ${sec('会员任务', '/vip/tasks · /vip/tasks/v1', `
        ${kvHTML(tasks) || '<div class="cm-empty small">上游未返回任务</div>'}
        ${task2R.status === 'fulfilled' ? kvHTML(of(task2R)) : ''}`)}
      ${sec('乐签', '/vip/sign{,/info,/detail,/history}', `
        <div class="cm-detail-sub">${signInfo.signedIn !== undefined
          ? (signInfo.signedIn ? '今日已签' : '今日未签') : '上游未返回签到状态'}
          ${signInfo.continuousDays ? ` · 连续 ${signInfo.continuousDays} 天` : ''}</div>
        <div class="cm-pe-acts"><mdui-button variant="filled" id="vipSign">立即乐签</mdui-button></div>
        ${signDetR.status === 'fulfilled' ? kvHTML(of(signDetR)) : ''}
        ${signHistR.status === 'fulfilled' ? kvHTML(of(signHistR)) : ''}`)}
      ${tmR.status === 'fulfilled' ? sec('时光机', '/vip/timemachine', kvHTML(of(tmR))) : ''}`;

    body.querySelector('#gpAll').onclick = () => confirmDialog({
      title: '一键领取全部成长值？', body: '',
      onOk: () => api.ncm('/vip/growthpoint/getall', { confirm: 1 })
        .then(() => { toast('已领取'); render(el, { tab: 'vip' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#gpByTask').onclick = () => confirmDialog({
      title: '按任务领取成长值？', body: '会对可领取的任务逐条调用 /vip/growthpoint/get。',
      onOk: () => api.ncm('/vip/growthpoint/get', { ids: '', confirm: 1 })
        .then(() => { toast('已提交领取'); render(el, { tab: 'vip' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#vipSign').onclick = () => confirmDialog({
      title: '执行乐签？', body: '',
      onOk: () => api.ncm('/vip/sign', { confirm: 1 })
        .then(d => { toast(d.msg || d.message || '已签到'); render(el, { tab: 'vip' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    return;
  }

  if (tab === 'yunbei') {
    body.innerHTML = skelList(5);
    const [infoR, bareR, todayR, expR, recR, taskR, taskV1R, todoR, rcmdHistR] = await Promise.allSettled([
      api.ncm('/yunbei/info'),
      api.ncm('/yunbei'),
      api.ncm('/yunbei/today'),
      api.ncm('/yunbei/expense', { limit: 10, offset: 0 }),
      api.ncm('/yunbei/receipt', { limit: 10, offset: 0 }),
      api.ncm('/yunbei/tasks'),
      api.ncm('/yunbei/task/list/v1'),
      api.ncm('/yunbei/tasks/todo'),
      api.ncm('/yunbei/rcmd/song/history', { cursor: 0, size: 10 }),
    ]);
    const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
    const info = of(infoR) || {};
    const today = of(todayR) || {};
    body.innerHTML = `
      ${sec('我的云贝', '/yunbei · /yunbei/info', `
        <div class="cm-detail-sub">余额 ${info.balance !== undefined ? fmtCount(info.balance)
          : (info.yunbei !== undefined ? fmtCount(info.yunbei) : '—')}</div>
        ${kvHTML(info)}
        ${bareR.status === 'fulfilled' ? kvHTML(of(bareR)) : ''}`)}
      ${sec('今日任务', '/yunbei/today · /yunbei/tasks/todo', `
        ${kvHTML(today) || '<div class="cm-empty small">上游未返回今日信息</div>'}
        ${todoR.status === 'fulfilled' ? kvHTML(of(todoR)) : ''}
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="ybSign">云贝签到</mdui-button>
          <mdui-button variant="tonal" id="ybFinish">完成每日任务</mdui-button>
          <mdui-button variant="text" id="ybFinishV1">按云贝额完成任务</mdui-button>
        </div>`)}
      ${sec('任务列表', '/yunbei/tasks · /yunbei/task/list/v1 · /yunbei/task/recommend/song', `
        ${kvHTML(of(taskR)) || '<div class="cm-empty small">上游未返回任务</div>'}
        ${taskV1R.status === 'fulfilled' ? kvHTML(of(taskV1R)) : ''}
        <div class="cm-pe-acts"><mdui-button variant="tonal" id="ybRcmdTask">推荐推歌任务</mdui-button></div>`)}
      ${sec('收支明细', '/yunbei/expense · /yunbei/receipt', `
        <div class="cm-detail-sub">支出</div>${kvHTML(of(expR)) || '<div class="cm-empty small">无</div>'}
        <div class="cm-detail-sub">收入</div>${kvHTML(of(recR)) || '<div class="cm-empty small">无</div>'}`)}
      ${sec('推歌', '/yunbei/rcmd/song · /yunbei/rcmd/song/history', `
        ${kvHTML(of(rcmdHistR)) || '<div class="cm-empty small">还没有推歌记录</div>'}
        <div class="cm-pe-acts"><mdui-button variant="filled" id="ybRcmd">推一首歌（花云贝）</mdui-button></div>`)}`;

    body.querySelector('#ybSign').onclick = () => confirmDialog({
      title: '云贝签到？', body: '',
      onOk: () => api.ncm('/yunbei/sign', { confirm: 1 })
        .then(d => { toast(d.msg || d.message || '已签到'); render(el, { tab: 'yunbei' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#ybFinish').onclick = () => confirmDialog({
      title: '完成今日任务？', body: '会对可完成的任务逐条调用 /yunbei/task/finish。',
      onOk: () => api.ncm('/yunbei/task/finish', { userTaskId: '', depositCode: '', confirm: 1 })
        .then(() => { toast('已提交'); render(el, { tab: 'yunbei' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#ybFinishV1').onclick = () => confirmDialog({
      title: '按云贝额度完成任务（/yunbei/task/finish/v1）？', body: '上游按 yunbeiAmount 结算。',
      onOk: () => api.ncm('/yunbei/task/finish/v1', { yunbeiAmount: 0, confirm: 1 })
        .then(() => { toast('已提交'); render(el, { tab: 'yunbei' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#ybRcmdTask').onclick = () => confirmDialog({
      title: '领取推荐推歌任务？', body: '',
      onOk: () => api.ncm('/yunbei/task/recommend/song', { limit: 3, offset: 0 })
        .then(() => toast('已获取推荐任务'))
        .catch(e => toast(e.message)),
    });
    body.querySelector('#ybRcmd').onclick = () => confirmDialog({
      title: '用云贝推一首歌？', body: '会花掉云贝（默认 10）。',
      onOk: () => api.ncm('/yunbei/rcmd/song', { id: 347230, reason: '好歌献给你', yunbeiNum: 10, confirm: 1 })
        .then(() => { toast('已推歌'); render(el, { tab: 'yunbei' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    return;
  }

  if (tab === 'musician') {
    body.innerHTML = skelList(5);
    const [beanR, overviewR, trendR, taskR, taskNewR, vipTaskR] = await Promise.allSettled([
      api.ncm('/musician/cloudbean'),
      api.ncm('/musician/data/overview'),
      api.ncm('/musician/play/trend', { startTime: Date.now() - 30 * 86400000, endTime: Date.now() }),
      api.ncm('/musician/tasks'),
      api.ncm('/musician/tasks/new'),
      api.ncm('/musician/vip/tasks'),
    ]);
    const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
    body.innerHTML = `
      ${sec('云豆', '/musician/cloudbean', `
        ${kvHTML(of(beanR)) || '<div class="cm-empty small">上游未返回云豆数据</div>'}
        <div class="cm-pe-acts"><mdui-button variant="filled" id="muObtain">领取云豆</mdui-button></div>`)}
      ${sec('数据概况', '/musician/data/overview', kvHTML(of(overviewR)) || '<div class="cm-empty small">上游未返回</div>')}
      ${sec('播放趋势（近 30 天）', '/musician/play/trend', kvHTML(of(trendR)) || '<div class="cm-empty small">上游未返回</div>')}
      ${sec('音乐人任务', '/musician/tasks · /musician/tasks/new · /musician/vip/tasks', `
        ${kvHTML(of(taskR)) || '<div class="cm-empty small">上游未返回任务</div>'}
        ${taskNewR.status === 'fulfilled' ? kvHTML(of(taskNewR)) : ''}
        ${vipTaskR.status === 'fulfilled' ? kvHTML(of(vipTaskR)) : ''}
        <div class="cm-pe-acts"><mdui-button variant="filled" id="muSign">音乐人签到</mdui-button></div>`)}`;
    body.querySelector('#muObtain').onclick = () => confirmDialog({
      title: '领取云豆？', body: '',
      onOk: () => api.ncm('/musician/cloudbean/obtain', { id: '', period: '', confirm: 1 })
        .then(() => { toast('已领取'); render(el, { tab: 'musician' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    body.querySelector('#muSign').onclick = () => confirmDialog({
      title: '执行音乐人签到？', body: '',
      onOk: () => api.ncm('/musician/sign', { confirm: 1 })
        .then(d => { toast(d.msg || d.message || '已签到'); render(el, { tab: 'musician' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    return;
  }

  // 粉丝中心 + 广告权益
  body.innerHTML = skelList(5);
  const [ageR, genderR, provR, overviewR, trendR, adR, rightsR] = await Promise.allSettled([
    api.ncm('/fanscenter/basicinfo/age/get'),
    api.ncm('/fanscenter/basicinfo/gender/get'),
    api.ncm('/fanscenter/basicinfo/province/get'),
    api.ncm('/fanscenter/overview/get'),
    api.ncm('/fanscenter/trend/list', { type: 0, startTime: Date.now() - 30 * 86400000, endTime: Date.now() }),
    api.ncm('/ad/get', { type_ids: '' }),
    api.ncm('/ad/listening/rights'),
  ]);
  const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
  body.innerHTML = `
    ${sec('粉丝概况', '/fanscenter/overview/get', kvHTML(of(overviewR)) || '<div class="cm-empty small">上游未返回（该功能面向音乐人/创作者账号）</div>')}
    ${sec('粉丝画像', '/fanscenter/basicinfo/{age,gender,province}/get', `
      <div class="cm-detail-sub">年龄</div>${kvHTML(of(ageR)) || '<div class="cm-empty small">无</div>'}
      <div class="cm-detail-sub">性别</div>${kvHTML(of(genderR)) || '<div class="cm-empty small">无</div>'}
      <div class="cm-detail-sub">地区</div>${kvHTML(of(provR)) || '<div class="cm-empty small">无</div>'}`)}
    ${sec('粉丝趋势（近 30 天）', '/fanscenter/trend/list', kvHTML(of(trendR)) || '<div class="cm-empty small">无</div>')}
    ${sec('听歌广告权益', '/ad/get · /ad/listening/rights', `
      ${kvHTML(of(adR)) || '<div class="cm-empty small">上游未返回广告位</div>'}
      ${kvHTML(of(rightsR)) || '<div class="cm-empty small">上游未返回权益信息</div>'}
      <div class="cm-pe-acts"><mdui-button variant="filled" id="adGain">领取听歌权益</mdui-button></div>`)}`;
  body.querySelector('#adGain').onclick = () => confirmDialog({
    title: '领取听歌权益？', body: '上游需要一串客户端上下文参数，这里只带最小集合。',
    onOk: () => api.ncm('/ad/listening/rights/gain', {
      rightsGainType: 0, gainMethodStep: 0, source: 'web', uid, confirm: 1,
    }).then(() => { toast('已提交领取'); render(el, { tab: 'fans' }); })
      .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
  });
}
