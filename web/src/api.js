// API 层：优先走 Android 原生 HTTP 桥（无 CORS），浏览器调试时回退 fetch。
const LS = {
  base: 'cm.base',
  secure: 'cm.secure',
  token: 'cm.token',
  user: 'cm.user',
  accounts: 'cm.accounts',
  quality: 'cm.quality',
  theme: 'cm.theme',
};

const DEFAULT_BASE = 'https://music.20110208.xyz/cm';

export const settings = {
  get base() {
    const raw = localStorage.getItem(LS.base) || DEFAULT_BASE;
    // 安全连接模式（默认开启）：强制 HTTPS。
    // 关闭后尊重用户填写的协议（http:// 或 https:// 均可）。
    if (this.secureMode) {
      return raw.replace(/^http:\/\//i, 'https://');
    }
    return raw;
  },
  set base(v) { localStorage.setItem(LS.base, v); },
  get secureMode() { return localStorage.getItem(LS.secure) !== '0'; },   // 默认 true
  set secureMode(v) { localStorage.setItem(LS.secure, v ? '1' : '0'); },
  get quality() { return localStorage.getItem(LS.quality) || 'auto'; },
  set quality(v) { localStorage.setItem(LS.quality, v); },
  get theme() { return localStorage.getItem(LS.theme) || 'auto'; },
  set theme(v) { localStorage.setItem(LS.theme, v); },
};

// ---------- 账号本地存储（支持多账号切换） ----------

export const auth = {
  get token() { return localStorage.getItem(LS.token) || ''; },
  get user() { try { return JSON.parse(localStorage.getItem(LS.user)) || null; } catch { return null; } },

  saveLogin(token, user) {
    localStorage.setItem(LS.token, token);
    localStorage.setItem(LS.user, JSON.stringify(user));
    const accounts = this.accounts().filter(a => a.username !== user.username);
    accounts.unshift({ username: user.username, nickname: user.nickname, avatar: user.avatar, token });
    localStorage.setItem(LS.accounts, JSON.stringify(accounts.slice(0, 5)));
  },
  accounts() { try { return JSON.parse(localStorage.getItem(LS.accounts)) || []; } catch { return []; } },
  switchTo(username) {
    const a = this.accounts().find(x => x.username === username);
    if (!a) return false;
    localStorage.setItem(LS.token, a.token);
    localStorage.setItem(LS.user, JSON.stringify({ id: 0, username: a.username, nickname: a.nickname, avatar: a.avatar, bio: '' }));
    return true;
  },
  clear() {
    const cur = this.user;
    if (cur) {
      const accounts = this.accounts().filter(a => a.username !== cur.username);
      localStorage.setItem(LS.accounts, JSON.stringify(accounts));
    }
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.user);
  },
};

// ---------- 传输 ----------

let bridged = typeof window.NativeApi !== 'undefined';
const pending = new Map();
let seq = 0;

window.__cmHttpDone = function (id, status, body) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = { error: '响应解析失败' }; }
  if (status >= 200 && status < 300) p.resolve(data);
  else p.reject(Object.assign(new Error((data && data.error) || `HTTP ${status}`), { status }));
};

async function rawRequest(method, url, headers, bodyStr) {
  if (bridged) {
    return new Promise((resolve, reject) => {
      const id = 'r' + (++seq);
      pending.set(id, { resolve, reject });
      window.NativeApi.http(id, method, url, JSON.stringify(headers || {}), bodyStr || '');
    });
  }
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: bodyStr || undefined });
  let data = null;
  try { data = await r.json(); } catch { /* 空体 */ }
  if (r.ok) return data;
  throw Object.assign(new Error((data && data.error) || `HTTP ${r.status}`), { status: r.status });
}

let onAuthExpired = null;
export function setAuthExpiredHandler(fn) { onAuthExpired = fn; }

export async function call(method, path, { body, auth: needAuth = false } = {}) {
  const headers = {};
  if (needAuth && auth.token) headers.Authorization = 'Bearer ' + auth.token;
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  try {
    return await rawRequest(method, settings.base + path, headers, bodyStr);
  } catch (e) {
    if (e.status === 401 && needAuth && onAuthExpired) onAuthExpired();
    throw e;
  }
}

