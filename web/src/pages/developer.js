// CurrentDeveloper 开发者平台：自助把应用接入 CurrentStation 通行证
//
// 路由：#/developer
//
// 能做什么（全部走 /passport/apps*，普通用户只能操作自己登记的应用）：
//   · 新建应用：填名称 / 主页 / 回调地址（redirect_uri）/ 需要的 scope / 公开或机密
//   · 拿到凭据：client_id 随时可见、可复制；client_secret 只在创建或轮换时显示一次
//   · 获取令牌：一键用刚拿到的凭据试取「应用令牌」（client_credentials），
//     并给出可直接粘贴的接入代码（授权码 + PKCE 那一段）
//   · 管理：改名称/主页/回调/scope、轮换密钥、停用/启用
import { mdui } from '../md.js';
import { api, settings, auth } from '../api.js';
import { esc, toast } from '../ui.js';

export const TITLE = '开发者平台';

const SCOPE_HINT = [
  { k: 'openid', t: '登录身份（必需）' },
  { k: 'profile', t: '昵称 / 头像 / 简介' },
  { k: 'email', t: '邮箱（脱敏）' },
  { k: 'phone', t: '手机号（脱敏）' },
  { k: 'offline_access', t: '长期授权（30 天可刷新）' },
];

const DOC_URL = () => settings.base + '/passport/docs';
const APP_URL = () => settings.base.replace(/\/cm\/?$/, '') + '/app/';

function openDoc() {
  const w = window.open(DOC_URL(), '_blank');
  if (!w) location.href = DOC_URL();
}

async function copy(text, okMsg = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch {
    toast('复制失败，请手动选择文本');
  }
}

/** 接入代码片段：把该应用的真实 client_id / 回调地址填进去，密钥用占位符。 */
function snippet(app) {
  const cb = (app.redirects || [])[0] || 'https://你的域名/auth/callback';
  const base = settings.base;
  return `# 1) 把用户送到通行证授权页（PKCE：verifier 随机 43~128 位，challenge = BASE64URL(SHA256(verifier))）
${base}/passport/authorize?response_type=code
  &client_id=${app.clientId}
  &redirect_uri=${encodeURIComponent(cb)}
  &scope=${encodeURIComponent(app.scopes || 'openid profile')}
  &state=<随机串>
  &code_challenge=<challenge>&code_challenge_method=S256

# 2) 回调里拿到 code 后换取令牌（有密钥的客户端用 Basic 或 client_secret 字段）
curl -X POST ${base}/passport/token -H "Content-Type: application/json" -d '{
  "grant_type":"authorization_code",
  "client_id":"${app.clientId}",
  "client_secret":"<你的 client_secret>",
  "code":"<回调里的 code>",
  "redirect_uri":"${cb}",
  "code_verifier":"<第 1 步的 verifier>"}'

# 3) 取用户信息
curl ${base}/passport/userinfo -H "Authorization: Bearer cs_at_…"

# 只有应用自己、没有用户时（服务端到服务端）：
curl -X POST ${base}/passport/token -H "Content-Type: application/json" -d '{
  "grant_type":"client_credentials","client_id":"${app.clientId}",
  "client_secret":"<你的 client_secret>","scope":"openid"}'`;
}

function codeBlock(text) {
  return `<pre style="margin:8px 0 0;padding:10px 12px;border-radius:10px;background:rgba(120,128,145,.14);overflow:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all">${esc(text)}</pre>`;
}

