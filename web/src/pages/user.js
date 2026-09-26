// 用户页：未登录=登录/注册；已登录=我的主页（资料/统计/歌单/多账号/设置）
import { mdui } from '../md.js';
import { api, auth, settings } from '../api.js';
import { esc, toast, avatarHTML, confirmDialog, promptDialog, skelProfile } from '../ui.js';

export async function render(el) {
  if (!auth.token) return renderAuth(el);
  return renderProfile(el);
}

// ---------- 登录 / 注册 ----------

function renderAuth(el) {
  el.innerHTML = `
    <div class="cm-auth">
      <div class="cm-auth-logo"><span class="material-icons-outlined">graphic_eq</span></div>
      <div class="cm-auth-title">CurrentMusic</div>
      <mdui-segmented-button-group value="login" selects="single" id="mode">
        <mdui-segmented-button value="login">登录</mdui-segmented-button>
        <mdui-segmented-button value="register">注册</mdui-segmented-button>
      </mdui-segmented-button-group>
      <div class="cm-auth-form">
        <mdui-text-field id="fUser" label="用户名" variant="outlined"></mdui-text-field>
        <mdui-text-field id="fNick" label="昵称（可留空）" variant="outlined" hidden></mdui-text-field>
        <mdui-text-field id="fPass" label="密码" variant="outlined" type="password" password-icon></mdui-text-field>
        <div class="cm-vfy-tabs" id="vfyTabs" hidden>
          <mdui-segmented-button-group value="phone" selects="single" id="vfy">
            <mdui-segmented-button value="phone">手机验证</mdui-segmented-button>
            <mdui-segmented-button value="email">邮箱验证</mdui-segmented-button>
          </mdui-segmented-button-group>
        </div>
        <div class="cm-email-row" id="rowPhone" hidden>
          <mdui-text-field id="fPhone" label="手机号" variant="outlined" type="tel" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-email-row" id="rowPhoneCode" hidden>
          <mdui-text-field id="fPhoneCode" label="短信验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="sendPhoneCode">获取验证码</mdui-button>
        </div>
        <div class="cm-vfy-hint" id="vfyHint" hidden></div>
        <div class="cm-email-row" id="rowEmail" hidden>
          <mdui-text-field id="fEmail" label="邮箱" variant="outlined" type="email" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-email-row" id="rowEmailCode" hidden>
          <mdui-text-field id="fEmailCode" label="邮箱验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="sendCode">获取验证码</mdui-button>
        </div>
        <mdui-button variant="filled" id="go" full-width>${'登录'}</mdui-button>
      </div>
      <div class="cm-auth-alt"><span>其他登录方式</span></div>
      <mdui-button variant="tonal" full-width id="altInternal">
        <span class="material-icons-outlined">key</span>&nbsp;内部账户登录
      </mdui-button>
      ${!(window.NativeApi && window.NativeApi.versionCode) ? `
        <a class="cm-auth-apk" id="dlApk" href="${esc(settings.base + '/download/latest')}">
          <span class="material-icons-outlined">android</span>下载安卓版 APP（支持后台播放）
        </a>` : ''}
      <div class="cm-auth-note" id="authNote">注册需完成手机或邮箱验证（验证码 5 分钟内有效）；本服务为自建音乐社区，数据存储于服务器管理员处。</div>
    </div>`;

  const mode = el.querySelector('#mode');
  const nick = el.querySelector('#fNick');
  const go = el.querySelector('#go');
  const vfyTabs = el.querySelector('#vfyTabs');
  const vfy = el.querySelector('#vfy');
  const vfyHint = el.querySelector('#vfyHint');
  const rowPhone = el.querySelector('#rowPhone');
  const rowPhoneCode = el.querySelector('#rowPhoneCode');
  const rowEmail = el.querySelector('#rowEmail');
  const rowEmailCode = el.querySelector('#rowEmailCode');

  // 短信通道提示（服务端给：自建网关 / 网易云通道），只在注册-手机验证时展示
  let smsHint = '';
  api.smsInfo().then(d => { smsHint = d.hint || ''; showHint(); }).catch(() => {});

  function showHint() {
    // 异步回调（如 smsInfo 返回）也可能在登录 tab 期间到达：只在「注册 + 手机验证」下显示
    if (mode.value !== 'register' || vfy.value !== 'phone') { vfyHint.hidden = true; return; }
    vfyHint.textContent = smsHint || '验证码 5 分钟内有效，请勿泄露';
    vfyHint.hidden = false;
  }

  // 验证方式：手机验证（默认）/ 邮箱验证
  const setVerify = v => {
    const phone = v === 'phone';
    rowPhone.hidden = !phone;
    rowPhoneCode.hidden = !phone;
    rowEmail.hidden = phone;
    rowEmailCode.hidden = phone;
    vfyHint.hidden = true;
    if (phone) showHint();
  };
  vfy.addEventListener('change', () => setVerify(vfy.value));

  // 按模式只显示必填项：登录=用户名+密码；注册=用户名+昵称+密码+验证方式对应字段
  const setMode = m => {
    const reg = m === 'register';
    nick.hidden = !reg;
    vfyTabs.hidden = !reg;
    el.querySelector('#fUser').setAttribute('label', reg ? '用户名' : '用户名 / 手机号');
    go.textContent = reg ? '注册并登录' : '登录';
    if (reg) setVerify(vfy.value);
    else { rowPhone.hidden = rowPhoneCode.hidden = rowEmail.hidden = rowEmailCode.hidden = vfyHint.hidden = true; }
  };
  mode.addEventListener('change', () => setMode(mode.value));
  setMode('login');

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
            api.internalLogin(pw).then(r => {
              diag.open = false;
              auth.saveLogin(r.token, r.user);
              toast('已进入内部账户');
              location.hash = '#/home';
            }).catch(e => toast(e.message));
            return false;
          },
        },
      ],
    });
    setTimeout(() => diag.querySelector('#iPass')?.focus?.(), 200);
  };

  // 获取验证码：60s 倒计时（邮箱 / 短信各一份）
  const sendBtn = el.querySelector('#sendCode');
  const sendPhoneBtn = el.querySelector('#sendPhoneCode');
  const cdEmail = { timer: null }, cdPhone = { timer: null };

  sendBtn.onclick = async () => {
    const email = el.querySelector('#fEmail').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请先填写正确的邮箱地址');
    try {
      sendBtn.loading = true;
      await api.sendEmailCode(email);
      toast('验证码已发送，请查收邮箱（注意垃圾箱）');
      countdown(sendBtn, cdEmail);
    } catch (e) {
      toast(e.message);
    } finally {
      sendBtn.loading = false;
    }
  };

  sendPhoneBtn.onclick = async () => {
    const phone = el.querySelector('#fPhone').value.replace(/\D/g, '');
    if (!/^\d{5,15}$/.test(phone)) return toast('请先填写正确的手机号');
    try {
      sendPhoneBtn.loading = true;
      const r = await api.sendPhoneCode(phone);
      if (r && r.hint) { smsHint = r.hint; showHint(); }
      toast('验证码已发送，请留意短信');
      countdown(sendPhoneBtn, cdPhone);
    } catch (e) {
      toast(e.message);
    } finally {
      sendPhoneBtn.loading = false;
    }
  };

  go.onclick = async () => {
    const username = el.querySelector('#fUser').value.trim();
    const password = el.querySelector('#fPass').value;
    if (!username || !password) return toast('请填写用户名和密码');
    if (mode.value === 'register') {
      const nickname = nick.value.trim() || username;
      let payload;
      if (vfy.value === 'phone') {
        const phone = el.querySelector('#fPhone').value.replace(/\D/g, '');
        const phoneCode = el.querySelector('#fPhoneCode').value.trim();
        if (!/^\d{5,15}$/.test(phone)) return toast('请填写正确的手机号');
        if (!phoneCode) return toast('请填写短信验证码');
        payload = { username, password, nickname, phone, phoneCode };
      } else {
        const email = el.querySelector('#fEmail').value.trim();
        const emailCode = el.querySelector('#fEmailCode').value.trim();
        if (!email) return toast('请填写邮箱');
        if (!emailCode) return toast('请填写邮箱验证码');
        payload = { username, password, nickname, email, emailCode };
      }
      try {
        go.loading = true;
        const r = await api.register(payload);
        auth.saveLogin(r.token, r.user);
        toast(`欢迎，${r.user.nickname}！`);
        location.hash = '#/home';
      } catch (e) {
        toast(e.message);
      } finally {
        go.loading = false;
      }
      return;
    }
    try {
      go.loading = true;
      const r = await api.login(username, password);
      auth.saveLogin(r.token, r.user);
      toast(`欢迎，${r.user.nickname}！`);
      location.hash = '#/home';
    } catch (e) {
      toast(e.message);
    } finally {
      go.loading = false;
    }
  };
}

