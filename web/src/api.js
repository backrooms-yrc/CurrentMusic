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
    // 401 有两种来源：项目会话失效（该提示重新登录）与「尚未绑定网易云」（该引导去绑定）。
    // 后者按状态码一律当成会话失效会误报「登录已失效」，所以按文案区分。
    if (e.status === 401 && needAuth && onAuthExpired && !/绑定/.test(e.message || '')) onAuthExpired();
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

/** File/Blob → base64（去掉 data URL 前缀）。 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(blob);
  });
}

/**
 * 图片降采样：最长边压到 1024、转 JPEG。
 * 为什么必须做：手机原图 4~8MB，而服务端请求体上限 2MB（base64 还要再涨 1/3），
 * 原样上传必然 400；上游封面/头像也只需要一张方图。
 * 非图片或 canvas 不可用时抛错，由调用方回退原文件。
 */
function shrinkImage(file, maxSide = 1024, quality = 0.86) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || '')) return reject(new Error('不是图片'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob(b => {
          URL.revokeObjectURL(url);
          b ? resolve(b) : reject(new Error('图片压缩失败'));
        }, 'image/jpeg', quality);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
    img.src = url;
  });
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
  // 上报**实际收听毫秒**（增量）。带 ms 时后端累加到这首歌最近一次播放记录上，
  // 不再用"点开就记整首时长"的旧口径（见 cm_db.listen_ms）。
  addListenMs: (ncmId, ms) => call('POST', `/plays/${ncmId}`, { body: { ms }, auth: true }),
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
  // 绑定有效性：走项目专用入口（上游 /login/status、/login/refresh 属 T3，不允许泛化转发）
  ncmLive: () => call('GET', '/ncmbind/live', { auth: true }),
  ncmRefresh: () => call('POST', '/ncmbind/refresh', { body: {}, auth: true }),
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
  // type 可指定 'song'/'artist'/'album'/'playlist'：只请求需要的类型。
  // 上游各类型耗时差异大（歌手曾达 6s+），而搜索页默认展示「单曲」，
  // 因此按类型分开取，首屏不必等其它类型。省略 type 则返回全部类型（旧行为）。
  search: (keywords, offset = 0, limit = 30, type = '') => call('GET',
    `/ncm/search?keywords=${encodeURIComponent(keywords)}&offset=${offset}&limit=${limit}${type ? `&type=${type}` : ''}`),
  album: (id) => call('GET', `/ncm/album?id=${id}`),
  artistAlbums: (id, offset = 0, limit = 30) => call('GET', `/ncm/artist/albums?id=${id}&offset=${offset}&limit=${limit}`),
  artist: (id, offset = 0, limit = 100) => call('GET', `/ncm/artist?id=${id}&offset=${offset}&limit=${limit}`),
  followArtist: (id, on, name, pic) => call('POST', `/artists/${id}/follow`, { body: { on, name, pic }, auth: true }),
  followedArtists: (refresh = false) => call('GET', `/artists/followed${refresh ? '?refresh=1' : ''}`, { auth: true }),
  songUrl: (ncmId, level) => call('GET', `/ncm/song/url?id=${ncmId}&level=${level}`),

  // ---- 帖子（发现页） ----
  posts: (offset = 0, limit = 20, author = null) => call('GET',
    `/posts?offset=${offset}&limit=${limit}${author ? `&author=${author}` : ''}`),
  postCreate: (content, attachments) => call('POST', '/posts', { body: { content, attachments }, auth: true }),
  postDelete: (id) => call('DELETE', `/posts/${id}`, { auth: true }),
  postLike: (id, on) => call('POST', `/posts/${id}/like`, { body: { on }, auth: true }),
  postComments: (id) => call('GET', `/posts/${id}/comments`),
  postComment: (id, content) => call('POST', `/posts/${id}/comments`, { body: { content }, auth: true }),
  postCommentDelete: (cid) => call('DELETE', `/posts/comments/${cid}`, { auth: true }),
  songDetail: (ids) => call('GET', `/ncm/song/detail?ids=${ids.slice(0, 100).join(',')}`),
  lyric: (ncmId) => call('GET', `/ncm/lyric?id=${ncmId}`),
  commentCount: (ncmId) => call('GET', `/ncm/comment-count?id=${ncmId}`),
  ncmPlaylist: (pid) => call('GET', `/ncm/playlist?id=${pid}`),
  daily: () => call('GET', '/daily', { auth: true }),
  /** 歌曲百科（服务端已把上游页级结构归一化成「章节 + 字段 + 正文」）。 */
  songWiki: (ncmId) => call('GET', `/song/wiki?id=${ncmId}`),

  /** 首屏聚合：一次拿回 me/daily/bind/recent（服务端并行取好）。旧服务端没有该端点 → 调用方回退逐个请求。 */
  bootstrap: () => call('GET', '/bootstrap', { auth: true }),

  // ---- NCM 泛化网关（阶段一：发现 / 榜单 / 曲风 / 搜索增强）----
  // 统一走 /ncm/<上游路径>。路径必须在后端登记表（backend/cm_ncm_registry.py）内，
  // 且阶段已启用；未登记返回 404，敏感路径（T3）返回 403。
  ncm: (path, params = {}) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    // 必须带 Bearer：T1/T2 分级要拿调用者自己的 ncmbind cookie，没 token 一律 401「未登录」。
    // （T0 带了也无害——后端只对 T0 用服务端 SVIP 档并剥离身份字段。）
    return call('GET', `/ncm${path}${qs ? `?${qs}` : ''}`, { auth: true });
  },
  /**
   * 带文件的 NCM 写接口（封面/头像这类，后端白名单见 cm_ncm_gateway.UPLOAD_FIELD）。
   * 图片会先按最长边降采样再上传：手机原图动辄 4~8MB，而服务端请求体上限 2MB，
   * 且上游只需一张正方形的封面/头像。降采样失败（老内核/canvas 异常）时回退为原文件。
   */
  ncmUpload: async (path, params = {}, file) => {
    const blob = await shrinkImage(file).catch(() => file);
    // 服务端请求体上限 2MB（MAX_BODY，base64 后还要涨 1/3）。压不动的（非图片、老内核）
    // 就在这里拦住并给出可读提示，别让服务端读到一半断管道。
    if (blob.size > 1400 * 1024) throw new Error('文件过大（需小于 1.4MB，请换一张图片或先裁剪）');
    const b64 = await blobToBase64(blob);
    const qs = Object.entries({ ...params, confirm: 1 })
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return call('POST', `/ncm${path}${qs ? `?${qs}` : ''}`, {
      auth: true,
      body: { file: b64, filename: file.name || 'upload.jpg', contentType: blob.type || file.type || 'image/jpeg' },
    });
  },
  // 首页与推荐
  banner: (type = 0) => api.ncm('/banner', { type }),
  personalized: (limit = 12) => api.ncm('/personalized', { limit }),
  personalizedNewSong: (limit = 12) => api.ncm('/personalized/newsong', { limit }),
  personalizedMv: (limit = 6) => api.ncm('/personalized/mv', { limit }),
  personalizedDj: (limit = 6) => api.ncm('/personalized/djprogram', { limit }),
  privateContent: () => api.ncm('/personalized/privatecontent'),
  privateContentList: (limit = 6) => api.ncm('/personalized/privatecontent/list', { limit }),
  homePage: () => api.ncm('/homepage/block/page'),
  homeDragon: () => api.ncm('/homepage/dragon/ball'),
  // 榜单
  toplist: () => api.ncm('/toplist'),
  toplistDetail: () => api.ncm('/toplist/detail'),
  topPlaylist: (cat = '全部', limit = 12, offset = 0, order = 'hot') =>
    api.ncm('/top/playlist', { cat, limit, offset, order }),
  topSong: (type = 0, limit = 20, offset = 0) => api.ncm('/top/song', { type, limit, offset }),
  topArtists: (limit = 12, offset = 0) => api.ncm('/top/artists', { limit, offset }),
  topList: (type = 0) => api.ncm('/top/list', { type }),
  // 曲风
  styleList: () => api.ncm('/style/list'),
  styleDetail: (tagId) => api.ncm('/style/detail', { tagId }),
  styleSongs: (tagId, size = 20, cursor = 0) => api.ncm('/style/song', { tagId, size, cursor }),
  stylePlaylists: (tagId, size = 12, cursor = 0) => api.ncm('/style/playlist', { tagId, size, cursor }),
  styleArtists: (tagId, size = 12, cursor = 0) => api.ncm('/style/artist', { tagId, size, cursor }),
  styleAlbums: (tagId, size = 12, cursor = 0) => api.ncm('/style/album', { tagId, size, cursor }),
  // 搜索增强
  searchHotDetail: () => api.ncm('/search/hot/detail'),
  searchSuggest: (keywords, type = 'mobile') => api.ncm('/search/suggest', { keywords, type }),
  searchDefault: () => api.ncm('/search/default'),
  // 音乐日历 / 国家码
  calendar: (startTime, endTime) => api.ncm('/calendar', { startTime, endTime }),
  countries: () => api.ncm('/countries/code/list'),

  avatarUrl: (fname) => fname ? `${settings.base}/avatar/${fname}` : '',
  decorUrl: (id) => id ? `${settings.base}/decor/${encodeURIComponent(id)}.gif` : '',
  // 挂件放大比例表（id → 比例）：广场/主页等只拿到挂件 id，需靠它换算渲染尺寸
  decorScales: () => call('GET', '/decorations/scales'),
};

/** 上游原始歌曲对象 → 项目规范歌曲对象（字段与后端 cm_ncm._norm_song 保持一致）。
 *  泛化网关返回的是上游原始 JSON（ar/al/dt），前端消费前必须过这一层归一。 */
export function ncmSong(s) {
  if (!s || !s.id) return null;
  const ar = s.ar || s.artists || [];
  const al = s.al || s.album || {};
  return {
    ncm_id: s.id,
    name: s.name || '',
    artists: ar.map(a => a && a.name).filter(Boolean).join(' / '),
    artist_ids: ar.map(a => a && a.id).filter(Boolean),
    album: al.name || '',
    pic: (al.picUrl || s.picUrl || '').replace(/^http:/, 'https:'),
    duration: s.dt || s.duration || 0,
    fee: s.fee == null ? 0 : s.fee,
    pop: s.pop == null ? 0 : s.pop,
    mv: s.mv || s.mvid || 0,      // MV id（0 = 无）：歌曲条的「播放 MV」按钮据此显示
  };
}

/** 批量归一 + 丢弃无效项。 */
export function ncmSongs(list) {
  return (list || []).map(ncmSong).filter(Boolean);
}

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