function showCredentials(r, appForSnippet) {
  const diag = mdui.dialog({
    headline: r.clientSecret ? '应用已创建 · 请保存密钥' : '应用已创建',
    body: `<div class="cm-more">
      <div class="cm-more-s">${r.clientSecret
        ? '<b>client_secret 只显示这一次</b>，请立刻存到应用服务端的环境变量里（不要写进前端代码）。'
        : '公开客户端（App / SPA）不需要密钥，但必须使用 PKCE。'}</div>
      <div class="cm-more-s" style="margin-top:8px">client_id</div>
      <div style="display:flex;gap:8px;align-items:center">
        <code style="flex:1;word-break:break-all">${esc(r.clientId)}</code>
        <mdui-button variant="text" data-copy="${esc(r.clientId)}">复制</mdui-button>
      </div>
      ${r.clientSecret ? `<div class="cm-more-s" style="margin-top:8px">client_secret</div>
      <div style="display:flex;gap:8px;align-items:center">
        <code style="flex:1;word-break:break-all">${esc(r.clientSecret)}</code>
        <mdui-button variant="text" data-copy="${esc(r.clientSecret)}">复制</mdui-button>
      </div>` : ''}
      <div class="cm-more-s" style="margin-top:12px">接入代码</div>
      ${codeBlock(snippet(appForSnippet))}
      <div id="ppTry" style="margin-top:10px"></div>
    </div>`,
    actions: [{ text: '接入文档', onClick: () => { openDoc(); return false; } }, { text: '完成' }],
  });
  diag.querySelectorAll('mdui-button[data-copy]').forEach(b => {
    b.onclick = () => copy(b.dataset.copy);
  });
  // 一键「获取令牌」：拿刚创建的凭据直接试一次 client_credentials（演示能跑通）
  const box = diag.querySelector('#ppTry');
  if (r.clientSecret && box) {
    box.innerHTML = '<mdui-button variant="tonal" id="ppTryBtn">立即获取应用令牌（演示）</mdui-button><div id="ppTryOut" style="font-size:12.5px;margin-top:6px"></div>';
    box.querySelector('#ppTryBtn').onclick = async () => {
      const out = box.querySelector('#ppTryOut');
      out.textContent = '请求中…';
      try {
        const resp = await fetch(settings.base + '/passport/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credentials', client_id: r.clientId,
                                 client_secret: r.clientSecret, scope: 'openid' }),
        });
        const d = await resp.json().catch(() => ({}));
        out.innerHTML = resp.ok
          ? `<span style="color:#157f3d">✓ 拿到应用令牌</span>（${esc(String(d.access_token || '').slice(0, 16))}…，${Math.round((d.expires_in || 0) / 3600)} 小时有效）`
          : `<span style="color:#b3261e">✗ ${esc(d.error_description || d.error || ('HTTP ' + resp.status))}</span>`;
      } catch (e) {
        out.innerHTML = `<span style="color:#b3261e">✗ ${esc(e.message || '网络错误')}</span>`;
      }
    };
  }
}

function appForm(app, onDone) {
  const isNew = !app;
  const a = app || { name: '', homepage: '', redirects: [], scopes: 'openid profile', public: false };
  const diag = mdui.dialog({
    headline: isNew ? '新建应用' : '编辑应用',
    body: `<div class="cm-more">
      <mdui-text-field id="dvName" label="应用名称" variant="outlined" value="${esc(a.name)}" style="width:100%"></mdui-text-field>
      <mdui-text-field id="dvHome" label="应用主页（可选）" variant="outlined" value="${esc(a.homepage || '')}" style="width:100%;margin-top:8px"></mdui-text-field>
      <div class="cm-more-s" style="margin:10px 0 4px">回调地址 redirect_uri（每行一个，必须 https；本机调试可用 http://localhost）</div>
      <textarea id="dvRedirect" rows="2" style="width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid rgba(120,128,145,.35);background:transparent;color:inherit;font:13px/1.6 ui-monospace,monospace">${esc((a.redirects || []).join('\n'))}</textarea>
      <mdui-text-field id="dvScope" label="需要的 scope（空格分隔）" variant="outlined" value="${esc(a.scopes || 'openid profile')}" style="width:100%;margin-top:8px"></mdui-text-field>
      <div class="cm-more-s" style="margin-top:6px">${SCOPE_HINT.map(s => `<code>${s.k}</code> ${esc(s.t)}`).join(' · ')}</div>
      <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:calc(13px * var(--cm-fs, 1))">
        <mdui-checkbox id="dvPublic" ${a.public ? 'checked' : ''}></mdui-checkbox>公开客户端（原生 App / 纯前端：不发密钥，强制 PKCE）
      </label>
    </div>`,
    actions: [
      {
        text: isNew ? '创建' : '保存',
        // 注意：这里必须是**同步** onClick（返回 false 保持弹窗），
        // 异步逻辑放进 IIFE —— mdui 看到 Promise 就会在 resolve 时自动关窗
        onClick: () => {
          (async () => {
          const payload = {
            name: (diag.querySelector('#dvName').value || '').trim(),
            homepage: (diag.querySelector('#dvHome').value || '').trim(),
            redirects: (diag.querySelector('#dvRedirect').value || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean),
            scopes: (diag.querySelector('#dvScope').value || 'openid profile').trim(),
            public: !!(diag.querySelector('#dvPublic') || {}).checked,
          };
          if (!payload.name) { toast('请填写应用名称'); return false; }
          if (!payload.redirects.length) { toast('请至少填一个回调地址'); return false; }
          try {
            if (isNew) {
              const r = await api.passportCreateApp(payload);
              diag.open = false;
              showCredentials(r, Object.assign({}, payload, { clientId: r.clientId }));
              onDone();
            } else {
              const r = await api.passportUpdateApp(app.clientId, payload);
              diag.open = false;
              if (r.clientSecret) showCredentials({ clientId: app.clientId, clientSecret: r.clientSecret },
                                                 Object.assign({}, app, payload));
              else toast('已保存');
              onDone();
            }
          } catch (e) { toast(e.message || '保存失败'); }
          })();
          return false;
        },
      },
      { text: '取消' },
    ],
  });
}

