// 发现页「Chat」：公共聊天室（v1.28.30）。
//
// 设计要点：
//   · 实时：SSE（/cm/live/chat 无缓冲命名空间）——先拉历史 + latestSeq，再从该
//     seq 订阅增量；断线由 EventSource 按 id=seq 自动续传。切走 TAB 时关闭连接。
//   · 身份：消息内联返回 user（昵称/用户名/头像/挂件/头衔/角色），渲染复用
//     ui.js 的 avatarHTML（自带挂件叠加）与 userTags（头衔+角色徽章）。
//   · @ 提及：输入 @ 弹出成员选择（/chat/members 近期活跃），选中插入 @昵称；
//     发送时把「内容里确实出现的 @昵称」换算成 user id 列表（服务端只存 id）。
//   · 图片：本地 canvas 压到 ≤1280px JPEG（长边）再 base64 上传（服务端 ≤1.5MB、
//     魔法字节校验），直链由后端 /chat/image/<file> 分发。
import { api, auth, call, settings } from './api.js';
import { esc, avatarHTML, userTags, toast } from './ui.js';

const PAGE = 30;
let es = null;              // 当前 SSE 连接（重进 TAB / 切走时关闭）
let pollTimer = 0;          // SSE 不可用时的轮询兜底
let fitChat = null;         // 聊天区高度自适应解绑函数
let myId = 0;               // 自己的 user id（标记「我」的消息、删除权限）

/** 关闭聊天 SSE（切到其它 TAB / 离开发现页时调用，避免连接悬挂）。 */
let navWatcher = null;
export function closeChat() {
  if (es) { try { es.close(); } catch (e) { /* 忽略 */ } es = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  if (navWatcher) { window.removeEventListener('hashchange', navWatcher); navWatcher = null; }
  if (fitChat) { fitChat(); fitChat = null; }
}

const fmtTime = ts => {
  const d = new Date((ts || 0) * 1000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (d >= today) ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

/** 文本转 HTML：转义 → 换行保留 → @昵称 高亮（提及者与成员昵称都算）。 */
function contentHTML(m, members) {
  let text = esc(m.content || '');
  const names = new Map();
  (m.mentions || []).forEach(u => names.set(u.nickname, u.id));
  (members || []).forEach(u => names.set(u.nickname, u.id));
  for (const [nick] of names) {
    if (!nick) continue;
    text = text.split('@' + nick).join(`<span class="cm-chatp-at">@${esc(nick)}</span>`);
  }
  return text.replace(/\n/g, '<br>');
}

function msgHTML(m) {
  const mine = m.user && m.user.id === myId;
  return `
  <div class="cm-chatp-msg${mine ? ' mine' : ''}" data-id="${m.id}" data-uid="${m.user ? m.user.id : 0}">
    <span class="cm-chatp-ava" data-uid="${m.user ? m.user.id : 0}">${m.user ? avatarHTML(m.user, 40) : '<div class="cm-avatar ph" style="width:40px;height:40px">?</div>'}</span>
    <div class="cm-chatp-main">
      <div class="cm-chatp-head">
        <span class="cm-chatp-nick" data-uid="${m.user ? m.user.id : 0}">${m.user ? esc(m.user.nickname) : '已注销用户'}</span>
        ${m.user ? userTags(m.user) : ''}
        <span class="cm-chatp-un">@${m.user ? esc(m.user.username) : '—'}</span>
        <span class="cm-chatp-time">${fmtTime(m.createdAt)}</span>
        ${mine ? `<span class="cm-chatp-del material-icons-outlined" data-del="${m.id}" title="删除">delete</span>` : ''}
      </div>
      <div class="cm-chatp-bubble">
        ${m.content ? `<div class="cm-chatp-text">${contentHTML(m, membersCache)}</div>` : ''}
        ${m.image ? `<img class="cm-chatp-img" src="${esc(settings.base)}/chat/image/${esc(m.image)}" loading="lazy" onclick="window.open(this.src,'_blank')">` : ''}
      </div>
    </div>
  </div>`;
}

let membersCache = [];       // @ 选择器成员（也用于渲染高亮）

/** 从内容反推提及 id：@昵称 确实出现在文本里才带上。 */
function mentionsFromContent(text) {
  const t = ' ' + (text || '') + ' ';
  const ids = [];
  for (const u of membersCache) {
    if (u.nickname && t.includes('@' + u.nickname) && !ids.includes(u.id)) ids.push(u.id);
  }
  return ids.slice(0, 10);
}

/** 本地压缩：长边 ≤1280px 的 JPEG（聊天图片不需要原图，服务端上限 1.5MB）。 */
function compressImage(file, maxSide = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * scale));
      cv.height = Math.max(1, Math.round(img.height * scale));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const dataURL = cv.toDataURL('image/jpeg', quality);
      resolve(dataURL.slice(dataURL.indexOf(',') + 1));      // 去掉 data:image/jpeg;base, 前缀
    };
    img.src = url;
  });
}

