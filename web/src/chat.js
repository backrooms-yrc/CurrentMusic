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
import { renderMarkdown } from './markdown.js';

const PAGE = 30;
const AI_USERNAME = 'CurrentMusicAI';
const SUGGEST = {
  song: ['这首歌的创作背景是什么？', '这首歌出自哪部影视作品？', '这名歌手的生平事迹有哪些？'],
  image: ['这张图里有什么？', '提取图片里的文字', '根据这张图推荐几首歌'],
  album: ['这张专辑的创作背景是什么？', '这张专辑里有哪些代表作？', '这位歌手的生平事迹有哪些？'],
  artist: ['这位歌手的生平事迹有哪些？', '这位歌手的代表作有哪些？', '这位歌手的音乐风格是怎样的？'],
  playlist: ['这个歌单的主题是什么？', '这个歌单里有哪些值得一听的歌？', '这个歌单适合什么场景听？'],
  generic: ['最近有什么好听的歌？', '推荐几首适合通勤的歌', '介绍一下 CurrentMusic 这个站'],
};
let es = null;              // 当前 SSE 连接（重进 TAB / 切走时关闭）
let pollTimer = 0;          // SSE 不可用时的轮询兜底
let fitChat = null;         // 聊天区高度自适应解绑函数
let ptrHost = null;         // Chat 期间给 #out 打的下拉刷新禁用标记
let pickerFit = null;        // 键盘/旋转时重新约束 @ 选择器
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
  if (ptrHost) { ptrHost.removeAttribute('data-ptr-ignore'); ptrHost = null; }
  if (pickerFit) { pickerFit(); pickerFit = null; }
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
  const isBot = !!(m.user && (m.user.isBot || m.user.is_bot));
  const body = m.content
    ? (isBot
        ? `<div class="cm-chatp-md${m.streaming ? ' streaming' : ''}">${renderMarkdown(m.content)}</div>`
        : `<div class="cm-chatp-text">${contentHTML(m, membersCache)}</div>`)
    : (m.streaming ? '<div class="cm-chatp-typing">正在思考…</div>' : '');
  const img = m.image
    ? `<img class="cm-chatp-img" src="${esc(settings.base)}/chat/image/${esc(m.image)}" loading="lazy" onclick="window.open(this.src,'_blank')">`
    : '';
  return `
  <div class="cm-chatp-msg${mine ? ' mine' : ''}${m.streaming ? ' streaming' : ''}" data-id="${m.id}"
       data-uid="${m.user ? m.user.id : 0}" data-bot="${isBot ? '1' : '0'}">
    <span class="cm-chatp-ava" data-uid="${m.user ? m.user.id : 0}" data-nick="${m.user ? esc(m.user.nickname) : ''}"
          title="长按 @ TA">${m.user ? avatarHTML(m.user, 40) : '<div class="cm-avatar ph" style="width:40px;height:40px">?</div>'}</span>
    <div class="cm-chatp-main">
      <div class="cm-chatp-head">
        <span class="cm-chatp-nick" data-uid="${m.user ? m.user.id : 0}">${m.user ? esc(m.user.nickname) : '已注销用户'}</span>
        ${m.user ? userTags(m.user) : ''}
        ${m.user && m.user.username && m.user.username !== m.user.nickname
          ? `<span class="cm-chatp-un">@${esc(m.user.username)}</span>` : ''}
        <span class="cm-chatp-time">${fmtTime(m.createdAt)}</span>
        ${mine ? `<span class="cm-chatp-del material-icons-outlined" data-del="${m.id}" title="删除">delete</span>` : ''}
      </div>
      ${(body || img) ? `<div class="cm-chatp-bubble">${body}${img}</div>` : ''}
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
  // Chat 有自己的消息滚动区，整页下拉刷新只会打断阅读/输入；本 TAB 内禁用全局 PTR
  ptrHost = document.getElementById('out');
  if (ptrHost) ptrHost.setAttribute('data-ptr-ignore', '');
  // 离开发现页（如点进用户主页）时关闭后台连接；TAB 内切换由 closeChat 负责
  navWatcher = () => { if (!/^#\/square/.test(location.hash || '')) closeChat(); };
  window.addEventListener('hashchange', navWatcher);
  box.innerHTML = `
    <div class="cm-chatp" data-ptr-ignore>
      <div class="cm-chatp-list" id="chatList">
        <div class="cm-chatp-more" id="chatMore" style="display:none"><mdui-button variant="text">加载更早的消息</mdui-button></div>
        <div id="chatMsgs"></div>
        <div class="cm-chatp-empty" id="chatEmpty">还没有人说话，来打个招呼吧</div>
      </div>
      <div class="cm-chatp-picker" id="chatPicker"></div>
      <div class="cm-chatp-suggest" id="chatSuggest" hidden></div>
      <div class="cm-chatp-composer">
        <button class="cm-chatp-tool material-icons-outlined" id="chatAddBtn" title="添加内容" aria-label="添加内容" aria-expanded="false">add</button>
        <div class="cm-chatp-addmenu" id="chatAddMenu" hidden>
          <button type="button" data-add="image"><span class="material-icons-outlined">image</span>图片</button>
          <button type="button" data-add="att"><span class="material-icons-outlined">library_add</span>引用内容</button>
        </div>
        <input type="file" id="chatImgFile" accept="image/*" style="display:none">
        <div class="cm-chatp-inputwrap">
          <textarea id="chatInput" rows="1" enterkeyhint="send"
            placeholder="${auth.token ? '发消息…（@ 提及）' : '登录后即可聊天'}" ${auth.token ? '' : 'disabled'}></textarea>
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
      // 可用底边取「可视视口 / 底栏 / 迷你播放条」三者最靠上的那条线。
      // 玻璃皮肤下 #out 是铺满全屏的（内容从胶囊底栏下穿过），只看 out.clientHeight
      // 会把输入框放到导航栏后面；键盘弹出时 visualViewport 才是真实可见底边。
      const vv = window.visualViewport;
      let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      // #out 才是内容真正可见的盒子：≥900px 时它停在迷你条预留区之上；
      // 只在手机上铺满全屏。聊天框不能超出它，否则输入框会被 #out 的 overflow 裁掉。
      const out = document.getElementById('out');
      if (out) bottom = Math.min(bottom, out.getBoundingClientRect().bottom);
      const nav = document.getElementById('bottomNav');
      if (nav) {
        const nr = nav.getBoundingClientRect();
        // ≥900px 时底部导航变成左侧 navigation rail：它的 top=56px，不是「底边」。
        // 只有横向、且高度不到半屏的底栏才用 top 作为下边界，否则会把聊天框压成
        // 240px 后悬在屏幕中间。
        const bottomBar = nr.height > 0 && nr.width > nr.height && nr.height < window.innerHeight * 0.5;
        if (bottomBar) bottom = Math.min(bottom, nr.top);
      }
      const mini = document.getElementById('mini');
      if (mini) {
        const mr = mini.getBoundingClientRect();
        if (mr.height > 0) bottom = Math.min(bottom, mr.top);
      }
      const top = chatEl.getBoundingClientRect().top;
      chatEl.style.height = Math.max(160, Math.floor(bottom - top - 8)) + 'px';
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
  const composer = box.querySelector('.cm-chatp-composer');
  const addBtn = box.querySelector('#chatAddBtn');
  const addMenu = box.querySelector('#chatAddMenu');
  const imgFile = box.querySelector('#chatImgFile');
  const picker = box.querySelector('#chatPicker');
  const suggest = box.querySelector('#chatSuggest');
  const preview = box.querySelector('#chatPreview');

  // ---- @ 提及选择器：本地即时过滤 + 服务端实时搜索（QQ 式） ----
  let mentionTimer = 0, mentionSeq = 0, pickerIndex = -1, pickerItems = [], pickerOpen = false;
  const mentionCache = new Map();   // q -> users

  const closeAddMenu = () => {
    addMenu.hidden = true;
    addBtn.setAttribute('aria-expanded', 'false');
  };
  const hidePicker = () => {
    pickerOpen = false;
    picker.style.display = 'none';
    pickerItems = [];
    pickerIndex = -1;
  };
  const toggleAddMenu = () => {
    if (!addMenu.hidden) { closeAddMenu(); return; }
    if (!auth.token) return toast('登录后可发送图片或引用内容');
    hidePicker();
    addMenu.hidden = false;
    addBtn.setAttribute('aria-expanded', 'true');
  };
  function growInput() {
    input.style.height = 'auto';
    const h = Math.min(120, input.scrollHeight);
    input.style.height = h + 'px';
    input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
    if (pickerOpen) requestAnimationFrame(placePicker);
  }
  function placePicker() {
    if (!pickerOpen) return;
    const cr = chatEl.getBoundingClientRect();
    let anchor = composer.getBoundingClientRect().top;
    if (!suggest.hidden) anchor = Math.min(anchor, suggest.getBoundingClientRect().top);
    picker.style.bottom = Math.max(56, Math.round(cr.bottom - anchor + 8)) + 'px';
    picker.style.maxHeight = Math.max(120, Math.min(260, Math.round(anchor - cr.top - 12))) + 'px';
  }
  const repositionPicker = () => { if (pickerOpen) requestAnimationFrame(placePicker); };
  window.addEventListener('resize', repositionPicker);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', repositionPicker);
  pickerFit = () => {
    window.removeEventListener('resize', repositionPicker);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', repositionPicker);
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
    growInput();
    updateSuggest();
  };

  const aiMentioned = () => {
    for (const u of pickedMentions.values()) {
      if (u.isBot || u.username === AI_USERNAME) return true;
    }
    return new RegExp('@\\s*' + AI_USERNAME + '\\b').test(input.value);
  };

  /** 长按头像：把 @昵称 插入当前光标位置。 */
  function mentionUser(uid, nick) {
    if (!uid || !nick) return;
    pickedMentions.set(uid, { id: uid, nickname: nick, isBot: nick === AI_USERNAME });
    mergeMembers([pickedMentions.get(uid)]);
    const pos = input.selectionStart || input.value.length;
    const insert = '@' + nick + ' ';
    input.value = input.value.slice(0, pos) + insert + input.value.slice(pos);
    const at = pos + insert.length;
    input.focus();
    try { input.setSelectionRange(at, at); } catch { /* 忽略 */ }
    hidePicker();
    growInput();
    updateSuggest();
    toast('已 @' + nick);
  }

  /** 引用卡片并 @AI 时，在输入框上方给出「猜你想问」。 */
  function updateSuggest() {
    if (!aiMentioned()) { suggest.hidden = true; suggest.innerHTML = ''; return; }
    const card = pendingAtts[0];
    const qs = pendingImage ? SUGGEST.image
      : card ? (SUGGEST[card.type] || SUGGEST.song) : SUGGEST.generic;
    suggest.innerHTML = '<span class="cm-chatp-suggest-t">猜你想问</span>' +
      qs.map(q => `<button type="button" class="cm-chatp-sug">${esc(q)}</button>`).join('');
    suggest.hidden = false;
    if (pickerOpen) requestAnimationFrame(placePicker);
    suggest.querySelectorAll('.cm-chatp-sug').forEach(b => {
      b.onclick = () => {
        const q = b.textContent;
        const base = input.value.trim();
        if (!base.includes(q)) input.value = base ? base + ' ' + q : q;
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 忽略 */ }
        growInput();
      };
    });
  }
  const drawPicker = (list, q) => {
    closeAddMenu();
    pickerItems = (list || []).slice(0, 8);
    pickerIndex = pickerItems.length ? 0 : -1;
    if (!pickerItems.length) {
      picker.innerHTML = '<div class="cm-chatp-pk-empty">没有匹配的用户</div>';
      pickerOpen = true;
      picker.style.display = 'block';
      requestAnimationFrame(placePicker);
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
    requestAnimationFrame(placePicker);
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
    if (!addMenu.hidden && !addMenu.contains(e.target) && !addBtn.contains(e.target)) closeAddMenu();
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
    msgsEl.querySelectorAll('.cm-chatp-nick').forEach(el => {
      if (el.dataset.uid && el.dataset.uid !== '0' && !el.dataset.b) {
        el.dataset.b = '1';
        el.onclick = () => { location.hash = `#/u/${el.dataset.uid}`; };
      }
    });
    // 头像：点击进主页；长按（触摸/鼠标 500ms）或右键 → 在输入框 @ TA
    msgsEl.querySelectorAll('.cm-chatp-ava').forEach(el => {
      if (!el.dataset.uid || el.dataset.uid === '0' || el.dataset.b) return;
      el.dataset.b = '1';
      let lp = 0, fired = false, firedAt = 0;
      const doMention = () => {
        if (Date.now() - firedAt < 800) return;     // 长按后 WebView 还会补一次 contextmenu，去重
        fired = true; firedAt = Date.now();
        mentionUser(+el.dataset.uid, el.dataset.nick || '');
      };
      // 注意：start 不能重置 fired —— 触摸长按后浏览器会补发 mousedown/click，
      // 若此时把 fired 清掉，补发的 click 会跳去主页，而不是停在聊天页。
      const start = () => { clearTimeout(lp); lp = setTimeout(doMention, 500); };
      const cancel = () => clearTimeout(lp);
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchend', cancel);
      el.addEventListener('touchmove', cancel);
      el.addEventListener('mousedown', e => { if (e.button === 0) start(); });
      el.addEventListener('mouseup', cancel);
      el.addEventListener('mouseleave', cancel);
      el.addEventListener('contextmenu', e => { e.preventDefault(); doMention(); });
      el.addEventListener('click', e => {
        if (fired && Date.now() - firedAt < 900) {
          e.preventDefault(); e.stopPropagation();
          fired = false;
          return;
        }
        fired = false;
        location.hash = `#/u/${el.dataset.uid}`;
      });
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
  function updateMessage(p) {
    const el = msgsEl.querySelector(`.cm-chatp-msg[data-id="${p.id}"]`);
    if (!el) return;
    const stick = nearBottom();
    const isBot = el.dataset.bot === '1';
    const main = el.querySelector('.cm-chatp-main');
    let bubble = el.querySelector('.cm-chatp-bubble');
    let body = el.querySelector('.cm-chatp-md, .cm-chatp-text, .cm-chatp-typing');
    if (p.content) {
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.className = 'cm-chatp-bubble';
        main.insertBefore(bubble, main.querySelector('.cm-chatp-atts'));
      }
      if (!body) {
        body = document.createElement('div');
        bubble.prepend(body);
      }
      if (isBot) body.innerHTML = renderMarkdown(p.content);
      else body.textContent = p.content;
      body.className = (isBot ? 'cm-chatp-md' : 'cm-chatp-text') + (p.streaming ? ' streaming' : '');
    } else if (body) {
      if (p.streaming) {
        body.className = 'cm-chatp-typing';
        body.textContent = '正在思考…';
      } else {
        body.remove();
        if (bubble && !bubble.querySelector('.cm-chatp-img')) bubble.remove();
      }
    }
    let attsEl = el.querySelector('.cm-chatp-atts');
    if (p.atts && p.atts.length) {
      if (!attsEl) {
        attsEl = document.createElement('div');
        attsEl.className = 'cm-chatp-atts';
        main.appendChild(attsEl);
      }
      attsEl.innerHTML = attachHTML(p.atts, { compact: true });
      bindAttach(el, p.atts);
    } else if (attsEl) {
      attsEl.remove();
    }
    el.classList.toggle('streaming', !!p.streaming);
    if (stick) scrollBottom();
  }

  const applyEvent = ev => {
    try {
      const raw = JSON.parse(ev.data);
      const type = ev.type;
      if (type === 'message') {
        const stick = nearBottom();
        appendMsg(raw.payload); bindMsgs();
        if (stick) scrollBottom();
      } else if (type === 'edit') {
        updateMessage(raw.payload);
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
    es.addEventListener('edit', applyEvent);
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
  let uploadingImage = false;       // 图片还在压缩/上传时，发送会丢掉图片，必须先拦住
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
    if (uploadingImage) return toast('图片还在处理中，稍等一下再发送');
    const content = input.value.trim();
    if (!content && !pendingImage && !pendingAtts.length) return;
    if (!auth.token) return toast('登录后即可聊天');
    sendBtn.setAttribute('loading', '');
    try {
      const m = await api.chatSend({ content, image: pendingImage, mentions: mentionsFromContent(content), atts: pendingAtts });
      appendMsg(m); bindMsgs(); scrollBottom();
      input.value = ''; growInput();
      pendingImage = ''; pendingAtts = []; pickedMentions.clear(); closeAddMenu(); setPreview();
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
  input.addEventListener('focus', () => {
    closeAddMenu();
    // 键盘弹出后列表可视高度变小；若原本在底部，等键盘动画结束再贴底
    if (nearBottom()) setTimeout(scrollBottom, 280);
  });
  input.addEventListener('input', () => {
    growInput();
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

  addBtn.onclick = e => { e.stopPropagation(); toggleAddMenu(); };
  addMenu.querySelector('[data-add="image"]').onclick = () => {
    closeAddMenu();
    imgFile.click();
  };
  addMenu.querySelector('[data-add="att"]').onclick = () => {
    closeAddMenu();
    if (pendingAtts.length >= MAX_ATTACH) return toast(`最多引用 ${MAX_ATTACH} 项`);
    openAttachPicker(picked => {
      const room = MAX_ATTACH - pendingAtts.length;
      picked.slice(0, room).forEach(x => {
        if (!pendingAtts.some(p => p.type === x.type && p.id === x.id)) pendingAtts.push(x);
      });
      setPreview();
    });
  };
  imgFile.onchange = async ev => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return toast('只能发图片');
    if (uploadingImage) return;
    uploadingImage = true;
    toast('图片处理中…');
    try {
      const b64 = await compressImage(f);
      const d = await api.chatUpload({ file: b64, filename: 'chat.jpg', contentType: 'image/jpeg' });
      pendingImage = d.image; setPreview();
    } catch (e) { toast(e.message || '图片上传失败'); }
    finally { uploadingImage = false; }
  };
}
