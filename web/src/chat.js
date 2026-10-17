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
import { MAX_ATTACH, TYPE_LABEL, attachHTML, bindAttach, openAttachPicker } from './attach.js';

const PAGE = 30;
const AI_USERNAME = 'CurrentMusicAI';
const SUGGEST = {
  song: ['这首歌的创作背景是什么？', '这首歌出自哪部影视作品？', '这名歌手的生平事迹有哪些？'],
  album: ['这张专辑的创作背景是什么？', '这张专辑里有哪些代表作？', '这位歌手的生平事迹有哪些？'],
  artist: ['这位歌手的生平事迹有哪些？', '这位歌手的代表作有哪些？', '这位歌手的音乐风格是怎样的？'],
  playlist: ['这个歌单的主题是什么？', '这个歌单里有哪些值得一听的歌？', '这个歌单适合什么场景听？'],
};
let es = null;              // 当前 SSE 连接（重进 TAB / 切走时关闭）
let pollTimer = 0;          // SSE 不可用时的轮询兜底
let fitChat = null;         // 聊天区高度自适应解绑函数
let myId = 0;               // 自己的 user id（标记「我」的消息、删除权限）

/** 关闭聊天 SSE（切到其它 TAB / 离开发现页时调用，避免连接悬挂）。 */
let navWatcher = null;
let pickerDocHandler = null;
export function closeChat() {
  if (es) { try { es.close(); } catch (e) { /* 忽略 */ } es = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  if (navWatcher) { window.removeEventListener('hashchange', navWatcher); navWatcher = null; }
  if (fitChat) { fitChat(); fitChat = null; }
  if (pickerDocHandler) { document.removeEventListener('click', pickerDocHandler); pickerDocHandler = null; }
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
      ${m.atts && m.atts.length ? `<div class="cm-chatp-atts">${attachHTML(m.atts, { compact: true })}</div>` : ''}
    </div>
  </div>`;
}

let membersCache = [];               // @ 选择器本地缓存（也用于渲染高亮）
const pickedMentions = new Map();    // id -> user：从选择器选中的（服务端搜索结果也能计入 mentions）

/** 合并到本地成员缓存（去重、限量），供 @ 本地即时过滤。 */
function mergeMembers(list) {
  for (const u of list || []) {
    if (!u || !u.id) continue;
    const i = membersCache.findIndex(x => x.id === u.id);
    if (i >= 0) membersCache[i] = u;
    else membersCache.push(u);
  }
  if (membersCache.length > 200) membersCache = membersCache.slice(-200);
}

/** 从内容反推提及 id：@昵称 确实出现在文本里才带上（含选择器选中的服务端搜索结果）。 */
function mentionsFromContent(text) {
  const t = ' ' + (text || '') + ' ';
  const ids = [];
  const pool = new Map();
  membersCache.forEach(u => pool.set(u.id, u));
  pickedMentions.forEach((u, id) => pool.set(id, u));
  for (const u of pool.values()) {
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
  pickedMentions.clear();
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
      <div class="cm-chatp-suggest" id="chatSuggest" hidden></div>
      <div class="cm-chatp-composer">
        <button class="cm-chatp-tool material-icons-outlined" id="chatImgBtn" title="发图片">image</button>
        <button class="cm-chatp-tool material-icons-outlined" id="chatAttBtn" title="引用单曲/专辑/歌手/歌单">library_add</button>
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
  const suggest = box.querySelector('#chatSuggest');
  const preview = box.querySelector('#chatPreview');

  // ---- @ 提及选择器：本地即时过滤 + 服务端实时搜索（QQ 式） ----
  let mentionTimer = 0, mentionSeq = 0, pickerIndex = -1, pickerItems = [], pickerOpen = false;
  const mentionCache = new Map();   // q -> users

  const hidePicker = () => {
    pickerOpen = false;
    picker.style.display = 'none';
    pickerItems = [];
    pickerIndex = -1;
  };
  const markActive = () => {
    picker.querySelectorAll('.cm-chatp-pk').forEach((b, i) => b.classList.toggle('on', i === pickerIndex));
  };
  const hl = (text, q) => {
    const s = esc(text || '');
    if (!q) return s;
    const needle = esc(q);
    const i = s.toLowerCase().indexOf(needle.toLowerCase());
    if (i < 0) return s;
    return s.slice(0, i) + '<mark class="cm-chatp-hl">' + s.slice(i, i + needle.length) + '</mark>' + s.slice(i + needle.length);
  };
  const pickUser = (u) => {
    if (!u) return;
    const pos = input.selectionStart || 0;
    const before = input.value.slice(0, pos).replace(/@([^\s@]*)$/, () => '@' + u.nickname + ' ');
    input.value = before + input.value.slice(pos);
    pickedMentions.set(u.id, u);
    mergeMembers([u]);
    hidePicker();
    input.focus();
    try { input.setSelectionRange(before.length, before.length); } catch { /* 忽略 */ }
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
    updateSuggest();
  };

  const aiMentioned = () => {
    for (const u of pickedMentions.values()) {
      if (u.isBot || u.username === AI_USERNAME) return true;
    }
    return new RegExp('@\\s*' + AI_USERNAME + '\\b').test(input.value);
  };

  /** 引用卡片并 @AI 时，在输入框上方给出「猜你想问」。 */
  function updateSuggest() {
    if (!aiMentioned()) { suggest.hidden = true; suggest.innerHTML = ''; return; }
    const card = pendingAtts[0];
    if (!card) {
      suggest.innerHTML = '<span class="cm-chatp-suggest-h">先引用一张单曲 / 专辑 / 歌手 / 歌单卡片，再问我吧</span>';
      suggest.hidden = false;
      return;
    }
    const qs = SUGGEST[card.type] || SUGGEST.song;
    suggest.innerHTML = '<span class="cm-chatp-suggest-t">猜你想问</span>' +
      qs.map(q => `<button type="button" class="cm-chatp-sug">${esc(q)}</button>`).join('');
    suggest.hidden = false;
    suggest.querySelectorAll('.cm-chatp-sug').forEach(b => {
      b.onclick = () => {
        const q = b.textContent;
        const base = input.value.trim();
        if (!base.includes(q)) input.value = base ? base + ' ' + q : q;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 忽略 */ }
        input.style.height = 'auto';
        input.style.height = Math.min(120, input.scrollHeight) + 'px';
      };
    });
  }
  const drawPicker = (list, q) => {
    pickerItems = (list || []).slice(0, 8);
    pickerIndex = pickerItems.length ? 0 : -1;
    if (!pickerItems.length) {
      picker.innerHTML = '<div class="cm-chatp-pk-empty">没有匹配的用户</div>';
      pickerOpen = true;
      picker.style.display = 'block';
      return;
    }
    picker.innerHTML = pickerItems.map((u, i) => `
      <button type="button" class="cm-chatp-pk${i === 0 ? ' on' : ''}" data-i="${i}">
        ${avatarHTML(u, 28)}
        <span class="cm-chatp-pk-t">
          <span class="cm-chatp-pk-n">${hl(u.nickname, q)}${userTags(u)}</span>
          <span class="cm-chatp-pk-u">@${esc(u.username || '')}</span>
        </span>
      </button>`).join('');
    pickerOpen = true;
    picker.style.display = 'block';
    picker.querySelectorAll('.cm-chatp-pk').forEach(b => {
      const take = e => { e.preventDefault(); pickUser(pickerItems[+b.dataset.i]); };
      b.addEventListener('mousedown', take);
      b.addEventListener('touchstart', take, { passive: false });
    });
  };
  const searchMentions = (q) => {
    clearTimeout(mentionTimer);
    const my = ++mentionSeq;
    if (!q) { drawPicker(membersCache.slice(0, 8), ''); return; }   // 刚输入 @：先给近期成员
    mentionTimer = setTimeout(async () => {
      let list = mentionCache.get(q);
      if (!list) {
        try {
          const d = await api.chatMembers(q);
          list = (d && d.members) || [];
          mentionCache.set(q, list);
          mergeMembers(list);
          if (mentionCache.size > 100) mentionCache.clear();
        } catch { return; }              // 网络失败：保留本地即时结果
      }
      if (my !== mentionSeq) return;     // 过期响应
      const m = /@([^\s@]{0,20})$/.exec(input.value.slice(0, input.selectionStart || 0));
      if (!m || m[1] !== q) return;      // 用户已继续输入
      drawPicker(list, q);
    }, 180);
  };
  pickerDocHandler = (e) => {
    if (pickerOpen && !picker.contains(e.target) && e.target !== input) hidePicker();
  };
  document.addEventListener('click', pickerDocHandler);

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
  api.chatMembers().then(d => mergeMembers((d && d.members) || [])).catch(() => {});

  // ---- 消息渲染 ----
  let oldest = 0, count = 0;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const scrollBottom = () => { list.scrollTop = list.scrollHeight; };

  function appendMsg(m) {
    if (msgsEl.querySelector(`[data-id="${m.id}"]`)) return;      // SSE 与发送响应去重
    msgsEl.insertAdjacentHTML('beforeend', msgHTML(m));
    const node = msgsEl.lastElementChild;
    if (node && m.atts && m.atts.length) bindAttach(node, m.atts);
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
      list2.forEach(m => {
        const node = msgsEl.querySelector(`.cm-chatp-msg[data-id="${m.id}"]`);
        if (node && m.atts && m.atts.length) bindAttach(node, m.atts);
      });
      oldest = list2[0].id;
      if (list2.length < PAGE) moreEl.style.display = 'none';
      bindMsgs();
      list.scrollTop = list.scrollHeight - keep;      // 保持视口不跳
    } catch (e) { toast(e.message || '加载失败'); }
  };

  // ---- 发送（文本 / 图片 / @） ----
  let pendingImage = '';
  let pendingAtts = [];
  const setPreview = () => {
    const has = !!pendingImage || pendingAtts.length > 0;
    preview.style.display = has ? '' : 'none';
    if (!has) { preview.innerHTML = ''; return; }
    preview.innerHTML = `
      ${pendingImage ? `<span class="cm-chatp-pend-img"><img src="${esc(settings.base)}/chat/image/${esc(pendingImage)}"><span class="cm-chatp-rm material-icons-outlined" data-rmimg>close</span></span>` : ''}
      ${pendingAtts.map((a, i) => `<span class="cm-peditor-att">${esc(TYPE_LABEL[a.type] || '')}·${esc(a.name)}<span class="material-icons-outlined" data-rmatt="${i}">close</span></span>`).join('')}`;
    const rmImg = preview.querySelector('[data-rmimg]');
    if (rmImg) rmImg.onclick = () => { pendingImage = ''; setPreview(); };
    preview.querySelectorAll('[data-rmatt]').forEach(x => {
      x.onclick = () => { pendingAtts.splice(+x.dataset.rmatt, 1); setPreview(); };
    });
    updateSuggest();
  };

  async function doSend() {
    const content = input.value.trim();
    if (!content && !pendingImage && !pendingAtts.length) return;
    if (!auth.token) return toast('登录后即可聊天');
    sendBtn.setAttribute('loading', '');
    try {
      const m = await api.chatSend({ content, image: pendingImage, mentions: mentionsFromContent(content), atts: pendingAtts });
      appendMsg(m); bindMsgs(); scrollBottom();
      input.value = ''; input.style.height = 'auto';
      pendingImage = ''; pendingAtts = []; pickedMentions.clear(); setPreview();
    } catch (e) {
      toast(e.message || '发送失败');
    } finally { sendBtn.removeAttribute('loading'); }
  }
  sendBtn.onclick = doSend;
  input.addEventListener('keydown', e => {
    const pickerVisible = pickerOpen;
    if (pickerVisible && e.key === 'Escape') { e.preventDefault(); hidePicker(); return; }
    if (pickerVisible && pickerItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); pickerIndex = (pickerIndex + 1) % pickerItems.length; markActive(); return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault(); pickerIndex = (pickerIndex - 1 + pickerItems.length) % pickerItems.length; markActive(); return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault(); pickUser(pickerItems[pickerIndex] || pickerItems[0]); return;
      }
    }
    // 中文输入法组字中的回车是「选词」，不能当成发送
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault(); doSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
    const before = input.value.slice(0, input.selectionStart || 0);
    const m = /@([^\s@]{0,20})$/.exec(before);
    if (!auth.token || !m) { if (!m) hidePicker(); updateSuggest(); return; }
    const q = m[1];
    // 先给本地候选（不等网络）；随后服务端在 180ms 防抖后补全搜索结果
    const kw = q.toLowerCase();
    const local = membersCache.filter(u => (u.nickname || '').toLowerCase().includes(kw)).slice(0, 8);
    if (local.length) drawPicker(local, q);
    else if (q) {
      // 本地没有命中：先显示搜索中，避免"没有匹配"闪一下
      picker.innerHTML = '<div class="cm-chatp-pk-empty">搜索中…</div>';
      pickerOpen = true;
      pickerItems = [];
      pickerIndex = -1;
      picker.style.display = 'block';
    }
    searchMentions(q);
    updateSuggest();
  });

  box.querySelector('#chatAttBtn').onclick = () => {
    if (!auth.token) return toast('登录后可引用内容');
    if (pendingAtts.length >= MAX_ATTACH) return toast(`最多引用 ${MAX_ATTACH} 项`);
    openAttachPicker(picked => {
      const room = MAX_ATTACH - pendingAtts.length;
      picked.slice(0, room).forEach(x => {
        if (!pendingAtts.some(p => p.type === x.type && p.id === x.id)) pendingAtts.push(x);
      });
      setPreview();
    });
  };

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
