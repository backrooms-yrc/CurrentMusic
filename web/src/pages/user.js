import { passkeyLogin } from '../passkeys.js';
import { afterLogin, startWelcome, authArt } from '../auth-flow.js';
import { finishLogin } from '../twofactor.js';
// 用户页：未登录=登录/注册；已登录=我的主页（资料/统计/歌单/多账号/设置）
import { mdui } from '../md.js';
import { api, auth, settings, adoptDecorScales } from '../api.js';
import { esc, toast, avatarHTML, confirmDialog, promptDialog, skelProfile, fmtListen, userTags } from '../ui.js';

export async function render(el, params) {
  if (!auth.token) return renderAuth(el);
  // 首页横幅深链 #/user?decor=1：进页面后自动打开挂件选择器
  const autoDecor = !!(params && params.query && params.query.decor);
  return renderProfile(el, autoDecor);
}

// ---------- 头像挂件 ----------

// 设置行右侧的状态文案：已佩戴=挂件名；可设置=「去设置」；未达标=还差多久；加载失败=重试
function decorValue(decor) {
  const cur = (decor.decorations || []).find(d => d.id === decor.current);
  if (cur) return esc(cur.name);
  if (decor.unlocked) return '去设置';
  if (decor.failed) return '加载失败，点击重试';
  const left = Math.max(0, (decor.minListenMs || 7200000) - (decor.listenMs || 0));
  return `听满 2 小时解锁（还差 ${fmtListen(left)}）`;
}

// 挂件选择器：搜索 + 网格预览 + 当前佩戴标记；未达门槛时展示进度而不列出素材
function decorDialog(d, onDone) {
  const list = d.decorations || [];
  const body = d.failed
    ? `<div class="cm-decor-hint">挂件目录加载失败（${esc(d.error || '网络异常')}）。<br>请稍后重试。</div>`
    : d.unlocked
    ? `<div class="cm-decor-hint">听歌时长已达 2 小时，选择一个挂件展示在个人主页、发现页等公开位置</div>
       <div class="cm-decor-bar">
         <span class="material-icons-outlined">search</span>
         <input id="decorQ" type="search" autocomplete="off" enterkeyhint="search"
                placeholder="搜索挂件名称或 ID">
         <span class="cm-decor-count" id="decorCount">${list.length}</span>
       </div>
       <div class="cm-decor-grid" id="decorGrid">
         <div class="cm-decor-item ${d.current ? '' : 'on'}" data-id="" data-key="">
           <div class="cm-decor-thumb ph"><span class="material-icons-outlined">block</span></div><span>不佩戴</span>
         </div>
         ${list.map(x => `
           <div class="cm-decor-item ${x.id === d.current ? 'on' : ''}" data-id="${esc(x.id)}"
                data-key="${esc((x.name + ' ' + x.id).toLowerCase())}" title="${esc(x.name)}">
             <div class="cm-decor-thumb"><img loading="lazy" src="${esc(api.decorUrl(x.id))}" alt="${esc(x.name)}"></div>
             <span>${esc(x.name)}</span>
           </div>`).join('')}
       </div>
       <div class="cm-decor-none" id="decorNone" hidden>没有匹配的挂件</div>`
    : `<div class="cm-decor-hint">听歌时长满 <b>2 小时</b> 即可设置头像挂件。
        当前累计 <b>${fmtListen(d.listenMs || 0)}</b>，还差 <b>${fmtListen(Math.max(0, (d.minListenMs || 7200000) - (d.listenMs || 0)))}</b>。
        挂件会展示在个人主页、发现页等公开位置。</div>`;
  const diag = mdui.dialog({
    headline: '头像挂件',
    body: `<div class="cm-decor-wrap">${body}</div>`,
    actions: [{ text: '关闭' }],
  });
  setTimeout(() => {
    const grid = diag.querySelector('#decorGrid');
    if (!grid) return;
    // 选择挂件
    grid.querySelectorAll('.cm-decor-item').forEach(it => {
      it.onclick = async () => {
        const id = it.dataset.id || '';
        try {
          await api.setDecoration(id);
          toast(id ? '挂件已设置，全站可见' : '已取消佩戴');
          diag.open = false;
          if (onDone) onDone();
        } catch (e) {
          toast(e.message);      // 未达标/挂件下架等由后端给出可读文案
        }
      };
    });
    // 搜索：按名称或 id 过滤（402 款手动翻找不现实）。匹配项才参与布局，避免 400 个节点重排
    const q = diag.querySelector('#decorQ');
    const cnt = diag.querySelector('#decorCount');
    const none = diag.querySelector('#decorNone');
    const items = [].slice.call(grid.querySelectorAll('.cm-decor-item'));
    let timer = 0;
    const apply = () => {
      const v = (q.value || '').trim().toLowerCase();
      let shown = 0;
      items.forEach(it => {
        const hit = !v || it.dataset.key.indexOf(v) > -1;
        it.hidden = !hit;
        if (hit && it.dataset.id) shown++;
      });
      if (cnt) cnt.textContent = shown;
      if (none) none.hidden = shown > 0 || !v;
    };
    if (q) {
      q.oninput = () => { clearTimeout(timer); timer = setTimeout(apply, 180); };
      q.onkeydown = e => { if (e.key === 'Enter') { clearTimeout(timer); apply(); } };
    }
  }, 0);
}

