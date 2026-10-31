// 播放页「问AI」：以当前歌曲为上下文，复用 Chat 的 Markdown/卡片渲染与流式回答。
// 与公共 Chat 不同，这里走后端 /ai/live 的私有 SSE，不向聊天室发消息；
// 上下文使用独立的 player scope，弹窗关闭后重新打开会清空。
import { api, auth, settings } from './api.js';
import { esc, toast, dismissToasts, avatarHTML } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { attachHTML, bindAttach } from './attach.js';

const CHIPS = ['这首歌的创作背景', '出自哪部影视作品', '这位歌手的代表作', '推荐几首类似的歌'];
let state = null;
const TYPING = '<div class="cm-aiask-typing"><span>正在思考</span><i></i><i></i><i></i></div>';

// 问AI 的所有头像复用 CurrentMusicAI 账号头像（不再手绘画 AI 图标）
let aiBot = null;
let aiBotPromise = null;
export async function ensureAiBot() {
  if (aiBot) return aiBot;
  if (!aiBotPromise) {
    aiBotPromise = api.chatMembers('CurrentMusicAI').then(d => {
      const list = (d && d.members) || [];
      aiBot = list.find(u => (u.isBot || u.is_bot) && u.username === 'CurrentMusicAI')
        || list.find(u => u.isBot || u.is_bot) || null;
      return aiBot;
    }).catch(() => null);
  }
  return aiBotPromise;
}

function botAvaHTML(size) {
  return aiBot ? avatarHTML(aiBot, size) : 'AI';
}

function songOf(song) {
  return {
    type: 'song',
    id: Number(song.ncm_id) || 0,
    name: String(song.name || ''),
    sub: String(song.artists || ''),
    pic: String(song.pic || ''),
  };
}

function botHTML(content = '', streaming = false) {
  const body = content
    ? `<div class="cm-chatp-md${streaming ? ' streaming' : ''}">${renderMarkdown(content)}</div>`
    : TYPING;
  return `<div class="cm-aiask-msg bot enter">
    <span class="cm-aiask-ava${aiBot ? ' has-ava' : ''}">${botAvaHTML(28)}</span>
    <div class="cm-aiask-main">
      <div class="cm-aiask-bubble">${body}</div>
      <div class="cm-aiask-atts" hidden></div>
    </div>
  </div>`;
}

function paintBot(el, content, streaming) {
  const bubble = el.querySelector('.cm-aiask-bubble');
  if (!content) {
    bubble.innerHTML = TYPING;
    return;
  }
  bubble.innerHTML = `<div class="cm-chatp-md${streaming ? ' streaming' : ''}">${renderMarkdown(content)}</div>`;
}