export async function render(el) {
  if (!auth.token) {
    try { sessionStorage.setItem('cm.ppBack', '#/developer'); } catch { /* 隐私模式 */ }
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1));color:var(--cm-primary)">developer_mode</span>
      <div><b>CurrentDeveloper 开发者平台</b><br>用 CurrentStation 通行证登录后，即可把自己的应用接进来。</div>
      <mdui-button variant="filled" id="dvLogin">去登录</mdui-button></div>`;
    el.querySelector('#dvLogin').onclick = () => { location.hash = '#/user'; };
    return;
  }

  el.innerHTML = `
    <div class="cm-login-tip page" style="text-align:left">
      <div style="display:flex;align-items:center;gap:8px;font-weight:650;font-size:calc(16px * var(--cm-fs, 1))">
        <span class="material-icons-outlined" style="color:var(--cm-primary)">developer_mode</span>CurrentDeveloper 开发者平台
      </div>
      <div style="font-size:calc(12.5px * var(--cm-fs, 1));opacity:.75;line-height:1.7;margin-top:6px">
        给自己的应用接入 CurrentStation 通行证：「用通行证登录」由我们负责，你只需拿 <code>client_id</code>（+ 密钥）、
        配好回调地址，就能在授权后换到令牌和用户资料。用户密码永远不会经过你的应用。
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <mdui-button variant="filled" id="dvNew">新建应用</mdui-button>
        <mdui-button variant="outlined" id="dvDocs">接入文档</mdui-button>
      </div>
      <div id="dvQuota" style="font-size:calc(12px * var(--cm-fs, 1));opacity:.6;margin-top:8px"></div>
    </div>
    <div id="dvList">${'<div class="cm-loading">加载中…</div>'}</div>`;

  el.querySelector('#dvDocs').onclick = openDoc;
  el.querySelector('#dvNew').onclick = () => appForm(null, () => render(el));

  const list = el.querySelector('#dvList');
  let data;
  try {
    data = await api.passportApps();
  } catch (e) {
    list.innerHTML = `<div class="cm-empty">读取失败：${esc(e.message || '未知错误')}</div>`;
    return;
  }
  const apps = data.apps || [];
  const quota = data.quota || {};
  const q = el.querySelector('#dvQuota');
  if (q) q.textContent = `已登记 ${quota.used || apps.length} / ${quota.max || 5} 个应用${quota.admin ? '（管理员）' : ''}`;

  if (!apps.length) {
    list.innerHTML = `<div class="cm-login-tip page"><div style="opacity:.75">还没有应用。点「新建应用」填上名称与回调地址即可——</div>
      <div style="opacity:.75;margin-top:4px">拿到 client_id 后，按「接入文档」里的四步就能跑通授权换令牌。</div></div>`;
    return;
  }

  list.innerHTML = apps.map(a => `
    <div class="cm-login-tip page" style="text-align:left">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <b style="font-size:calc(15px * var(--cm-fs, 1))">${esc(a.name)}</b>
        <span class="cm-tag">${a.public ? '公开客户端' : '机密客户端'}</span>
        ${a.firstParty ? '<span class="cm-tag admin">官方</span>' : ''}
        ${a.disabled ? '<span class="cm-tag">已停用</span>' : ''}
        ${a.mine === false ? '<span class="cm-tag">他人</span>' : ''}
      </div>
      <div style="font-size:calc(12px * var(--cm-fs, 1));opacity:.75;margin-top:6px;word-break:break-all">
        client_id <code>${esc(a.clientId)}</code>
      </div>
      <div style="font-size:calc(12px * var(--cm-fs, 1));opacity:.75;margin-top:2px">
        权限：${esc((a.scopes || '').split(/\s+/).filter(Boolean).join(' · ') || 'openid')} · 在用授权 ${a.grants || 0}
      </div>
      <div style="font-size:calc(12px * var(--cm-fs, 1));opacity:.6;margin-top:2px;word-break:break-all">
        回调：${esc((a.redirects || []).join(' , ') || '（未设置）')}${a.homepage ? ' · 主页 ' + esc(a.homepage) : ''}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <mdui-button variant="text" data-act="copy" data-id="${esc(a.clientId)}">复制 ID</mdui-button>
        <mdui-button variant="text" data-act="snippet" data-id="${esc(a.clientId)}">接入代码</mdui-button>
        <mdui-button variant="text" data-act="edit" data-id="${esc(a.clientId)}">编辑</mdui-button>
        ${a.public ? '' : `<mdui-button variant="text" data-act="rotate" data-id="${esc(a.clientId)}">轮换密钥</mdui-button>`}
        <mdui-button variant="text" data-act="toggle" data-id="${esc(a.clientId)}" data-off="${a.disabled ? '1' : '0'}">${a.disabled ? '启用' : '停用'}</mdui-button>
      </div>
    </div>`).join('');

  const byId = id => apps.find(x => x.clientId === id);
  list.querySelectorAll('mdui-button[data-act]').forEach(b => {
    const a = byId(b.dataset.id);
    if (!a) return;
    b.onclick = async () => {
      const act = b.dataset.act;
      if (act === 'copy') return copy(a.clientId, '已复制 client_id');
      if (act === 'snippet') {
        mdui.dialog({
          headline: `${a.name} · 接入代码`,
          body: `<div class="cm-more">${codeBlock(snippet(a))}
            <div class="cm-more-s" style="margin-top:8px">把 <code>&lt;你的 client_secret&gt;</code> 换成创建时保存的那把；
            公开客户端则不带密钥、改为在换令牌时传 <code>code_verifier</code>。</div></div>`,
          actions: [{ text: '复制', onClick: () => { copy(snippet(a)); return false; } },
                    { text: '接入文档', onClick: () => { openDoc(); return false; } }, { text: '关闭' }],
        });
        return;
      }
      if (act === 'edit') return appForm(a, () => render(el));
      if (act === 'rotate') {
        mdui.dialog({
          headline: '轮换 client_secret？',
          body: `<div class="cm-more"><div class="cm-more-s">新密钥<b>只显示一次</b>，旧密钥立即失效。
            勾选下面这项可以同时撤销该应用已发出的全部授权（客户端必须重新走一次授权）。</div>
            <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:calc(13px * var(--cm-fs, 1))">
              <mdui-checkbox id="dvRevoke"></mdui-checkbox>同时撤销该应用已发出的授权</label></div>`,
          actions: [
            {
              text: '轮换',
              onClick: () => {
                (async () => {
                  try {
                    const r = await api.passportRotateSecret(a.clientId, true);
                    showCredentials({ clientId: a.clientId, clientSecret: r.clientSecret }, a);
                  } catch (e) { toast(e.message || '轮换失败'); }
                })();
                return true;      // 关掉确认框，接着弹凭据框
              },
            },
            { text: '取消' },
          ],
        });
        return;
      }
      if (act === 'toggle') {
        const off = b.dataset.off === '0';
        try {
          if (off) await api.passportDisableApp(a.clientId);
          else await api.passportUpdateApp(a.clientId, { disabled: false });
          toast(off ? '已停用（该应用全部授权已撤销）' : '已启用');
          render(el);
        } catch (e) { toast(e.message || '操作失败'); }
      }
    };
  });
}
