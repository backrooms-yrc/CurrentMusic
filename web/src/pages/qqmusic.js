import { auth, settings } from '../api.js';
import { mdui } from '../md.js';
import { esc, toast, confirmDialog, fmtDur, skelList } from '../ui.js';
import { player } from '../player.js';
import { hasQqSession, qqRequest, qqSongs, saveQqSession } from '../qqmusic.js';
import { openQqComments } from '../qq-comments.js';

const TYPES = { song: '单曲', artist: '歌手', album: '专辑', playlist: '歌单' };
const KEYS = { song: 'songs', artist: 'artists', album: 'albums', playlist: 'playlists' };
const CHANNELS = { qqmusic: 'QQ 音乐', qq: 'QQ', wechat: '微信' };
const LIMIT = 20;
const authOptions = { requireLogin: true };

export function render(el, [kind, id] = []) {
  if (window.NativeApi) {
    el.innerHTML = '<p class="cm-empty">请在系统浏览器打开流声屿，进入 QQ 音乐。</p>';
    return;
  }
  const scope = auth.scope, base = settings.base;
  const savedKind = Object.prototype.hasOwnProperty.call(TYPES, kind);
  let request = 0, page = 0, list = [];
  let suggestTimer = 0, suggestions = null;
  const state = { type: 'song', query: '', library: '' };
  el.innerHTML = `<section class="cm-qq-page">
    <div class="cm-sec-head"><h2>QQ 音乐</h2><a class="cm-sec-more" href="#/home">切换到网易云音乐</a></div>
    <div id="qqAccount" class="cm-detail-actions"></div>
    <form id="qqSearch" class="cm-qq-search">
      <label>搜索 QQ 音乐 <input id="qqKeyword" type="search" maxlength="60" placeholder="搜索单曲、歌手、专辑或歌单" required></label>
      <select id="qqType" aria-label="搜索分类">${Object.entries(TYPES).map(([key, title]) => `<option value="${key}">${title}</option>`).join('')}</select>
      <button type="submit">搜索</button>
    </form>
    <div id="qqKeywords" class="cm-chips" aria-label="搜索建议"></div>
    <div id="qqResults"></div>
  </section>`;
  const host = el.querySelector('.cm-qq-page');
  const $ = selector => host.querySelector(selector);
  const results = $('#qqResults');
  const active = () => host.isConnected && auth.scope === scope && settings.base === base;

  function showKeywords(words) {
    const box = $('#qqKeywords');
    box.textContent = '';
    if (!Array.isArray(words)) return;
    for (const word of words.filter(value => typeof value === 'string' && value.trim()).slice(0, 8)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cm-hot';
      button.textContent = word;
      button.onclick = () => {
        $('#qqKeyword').value = word;
        submitSearch();
      };
      box.appendChild(button);
    }
  }

  function renderAccount(profile) {
    const account = $('#qqAccount');
    account.innerHTML = hasQqSession()
      ? `<span id="qqProfile">${esc(profile?.nickname || profile?.name || 'QQ 音乐已连接')}</span>
         <mdui-button type="button" variant="tonal" id="qqFavorites">我喜欢</mdui-button>
         <mdui-button type="button" variant="tonal" id="qqPlaylists">我的歌单</mdui-button>
         <mdui-button type="button" variant="text" id="qqRefresh">续期</mdui-button>
         <mdui-button type="button" variant="text" id="qqLogout">退出 QQ 音乐</mdui-button>`
      : auth.token
        ? '<mdui-button type="button" variant="tonal" id="qqConnect">扫码登录 QQ 音乐</mdui-button>'
        : '<mdui-button href="#/user" variant="tonal">登录 CurrentMusic 后连接 QQ 音乐</mdui-button>';
    if ($('#qqConnect')) $('#qqConnect').onclick = () => openQqLogin(active, syncAccount);
    if (!$('#qqLogout')) return;
    $('#qqFavorites').onclick = () => loadLibrary('favorites');
    $('#qqPlaylists').onclick = () => loadLibrary('playlists');
    $('#qqRefresh').onclick = async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try { await qqRequest('/login/refresh', { ...authOptions, body: {} }); await syncAccount(); }
      catch (error) { if (active()) toast(error.message); }
      finally { button.disabled = false; }
    };
    $('#qqLogout').onclick = () => confirmDialog({
      title: '退出 QQ 音乐？',
      onOk: async () => {
        if (!active()) return;
        await qqRequest('/logout', { ...authOptions, body: { confirm: 1 } });
        if (!active()) return;
        request++;
        renderAccount();
        if (state.library) results.textContent = '';
      },
    });
  }

  async function syncAccount() {
    if (!active()) return;
    if (!hasQqSession()) { renderAccount(); return; }
    try {
      const response = await qqRequest('/login/status', authOptions);
      if (active()) renderAccount(response.data?.profile);
    } catch (error) {
      if (active()) {
        renderAccount();
        if (error.status !== 401) toast(error.message);
      }
    }
  }

  function renderItems(heading, type, items, more, nextPage, route, favorites = false) {
    const songs = type === 'song';
    const normalized = songs ? qqSongs(items) : items.filter(item => /^[a-zA-Z0-9]{1,64}$/.test(item.id || item.mid || item.dissid || ''));
    results.innerHTML = `<div class="cm-sec-head"><h2>${esc(heading)}</h2>
        ${songs && normalized.length ? '<mdui-button type="button" variant="text" id="qqPlayAll">播放全部</mdui-button>' : ''}</div>
      ${normalized.length ? '<div class="cm-songs">' + normalized.map((item, i) => {
        const key = item.id || item.mid || item.dissid;
        const title = item.name || item.title || item.dissname || '未命名';
        const subtitle = item.artists || item.creator || item.artist || '';
        const picture = item.pic || item.cover || '';
        return `<div class="cm-song cm-qq-row" data-index="${i}">
          ${picture ? `<img class="cm-song-pic" src="${esc(picture)}" alt="" loading="lazy">` : ''}
          ${songs
            ? `<button type="button" class="cm-song-main cm-qq-track" data-qq-play><span class="cm-song-name">${esc(title)}</span><span class="cm-song-sub">${esc(subtitle)}</span></button>`
            : `<a class="cm-song-main" href="#/qqmusic/${type}/${key}"><span class="cm-song-name">${esc(title)}</span><span class="cm-song-sub">${esc(subtitle)}</span></a>`}
          ${songs ? `<span class="cm-song-dur">${fmtDur(item.duration)}</span>
            ${item.qq_id ? '<button type="button" class="cm-song-mv" data-qq-comments aria-label="评论"><span class="material-icons-outlined" aria-hidden="true">forum</span></button>' : ''}
            <button class="cm-song-mv" type="button" data-qq-enqueue aria-label="加入播放队列"><span class="material-icons-outlined" aria-hidden="true">queue</span></button>
            ${hasQqSession() && item.qq_id ? `<button type="button" class="cm-song-mv" data-qq-like aria-label="${favorites ? '取消喜欢' : '加入我喜欢'}"><span class="material-icons-outlined" aria-hidden="true">${favorites ? 'heart_broken' : 'favorite_border'}</span></button>` : ''}` : ''}
        </div>`;
      }).join('') + '</div>' : '<div class="cm-empty">暂无结果</div>'}
      ${more ? '<mdui-button variant="text" type="button" id="qqMore">加载更多</mdui-button>' : ''}`;
    const canPlay = () => {
      if (hasQqSession()) return true;
      toast('连接 QQ 音乐后可以播放');
      $('#qqConnect')?.focus();
      return false;
    };
    if ($('#qqPlayAll')) $('#qqPlayAll').onclick = () => {
      if (canPlay()) player.playList(normalized, 0, { playlist: route || '' });
    };
    if ($('#qqMore')) $('#qqMore').onclick = nextPage;
    results.querySelectorAll('[data-index]').forEach(row => {
      const track = normalized[Number(row.dataset.index)];
      const play = row.querySelector('[data-qq-play]');
      if (!play) return;
      play.onclick = () => {
        if (!canPlay()) return;
        if (route) player.playList(normalized, Number(row.dataset.index), { shuffleStart: false, playlist: route });
        else player.playSong(track);
      };
      row.querySelector('[data-qq-enqueue]').onclick = () => { if (canPlay()) player.enqueue(track, route); };
      const comments = row.querySelector('[data-qq-comments]');
      if (comments) comments.onclick = () => openQqComments(track);
      const like = row.querySelector('[data-qq-like]');
      if (like) like.onclick = () => confirmDialog({
        title: favorites ? '从 QQ 音乐移除这首喜欢？' : '加入 QQ 音乐的我喜欢？',
        body: esc(track.name),
        onOk: async () => {
          if (!active()) return;
          await qqRequest('/native/user/song/like', { ...authOptions, body: {
            confirm: 1, song: { id: Number(track.qq_id), mid: track.qq_mid, type: 0 }, liked: !favorites,
          } });
          if (!active()) return;
          toast(favorites ? '已取消喜欢' : '已加入 QQ 音乐的我喜欢');
          if (favorites) loadLibrary('favorites');
        },
      });
    });
    const locate = new URLSearchParams(location.hash.split('?')[1] || '').get('track');
    if (songs && locate) {
      const index = normalized.findIndex(s => s.ncm_id === locate);
      const row = index >= 0 && results.querySelector(`[data-index="${index}"]`);
      if (row) { row.classList.add('cm-song-located'); row.querySelector('[data-qq-play]').focus(); }
    }
  }

  async function search(append = false) {
    const key = ++request;
    const currentPage = append ? page + 1 : 0;
    const { type, query } = state;
    if (!append) results.innerHTML = skelList(4);
    const more = $('#qqMore');
    if (more) more.disabled = true;
    try {
      const response = await qqRequest('/search', { query: { keywords: query, type, limit: LIMIT, offset: currentPage * LIMIT } });
      if (!active() || key !== request) return;
      page = currentPage;
      const items = Array.isArray(response[KEYS[type]]) ? response[KEYS[type]] : [];
      list = append ? list.concat(items) : items;
      renderItems(TYPES[type] + '搜索结果', type, list, response.hasMore?.[type] === true, () => search(true));
    } catch (error) {
      if (!active() || key !== request) return;
      if (append && more) { more.disabled = false; toast(error.message); }
      else renderFailure(error, search);
      if (!hasQqSession()) renderAccount();
    }
  }

  function renderFailure(error, retry) {
    results.innerHTML = `<div class="cm-empty">${esc(error.message)} <button type="button" id="qqRetry">重试</button></div>`;
    $('#qqRetry').onclick = () => retry();
  }

  async function loadLibrary(name, append = false) {
    const key = ++request;
    const currentPage = append ? page + 1 : 0;
    state.library = name;
    if (!append) results.innerHTML = skelList(4);
    const more = $('#qqMore');
    if (more) more.disabled = true;
    try {
      const liked = name === 'favorites';
      const response = await qqRequest(liked ? '/native/user/liked-songs' : '/native/user/playlist', {
        ...authOptions, query: { limit: LIMIT, offset: currentPage * LIMIT },
      });
      if (!active() || key !== request) return;
      const data = response.data || {};
      const items = liked ? data.songs || [] : data.playlists || data.playlist || data.list || [];
      page = currentPage;
      list = append ? list.concat(items) : items;
      renderItems(liked ? 'QQ 音乐 · 我喜欢' : 'QQ 音乐 · 我的歌单', liked ? 'song' : 'playlist',
        list, !!data.more, () => loadLibrary(name, true), '', liked);
    } catch (error) {
      if (!active() || key !== request) return;
      if (append && more) { more.disabled = false; toast(error.message); }
      else renderFailure(error, () => loadLibrary(name));
      if (!hasQqSession()) renderAccount();
    }
  }

  async function loadDetails() {
    const key = ++request;
    results.innerHTML = skelList(4);
    try {
      const data = await qqRequest('/' + kind, { query: { id, ...(kind === 'artist' ? { offset: 0, limit: 50 } : {}) } });
      if (!active() || key !== request) return;
      renderItems(data.name || TYPES[kind], 'song', data.songs || [], false, null, '#/qqmusic/' + kind + '/' + id);
      if (kind === 'artist') {
        const albums = Array.isArray(data.albums) ? data.albums.filter(album => /^[a-zA-Z0-9]{1,64}$/.test(album.id)) : [];
        if (albums.length) results.insertAdjacentHTML('beforeend', `<div class="cm-sec-head"><h2>专辑</h2></div>
          <div class="cm-chips">${albums.map(album => `<a class="cm-hot" href="#/qqmusic/album/${album.id}">${esc(album.name)}</a>`).join('')}</div>`);
      }
    } catch (error) { if (active() && key === request) renderFailure(error, loadDetails); }
  }

  function submitSearch() {
    clearTimeout(suggestTimer);
    suggestions?.abort();
    showKeywords([]);
    state.query = $('#qqKeyword').value.trim();
    state.type = $('#qqType').value;
    state.library = '';
    if (state.query && TYPES[state.type]) search();
  }
  $('#qqSearch').onsubmit = event => { event.preventDefault(); submitSearch(); };
  $('#qqKeyword').oninput = event => {
    const keyword = event.target.value.trim();
    clearTimeout(suggestTimer);
    suggestions?.abort();
    showKeywords([]);
    if (!keyword || !active()) return;
    suggestTimer = setTimeout(async () => {
      const controller = suggestions = new AbortController();
      try {
        const result = await qqRequest('/native/search/suggest', { query: { keyword }, withSession: false, signal: controller.signal });
        if (!controller.signal.aborted && active() && $('#qqKeyword').value.trim() === keyword) showKeywords(result.suggestions);
      } catch { /* Search remains available when suggestions are unavailable. */ }
    }, 200);
  };
  renderAccount();
  syncAccount();
  if (savedKind && kind !== 'song' && id) loadDetails();
  else qqRequest('/native/search/hot', { withSession: false }).then(data => {
    if (active() && !$('#qqKeyword').value) showKeywords(data.hotkeys?.map(item => item.keyword));
  }).catch(() => {});
}

