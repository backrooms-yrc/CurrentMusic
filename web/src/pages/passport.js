// CurrentStation 通行证 · 授权确认页（OAuth 2.0 授权码 + PKCE）
//
// 路由：#/passport/authorize?response_type=code&client_id=…&redirect_uri=…&scope=…
//        &state=…&code_challenge=…&code_challenge_method=S256
//
// 这是「统一登录平台」面向用户的那一屏：第三方应用把用户送到这里，用户看到的是
// **应用名 + 它申请哪些权限 + 当前是哪个账号在授权**，点同意才发一次性 code。
// 安全要点：
//   · 未登录先去登录，登录后回到本页（sessionStorage 记 back）；
//   · 页面只是"展示 + 提交同意"，真正的参数校验（回调地址精确匹配、scope 上限、
//     PKCE 形态）全在服务端做，前端伪造不了；
//   · 跳转前再确认一次 redirect 是服务端下发的，不用 query 里的原始值。
import { api, auth } from '../api.js';
import { esc, toast } from '../ui.js';

export const TITLE = '通行证授权';

function card(html) {
  return `<div class="cm-login-tip page" style="text-align:left">${html}</div>`;
}

function fail(el, title, detail) {
  el.innerHTML = card(`
    <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px">
      <span class="material-icons-outlined" style="color:#b3261e">error_outline</span>${esc(title)}
    </div>
    <div style="font-size:calc(13px * var(--cm-fs, 1));opacity:.75;line-height:1.7">${detail || ''}</div>`);
}

export async function render(el, params = {}) {
  const q = params.query || {};
  const needed = ['client_id', 'redirect_uri'];
  const missing = needed.filter(k => !q[k]);
  if (missing.length) {
    fail(el, '授权请求不完整', `缺少参数：${esc(missing.join('、'))}。请从应用重新发起登录。`);
    return;
  }

  if (!auth.token) {
    // 记下回来的位置：登录/注册成功后 user.js 会跳回这里
    try { sessionStorage.setItem('cm.ppBack', location.hash); } catch { /* 隐私模式 */ }
    el.innerHTML = card(`
      <div style="display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px">
        <span class="material-icons-outlined" style="color:var(--cm-primary)">passport</span>需要先登录 CurrentStation 通行证
      </div>
      <div style="font-size:calc(13px * var(--cm-fs, 1));opacity:.75;line-height:1.7">
        登录后会自动回到这个授权确认页。通行证是所有 Current 系产品共用的账号——一次登录，处处可用。
      </div>
      <mdui-button variant="filled" style="margin-top:12px" id="ppGoLogin">去登录</mdui-button>`);
    el.querySelector('#ppGoLogin').onclick = () => { location.hash = '#/user'; };
    return;
  }

  let info;
  el.innerHTML = card('<div style="opacity:.7">正在读取授权信息…</div>');
  try {
    info = await api.passportAuthorizeInfo(q);
  } catch (e) {
    if (e.status === 401) {
      try { sessionStorage.setItem('cm.ppBack', location.hash); } catch { /* 忽略 */ }
      fail(el, '登录已失效', `请<a href="#/user">重新登录</a>后再试。`);
    } else {
      fail(el, '无法完成授权', esc(e.message || '参数校验未通过'));
    }
    return;
  }

  const app = info.app || {};
  const scopes = info.scopes || [];
  const user = info.user || {};
  el.innerHTML = `
    <div class="cm-login-tip page" style="text-align:left;max-width:520px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:2px">
        ${app.logo ? `<img src="${esc(app.logo)}" alt="" style="width:40px;height:40px;border-radius:11px;object-fit:cover">`
                   : `<div style="width:40px;height:40px;border-radius:11px;display:grid;place-items:center;background:color-mix(in srgb, var(--cm-primary) 18%, transparent);color:var(--cm-primary);font-weight:700">${esc((app.name || '应用').slice(0, 1))}</div>`}
        <div style="min-width:0">
          <div style="font-weight:650;font-size:calc(16px * var(--cm-fs, 1))">${esc(app.name || '未知应用')}</div>
          <div style="font-size:calc(12px * var(--cm-fs, 1));opacity:.7">
            ${app.firstParty ? 'Current 系产品' : '第三方应用'} · 想使用你的通行证登录
          </div>
        </div>
      </div>
      <div style="margin:14px 0 6px;font-size:calc(13px * var(--cm-fs, 1));opacity:.8">
        以 <b>${esc(user.nickname || '当前账号')}</b>（${esc(user.sub || '')}）授权，将允许它：
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${scopes.map(s => `
          <div style="display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border-radius:10px;background:rgba(120,128,145,.10)">
            <span class="material-icons-outlined" style="font-size:calc(18px * var(--cm-fs, 1));opacity:.8">${s.scope === 'offline_access' ? 'schedule' : s.scope === 'profile' ? 'account_circle' : s.scope === 'email' ? 'mail' : s.scope === 'phone' ? 'smartphone' : 'badge'}</span>
            <div style="min-width:0">
              <div style="font-size:calc(13.5px * var(--cm-fs, 1));font-weight:600">${esc(s.label || s.scope)}
                ${s.already ? '<span style="font-weight:400;opacity:.6"> · 之前已授权</span>' : ''}</div>
              <div style="font-size:calc(12px * var(--cm-fs, 1));opacity:.7">${esc(s.desc || '')}</div>
            </div>
          </div>`).join('')}
      </div>
      <div style="margin-top:12px;font-size:calc(12px * var(--cm-fs, 1));opacity:.62;line-height:1.7">
        授权后 ${app.name || '该应用'} 拿到的是一个令牌，只能读取上面这些信息；它<strong>拿不到你的密码</strong>，
        也访问不了未列出的内容。你可以在「设置 → 通行证授权管理」里随时撤回。
      </div>
      <div style="display:flex;gap:10px;margin-top:14px">
        <mdui-button variant="filled" id="ppOk" style="flex:1">同意授权</mdui-button>
        <mdui-button variant="outlined" id="ppNo" style="flex:0 0 auto">拒绝</mdui-button>
      </div>
      <div id="ppErr" style="margin-top:8px;font-size:calc(12.5px * var(--cm-fs, 1));color:#b3261e"></div>
    </div>`;

  const submit = async approve => {
    const ok = el.querySelector('#ppOk'), no = el.querySelector('#ppNo'), err = el.querySelector('#ppErr');
    if (ok) ok.disabled = true;
    if (no) no.disabled = true;
    try {
      const r = await api.passportApprove(Object.assign({}, q, { approve }));
      // 只用服务端下发的地址跳转（前端不自己拼回调，避免被 query 里的值带偏）
      if (r && r.redirect) location.replace(r.redirect);
      else fail(el, '无法跳回应用', '服务端没有返回回调地址，请重试或联系应用方。');
    } catch (e) {
      if (err) err.textContent = e.message || '授权失败';
      if (ok) ok.disabled = false;
      if (no) no.disabled = false;
      toast(e.message || '授权失败');
    }
  };
  el.querySelector('#ppOk').onclick = () => submit(true);
  el.querySelector('#ppNo').onclick = () => submit(false);
}