// ---------- 端点封装 ----------

/** 设备标识（App 取真实机型，浏览器按 UA 归纳） */
export function deviceInfo() {
  const ua = navigator.userAgent || '';
  const isApp = typeof window.NativeApi !== 'undefined';
  let label = '';
  try {
    if (isApp && window.NativeApi.deviceModel) label = window.NativeApi.deviceModel();
  } catch { /* 忽略 */ }
  if (!label) {
    const os = (/Android[ /]([\d.]+)/.exec(ua) && 'Android ' + /Android[ /]([\d.]+)/.exec(ua)[1])
      || (/Windows/.test(ua) && 'Windows') || (/Macintosh|Mac OS/.test(ua) && 'macOS')
      || (/Linux/.test(ua) && 'Linux') || '';
    const ch = /Chrome\/([\d.]+)/.exec(ua);
    label = [isApp ? 'App' : '网页', os, ch ? 'Chromium ' + ch[1].split('.')[0] : ''].filter(Boolean).join(' · ');
  }
  return { device: label, platform: isApp ? 'app' : 'web' };
}

export const api = {
  // 认证/资料
  register: (payload) => call('POST', '/auth/register', { body: { ...payload, ...deviceInfo() } }),
  sendEmailCode: (email) => call('POST', '/auth/email/code', { body: { email } }),
  sendPhoneCode: (phone) => call('POST', '/auth/phone/code', { body: { phone } }),
  smsInfo: () => call('GET', '/auth/sms'),
  login: (username, password) => call('POST', '/auth/login', { body: { username, password, ...deviceInfo() } }),
  internalLogin: (password) => call('POST', '/auth/internal', { body: { password, ...deviceInfo() } }),
  logout: () => call('POST', '/auth/logout', { body: {}, auth: true }),
  sessions: () => call('GET', '/auth/sessions', { auth: true }),
  revokeSession: (id) => call('DELETE', `/auth/sessions/${id}`, { body: {}, auth: true }),
  revokeOtherSessions: () => call('DELETE', '/auth/sessions/others', { body: {}, auth: true }),

  // 管理员
  adminOverview: () => call('GET', '/admin/overview', { auth: true }),
  adminUsers: (query = '', offset = 0, limit = 20) => call('GET', `/admin/users?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`, { auth: true }),
  adminDisable: (id, on) => call('POST', `/admin/users/${id}/disable`, { body: { on }, auth: true }),
  adminResetPassword: (id, password) => call('POST', `/admin/users/${id}/password`, { body: { password }, auth: true }),
  adminKick: (id) => call('POST', `/admin/users/${id}/kick`, { body: {}, auth: true }),
  adminSetAdmin: (id, on) => call('POST', `/admin/users/${id}/admin`, { body: { on }, auth: true }),
  adminSessions: () => call('GET', '/admin/sessions', { auth: true }),
  adminClearCache: (scope = 'aux') => call('POST', '/admin/cache/clear', { body: { scope }, auth: true }),
  me: () => call('GET', '/auth/me', { auth: true }),
  profileOf: (uid) => call('GET', `/profile/${uid}`),
  updateProfile: (fields) => call('PUT', '/profile', { body: fields, auth: true }),
  changePassword: (oldPassword, newPassword) => call('PUT', '/profile/password', { body: { oldPassword, newPassword }, auth: true }),
  uploadAvatarBase64: (b64) => call('PUT', '/profile/avatar', { body: { data: b64 }, auth: true }),
  // 头像挂件：目录（带 token 时附本人解锁状态）；素材固定 .gif/.png 由后端按 id 寻址
  decorations: () => call('GET', '/decorations', { auth: true }),
  setDecoration: (id) => call('PUT', '/decorations/mine', { body: { id }, auth: true }),

  // 点赞/收藏/状态
  toggleLike: (meta) => call('POST', `/likes/${meta.ncm_id}`, { body: meta, auth: true }),
  likedSongs: () => call('GET', '/likes/mine', { auth: true }),
  likeCount: (ids) => call('GET', `/likes/count?ids=${ids.join(',')}`),
  songsStatus: (ids) => call('GET', `/songs/status?ids=${ids.slice(0, 100).join(',')}`, { auth: true }),

  // 元数据/历史
  pushMeta: (songs) => call('POST', '/meta', { body: { songs }, auth: true }),
  recordPlay: (meta) => call('POST', `/plays/${meta.ncm_id}`, { body: meta, auth: true }),
  recentPlays: (limit = 50) => call('GET', `/plays/recent?limit=${limit}`, { auth: true }),

  // 用户广场 / 公开主页（公开端点）
  userSquare: (query = '', sort = 'reg', offset = 0, limit = 30, listening = false) =>
    call('GET', `/users/square?query=${encodeURIComponent(query)}&sort=${sort}&offset=${offset}&limit=${limit}`
      + (listening ? '&listening=1' : '')),
  userProfile: (uid) => call('GET', `/users/${uid}/profile`),
  setSquarePublic: (on) => call('PUT', '/profile', { body: { publicSquare: on }, auth: true }),

  // 歌单
  myPlaylists: () => call('GET', '/playlists', { auth: true }),
  createPlaylist: (name, description) => call('POST', '/playlists', { body: { name, description }, auth: true }),
  playlist: (pid) => call('GET', `/playlists/${pid}`, { auth: true }),
  updatePlaylist: (pid, fields) => call('PUT', `/playlists/${pid}`, { body: fields, auth: true }),
  deletePlaylist: (pid) => call('DELETE', `/playlists/${pid}`, { body: {}, auth: true }),
  addPlaylistTracks: (pid, songs) => call('POST', `/playlists/${pid}/tracks`, { body: { songs }, auth: true }),
  delPlaylistTracks: (pid, ids) => call('DELETE', `/playlists/${pid}/tracks`, { body: { songs: ids.map(i => ({ ncm_id: i, name: 'x' })) }, auth: true }),

  // 网易云账号绑定
  bindStatus: () => call('GET', '/ncmbind', { auth: true }),
  qrKey: () => call('POST', '/ncmbind/qr/key', { body: {}, auth: true }),
  qrImg: (key) => call('GET', `/ncmbind/qr/img?key=${encodeURIComponent(key)}`, { auth: true }),
  qrCheck: (key) => call('GET', `/ncmbind/qr/check?key=${encodeURIComponent(key)}`, { auth: true }),
  unbindNcm: () => call('DELETE', '/ncmbind', { body: {}, auth: true }),
  syncNcm: () => call('POST', '/ncmbind/sync', { body: {}, auth: true }),
  ncmLike: (meta, like) => call('POST', `/ncmbind/like/${meta.ncm_id}`, { body: { ...meta, like }, auth: true }),
  ncmLikelist: () => call('GET', '/ncmbind/likelist', { auth: true }),
  ncmPhoneCode: (phone, ctcode) => call('POST', '/ncmbind/phone/code', { body: { phone, ctcode }, auth: true }),
  ncmPhoneLogin: (phone, captcha, ctcode) => call('POST', '/ncmbind/phone/login', { body: { phone, captcha, ctcode }, auth: true }),
  comments: (ncmId, offset = 0, limit = 20) => call('GET', `/ncm/comments?id=${ncmId}&offset=${offset}&limit=${limit}`, { auth: true }),
  commentPost: (ncmId, content, commentId) => call('POST', `/ncmbind/comment/${ncmId}`, { body: { content, commentId }, auth: true }),
  commentLike: (ncmId, commentId, like) => call('POST', `/ncmbind/comment-like/${ncmId}`, { body: { commentId, like }, auth: true }),
  commentFloor: (ncmId, cid) => call('GET', `/ncm/comment/floor?id=${ncmId}&cid=${cid}`),
  hotSearch: () => call('GET', '/ncm/hot'),
  commentDelete: (ncmId, commentId) => call('DELETE', `/ncmbind/comment/${ncmId}`, { body: { commentId }, auth: true }),

  // NCM 音源
  search: (keywords, offset = 0, limit = 30) => call('GET', `/ncm/search?keywords=${encodeURIComponent(keywords)}&offset=${offset}&limit=${limit}`),
  album: (id) => call('GET', `/ncm/album?id=${id}`),
  artistAlbums: (id, offset = 0, limit = 30) => call('GET', `/ncm/artist/albums?id=${id}&offset=${offset}&limit=${limit}`),
  artist: (id, offset = 0, limit = 100) => call('GET', `/ncm/artist?id=${id}&offset=${offset}&limit=${limit}`),
  followArtist: (id, on, name, pic) => call('POST', `/artists/${id}/follow`, { body: { on, name, pic }, auth: true }),
  followedArtists: (refresh = false) => call('GET', `/artists/followed${refresh ? '?refresh=1' : ''}`, { auth: true }),
  songUrl: (ncmId, level) => call('GET', `/ncm/song/url?id=${ncmId}&level=${level}`),
  songDetail: (ids) => call('GET', `/ncm/song/detail?ids=${ids.slice(0, 100).join(',')}`),
  lyric: (ncmId) => call('GET', `/ncm/lyric?id=${ncmId}`),
  commentCount: (ncmId) => call('GET', `/ncm/comment-count?id=${ncmId}`),
  ncmPlaylist: (pid) => call('GET', `/ncm/playlist?id=${pid}`),
  daily: () => call('GET', '/daily', { auth: true }),

  avatarUrl: (fname) => fname ? `${settings.base}/avatar/${fname}` : '',
  decorUrl: (id) => id ? `${settings.base}/decor/${encodeURIComponent(id)}.gif` : '',
  // 挂件放大比例表（id → 比例）：广场/主页等只拿到挂件 id，需靠它换算渲染尺寸
  decorScales: () => call('GET', '/decorations/scales'),
};