function openQqLogin(active, success) {
  let qr, checkTimer = 0;
  let version = 0;
  const dialog = mdui.dialog({
    headline: '扫码登录 QQ 音乐',
    body: `<div class="cm-form"><label>扫码应用 <select id="qqLoginChannel" disabled></select></label>
      <mdui-button id="qqMakeCode" variant="tonal" disabled>生成二维码</mdui-button>
      <img id="qqLoginImage" width="220" height="220" alt="QQ 音乐登录二维码" hidden>
      <p id="qqLoginStatus" role="status">正在查询可用的扫码方式…</p></div>`,
    actions: [{ text: '取消' }],
  });
  const image = dialog.querySelector('#qqLoginImage');
  const status = dialog.querySelector('#qqLoginStatus');
  const channels = dialog.querySelector('#qqLoginChannel');
  const start = dialog.querySelector('#qqMakeCode');
  const working = generation => active() && dialog.open && generation === version;
  const post = (path, body) => qqRequest('/login/qr/' + path, { ...authOptions, withSession: false, body });
  const cancel = key => key && active() ? post('cancel', { key }).catch(() => {}) : Promise.resolve();

  async function verify(generation, key) {
    if (!working(generation)) return;
    try {
      const response = await post('check', { key });
      if (!working(generation)) return;
      if (response.code === 803) {
        saveQqSession(response.data?.session);
        qr = '';
        dialog.open = false;
        success();
      } else if (response.code === 800) {
        qr = '';
        image.hidden = true;
        status.textContent = '二维码已失效，请重新生成。';
        start.disabled = false;
      } else {
        status.textContent = response.code === 802 ? '已扫码，请在手机上确认。' : '等待扫码…';
        checkTimer = setTimeout(() => verify(generation, key), 1800);
      }
    } catch (error) {
      if (!working(generation)) return;
      status.textContent = error.message;
      start.disabled = false;
    }
  }

  start.onclick = async () => {
    if (!active() || start.disabled) return;
    const generation = ++version;
    clearTimeout(checkTimer);
    start.disabled = true;
    image.hidden = true;
    status.textContent = '正在获取二维码…';
    await cancel(qr);
    qr = '';
    try {
      if (!working(generation)) return;
      const response = await post('key', { channel: channels.value });
      const key = response.data?.unikey;
      if (typeof key !== 'string' || !/^[a-f0-9]{48}$/.test(key)) throw new Error('未取得有效的扫码标识');
      if (!working(generation)) { cancel(key); return; }
      qr = key;
      const code = await post('create', { key });
      if (!working(generation)) return;
      const url = code.data?.qrimg;
      if (typeof url !== 'string' || url.length > 262144 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) {
        throw new Error('未取得有效的二维码图片');
      }
      image.src = url;
      image.hidden = false;
      status.textContent = '请使用所选应用扫码。';
      checkTimer = setTimeout(() => verify(generation, key), 1500);
    } catch (error) {
      if (!working(generation)) return;
      cancel(qr);
      qr = '';
      status.textContent = error.message;
      start.disabled = false;
    }
  };

  dialog.addEventListener('close', () => {
    version++;
    clearTimeout(checkTimer);
    cancel(qr);
  }, { once: true });
  qqRequest('/login/channels', { withSession: false }).then(response => {
    if (!working(0)) return;
    const allowed = (response.data?.channels || []).filter(key => Object.prototype.hasOwnProperty.call(CHANNELS, key));
    if (!allowed.length) { status.textContent = '服务器没有开放 QQ 音乐扫码通道。'; return; }
    channels.innerHTML = allowed.map(key => `<option value="${key}">${CHANNELS[key]}</option>`).join('');
    channels.disabled = start.disabled = false;
    status.textContent = '';
  }).catch(error => { if (working(0)) status.textContent = error.message; });
}