// ---------- 登录 / 注册 ----------

// 验证码按钮倒计时：每个按钮独立计时，重复点击不会叠加多个 interval。
function startCountdown(btn, label = '获取验证码') {
  clearInterval(btn._cmCd);
  let left = 60;
  btn.disabled = true;
  const tick = () => {
    btn.textContent = `${left}s 后重发`;
    if (left-- <= 0) {
      clearInterval(btn._cmCd);
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  tick();
  btn._cmCd = setInterval(tick, 1000);
}

// 忘记密码（未登录）：邮箱验证码 → 新密码。重置成功后服务端吊销全部会话，
// 所以这里不自动登录，只把用户名回填到登录框。
function passwordResetDialog(onDone) {
  const diag = mdui.dialog({
    headline: '找回密码',
    body: `<div class="cm-form">
      <div class="cm-form-hint">用注册或已绑定的邮箱接收验证码；重置成功后所有设备需重新登录。</div>
      <mdui-text-field id="frMail" label="邮箱" variant="outlined" type="email" style="width:100%"></mdui-text-field>
      <div class="cm-email-row">
        <mdui-text-field id="frCode" label="邮箱验证码" variant="outlined" style="flex:1"></mdui-text-field>
        <mdui-button variant="tonal" id="frSend">获取验证码</mdui-button>
      </div>
      <mdui-text-field id="frPass" label="新密码（6~64 位）" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
      <mdui-text-field id="frPass2" label="确认新密码" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
    </div>`,
    actions: [
      { text: '取消' },
      {
        text: '重置密码',
        onClick: () => {
          const email = diag.querySelector('#frMail').value.trim();
          const code = diag.querySelector('#frCode').value.trim();
          const nw = diag.querySelector('#frPass').value;
          const nw2 = diag.querySelector('#frPass2').value;
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('请填写正确的邮箱'); return false; }
          if (!code) { toast('请填写邮箱验证码'); return false; }
          if (!nw || nw.length < 6 || nw.length > 64) { toast('新密码需 6~64 位'); return false; }
          if (nw !== nw2) { toast('两次输入的新密码不一致'); return false; }
          return api.resetPassword(email, code, nw)
            .then(r => {
              toast('密码已重置，请用新密码登录');
              if (onDone) onDone(r);
            })
            .catch(e => { toast(e.message); return false; });
        },
      },
    ],
  });
  const send = diag.querySelector('#frSend');
  send.onclick = async () => {
    const email = diag.querySelector('#frMail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请先填写正确的邮箱地址');
    try {
      send.loading = true;
      await api.sendPasswordResetCode(email);
      toast('验证码已发送，请查收邮箱（注意垃圾箱）');
      startCountdown(send);
    } catch (e) {
      toast(e.message);
    } finally {
      send.loading = false;
    }
  };
  setTimeout(() => diag.querySelector('#frMail')?.focus?.(), 200);
  return diag;
}

function renderAuth(el) {
  el.innerHTML = `
    <section class="cm-auth-layout cm-login-layout">
      <aside class="cm-auth-story">${authArt('music')}<span class="cm-auth-eyebrow">YOUR MUSIC, YOUR MOMENT</span><h1>让喜欢的旋律，<br>回到你的生活里。</h1><p>收藏每一次心动，发现下一首喜欢。<br>用一个账号，连接你的音乐世界。</p><span class="cm-auth-brand">CurrentMusic <span>·</span> CurrentStation 通行证</span></aside>
      <div class="cm-auth cm-auth-panel">
      <div class="cm-auth-logo"><img src="brand-icon.png?v=sage1" alt="CurrentMusic" width="64" height="64"></div>
      <div class="cm-auth-kicker">CURRENTSTATION 通行证</div><h2 class="cm-auth-title" id="authTitle">欢迎回来</h2>
      <p class="cm-auth-description" id="authDescription">登录账号，继续你的音乐时光。</p>
      <div class="cm-auth-form">
        <mdui-text-field id="fUser" label="用户名" variant="outlined" autocomplete="username"></mdui-text-field>
        <mdui-text-field id="fNick" label="昵称（可留空）" variant="outlined" hidden></mdui-text-field>
        <mdui-text-field id="fPass" label="密码" variant="outlined" type="password" password-icon autocomplete="current-password"></mdui-text-field>
        <div class="cm-email-row" id="rowContact" hidden>
          <mdui-text-field id="fContact" label="手机号或邮箱" variant="outlined" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-email-row" id="rowContactCode" hidden>
          <mdui-text-field id="fContactCode" label="验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="sendContactCode">获取验证码</mdui-button>
        </div>
        <div class="cm-vfy-hint" id="vfyHint" hidden></div>
        <div class="cm-email-row" id="rowEmail" hidden>
          <mdui-text-field id="fEmail" label="邮箱" variant="outlined" type="email" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-email-row" id="rowEmailCode" hidden>
          <mdui-text-field id="fEmailCode" label="邮箱验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="sendCode">获取验证码</mdui-button>
        </div>
        <label class="cm-auth-note" id="consentRow" hidden><input type="checkbox" id="legalConsent"> 我已阅读并同意《用户协议》与《隐私政策》</label>
        <div class="cm-auth-error" id="authError" role="alert" aria-live="polite"></div><mdui-button variant="filled" id="go" full-width>${'登录'}</mdui-button>
        <div class="cm-auth-links" id="loginLinks">
          <button type="button" id="forgot">忘记密码？</button>
          <button type="button" id="toCode">邮箱验证码登录</button>
        </div>
        <div class="cm-auth-links" id="codeLinks" hidden>
          <button type="button" id="backLogin"><span class="material-icons-outlined" aria-hidden="true">arrow_back</span>返回密码登录</button>
        </div>
      </div>
      <p class="cm-auth-switch" id="authSwitch">
        <span id="switchToReg">还没有账号？<button type="button" id="toRegister">立即注册</button></span>
        <span id="switchToLogin" hidden>已有账号？<button type="button" id="toLogin">返回登录</button></span>
      </p>
      <div class="cm-auth-alt"><span>其他登录方式</span></div>
      <mdui-button variant="tonal" full-width id="passkeyLogin">通行密钥登录</mdui-button>
      <mdui-button variant="tonal" full-width id="altInternal">
        <span class="material-icons-outlined">key</span>&nbsp;内部账户登录
      </mdui-button>
      ${!(window.NativeApi && window.NativeApi.versionCode) ? `
        <a class="cm-auth-apk" id="dlApk" href="${esc(settings.base + '/download/latest')}">
          <span class="material-icons-outlined">android</span>下载安卓版 APP（支持后台播放）
        </a>` : ''}
      <div class="cm-auth-note" id="authNote">注册前请阅读 <a href="#/legal/terms" target="_blank" rel="noopener">《用户协议》</a> 与 <a href="#/legal/privacy" target="_blank" rel="noopener">《隐私政策》</a>，了解服务规则与个人信息处理方式。</div>
    </div></section>`;

  // 模式不再用顶部等分 tab：登录为主视图，「验证码登录」与「忘记密码」是行内链接，
  // 注册通过底部「还没有账号？」切换线进入（主流登录页惯例）。
  el.querySelector('#passkeyLogin').onclick = async () => {
    const button = el.querySelector('#passkeyLogin'); if (button.loading) return; button.loading = true;
    try { await passkeyLogin(); } catch(e) { el.querySelector('#authError').textContent = e.message; } finally { button.loading = false; }
  };
  let curMode = 'login';
  const nick = el.querySelector('#fNick');
  const go = el.querySelector('#go');
  const vfyHint = el.querySelector('#vfyHint');
  const rowContact = el.querySelector('#rowContact');
  const rowContactCode = el.querySelector('#rowContactCode');
  const rowEmail = el.querySelector('#rowEmail');
  const rowEmailCode = el.querySelector('#rowEmailCode');
  const loginLinks = el.querySelector('#loginLinks');
  const codeLinks = el.querySelector('#codeLinks');

  // 短信通道提示（服务端给：自建网关 / 网易云通道），只在注册且填的是手机号时展示
  let smsHint = '';
  api.smsInfo().then(d => { smsHint = d.hint || ''; showHint(); }).catch(() => {});

  // 注册的验证通道由填写的联系方式自动判断：纯数字→短信，含 @→邮箱
  const contactInfo = () => {
    const raw = (el.querySelector('#fContact')?.value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (digits && digits === raw.replace(/[\s-]/g, '') && /^\d{5,15}$/.test(digits)) return { type: 'phone', value: digits };
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return { type: 'email', value: raw };
    return { type: '', value: raw };
  };

  function showHint() {
    // 异步回调（如 smsInfo 返回）也可能在登录视图期间到达：只在「注册 + 手机号」下显示
    if (curMode !== 'register' || contactInfo().type !== 'phone') { vfyHint.hidden = true; return; }
    vfyHint.textContent = smsHint || '验证码 5 分钟内有效，请勿泄露';
    vfyHint.hidden = false;
  }
  el.querySelector('#fContact').addEventListener('input', showHint);

  // 按模式只显示必填项：登录=用户名+密码；验证码登录=邮箱+验证码；注册=用户名+昵称+密码+联系方式+验证码
  const setMode = m => {
    curMode = m;
    const reg = m === 'register';
    el.querySelector('#authTitle').textContent = reg ? '开启你的音乐旅程' : '欢迎回来';
    el.querySelector('#authDescription').textContent = reg ? '创建一个账号，把喜欢的音乐留在身边。' : m === 'code' ? '用绑定邮箱接收验证码，轻松登录。' : '登录账号，继续你的音乐时光。';
    el.querySelector('#authError').textContent = '';
    el.querySelector('#fPass').setAttribute('label', reg ? '设置密码（6~64 位）' : '密码');
    el.querySelector('#fPass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
    el.querySelector('#consentRow').hidden = !reg;
    const byCode = m === 'code';
    nick.hidden = !reg;
    el.querySelector('#fUser').hidden = byCode;
    el.querySelector('#fPass').hidden = byCode;
    el.querySelector('#fUser').setAttribute('label', reg ? '用户名' : '用户名 / 手机号');
    go.textContent = reg ? '创建账号' : '登录';
    loginLinks.hidden = m !== 'login';
    codeLinks.hidden = m !== 'code';
    el.querySelector('#switchToReg').hidden = reg;
    el.querySelector('#switchToLogin').hidden = !reg;
    // 注册：联系方式+验证码两行；验证码登录：邮箱两行；普通登录全部收起
    rowContact.hidden = rowContactCode.hidden = !reg;
    rowEmail.hidden = rowEmailCode.hidden = !byCode;
    showHint();
  };
  setMode('login');

  // 视图切换：进入时聚焦第一个要填的输入框
  const focusField = sel => setTimeout(() => el.querySelector(sel)?.focus?.(), 120);
  el.querySelector('#toCode').onclick = () => { setMode('code'); focusField('#fEmail'); };
  el.querySelector('#backLogin').onclick = () => { setMode('login'); focusField('#fUser'); };
  el.querySelector('#toRegister').onclick = () => { setMode('register'); focusField('#fUser'); };
  el.querySelector('#toLogin').onclick = () => { setMode('login'); focusField('#fUser'); };

  // 忘记密码：仅登录视图；重置成功后回填用户名，回到密码登录
  el.querySelector('#forgot').onclick = () => passwordResetDialog(r => {
    setMode('login');
    const userEl = el.querySelector('#fUser');
    userEl.value = (r && r.username) || '';
    el.querySelector('#fPass').value = '';
    setTimeout(() => el.querySelector('#fPass')?.focus?.(), 200);
  });

  // 倒计时（每个按钮各一份，重发按钮 60s 内禁用）
  const countdown = (btn, state) => {
    let left = 60;
    btn.disabled = true;
    const tick = () => {
      btn.textContent = `${left}s 后重发`;
      if (left-- <= 0) { clearInterval(state.timer); btn.disabled = false; btn.textContent = '获取验证码'; }
    };
    tick();
    state.timer = setInterval(tick, 1000);
  };

  // 内部登录：底部第三方渠道入口 → 密码对话框
  el.querySelector('#altInternal').onclick = () => {
    const diag = mdui.dialog({
      headline: '内部账户登录',
      body: `<div class="cm-form">
        <mdui-text-field id="iPass" label="内部密码" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
      </div>`,
      actions: [
        { text: '取消' },
        {
          text: '登录',
          // mdui 对 promise 一律 resolve 即关窗，这里同步 return false 自行控制：
          // 失败保持弹窗可改密码重试，成功再手动关闭跳转
          onClick: () => {
            const pw = diag.querySelector('#iPass').value;
            if (!pw) { toast('请填写内部密码'); return false; }
            api.internalLogin(pw).then(r => { diag.open = false; return finishLogin(r); }).then(r => {
              if (!r) return;
              diag.open = false;
              auth.saveLogin(r.token, r.user);
              toast('已进入内部账户');
              afterLogin();
            }).catch(e => toast(e.message));
            return false;
          },
        },
      ],
    });
    setTimeout(() => diag.querySelector('#iPass')?.focus?.(), 200);
  };

  // 获取验证码：60s 倒计时（验证码登录邮箱一份 / 注册联系方式一份）
  const sendBtn = el.querySelector('#sendCode');
  const sendContactBtn = el.querySelector('#sendContactCode');
  const cdEmail = { timer: null }, cdContact = { timer: null };

  sendBtn.onclick = async () => {
    const email = el.querySelector('#fEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请先填写正确的邮箱地址');
    try {
      sendBtn.loading = true;
      // 验证码登录发登录码（服务端要求邮箱已注册）
      await api.loginEmailCode(email);
      toast('验证码已发送，请查收邮箱（注意垃圾箱）');
      countdown(sendBtn, cdEmail);
    } catch (e) {
      toast(e.message);
    } finally {
      sendBtn.loading = false;
    }
  };

  sendContactBtn.onclick = async () => {
    const { type, value } = contactInfo();
    if (!type) return toast(value ? '请填写正确的手机号或邮箱' : '请先填写手机号或邮箱');
    try {
      sendContactBtn.loading = true;
      if (type === 'phone') {
        const r = await api.sendPhoneCode(value);
        if (r && r.hint) { smsHint = r.hint; showHint(); }
        toast('验证码已发送，请留意短信');
      } else {
        await api.sendEmailCode(value);
        toast('验证码已发送，请查收邮箱（注意垃圾箱）');
      }
      countdown(sendContactBtn, cdContact);
    } catch (e) {
      toast(e.message);
    } finally {
      sendContactBtn.loading = false;
    }
  };

  el.querySelectorAll('.cm-auth-form mdui-text-field').forEach(input => input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); go.click(); }
  }));
  go.onclick = async () => {
    if (go.loading) return;
    el.querySelector('#authError').textContent = '';
    if (curMode === 'register' && !el.querySelector('#legalConsent').checked) {
      toast('请先阅读并勾选同意《用户协议》与《隐私政策》');
      el.querySelector('#legalConsent').focus();
      return;
    }
    const username = el.querySelector('#fUser').value.trim();
    const password = el.querySelector('#fPass').value;
    if (curMode === 'code') {
      // 邮箱验证码登录：邮箱 + 验证码两步
      const email = el.querySelector('#fEmail').value.trim();
      const code = el.querySelector('#fEmailCode').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请填写正确的邮箱');
      if (!code) return toast('请填写邮箱验证码');
      try {
        go.loading = true;
        const r = await finishLogin(await api.loginByEmail(email, code));
        if (!r) return;
        auth.saveLogin(r.token, r.user);
        toast(`欢迎，${r.user.nickname}！`);
        afterLogin();
      } catch (e) {
        el.querySelector('#authError').textContent = e.message;
      } finally {
        go.loading = false; }
      return;
    }
    if (!username || !password) return toast('请填写用户名和密码');
    if (curMode === 'register') {
      const nickname = nick.value.trim() || username;
      const { type, value } = contactInfo();
      const code = el.querySelector('#fContactCode').value.trim();
      if (!type) return toast('请填写正确的手机号或邮箱');
      if (!code) return toast(type === 'phone' ? '请填写短信验证码' : '请填写邮箱验证码');
      const payload = type === 'phone'
        ? { username, password, nickname, phone: value, phoneCode: code }
        : { username, password, nickname, email: value, emailCode: code };
      try {
        go.loading = true;
        const r = await api.register(payload);
        auth.saveLogin(r.token, r.user);
        startWelcome();
      } catch (e) {
        el.querySelector('#authError').textContent = e.message;
      } finally {
        go.loading = false;
      }
      return;
    }
    try {
      go.loading = true;
      const r = await finishLogin(await api.login(username, password));
      if (!r) return;
      auth.saveLogin(r.token, r.user);
      toast(`欢迎，${r.user.nickname}！`);
      afterLogin();
    } catch (e) {
      el.querySelector('#authError').textContent = e.message;
    } finally {
      go.loading = false;
    }
  };
}

