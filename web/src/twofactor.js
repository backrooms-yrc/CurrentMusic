import { api, auth } from './api.js';
import { esc, toast } from './ui.js';
import { afterLogin, completeWelcome, needsWelcome, authFrame } from './auth-flow.js';
import qrcode from 'qrcode-generator';

const CHALLENGE_KEY = 'cm.2fa.challenge';
let enrollment = null;
let recovery = null;
export function finishLogin(result) {
  if (!result.requires2FA && !result.requiresSecurityQuestion) return Promise.resolve(result);
  try {
    sessionStorage.setItem(CHALLENGE_KEY, JSON.stringify({ token: result.challengeToken, until: Date.now() + result.expiresIn * 1000, question: result.securityQuestion || '', method: result.verificationMethod || 'totp' }));
  } catch { toast('无法保存验证状态，请允许此站点使用会话存储后重试'); return Promise.resolve(null); }
  location.hash = result.requiresSecurityQuestion ? '#/security-question?mode=login' : '#/two-factor?mode=login';
  return Promise.resolve(null);
}
export function manage2FA() { location.hash = '#/two-factor'; }

function frame(el, title, description, body, back = '#/settings') {
  el.innerHTML = authFrame({ title, description, body: `<a class="cm-auth-back" href="${back}"><span class="material-icons-outlined">arrow_back</span>返回${back === '#/user' ? '登录' : back === '#/welcome' ? '引导' : '设置'}</a>${body}` });
  document.getElementById('out').scrollTop = 0;
}
function error(el, message) { const box = el.querySelector('[role=alert]'); if (box) box.textContent = message; }
function field(id, label, extra = '') { return `<mdui-text-field id="${id}" label="${label}" variant="outlined" ${extra}></mdui-text-field>`; }
function submit(el, selector, action) {
  const button = el.querySelector(selector);
  button.onclick = async () => {
    if (button.loading) return;
    button.loading = true; error(el, '');
    try { await action(); } catch (e) { error(el, e.message); } finally { button.loading = false; }
  };
  el.querySelectorAll('mdui-text-field').forEach(input => input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); button.click(); }
  }));
}
export async function render(el, params = []) {
  if (params.query && params.query.mode === 'login') return loginPage(el);
  if (!auth.token) { location.hash = '#/user'; return; }
  const owner = auth.token;
  const welcome = needsWelcome();
  const back = welcome ? '#/welcome' : '#/settings';
  const done = () => welcome ? completeWelcome() : (location.hash = '#/settings');
  if (recovery && recovery.owner === owner) return recoveryPage(el, done);
  if (enrollment && enrollment.owner === owner && enrollment.until > Date.now()) return bindPage(el, back, done);
  frame(el, '为账号多加一道保护', '使用你熟悉的验证器，让每次登录更安心。', '<div class="cm-auth-loading"><mdui-circular-progress></mdui-circular-progress><p>正在读取安全设置…</p></div>', back);
  try {
    const state = await api.twoFactorStatus();
    if (!el.isConnected || auth.token !== owner) return;
    if (state.securityQuestionEnabled) {
      enrollment = null;
      frame(el, '一次选择，一份保护', '验证器 2FA 与登录密保问题只能选择一种开启。', `<div class="cm-auth-kicker">账号安全</div><h2>当前已开启登录密保问题</h2><p class="cm-auth-description">如需改用验证器，请先验证原答案并关闭密保问题，再返回绑定。</p><mdui-button href="#/security-question" variant="filled">管理登录密保问题</mdui-button>`, back);
      return;
    }
    frame(el, state.enabled ? '安全，由你掌握' : '为账号多加一道保护', 'Google Authenticator、Microsoft Authenticator、Authy 等主流验证器均可使用。', `
      <div class="cm-auth-kicker">账号安全</div><h2>${state.enabled ? '两步验证已开启' : '开启两步验证'}</h2>
      <p class="cm-auth-description">${state.enabled ? `还有 ${state.recoveryCodesRemaining} 枚恢复码可用。关闭前，请验证你的身份。` : '先确认当前账号密码，再用验证器扫描二维码。整个过程只需几步。'}</p>
      <div class="cm-auth-fields">${field('mfaPass', '当前账号密码', 'type="password" password-icon autocomplete="current-password"')}
      ${state.enabled ? field('mfaCode', '验证码或恢复码', 'autocomplete="one-time-code"') : ''}
      <div class="cm-auth-error" role="alert" aria-live="polite"></div>
      <mdui-button variant="filled" id="mfaNext">${state.enabled ? '验证并关闭' : '继续绑定验证器'}</mdui-button></div>
      <p class="cm-auth-footnote">开启或关闭后，其他设备需要重新登录；当前设备将保持登录。</p>`, back);
    submit(el, '#mfaNext', async () => {
      const password = el.querySelector('#mfaPass').value;
      if (!password) throw new Error('请输入当前账号密码');
      if (state.enabled) {
        await api.disable2FA(password, el.querySelector('#mfaCode').value.trim());
        toast('两步验证已关闭'); done();
      } else {
        const setup = await api.setup2FA(password);
        enrollment = { ...setup, owner, until: Date.now() + setup.expiresIn * 1000 };
        if (el.isConnected && auth.token === owner) bindPage(el, back, done);
      }
    });
  } catch (e) {
    if (!el.isConnected) return;
    error(el, e.message);
    el.querySelector('.cm-auth-loading').innerHTML = '<p>暂时无法读取安全设置，请检查网络后重试。</p><mdui-button id="mfaRetry">重新加载</mdui-button>';
    el.querySelector('#mfaRetry').onclick = () => render(el, params);
  }
}
function loginPage(el) {
  let challenge;
  try { challenge = JSON.parse(sessionStorage.getItem(CHALLENGE_KEY) || 'null'); } catch { /* 过期视为重新登录 */ }
  const expired = !challenge || challenge.until <= Date.now();
  frame(el, '再一步，就能继续聆听', '两步验证已保护你的账号。请打开验证器，确认这次登录。', `
    <div class="cm-auth-kicker">登录 · 第 2 步</div><h2>${expired ? '请重新发起登录' : '输入安全验证码'}</h2>
    <p class="cm-auth-description">${expired ? '此次验证已过期，返回登录页重新验证账号即可。' : '输入验证器中每 30 秒更新的 6 位验证码。没有验证器？也可以使用一枚恢复码。'}</p>
    ${expired ? '<mdui-button href="#/user" variant="filled">返回登录</mdui-button>' : `<div class="cm-auth-fields">${field('otp', '验证码或恢复码', 'autocomplete="one-time-code" autofocus')}
    <div class="cm-auth-error" id="otpError" role="alert" aria-live="polite"></div><mdui-button id="verifyLogin" variant="filled">验证并登录</mdui-button></div><p class="cm-auth-footnote">验证码不正确？请检查手机时间是否自动同步。恢复码只能使用一次。</p>`}`, '#/user');
  if (expired) return;
  submit(el, '#verifyLogin', async () => {
    if (challenge.until <= Date.now()) { loginPage(el); return; }
    const code = el.querySelector('#otp').value.trim();
    if (!code) throw new Error('请输入验证码或恢复码');
    const result = await api.verify2FA(challenge.token, code);
    sessionStorage.removeItem(CHALLENGE_KEY);
    auth.saveLogin(result.token, result.user); afterLogin();
  });
}
function bindPage(el, back, done) {
  const setup = enrollment;
  const qr = qrcode(0, 'M'); qr.addData(setup.uri); qr.make();
  frame(el, '把安全，握在自己手中', '二维码在本机生成。用验证器扫一扫，也可以手动添加密钥。', `
    <div class="cm-auth-kicker">绑定验证器 · 第 2 步</div><h2>扫描二维码</h2>
    <p class="cm-auth-description">在验证器中添加账号，扫描下方二维码，再输入生成的验证码。请在 10 分钟内完成。</p>
    <div class="cm-auth-qr">${qr.createSvgTag({ cellSize: 3, margin: 12, scalable: true })}</div>
    <details class="cm-auth-manual"><summary>无法扫码？手动输入密钥</summary><code>${esc(setup.secret)}</code><p>时间型 · SHA1 · 6 位 · 30 秒</p></details>
    <div class="cm-auth-fields">${field('bindCode', '6 位验证码', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}
    <div class="cm-auth-error" role="alert" aria-live="polite"></div><mdui-button id="enableFactor" variant="filled">确认开启两步验证</mdui-button>
    <mdui-button id="restartFactor" variant="text">重新生成二维码</mdui-button></div>`, back);
  el.querySelector('#restartFactor').onclick = () => { enrollment = null; render(el); };
  submit(el, '#enableFactor', async () => {
    if (setup.until <= Date.now()) throw new Error('二维码已过期，请重新生成后再绑定');
    const code = el.querySelector('#bindCode').value.trim();
    if (!/^[0-9]{6}$/.test(code)) throw new Error('请输入 6 位数字验证码');
    const result = await api.enable2FA(code);
    recovery = { codes: result.recoveryCodes, owner: setup.owner }; enrollment = null;
    if (el.isConnected && auth.token === setup.owner) recoveryPage(el, done);
  });
}
function recoveryPage(el, done) {
  el.innerHTML = authFrame({ title: '已开启，再留一份安心', description: '保存恢复码，丢失验证器时也能找回登录入口。', body: `
    <div class="cm-auth-kicker"><span class="material-icons-outlined">check_circle</span>两步验证已开启</div><h2>请保存你的恢复码</h2>
    <p class="cm-auth-description">这些恢复码仅显示一次，每枚只能使用一次。请保存到安全的位置，不要分享给他人。</p>
    <div class="cm-recovery-grid">${recovery.codes.map(c => `<code>${esc(c)}</code>`).join('')}</div>
    <mdui-button id="copyRecovery" variant="tonal" full-width><span class="material-icons-outlined" slot="icon">content_copy</span>复制全部恢复码</mdui-button>
    <mdui-button id="downloadRecovery" variant="tonal" full-width><span class="material-icons-outlined" slot="icon">download</span>下载恢复码</mdui-button>
    <label class="cm-recovery-check"><mdui-checkbox id="savedRecovery"></mdui-checkbox>我已将恢复码保存在安全的位置</label>
    <mdui-button id="factorDone" variant="filled" full-width disabled>完成设置</mdui-button>
    <p class="cm-auth-footnote">找回密码不会关闭两步验证。离开前，请确认已保存恢复码。</p>` });
  document.getElementById('out').scrollTop = 0;
  el.querySelector('#copyRecovery').onclick = async () => {
    const text = recovery.codes.join('\n');
    try { await navigator.clipboard.writeText(text); toast('恢复码已复制，请保存到安全的位置'); }
    catch {
      const area = document.createElement('textarea');
      area.value = text; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { toast(document.execCommand('copy') ? '恢复码已复制，请妥善保存' : '请长按恢复码手动复制'); }
      catch { toast('请长按恢复码手动复制'); }
      finally { area.remove(); }
    }
  };
  if (window.NativeApi) el.querySelector('#downloadRecovery').hidden = true;
  el.querySelector('#downloadRecovery').onclick = () => {
    const blob = new Blob(['CurrentStation 两步验证恢复码\n每枚只能使用一次，请妥善保管。\n\n' + recovery.codes.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'CurrentStation-recovery-codes.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el.querySelector('#savedRecovery').addEventListener('change', e => { el.querySelector('#factorDone').disabled = !e.target.checked; });
  el.querySelector('#factorDone').onclick = () => {
    if (!el.querySelector('#savedRecovery').checked) return;
    recovery = null; done();
  };
}


export function renderQuestionLogin(el) {
  let challenge;
  try { challenge = JSON.parse(sessionStorage.getItem(CHALLENGE_KEY) || 'null'); } catch { /* 重新登录 */ }
  const expired = !challenge || challenge.method !== 'security_question' || challenge.until <= Date.now();
  frame(el, '回答熟悉的问题，继续聆听', '这次登录需要验证你设置的密保答案。', `
    <div class="cm-auth-kicker">登录 · 密保验证</div><h2>${expired ? '请重新发起登录' : '回答密保问题'}</h2>
    ${expired ? '<p class="cm-auth-description">此次验证已过期，请返回登录页重新验证账号。</p><mdui-button href="#/user" variant="filled">返回登录</mdui-button>' : `
    <div class="cm-welcome-note"><span class="material-icons-outlined">help_outline</span><p>${esc(challenge.question)}</p></div>
    <div class="cm-auth-fields">${field('securityAnswer', '密保答案', 'type="password" password-icon autocomplete="off" maxlength="128"')}
    <div class="cm-auth-error" role="alert" aria-live="polite"></div><mdui-button id="verifyQuestion" variant="filled">验证并登录</mdui-button></div>
    <p class="cm-auth-footnote">答案忽略首尾空格、英文大小写和全角半角差异。</p>`}`, '#/user');
  if (expired) return;
  submit(el, '#verifyQuestion', async () => {
    if (challenge.until <= Date.now()) { renderQuestionLogin(el); return; }
    const answer = el.querySelector('#securityAnswer').value;
    if (!answer.trim()) throw new Error('请输入密保答案');
    const result = await api.verifySecurityQuestion(challenge.token, answer);
    sessionStorage.removeItem(CHALLENGE_KEY);
    auth.saveLogin(result.token, result.user); afterLogin();
  });
}
