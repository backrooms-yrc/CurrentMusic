import { settings, auth, deviceInfo } from './api.js';
import { esc } from './ui.js';
import { afterLogin } from './auth-flow.js';

export const passkeysSupported = () => window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials && !window.NativeApi;
const decode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4-s.length%4)%4)), c => c.charCodeAt(0));
const encode = b => b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'') : null;
async function request(path, body, signed = false) {
  const response = await fetch(settings.base + '/auth/passkeys' + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
    headers: { ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(signed && auth.token ? {Authorization:'Bearer '+auth.token} : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '通行密钥请求失败');
  return data;
}
function options(value) {
  const o = {...value, challenge: decode(value.challenge)};
  if (o.user) o.user = {...o.user,id:decode(o.user.id)};
  for (const key of ['allowCredentials','excludeCredentials']) if(o[key]) o[key]=o[key].map(c=>({...c,id:decode(c.id)}));
  return o;
}
function serialize(c) {
  const r=c.response;
  return {id:c.id,rawId:encode(c.rawId),type:c.type,response:{clientDataJSON:encode(r.clientDataJSON),
    ...(r.attestationObject ? {attestationObject:encode(r.attestationObject),transports:r.getTransports ? r.getTransports() : []} :
      {authenticatorData:encode(r.authenticatorData),signature:encode(r.signature),userHandle:encode(r.userHandle)})}};
}
function readable(e) { return e.name==='NotAllowedError' ? '操作已取消或超时，请重试。' : e.name==='InvalidStateError' ? '此验证器已绑定，请使用已有通行密钥。' : e.message; }
export async function passkeyLogin() {
  if (!passkeysSupported()) throw Error('请使用支持通行密钥的 HTTPS 浏览器；App 内可在浏览器中打开本站。');
  try {
    const start = await request('/login/options',{});
    const credential = await navigator.credentials.get({publicKey:options(start.publicKey)});
    const result = await request('/login/verify',{challengeToken:start.challengeToken,credential:serialize(credential),...deviceInfo()});
    auth.saveLogin(result.token,result.user); afterLogin();
  } catch(e) { throw Error(readable(e)); }
}
export async function render(el) {
  if (!auth.token) { location.hash='#/user'; return; }
  const owner = auth.token;
  el.innerHTML = `<section class="cm-network"><a href="#/settings/account/security">← 账号与安全</a><h1>通行密钥</h1><p>用指纹、人脸、设备 PIN 或安全密钥登录，成功后无需再输入二步验证码或密保答案。每个域名须分别绑定，当前域名：${esc(location.hostname)}。</p>
    <div id="passkeyList" role="status">正在读取已绑定密钥…</div>
    <section><h2>绑定或删除</h2><p>为保护账号，操作时须验证当前密码，以及已启用的二步验证码或密保答案。</p>
    <label>密钥名称 <input id="pkName" maxlength="64" autocomplete="off" placeholder="例如：我的手机"></label>
    <label>当前密码 <input id="pkPassword" type="password" autocomplete="current-password"></label>
    <label>二步验证码或密保答案（未开启可留空）<input id="pkFactor" type="password" autocomplete="off"></label>
    <button id="pkAdd" ${passkeysSupported() ? '' : 'disabled'}>绑定通行密钥</button>
    ${passkeysSupported() ? '' : '<p>此环境不支持通行密钥，请在支持的 HTTPS 浏览器中打开本站。</p>'}</section><p id="pkError" role="alert"></p></section>`;
  const $=id=>el.querySelector('#'+id);
  let busy=false;
  const proof=()=>({password:$('pkPassword').value,factor:$('pkFactor').value});
  const run=async action=>{if(busy)return;busy=true;$('pkError').textContent='';try{await action();}catch(e){if(el.isConnected)$('pkError').textContent=readable(e);}finally{busy=false;if(el.isConnected){$('pkPassword').value='';$('pkFactor').value='';}}};
  async function load(){
    const r=await request('',undefined,true);
    if(!el.isConnected||auth.token!==owner)return;
    $('passkeyList').innerHTML=r.keys.length?r.keys.map(k=>`<article><strong>${esc(k.name)}</strong> · ${esc(k.rp)} · ${new Date(k.created*1000).toLocaleDateString()} <button data-key="${esc(k.id)}">删除</button></article>`).join(''):'尚未绑定通行密钥。';
    $('passkeyList').querySelectorAll('button').forEach(b=>b.onclick=()=>run(async()=>{await request('/delete',{id:b.dataset.key,...proof()},true);await load();}));
  }
  $('pkAdd').onclick=()=>run(async()=>{
    const start=await request('/register/options',proof(),true);
    const credential=await navigator.credentials.create({publicKey:options(start.publicKey)});
    if(auth.token!==owner)throw Error('账号已变化，请重新操作');
    await request('/register/verify',{challengeToken:start.challengeToken,credential:serialize(credential),name:$('pkName').value},true);
    await load();
  });
  await run(load);
}
