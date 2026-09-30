// 网易云账号资料 / 签到 / 设备管理（阶段四新增）
// 资料：/user/account、/user/detail、/user/detail/new、/user/level、/user/medal、
//      /user/subcount、/user/binding、/nickname/check、/cellphone/existence/check
// 写：  /user/update（改资料）、/avatar/upload（换头像，走 multipart 上传通道）、
//      /activate/init/profile（初始化昵称）—— 均 T2
// 签到：/sign/happy/info、/signin/progress（moduleId 取自前者）、/daily_signin（T2）
// 设备：/device/list、/device/kickoff（T2 下线）、/deviceinfo/center/upload（T2 上报本机）
import { api, auth } from '../api.js';
import { esc, toast, fmtCount, skelList, promptDialog, confirmDialog } from '../ui.js';

const KEY = 'cm.acctTab';

function needBind(el, text = '账号资料跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:44px">manage_accounts</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  if (!auth.token) { needBind(el, '登录后可查看网易云账号资料'); return; }
  let bind = { bound: false };
  try { bind = await api.bindStatus(); } catch { /* 未绑定 */ }
  if (!bind.bound) { needBind(el); return; }
  const uid = bind.profile && bind.profile.uid;

  const tab = params.tab || sessionStorage.getItem(KEY) || 'profile';
  const TABS = [
    { k: 'profile', l: '资料' },
    { k: 'sign', l: '签到' },
    { k: 'device', l: '设备' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="acTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="acBody">${skelList(6)}</div>`;
  el.querySelectorAll('#acTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#acBody');
  const fail = e => {
    body.innerHTML = /绑定|401/.test(e.message || '')
      ? '<div class="cm-empty">需先绑定网易云账号</div>'
      : `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
  };

  if (tab === 'profile') {
    body.innerHTML = skelList(6);
    // /user/account 给账号本体（userName/创建时间/状态），/user/detail 给资料，
    // /user/detail/new 给听歌数/等级点，三者互补，缺一个不影响其余渲染
    const [acctR, detR, newR, lvlR, medalR, subR, bindR] = await Promise.allSettled([
      api.ncm('/user/account'),
      api.ncm('/user/detail', { uid }),
      api.ncm('/user/detail/new', { uid }),
      api.ncm('/user/level'),
      api.ncm('/user/medal', { uid }),
      api.ncm('/user/subcount'),
      api.ncm('/user/binding', { uid }),
    ]);
    const of = (r, k) => (r.status === 'fulfilled' ? (r.value[k] || r.value.data || {}) : {});
    const acct = of(acctR, 'account');
    const profile = (detR.status === 'fulfilled' && detR.value.profile) || of(newR, 'profile') || {};
    const newd = newR.status === 'fulfilled' ? (newR.value || {}) : {};
    const lvl = lvlR.status === 'fulfilled' ? (lvlR.value.data || {}) : {};
    const medal = medalR.status === 'fulfilled' ? (medalR.value.data || {}) : {};
    const sub = subR.status === 'fulfilled' ? (subR.value || {}) : {};
    const bindings = bindR.status === 'fulfilled' ? (bindR.value.bindings || []) : [];

    const subBits = [
      ['歌单', sub.playlistCount], ['MV', sub.mvCount], ['歌手', sub.artistCount],
      ['电台', sub.djRadioCount], ['节目', sub.programCount], ['云盘', sub.cloudDiskCount],
    ].filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${fmtCount(v)}`);

    body.innerHTML = `
      <div class="cm-detail-head">
        <div class="cm-detail-cover cm-user-ava">${profile.avatarUrl ? `<img src="${esc(profile.avatarUrl)}?param=200y200" onerror="this.remove()">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div>
          <h2>${esc(profile.nickname || (bind.profile && bind.profile.nickname) || '')}</h2>
          <div class="cm-detail-sub">${esc(profile.signature || '')}</div>
          <div class="cm-detail-sub">Lv.${lvl.level || profile.level || '-'}${newd.listenSongs ? ` · 累计听歌 ${fmtCount(newd.listenSongs)} 首` : ''}${medal.medalNum ? ` · 勋章 ${medal.medalNum}` : ''}</div>
          <div class="cm-detail-actions">
            <mdui-button variant="filled" id="acEdit">编辑资料</mdui-button>
            <mdui-button variant="tonal" id="acAvatar">换头像</mdui-button>
            <mdui-button variant="text" id="acInit">初始化昵称</mdui-button>
          </div>
        </div>
      </div>
      <input type="file" id="acAvatarFile" accept="image/png,image/jpeg,image/webp" hidden>

      <section class="cm-sec">
        <div class="cm-sec-head"><h2>账号</h2><span class="cm-sec-sub">/user/account</span></div>
        <div class="cm-si-row"><b>登录名</b><span>${esc(acct.userName || '')}</span></div>
        <div class="cm-si-row"><b>状态</b><span>${acct.status === 0 ? '正常' : esc(String(acct.status))}</span></div>
        <div class="cm-si-row"><b>注册时间</b><span>${acct.createTime ? new Date(acct.createTime).toLocaleDateString('zh-CN') : ''}</span></div>
        ${newd.userPoint && newd.userPoint.balance !== undefined ? `<div class="cm-si-row"><b>云贝余额</b><span>${fmtCount(newd.userPoint.balance)}</span></div>` : ''}
      </section>

      <section class="cm-sec">
        <div class="cm-sec-head"><h2>收藏统计</h2><span class="cm-sec-sub">/user/subcount</span></div>
        <div class="cm-detail-sub">${esc(subBits.join(' · ') || '上游未返回统计')}</div>
      </section>

      <section class="cm-sec">
        <div class="cm-sec-head"><h2>等级进度</h2><span class="cm-sec-sub">/user/level</span></div>
        ${lvl.level ? `
          <div class="cm-si-row"><b>Lv.${lvl.level}</b><span>${Math.round((lvl.progress || 0) * 100)}%</span></div>
          <div class="cm-si-row"><b>听歌</b><span>${lvl.nowPlayCount || 0} / ${lvl.nextPlayCount || '-'}</span></div>
          <div class="cm-si-row"><b>登录</b><span>${lvl.nowLoginCount || 0} / ${lvl.nextLoginCount || '-'}</span></div>
          ${lvl.info ? `<div class="cm-al-desc">${esc(String(lvl.info).split('$').join(' · '))}</div>` : ''}`
        : '<div class="cm-empty small">上游未返回等级</div>'}
      </section>

      <section class="cm-sec">
        <div class="cm-sec-head"><h2>勋章</h2><span class="cm-sec-sub">/user/medal</span></div>
        ${(medal.obtainMedals || []).length ? `<div class="cm-hscroll">${(medal.obtainMedals || []).map(m => `
          <div class="cm-card cm-medal">
            <img src="${esc(m.medalPicUrl || '')}?param=200y200" loading="lazy" onerror="this.classList.add('none')">
            <div class="cm-card-name">${esc(m.medalName || '')}</div>
          </div>`).join('')}</div>`
        : '<div class="cm-empty small">还没有勋章</div>'}
      </section>

      <section class="cm-sec">
        <div class="cm-sec-head"><h2>绑定关系</h2><span class="cm-sec-sub">/user/binding</span></div>
        ${bindings.length ? bindings.map(b => {
          let extra = {};
          try { extra = JSON.parse(b.tokenJsonStr || '{}'); } catch { /* 保留空 */ }
          return `<div class="cm-si-row"><b>${esc(b.type === 1 ? '手机' : b.type === 2 ? '邮箱' : `类型 ${b.type}`)}</b>
            <span>${esc(extra.cellphone || extra.email || '已绑定')}</span></div>`;
        }).join('') : '<div class="cm-empty small">上游未返回绑定关系</div>'}
      </section>`;

    // 编辑资料：昵称先查重（/nickname/check），重复时给出上游候选名
    body.querySelector('#acEdit').onclick = () => openEdit(profile);
    // 换头像：走 api.ncmUpload → 后端白名单 → multipart（复用 P3 建的上传通道）
    body.querySelector('#acAvatar').onclick = () => body.querySelector('#acAvatarFile').click();
    body.querySelector('#acAvatarFile').onchange = async ev => {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      const btn = body.querySelector('#acAvatar');
      btn.loading = true;
      try {
        await api.ncmUpload('/avatar/upload', {}, file);
        toast('头像已更新');
        render(el, { tab: 'profile' });
      } catch (e) {
        toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
      } finally { btn.loading = false; ev.target.value = ''; }
    };
    body.querySelector('#acInit').onclick = () => promptDialog({
      title: '初始化昵称', label: '新昵称', placeholder: '仅首次设置可用',
      onOk: nickname => api.ncm('/activate/init/profile', { nickname, confirm: 1 })
        .then(() => { toast('已提交'); render(el, { tab: 'profile' }); })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });

    /** 资料编辑抽屉：昵称走查重，其余字段一次提交 /user/update。 */
    function openEdit(p) {
      const diag = document.createElement('mdui-dialog');
      diag.headline = '编辑资料';
      diag.innerHTML = `
        <div class="cm-pe-field"><label>昵称</label><input id="acNick" value="${esc(p.nickname || '')}"></div>
        <div class="cm-pe-hint" id="acNickHint"></div>
        <div class="cm-pe-field"><label>个签</label><input id="acSign" value="${esc(p.signature || '')}"></div>
        <div class="cm-pe-field"><label>性别（0 女 / 1 男 / 2 保密）</label><input id="acGender" value="${p.gender ?? ''}"></div>
        <div class="cm-pe-field"><label>生日（如 1995-06-01）</label><input id="acBirth" value="${p.birthday ? new Date(p.birthday).toISOString().slice(0, 10) : ''}"></div>
        <div class="cm-pe-field"><label>省份 ID（可留空）</label><input id="acProv" value="${p.province || ''}"></div>
        <div class="cm-pe-acts">
          <mdui-button variant="tonal" id="acCheckNick">查重昵称</mdui-button>
          <mdui-button variant="filled" id="acSave">保存</mdui-button>
        </div>`;
      document.body.appendChild(diag);
      diag.open = true;
      diag.querySelector('#acCheckNick').onclick = async () => {
        const nickname = diag.querySelector('#acNick').value.trim();
        if (!nickname) return toast('先填昵称');
        const hint = diag.querySelector('#acNickHint');
        hint.textContent = '查询中…';
        try {
          const d = await api.ncm('/nickname/check', { nickname });
          hint.textContent = d.duplicated
            ? `已被占用，可用候选：${(d.candidateNicknames || []).slice(0, 3).join(' / ')}`
            : '可以使用';
        } catch (e) { hint.textContent = `查询失败：${e.message}`; }
      };
      diag.querySelector('#acSave').onclick = async ev => {
        const btn = ev.currentTarget;
        btn.loading = true;
        const birth = diag.querySelector('#acBirth').value.trim();
        const params = {
          nickname: diag.querySelector('#acNick').value.trim(),
          signature: diag.querySelector('#acSign').value,
          gender: diag.querySelector('#acGender').value.trim(),
          province: diag.querySelector('#acProv').value.trim(),
          confirm: 1,
        };
        if (birth) {
          const t = Date.parse(birth);
          if (!Number.isNaN(t)) params.birthday = t;
        }
        try {
          await api.ncm('/user/update', params);
          toast('资料已更新');
          diag.open = false;
          render(el, { tab: 'profile' });
        } catch (e) {
          toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
        } finally { btn.loading = false; }
      };
    }

    // 手机号是否已注册（/cellphone/existence/check）：放在页脚一个小入口，避免误触
    const check = document.createElement('div');
    check.className = 'cm-sec';
    check.innerHTML = `<div class="cm-sec-head"><h2>手机号检测</h2><span class="cm-sec-sub">/cellphone/existence/check</span></div>
      <div class="cm-pe-inline"><input id="acPhone" placeholder="输入手机号"><mdui-button variant="tonal" id="acPhoneBtn">检测</mdui-button></div>
      <div class="cm-pe-hint" id="acPhoneHint"></div>`;
    body.appendChild(check);
    check.querySelector('#acPhoneBtn').onclick = async () => {
      const cellphone = check.querySelector('#acPhone').value.trim();
      if (!cellphone) return toast('请输入手机号');
      const hint = check.querySelector('#acPhoneHint');
      hint.textContent = '检测中…';
      try {
        const d = await api.ncm('/cellphone/existence/check', { cellphone });
        hint.textContent = d.exist !== undefined
          ? (d.exist ? '该手机号已注册网易云' : '该手机号未注册')
          : (d.message || d.msg || '上游未返回结论');
      } catch (e) { hint.textContent = `检测失败：${e.message}`; }
    };
    return;
  }

  if (tab === 'sign') {
    body.innerHTML = skelList(4);
    // /signin/progress 需要 moduleId，取自 /sign/happy/info 的 data.info.id
    const happyR = await Promise.allSettled([api.ncm('/sign/happy/info')]);
    const happy = happyR[0].status === 'fulfilled' ? ((happyR[0].value.data || {}).info || {}) : {};
    const moduleId = happy.id || 0;
    const progR = await Promise.allSettled([api.ncm('/signin/progress', { moduleId })]);
    const prog = progR[0].status === 'fulfilled' ? (progR[0].value.data || {}) : {};
    const today = prog.today || {};
    body.innerHTML = `
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>签到</h2><span class="cm-sec-sub">/sign/happy/info · /signin/progress</span></div>
        ${happy.title || happy.text ? `<div class="cm-detail-sub">${esc(happy.title || happy.text || '')}</div>` : ''}
        <div class="cm-si-row"><b>今日状态</b><span>${today.todaySignedIn === undefined ? '上游未返回' : (today.todaySignedIn ? '已签到' : '未签到')}</span></div>
        ${(today.todayStats || []).map(t => `<div class="cm-si-row"><b>${esc(t.description || '')}</b><span>${esc(String(t.calcType || ''))}</span></div>`).join('')}
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="acSignBtn">立即签到</mdui-button>
        </div>
      </section>`;
    body.querySelector('#acSignBtn').onclick = () => confirmDialog({
      title: '执行网易云签到？', body: '会以你的账号调用 /daily_signin。',
      onOk: () => api.ncm('/daily_signin', { type: 0, confirm: 1 })
        .then(d => {
          // 上游对不支持的账号会返回 code=200 + msg「功能暂不支持」，如实转达
          toast(d.msg || '已签到');
          render(el, { tab: 'sign' });
        })
        .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
    });
    return;
  }

  // 设备管理
  body.innerHTML = skelList(4);
  let devices = [];
  try {
    const d = await api.ncm('/device/list');
    devices = ((d.data || {}).userDeviceList) || [];
  } catch (e) { fail(e); return; }
  body.innerHTML = `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>登录设备</h2><span class="cm-sec-sub">/device/list</span></div>
      ${devices.length ? devices.map(dev => `
        <div class="cm-si-row" data-key="${esc(dev.deviceKey || '')}">
          <b>${esc(dev.deviceName || '设备')}</b>
          <span>${esc(dev.os || '')} · ${dev.lastActiveTime ? new Date(dev.lastActiveTime).toLocaleString('zh-CN') : ''}
          ${dev.ifLoginDevice ? '<i class="cm-si-act" data-kick="1">下线</i>' : '<i style="opacity:.5">非登录态</i>'}</span>
        </div>`).join('') : '<div class="cm-empty small">上游未返回设备列表</div>'}
      <div class="cm-pe-acts">
        <mdui-button variant="tonal" id="acReport">上报本机设备</mdui-button>
      </div>
      <div class="cm-pe-hint" id="acDevHint"></div>
    </section>`;

  body.querySelectorAll('[data-kick]').forEach(x => {
    x.onclick = ev => {
      const row = ev.target.closest('[data-key]');
      const key = row.dataset.key;
      if (!key) return;
      confirmDialog({
        title: '下线该设备？', body: '该设备需要重新登录。',
        onOk: () => api.ncm('/device/kickoff', { deviceKey: key, confirm: 1 })
          .then(() => { row.remove(); toast('已下线'); })
          .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
      });
    };
  });
  body.querySelector('#acReport').onclick = async () => {
    const hint = body.querySelector('#acDevHint');
    const name = `CurrentMusic ${navigator.platform || 'Web'}`;
    hint.textContent = '上报中…';
    try {
      await api.ncm('/deviceinfo/center/upload', { deviceName: name, name, confirm: 1 });
      hint.textContent = '已上报本机设备';
    } catch (e) {
      hint.textContent = `上报失败：${/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message}`;
    }
  };
}