// ---------- 挂件比例表：版本门控的内存 + localStorage 缓存 ----------
// 挂件素材自带透明留白（圆环外径常常只有画布的 ~0.6），渲染时必须按比例放大，
// 否则圆环会明显小于头像。比例表很小（402 项 id→数字），启动时取一次即可长期复用。
// 「版本门控」：只有版本号与随包构建的 CATALOG_VERSION 一致才采用缓存值，
// 否则退回 1（宁可不放大），避免目录更新后拿旧比例把挂件放大到错误尺寸。
import { DECOR_SCALES, CATALOG_VERSION } from './decor-scales.js';

const LS_DECOR_SCALES = 'cm.decorScales';
let _decorScales = null;          // { version, scales:{id:number} }

function _trusted() {
  if (_decorScales === null) {
    _decorScales = _readStoredScales() || { version: CATALOG_VERSION, scales: DECOR_SCALES };
  }
  return _decorScales.version === CATALOG_VERSION ? _decorScales.scales : null;
}

function _readStoredScales() {
  try {
    const raw = localStorage.getItem(LS_DECOR_SCALES);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && v.scales && typeof v.scales === 'object' ? v : null;
  } catch (e) { return null; }
}

/** 同步取比例：版本不符或未知 id 一律返回 1（不放大好过放大错）。 */
export function decorScale(id) {
  if (!id) return 1;
  const map = _trusted();
  const s = map && map[id];
  return typeof s === 'number' && s > 0 ? s : 1;
}

/** 预热：先用随包/本地缓存同步可用，再后台校验服务端版本并按需刷新。 */
export function warmDecorScales() {
  _trusted();
  api.decorScales().then(d => {
    if (!d || !d.scales) return;
    _decorScales = { version: d.version, scales: d.scales };
    try { localStorage.setItem(LS_DECOR_SCALES, JSON.stringify(_decorScales)); } catch (e) { /* 配额满忽略 */ }
  }).catch(() => { /* 离线/限流：用随包基线 */ });
}

/** 目录接口（/decorations）已带比例表时直接采纳，省一次请求且与列表同版本。 */
export function adoptDecorScales(d) {
  if (d && d.scales) {
    _decorScales = { version: d.version || CATALOG_VERSION, scales: d.scales };
    try { localStorage.setItem(LS_DECOR_SCALES, JSON.stringify(_decorScales)); } catch (e) { /* 忽略 */ }
  }
}

export function detectBridge() {
  bridged = typeof window.NativeApi !== 'undefined';
  return bridged;
}