// ---------- 我的主页 ----------

async function renderProfile(el) {
  el.innerHTML = skelProfile();
  let me = null, pls = [], bind = { bound: false }, follows = [], followCount = 0;
  const jobs = [
    api.me().then(d => { me = d; }).catch(() => {}),
    api.myPlaylists().then(d => { pls = d.playlists || []; }).catch(() => {}),
    api.bindStatus().then(d => { bind = d; }).catch(() => {}),
    api.followedArtists().then(d => { follows = d.artists || []; followCount = d.count || follows.length; }).catch(() => {}),
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
          <div class="cm-profile-name">${esc(u.nickname || u.username)}${u.isSuper ? ' <span class="cm-tag super">超级管理员</span>' : u.isAdmin ? ' <span class="cm-tag admin">管理员</span>' : ''} <span class="cm-edit" id="editNick"><span class="material-icons-outlined">edit</span></span></div>
          <div class="cm-profile-bio">${esc(u.bio || '这个人很懒，什么都没写')} <span class="cm-edit" id="editBio"><span class="material-icons-outlined">edit</span></span></div>
          ${u.phone ? `<div class="cm-profile-phone"><span class="material-icons-outlined">smartphone</span>${esc(u.phone)}</div>` : ''}
          <div class="cm-profile-stat">
            <span><b>${me ? me.stat.likes : 0}</b>点赞</span>
            <span><b>${me ? me.stat.playlists : pls.length}</b>歌单</span>
            <span><b>${me ? me.stat.playDays : 0}</b>天听过</span>
          </div>
        </div>
      </div>

      <div class="cm-quickrow">
        <a class="cm-quick" href="#/pl/likes"><span class="material-icons-outlined">favorite</span><b>我喜欢的音乐</b></a>
        <a class="cm-quick" href="#/library"><span class="material-icons-outlined">queue_music</span><b>我的歌单</b></a>
      </div>

      ${follows.length ? `
      <div class="cm-sec-head"><h2>关注的歌手</h2><span class="cm-sec-sub">${followCount || follows.length} 位 · 来自网易云</span></div>
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
               <mdui-button variant="text" id="unbind">解绑</mdui-button>
             </div>`
          : `<div class="cm-bindinfo">
               <div class="cm-bindname">绑定网易云音乐</div>
               <div class="cm-bindsub">手机验证码或扫码授权均可，绑定后自动同步你网易云 APP 里的全部歌单</div>
             </div>
             <mdui-button variant="filled" id="goBind">立即绑定</mdui-button>`
      }</div>

        <div class="cm-sec-head"><h2>账号管理</h2></div>
        <div class="cm-setting-list">
          <div class="cm-setting" id="chgPass"><span class="material-icons-outlined">password</span>修改密码</div>
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
  el.querySelector('#chgPass').onclick = () => {
    const diag = mdui.dialog({
      headline: '修改密码',
      body: `<div class="cm-form">
        <mdui-text-field id="pOld" label="原密码" variant="outlined" type="password" password-icon></mdui-text-field>
        <mdui-text-field id="pNew" label="新密码（6~64 位）" variant="outlined" type="password" password-icon></mdui-text-field>
      </div>`,
      actions: [
        { text: '取消' },
        {
          text: '确定',
          onClick: () => {
            const old = diag.querySelector('#pOld').value, nw = diag.querySelector('#pNew').value;
            if (!nw || nw.length < 6) { toast('新密码需 6~64 位'); return false; }
            return api.changePassword(old, nw)
              .then(() => toast('密码已修改'))
              .catch(e => { toast(e.message); return false; });
          },
        },
      ],
    });
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