// ---------- 我的主页 ----------

async function renderProfile(el, autoDecor) {
  el.innerHTML = skelProfile();
  let me = null, pls = [], bind = { bound: false }, follows = [], followCount = 0;
  let decor = { decorations: [], unlocked: false, listenMs: 0, current: '', minListenMs: 7200000, failed: true };
  const jobs = [
    api.me().then(d => { me = d; }).catch(() => {}),
    api.myPlaylists().then(d => { pls = d.playlists || []; }).catch(() => {}),
    api.bindStatus().then(d => { bind = d; }).catch(() => {}),
    api.followedArtists().then(d => { follows = d.artists || []; followCount = d.count || follows.length; }).catch(() => {}),
    // 失败时标记 failed：不能把「没取到」当成「未解锁」，否则限流/断网会误报成还差多少小时
    api.decorations()
      .then(d => {
        decor = Object.assign({ failed: false }, d || {});
        adoptDecorScales(d);      // 目录自带比例表 → 同步给全局渲染用，省一次请求
      })
      .catch(e => { decor.failed = true; decor.error = (e && e.message) || '网络异常'; }),
  ];
  await Promise.allSettled(jobs);

  const accounts = auth.accounts().filter(a => a.username !== (me || {}).username);
  const u = me || auth.user || {};

  el.innerHTML = `
    <div class="cm-profile">
      <div class="cm-profile-head">
        <div id="avaWrap" class="cm-ava-wrap" role="button" tabindex="0" title="点击更换头像"
             aria-label="更换头像">${avatarHTML(u, 84)}<span class="cm-ava-cam"><span class="material-icons-outlined">photo_camera</span></span></div>
        <div class="cm-profile-info">
          <div class="cm-profile-name">${esc(u.nickname || u.username)}${userTags(u)} <span class="cm-edit" id="editNick"><span class="material-icons-outlined">edit</span></span></div>
          <div class="cm-profile-bio">${esc(u.bio || '这个人很懒，什么都没写')} <span class="cm-edit" id="editBio"><span class="material-icons-outlined">edit</span></span></div>
          ${u.phone ? `<div class="cm-profile-phone"><span class="material-icons-outlined">smartphone</span>${esc(u.phone)}</div>` : ''}
          <div class="cm-profile-stat">
            <span><b>${me ? me.stat.likes : 0}</b>点赞</span>
            <span><b>${me ? me.stat.playlists : pls.length}</b>歌单</span>
            <span><b>${me ? me.stat.playDays : 0}</b>天听过</span>
            <span><b>${fmtListen(me ? me.stat.listenMs : 0)}</b>听歌时长</span>
          </div>
        </div>
      </div>

      <div class="cm-quickrow">
        <a class="cm-quick" href="#/pl/likes"><span class="material-icons-outlined">favorite</span><b>我喜欢的音乐</b></a>
        <a class="cm-quick" href="#/library"><span class="material-icons-outlined">queue_music</span><b>我的歌单</b></a>
        <a class="cm-quick" href="#/lyricmarks"><span class="material-icons-outlined">format_quote</span><b>我的歌词本</b></a>
        <a class="cm-quick" href="#/assets"><span class="material-icons-outlined">inventory_2</span><b>音乐资产</b></a>
      </div>

      ${follows.length ? `
      <div class="cm-sec-head"><h2>关注的歌手</h2><a class="cm-sec-more" href="#/followed">查看全部<i>${followCount || follows.length}</i></a></div>
      <div class="cm-hscroll cm-artist-row" id="followRow">
        ${follows.map(a => `
          <div class="cm-artist-card" data-aid="${a.artist_id}">
            <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=120y120" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
            <div class="cm-artist-name">${esc(a.name || '歌手')}</div>
          </div>`).join('')}
      </div>` : ''}

      <div class="cm-sec-head"><h2>网易云账号</h2></div>
      <div class="cm-bindbox" id="bindBox">${
        bind.bound
          ? `<img class="cm-bindava" src="${esc(bind.profile.avatar)}" onerror="this.style.display='none'">
             <div class="cm-bindinfo">
               <div class="cm-bindname">${esc(bind.profile.nickname || '已绑定')} ${bind.stale ? '<span class="cm-bindstale">已失效</span>' : ''}</div>
               <div class="cm-bindsub">${bind.lastSync ? `上次同步 ${fmtTime(bind.lastSync)} · ${bind.lastSyncCount} 个歌单` : '尚未同步'}</div>
             </div>
             <div class="cm-bindbtns">
               ${bind.stale ? `<mdui-button variant="tonal" id="rebind">重新绑定</mdui-button>` : `<mdui-button variant="tonal" id="syncNow">立即同步</mdui-button>`}
               <mdui-button variant="tonal" id="ncmLive">检查登录态</mdui-button>
               <mdui-button variant="tonal" id="ncmRefresh">刷新登录态</mdui-button>
               <mdui-button variant="text" id="advOps">高级操作</mdui-button>
               <mdui-button variant="text" id="unbind">解绑</mdui-button>
             </div>`
          : `<div class="cm-bindinfo">
               <div class="cm-bindname">绑定网易云音乐</div>
               <div class="cm-bindsub">手机验证码或扫码授权均可，绑定后自动同步你网易云 APP 里的全部歌单</div>
             </div>
             <mdui-button variant="filled" id="goBind">立即绑定</mdui-button>`
      }</div>
      ${bind.bound && bind.profile && bind.profile.uid ? `
      <section class="cm-sec" id="simiUserSec" hidden>
        <div class="cm-sec-head"><h2>相似用户</h2><span class="cm-sec-sub">按你的网易云口味推荐</span></div>
        <div class="cm-artist-grid" id="simiUser"></div>
      </section>` : ''}

        <div class="cm-sec-head"><h2>账号管理</h2></div>
        <div class="cm-setting-list">
          <div class="cm-setting" id="setDecor"><span class="material-icons-outlined">face_retouching_natural</span>头像挂件<i id="decorVal">${decorValue(decor)}</i></div>
          <div class="cm-setting" id="chgPass"><span class="material-icons-outlined">password</span>修改密码</div>
          <div class="cm-setting" id="goUgc"><span class="material-icons-outlined">menu_book</span>百科贡献<i>我的词条</i></div>
          <div class="cm-setting" id="goFoot"><span class="material-icons-outlined">insights</span>听歌足迹<i>播放记录 / 年度报告</i></div>
          <div class="cm-setting" id="goMsg"><span class="material-icons-outlined">forum</span>消息与私信<i>私信 / 评论 / 通知</i></div>
          <div class="cm-setting" id="goFollow"><span class="material-icons-outlined">group</span>关注与状态<i>关注 / 粉丝 / 我的状态</i></div>
          <div class="cm-setting" id="goEvents"><span class="material-icons-outlined">dynamic_feed</span>动态与话题<i>广场 / 我的动态 / 评论历史</i></div>
          <div class="cm-setting" id="goAccount"><span class="material-icons-outlined">manage_accounts</span>网易云账号资料<i>资料 / 签到 / 设备</i></div>
          <div class="cm-setting" id="goCloud"><span class="material-icons-outlined">cloud</span>音乐云盘<i>我的云盘 / 音频</i></div>
          <div class="cm-setting" id="goRadio"><span class="material-icons-outlined">radio</span>电台<i>推荐 / 分类 / 榜单 / 订阅</i></div>
          <div class="cm-setting" id="goPodcast"><span class="material-icons-outlined">podcasts</span>播客与私人 FM<i>我的播客 / 发现 / 广播 / FM</i></div>
          <div class="cm-setting" id="goMember"><span class="material-icons-outlined">workspace_premium</span>会员与云贝<i>乐签 / 成长值 / 云贝 / 音乐人</i></div>
          <div class="cm-setting" id="goServices"><span class="material-icons-outlined">spa</span>网易云服务<i>助眠 / 话题热榜 / 服务信息</i></div>
          <div class="cm-setting" id="goRep"><span class="material-icons-outlined">badge</span>云小编与审核<i>权益 / 活动 / 考核 / 审核</i></div>
        </div>

      ${accounts.length ? `
      <div class="cm-sec-head"><h2>切换账号</h2></div>
      <div class="cm-setting-list">
        ${accounts.map(a => `<div class="cm-setting" data-sw="${esc(a.username)}"><span class="material-icons-outlined">person</span>${esc(a.nickname || a.username)}<i>${esc(a.username)}</i></div>`).join('')}
      </div>` : ''}

      <div class="cm-logout"><mdui-button variant="outlined" error id="logout">退出登录</mdui-button></div>
    </div>
    <input type="file" id="avaFile" accept="image/png,image/jpeg,image/webp" hidden>`;

  // 关注的歌手 → 歌手主页
  el.querySelectorAll('#followRow .cm-artist-card').forEach(c => {
    c.onclick = () => { location.hash = `#/artist/${c.dataset.aid}`; };
  });

  // 绑定有效性：上游 /login/status 给权威结论，/login/refresh 一键续期（均为项目专用入口）
  el.querySelector('#advOps')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.advancedDialog(() => renderProfile(el)));
  });
  el.querySelector('#ncmLive')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    try {
      const d = await api.ncmLive();
      if (!d.bound) toast('尚未绑定网易云');
      else if (d.ok) { toast(`登录态正常：${(d.profile && d.profile.nickname) || ''}`); renderProfile(el); }
      else toast(d.note || '登录态已失效');
    } catch (e) { toast('检查失败：' + e.message); }
    finally { btn.loading = false; }
  });
  el.querySelector('#ncmRefresh')?.addEventListener('click', async ev => {
    const btn = ev.currentTarget;
    btn.loading = true;
    try {
      await api.ncmRefresh();
      toast('登录态已刷新');
      renderProfile(el);
    } catch (e) { toast(e.message); }
    finally { btn.loading = false; }
  });

  // 相似用户（/simi/user，以绑定的网易云 uid 为种子；上游该维度常为空，空则整块不显示）
  if (bind.bound && bind.profile && bind.profile.uid) {
    api.ncm('/simi/user', { id: bind.profile.uid, limit: 12, offset: 0 }).then(r => {
      const users = (r.userprofiles || []).filter(u => u && (u.userId || u.id));
      if (!users.length) return;
      const sec = el.querySelector('#simiUserSec');
      if (!sec) return;
      sec.hidden = false;
      el.querySelector('#simiUser').innerHTML = users.map(u => `
        <div class="cm-artist-card">
          <div class="cm-artist-ava">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}?param=160y160" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
          <div class="cm-artist-name">${esc(u.nickname || '')}</div>
          ${u.signature ? `<div class="cm-artist-sub">${esc(u.signature)}</div>` : ''}
        </div>`).join('');
    }).catch(() => {});
  }

  // 网易云绑定交互
  el.querySelector('#goBind')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.bindDialog(() => renderProfile(el)));
  });
  el.querySelector('#syncNow')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.runSync(el, () => renderProfile(el)));
  });
  el.querySelector('#rebind')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.bindDialog(() => renderProfile(el)));
  });
  el.querySelector('#unbind')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.unbindFlow(() => renderProfile(el)));
  });

  // 头像上传：点击头像即换（替换原「账号管理 → 更换头像」入口，位置更直观）
  const fileInput = el.querySelector('#avaFile');
  const avaWrap = el.querySelector('#avaWrap');
  if (avaWrap) {
    avaWrap.onclick = () => fileInput.click();
    avaWrap.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
  }
  fileInput.onchange = async () => {
    const f = fileInput.files[0];
    if (!f) return;
    if (f.size > 1024 * 1024) return toast('图片需 ≤1MB');
    const b64 = (await fileToBase64(f)).split(',')[1];
    try {
      await api.uploadAvatarBase64(b64);
      toast('头像已更新');
      renderProfile(el);
    } catch (e) { toast(e.message); }
  };

  el.querySelector('#editNick').onclick = () => promptDialog({
    title: '修改昵称', label: '新昵称', value: u.nickname || '',
    onOk: async v => { await api.updateProfile({ nickname: v }); toast('已更新'); renderProfile(el); },
  });
  el.querySelector('#editBio').onclick = () => promptDialog({
    title: '修改简介', label: '新简介', value: u.bio || '',
    onOk: async v => { await api.updateProfile({ bio: v }); toast('已更新'); renderProfile(el); },
  });
  // 头像挂件：设置行 → 选择器；未达门槛时点开显示进度
  el.querySelector('#setDecor').onclick = () => decorDialog(decor, () => renderProfile(el));
  // 首页横幅深链（#/user?decor=1）：数据就绪后自动弹出选择器（目录加载失败则不弹，避免空弹窗）
  if (autoDecor && !decor.failed) setTimeout(() => decorDialog(decor, () => renderProfile(el)), 120);

  el.querySelector('#goUgc').onclick = () => { location.hash = '#/ugc'; };
  el.querySelector('#goFoot').onclick = () => { location.hash = '#/footprint'; };
  el.querySelector('#goMsg').onclick = () => { location.hash = '#/messages'; };
  el.querySelector('#goFollow').onclick = () => { location.hash = '#/follow'; };
  el.querySelector('#goEvents').onclick = () => { location.hash = '#/events'; };
  el.querySelector('#goAccount').onclick = () => { location.hash = '#/account'; };
  el.querySelector('#goCloud').onclick = () => { location.hash = '#/cloud'; };
  el.querySelector('#goRadio').onclick = () => { location.hash = '#/radio'; };
  el.querySelector('#goPodcast').onclick = () => { location.hash = '#/podcast'; };
  el.querySelector('#goMember').onclick = () => { location.hash = '#/member'; };
  el.querySelector('#goServices').onclick = () => { location.hash = '#/services'; };
  el.querySelector('#goRep').onclick = () => { location.hash = '#/rep'; };
  el.querySelector('#chgPass').onclick = () => {
    const hasEmail = !!u.hasEmail;
    const diag = mdui.dialog({
      headline: '修改密码',
      body: `<div class="cm-form">
        ${hasEmail ? `<div class="cm-vfy-tabs">
          <mdui-segmented-button-group value="old" selects="single" id="pwdMode">
            <mdui-segmented-button value="old">原密码</mdui-segmented-button>
            <mdui-segmented-button value="email">邮箱验证码</mdui-segmented-button>
          </mdui-segmented-button-group>
        </div>` : ''}
        <div id="pwdOldPane">
          <mdui-text-field id="pOld" label="原密码" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
        </div>
        <div id="pwdEmailPane" hidden>
          <div class="cm-email-row">
            <mdui-text-field id="pEmailCode" label="邮箱验证码" variant="outlined" style="flex:1"></mdui-text-field>
            <mdui-button variant="tonal" id="pSendCode">获取验证码</mdui-button>
          </div>
          <div class="cm-form-hint">验证码发送到当前账号绑定的邮箱；验证成功后其他设备会下线。</div>
        </div>
        <mdui-text-field id="pNew" label="新密码（6~64 位）" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
        <mdui-text-field id="pNew2" label="确认新密码" variant="outlined" type="password" password-icon style="width:100%"></mdui-text-field>
        ${hasEmail ? '' : '<div class="cm-form-hint">当前账号未绑定邮箱，只能用原密码修改；绑定邮箱后可在忘记密码时用验证码找回。</div>'}
      </div>`,
      actions: [
        { text: '取消' },
        {
          text: '确定',
          onClick: () => {
            const nw = diag.querySelector('#pNew').value;
            const nw2 = diag.querySelector('#pNew2').value;
            if (!nw || nw.length < 6 || nw.length > 64) { toast('新密码需 6~64 位'); return false; }
            if (nw !== nw2) { toast('两次输入的新密码不一致'); return false; }
            const pwdMode = diag.querySelector('#pwdMode');
            if (pwdMode && pwdMode.value === 'email') {
              const code = diag.querySelector('#pEmailCode').value.trim();
              if (!code) { toast('请填写邮箱验证码'); return false; }
              return api.changePasswordByEmail(code, nw)
                .then(r => { toast(r && r.revoked ? `密码已修改，已下线 ${r.revoked} 台其他设备` : '密码已修改'); })
                .catch(e => { toast(e.message); return false; });
            }
            const old = diag.querySelector('#pOld').value;
            if (!old) { toast('请填写原密码'); return false; }
            return api.changePassword(old, nw)
              .then(() => toast('密码已修改'))
              .catch(e => { toast(e.message); return false; });
          },
        },
      ],
    });

    // 切换「原密码 / 邮箱验证码」：只显示对应输入区（未绑定邮箱时没有切换条）
    const pwdMode = diag.querySelector('#pwdMode');
    if (pwdMode) {
      const sync = () => {
        const emailMode = pwdMode.value === 'email';
        diag.querySelector('#pwdOldPane').hidden = emailMode;
        diag.querySelector('#pwdEmailPane').hidden = !emailMode;
      };
      pwdMode.addEventListener('change', sync);
      sync();
    }
    const send = diag.querySelector('#pSendCode');
    if (send) send.onclick = async () => {
      try {
        send.loading = true;
        const r = await api.sendProfilePasswordCode();
        toast(`验证码已发送至 ${(r && r.email) || '绑定邮箱'}（注意垃圾箱）`);
        startCountdown(send);
      } catch (e) {
        toast(e.message);
      } finally {
        send.loading = false;
      }
    };
    setTimeout(() => diag.querySelector('#pOld')?.focus?.(), 200);
  };
  el.querySelectorAll('[data-sw]').forEach(x => {
    x.onclick = () => {
      auth.switchTo(x.dataset.sw);
      toast('已切换账号');
      location.hash = '#/home';
      setTimeout(() => location.reload(), 300);
    };
  });
  el.querySelector('#logout').onclick = () => confirmDialog({
    title: '退出登录？',
    onOk: async () => {
      try { await api.logout(); } catch { /* 忽略 */ }
      auth.clear();
      location.hash = '#/home';
      renderAuth(el);
      location.reload();
    },
  });
}



function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return `今天 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