export function openAskAI(song) {
  if (!song || !song.ncm_id) return toast('当前没有播放中的歌曲');
  if (!auth.token) return toast('登录后即可向 AI 提问');
  if (state) closeAskAI();
  dismissToasts();

  const s = songOf(song);
  const root = document.createElement('div');
  root.className = 'cm-aiask';
  root.innerHTML = `
    <div class="cm-aiask-bg"></div>
    <section class="cm-aiask-panel" role="dialog" aria-modal="true" aria-label="问 CurrentMusicAI">
      <header class="cm-aiask-head">
        <div class="cm-aiask-title">
          <span class="cm-aiask-logo${aiBot ? ' has-ava' : ''}">${aiBot ? botAvaHTML(34) : '<span class="material-icons-outlined">auto_awesome</span>'}</span>
          <div><b>问 AI</b><span>CurrentMusicAI</span></div>
        </div>
        <button type="button" class="cm-aiask-x material-icons-outlined" data-close aria-label="关闭">close</button>
      </header>
      <div class="cm-aiask-song">
        ${s.pic ? `<img src="${esc(s.pic)}?param=96y96" alt="">` : '<span class="cm-aiask-song-ph material-icons-outlined">music_note</span>'}
        <div class="cm-aiask-song-t">
          <div class="cm-aiask-song-name">${esc(s.name)}</div>
          <div class="cm-aiask-song-sub">${esc(s.sub)}</div>
        </div>
        <span class="cm-tag ai">AI</span>
      </div>
      <div class="cm-aiask-list" aria-live="polite"></div>
      <div class="cm-aiask-chips">
        ${CHIPS.map((q, i) => `<button type="button" class="cm-chatp-sug" style="--i:${i}">${esc(q)}</button>`).join('')}
      </div>
      <form class="cm-aiask-composer">
        <textarea rows="1" enterkeyhint="send" placeholder="问问这首歌…（可继续追问）"></textarea>
        <button type="submit" class="cm-aiask-send" aria-label="发送">
          <span class="material-icons-outlined">arrow_upward</span>
        </button>
      </form>
    </section>`;
  document.body.appendChild(root);
  document.body.classList.add('cm-aiask-lock');
  if (!aiBot) {
    ensureAiBot().then(bot => {
      if (!bot || !root.isConnected) return;
      const logo = root.querySelector('.cm-aiask-logo');
      if (logo) { logo.classList.add('has-ava'); logo.innerHTML = botAvaHTML(34); }
      root.querySelectorAll('.cm-aiask-ava').forEach(el => {
        el.classList.add('has-ava');
        el.innerHTML = botAvaHTML(28);
      });
    });
  }

  const list = root.querySelector('.cm-aiask-list');
  const input = root.querySelector('.cm-aiask-composer textarea');
  const sendBtn = root.querySelector('.cm-aiask-send');
  const chips = root.querySelector('.cm-aiask-chips');
  const st = { root, list, input, sendBtn, chips, abort: null, busy: false, reset: true, closed: false,
               prevFocus: document.activeElement };
  state = st;

  const scroll = () => { list.scrollTop = list.scrollHeight; };
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(104, input.scrollHeight) + 'px';
  };
  const addUser = text => {
    list.insertAdjacentHTML('beforeend',
      `<div class="cm-aiask-msg user enter"><div class="cm-aiask-bubble">${esc(text).replace(/\n/g, '<br>')}</div></div>`);
    scroll();
  };
  const addBot = (text = '', streaming = false) => {
    list.insertAdjacentHTML('beforeend', botHTML(text, streaming));
    const el = list.lastElementChild;
    scroll();
    return el;
  };
  const fail = (el, text) => {
    paintBot(el, `**暂时没能回答：** ${text}\n\n可以稍后再问一次。`, false);
    el.classList.add('err');
    scroll();
  };

  const finishBusy = () => {
    st.busy = false;
    st.abort = null;
    sendBtn.disabled = !input.value.trim();
    input.focus();
  };

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q || st.busy || st.closed) return;
    if (!auth.token) return toast('登录后即可向 AI 提问');
    st.busy = true;
    sendBtn.disabled = true;
    chips.hidden = true;
    input.value = '';
    grow();
    addUser(q);
    const bot = addBot('', true);
    const ac = new AbortController();
    st.abort = ac;
    const timer = setTimeout(() => ac.abort('timeout'), 180000);
    let lastText = '';
    let gotDone = false;
    try {
      const res = await fetch(`${settings.base}/live/ai`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + auth.token,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({ question: q, song: s, reset: st.reset }),
        signal: ac.signal,
      });
      st.reset = false;
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch { /* 忽略 */ }
        throw new Error(msg);
      }
      if (!res.body) throw new Error('当前环境不支持流式响应');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handle = block => {
        let ev = 'message';
        const data = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length) return;
        let d;
        try { d = JSON.parse(data.join('\n')); } catch { return; }
        if (ev === 'delta') {
          lastText = d.text || '';
          paintBot(bot, lastText, true);
          scroll();
        } else if (ev === 'done') {
          gotDone = true;
          lastText = d.text || lastText;
          paintBot(bot, lastText, false);
          const atts = bot.querySelector('.cm-aiask-atts');
          if (d.cards && d.cards.length) {
            atts.hidden = false;
            atts.innerHTML = attachHTML(d.cards, { compact: true });
            bindAttach(bot, d.cards);
            // 卡片跳转到详情页/歌单时，弹窗不能继续盖在新页面上
            atts.querySelectorAll('.cm-post-att').forEach(a =>
              a.addEventListener('click', () => setTimeout(closeAskAI, 0), true));
          }
          scroll();
        } else if (ev === 'error') {
          throw new Error(d.error || 'AI 暂时不可用');
        }
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          handle(block);
        }
        if (gotDone) {                       // done 后立即释放，不能等服务端关连接
          try { await reader.cancel(); } catch { /* 忽略 */ }
          break;
        }
      }
      if (!gotDone) {
        if (!lastText) throw new Error('连接提前结束');
        paintBot(bot, lastText, false);
      }
    } catch (e) {
      if (st.closed) return;
      const msg = ac.signal.aborted
        ? (ac.signal.reason === 'timeout' ? '等待超时，请稍后再试' : '已取消')
        : (e.message || '网络错误');
      if (msg !== '已取消') fail(bot, msg);
      if (!ac.signal.aborted) ac.abort();
    } finally {
      clearTimeout(timer);
      if (!st.closed) finishBusy();
    }
  }

  root.querySelector('[data-close]').onclick = closeAskAI;
  root.querySelector('.cm-aiask-bg').onclick = closeAskAI;
  root.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAskAI(); return; }
    if (e.key !== 'Tab') return;
    const panel = root.querySelector('.cm-aiask-panel');
    const focusables = [...panel.querySelectorAll(
      'button, textarea, input, [href], [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.disabled && el.getClientRects().length);
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  root.querySelectorAll('.cm-chatp-sug').forEach(b => {
    b.onclick = () => {
      input.value = b.textContent;
      grow();
      sendBtn.disabled = false;
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 忽略 */ }
    };
  });
  input.addEventListener('input', () => {
    grow();
    sendBtn.disabled = st.busy || !input.value.trim();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      ask(input.value);
    }
  });
  root.querySelector('.cm-aiask-composer').addEventListener('submit', e => {
    e.preventDefault();
    ask(input.value);
  });

  addBot(`想了解《${s.name}》的什么？可以问我创作背景、影视出处、歌手经历，也可以让我推荐相似的歌。`);
  sendBtn.disabled = true;
  setTimeout(() => input.focus(), 80);
}

export function closeAskAI() {
  if (!state || state.closing) return;
  const closing = state;
  state = null;
  closing.closed = true;
  if (closing.abort) closing.abort.abort();
  closing.root.classList.add('closing');
  closing.input.blur();
  setTimeout(() => {
    closing.root.remove();
    if (!state) document.body.classList.remove('cm-aiask-lock');
    if (!state && closing.prevFocus && closing.prevFocus.isConnected) {
      try { closing.prevFocus.focus(); } catch { /* 忽略 */ }
    }
  }, 200);
}
