import { api, auth } from '../api.js';
import { esc, toast } from '../ui.js';
import { authFrame, needsWelcome, completeWelcome } from '../auth-flow.js';
import { renderQuestionLogin } from '../twofactor.js';

export async function render(el, params = []) {
  if (params.query && params.query.mode === 'login') { renderQuestionLogin(el); return; }
  if (!auth.token) { location.hash = '#/user'; return; }
  const owner = auth.token;
  const welcome = needsWelcome();
  const back = welcome ? '#/welcome' : '#/settings/account/security';
  const shell = body => {
    el.innerHTML = authFrame({ title: '用你记得的答案，守护登录', description: '登录密保问题与验证器 2FA 二选一开启。选择不易被别人猜到的答案。', body: `<a class="cm-auth-back" href="${back}"><span class="material-icons-outlined">arrow_back</span>返回${welcome ? '引导' : '账号与安全'}</a>${body}` });
    document.getElementById('out').scrollTop = 0;
  };
  shell('<div class="cm-auth-loading"><mdui-circular-progress></mdui-circular-progress><p>正在读取密保设置…</p></div>');
  try {
    const state = await api.securityQuestionStatus();
    if (!el.isConnected || auth.token !== owner) return;
    if (state.twoFactorEnabled) {
      shell('<div class="cm-auth-kicker">账号安全</div><h2>当前已开启验证器 2FA</h2><p class="cm-auth-description">两种登录保护不能同时开启。请先用验证码或恢复码关闭验证器 2FA，再设置密保问题。</p><mdui-button href="#/two-factor" variant="filled">管理验证器 2FA</mdui-button>');
      return;
    }
    shell(`<div class="cm-auth-kicker">账号安全</div><h2>${state.enabled ? '登录密保问题已开启' : '设置登录密保问题'}</h2>
      <p class="cm-auth-description">${state.enabled ? '关闭或更换问题前，请验证当前密码与原答案。' : '登录时，在密码或邮箱验证码之后回答这个问题。请设置只有你自己知道的答案。'}</p>
      <div class="cm-auth-fields"><mdui-text-field id="questionPassword" label="当前账号密码" variant="outlined" type="password" password-icon autocomplete="current-password"></mdui-text-field>
      ${state.enabled ? `<div class="cm-welcome-note"><span class="material-icons-outlined">help_outline</span><p>${esc(state.question)}</p></div>` : '<mdui-text-field id="questionText" label="自定义问题（4~100 字）" variant="outlined" maxlength="100"></mdui-text-field>'}
      <mdui-text-field id="questionAnswer" label="${state.enabled ? '原密保答案' : '设置答案（2~128 字）'}" variant="outlined" type="password" password-icon autocomplete="off" maxlength="128"></mdui-text-field>
      ${state.enabled ? '' : '<mdui-text-field id="confirmQuestionAnswer" label="再次输入答案" variant="outlined" type="password" password-icon autocomplete="off" maxlength="128"></mdui-text-field>'}
      <div id="questionError" class="cm-auth-error" role="alert" aria-live="polite"></div>
      <mdui-button id="saveSecurityQuestion" variant="filled">${state.enabled ? '验证并关闭密保问题' : '确认开启登录密保问题'}</mdui-button></div>
      <p class="cm-auth-footnote">答案忽略首尾空格、英文大小写和全角半角差异。开启或关闭后，其他设备需重新登录；找回密码不会关闭密保。</p>`);
    const button = el.querySelector('#saveSecurityQuestion');
    button.onclick = async () => {
      if (button.loading) return;
      const error = el.querySelector('#questionError'); error.textContent = '';
      const password = el.querySelector('#questionPassword').value;
      const answer = el.querySelector('#questionAnswer').value;
      if (!password || !answer.trim()) { error.textContent = '请填写当前密码与密保答案'; return; }
      if (!state.enabled && answer !== el.querySelector('#confirmQuestionAnswer').value) { error.textContent = '两次输入的密保答案不一致'; return; }
      button.loading = true;
      try {
        if (state.enabled) await api.disableSecurityQuestion(password, answer);
        else await api.enableSecurityQuestion(password, el.querySelector('#questionText').value, answer);
        toast(state.enabled ? '登录密保问题已关闭' : '登录密保问题已开启');
        if (welcome) completeWelcome(); else location.hash = '#/settings/account/security';
      } catch (e) { error.textContent = e.message; } finally { button.loading = false; }
    };
    el.querySelectorAll('mdui-text-field').forEach(input => input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); button.click(); } }));
  } catch (e) {
    if (!el.isConnected) return;
    shell(`<h2>暂时无法读取密保设置</h2><p class="cm-auth-description">${esc(e.message)}</p><mdui-button id="questionRetry" variant="filled">重新加载</mdui-button>`);
    el.querySelector('#questionRetry').onclick = () => render(el, params);
  }
}