export async function mountChat(box) {
  closeChat();
  // 离开发现页（如点进用户主页）时关闭后台连接；TAB 内切换由 closeChat 负责
  navWatcher = () => { if (!/^#\/square/.test(location.hash || '')) closeChat(); };
  window.addEventListener('hashchange', navWatcher);
  box.innerHTML = `
    <div class="cm-chatp">
      <div class="cm-chatp-list" id="chatList">
        <div class="cm-chatp-more" id="chatMore" style="display:none"><mdui-button variant="text">加载更早的消息</mdui-button></div>
        <div id="chatMsgs"></div>
        <div class="cm-chatp-empty" id="chatEmpty">还没有人说话，来打个招呼吧</div>
      </div>
      <div class="cm-chatp-picker" id="chatPicker"></div>
      <div class="cm-chatp-composer">
        <button class="cm-chatp-tool material-icons-outlined" id="chatImgBtn" title="发图片">image</button>
        <input type="file" id="chatImgFile" accept="image/*" style="display:none">
        <div class="cm-chatp-inputwrap">
          <textarea id="chatInput" rows="1" placeholder="${auth.token ? '说点什么…（@ 可以提及成员）' : '登录后即可聊天'}" ${auth.token ? '' : 'disabled'}></textarea>
          <div class="cm-chatp-preview" id="chatPreview" style="display:none"></div>
        </div>
        <mdui-button variant="filled" id="chatSend" ${auth.token ? '' : 'disabled'}>发送</mdui-button>
      </div>
    </div>`;

  // 聊天区高度：按 #out 的真实可见区域计算（含移动端键盘用 visualViewport 收缩），
  // 不再用 100dvh 减固定值——那样在手机上会高出一截，输入框被顶到导航栏后面。
  const chatEl = box.querySelector('.cm-chatp');
  if (chatEl) {
    const fit = () => {
      if (!chatEl.isConnected) { unbindFit(); return; }
      const out = document.getElementById('out');
      if (!out) return;
      const outRect = out.getBoundingClientRect();
      // 聊天区在 #out 内容坐标里的位置（滚动无关）
      const topInOut = chatEl.getBoundingClientRect().top - outRect.top + out.scrollTop;
      const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      const byOut = out.clientHeight - topInOut - 8;
      const byView = vh - (outRect.top + topInOut) - 8;
      chatEl.style.height = Math.max(240, Math.round(Math.min(byOut, byView))) + 'px';
    };
    const unbindFit = () => {
      window.removeEventListener('resize', fit);
      window.removeEventListener('orientationchange', fit);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', fit);
        window.visualViewport.removeEventListener('scroll', fit);
      }
      fitChat = null;
    };
    fitChat = unbindFit;
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', fit);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', fit);
      window.visualViewport.addEventListener('scroll', fit);
    }
    fit();
    requestAnimationFrame(fit);
  }

  const list = box.querySelector('#chatList');
  const msgsEl = box.querySelector('#chatMsgs');
  const emptyEl = box.querySelector('#chatEmpty');
  const moreEl = box.querySelector('#chatMore');
  const input = box.querySelector('#chatInput');
  const sendBtn = box.querySelector('#chatSend');
  const picker = box.querySelector('#chatPicker');
  const preview = box.querySelector('#chatPreview');

  if (auth.token) {
    api.me().then(u => {
      myId = (u && u.id) || 0;
      // 历史消息先于 me 渲染：补上「我的消息」高亮
      msgsEl.querySelectorAll('.cm-chatp-msg').forEach(n => {
        if (+n.dataset.uid === myId) n.classList.add('mine');
      });
    }).catch(() => {});
  }

  // ---- 成员（@ 选择器 + 高亮）----
  api.chatMembers().then(d => { membersCache = (d && d.members) || []; }).catch(() => {});

  // ---- 消息渲染 ----
  let oldest = 0, count = 0;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const scrollBottom = () => { list.scrollTop = list.scrollHeight; };

  function appendMsg(m) {
    if (msgsEl.querySelector(`[data-id="${m.id}"]`)) return;      // SSE 与发送响应去重
    msgsEl.insertAdjacentHTML('beforeend', msgHTML(m));
    count++; emptyEl.style.display = 'none';
  }
  function bindMsgs() {
    msgsEl.querySelectorAll('.cm-chatp-nick,.cm-chatp-ava').forEach(el => {
      if (el.dataset.uid && el.dataset.uid !== '0' && !el.dataset.b) {
        el.dataset.b = '1';
        el.onclick = () => { location.hash = `#/user/${el.dataset.uid}`; };
      }
    });
    msgsEl.querySelectorAll('.cm-chatp-del').forEach(el => {
      if (el.dataset.b) return; el.dataset.b = '1';
      el.onclick = async () => {
        if (!confirm('删除这条消息？')) return;
        try { await api.chatDelete(+el.dataset.del); msgsEl.querySelector(`[data-id="${el.dataset.del}"]`)?.remove(); }
        catch (e) { toast(e.message || '删除失败'); }
      };
    });
  }

  // ---- 历史 + 增量订阅 ----
  try {
    const d = await api.chatMessages(0, PAGE);
    (d.messages || []).forEach(appendMsg);
    oldest = (d.messages || [])[0] ? d.messages[0].id : 0;
    moreEl.style.display = oldest ? '' : 'none';
    bindMsgs(); scrollBottom();
  } catch (e) { toast(e.message || '聊天记录加载失败'); }

  // ---- 实时增量：SSE 优先，不可用时退化为 3s 轮询（旧 WebView/被中间层掐流） ----
  let since = 0;
  let sseOk = false;
  const applyEvent = ev => {
    try {
      const raw = JSON.parse(ev.data);
      const type = ev.type;
      if (type === 'message') {
        const stick = nearBottom();
        appendMsg(raw.payload); bindMsgs();
        if (stick) scrollBottom();
      } else if (type === 'delete') {
        msgsEl.querySelector(`[data-id="${raw.payload.id}"]`)?.remove();
      }
      if (raw.seq) since = Math.max(since, raw.seq);
    } catch (e) { /* 忽略坏帧 */ }
  };
  const startPolling = () => {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!box.isConnected) { clearInterval(pollTimer); pollTimer = 0; return; }   // 已离开
      try {
        const d = await call('GET', `/chat/live?since=${since}`);
        (d.events || []).forEach(e => applyEvent({ type: e.type, data: JSON.stringify(e) }));
      } catch (e) { /* 静默：下次再试 */ }
    }, 3000);
  };

  try {
    const live = await call('GET', '/chat/live').catch(() => null);
    since = (live && live.latestSeq) || 0;
    es = new EventSource(`${settings.base}/live/chat?sse=1&since=${since}`);
    es.addEventListener('message', applyEvent);
    es.addEventListener('delete', applyEvent);
    es.addEventListener('open', () => {
      sseOk = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }   // SSE 恢复：停轮询
    });
    es.addEventListener('error', () => {
      // EventSource 会自动重连；连续失败（readyState=CLOSED）时切轮询兜底
      if (es && es.readyState === EventSource.CLOSED) { sseOk = false; startPolling(); }
    });
  } catch (e) {
    sseOk = false;
    startPolling();
  }
  if (!sseOk) setTimeout(() => { if (!sseOk && !pollTimer) startPolling(); }, 5000);

  moreEl.onclick = async () => {
    if (!oldest) return;
    try {
      const d = await api.chatMessages(oldest, PAGE);
      const list2 = (d.messages || []);
      if (!list2.length) { moreEl.style.display = 'none'; return; }
      const keep = list.scrollHeight - list.scrollTop;
      msgsEl.insertAdjacentHTML('afterbegin', list2.map(msgHTML).join(''));
      oldest = list2[0].id;
      if (list2.length < PAGE) moreEl.style.display = 'none';
      bindMsgs();
      list.scrollTop = list.scrollHeight - keep;      // 保持视口不跳
    } catch (e) { toast(e.message || '加载失败'); }
  };

  // ---- 发送（文本 / 图片 / @） ----
  let pendingImage = '';
  const setPreview = () => {
    preview.style.display = pendingImage ? '' : 'none';
    preview.innerHTML = pendingImage
      ? `<img src="${esc(settings.base)}/chat/image/${esc(pendingImage)}"><span class="cm-chatp-rm material-icons-outlined" id="chatRmImg">close</span>` : '';
    if (pendingImage) preview.querySelector('#chatRmImg').onclick = () => { pendingImage = ''; setPreview(); };
  };

  async function doSend() {
    const content = input.value.trim();
    if (!content && !pendingImage) return;
    if (!auth.token) return toast('登录后即可聊天');
    sendBtn.setAttribute('loading', '');
    try {
      const m = await api.chatSend({ content, image: pendingImage, mentions: mentionsFromContent(content) });
      appendMsg(m); bindMsgs(); scrollBottom();
      input.value = ''; input.style.height = 'auto';
      pendingImage = ''; setPreview();
    } catch (e) {
      toast(e.message || '发送失败');
    } finally { sendBtn.removeAttribute('loading'); }
  }
  sendBtn.onclick = doSend;
  input.addEventListener('keydown', e => {
    // 中文输入法组字中的回车是「选词」，不能当成发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); doSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
    // 输入到 @xxx 时弹成员选择器
    const m = /@([^\s@]{0,12})$/.exec(input.value.slice(0, input.selectionStart || 0));
    if (m && auth.token && membersCache.length) {
      const kw = m[1].toLowerCase();
      const hits = membersCache.filter(u => u.nickname.toLowerCase().includes(kw)).slice(0, 6);
      if (hits.length) {
        picker.innerHTML = hits.map(u =>
          `<button class="cm-chatp-pk" data-nick="${esc(u.nickname)}" data-id="${u.id}">${avatarHTML(u, 24)}<span>${esc(u.nickname)}</span></button>`).join('');
        picker.style.display = '';
        picker.querySelectorAll('.cm-chatp-pk').forEach(b => {
          b.onclick = () => {
            const v = input.value.slice(0, input.selectionStart || 0).replace(/@([^\s@]*)$/, '@' + b.dataset.nick + ' ');
            input.value = v + input.value.slice(input.selectionStart || 0);
            picker.style.display = 'none';
            input.focus();
          };
        });
        return;
      }
    }
    picker.style.display = 'none';
  });

  box.querySelector('#chatImgBtn').onclick = () => {
    if (!auth.token) return toast('登录后可发图片');
    box.querySelector('#chatImgFile').click();
  };
  box.querySelector('#chatImgFile').onchange = async ev => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('只能发图片');
    toast('图片处理中…');
    try {
      const b64 = await compressImage(f);
      const d = await api.chatUpload({ file: b64, filename: 'chat.jpg', contentType: 'image/jpeg' });
      pendingImage = d.image; setPreview();
    } catch (e) { toast(e.message || '图片上传失败'); }
  };
}
