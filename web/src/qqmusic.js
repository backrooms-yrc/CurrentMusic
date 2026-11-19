import { auth, settings } from './api.js';

const QQ_ID = /^[a-zA-Z0-9]{1,64}$/;
const SESSION = /^[a-f0-9]{64}$/;
export const QQ_QUALITIES = [
  { key: 'auto', label: '自动' },
  { key: 'standard', label: '标准 128 kbps' },
  { key: 'exhigh', label: '极高 320 kbps' },
  { key: 'lossless', label: '无损 FLAC' },
];

function connection() {
  const url = new URL(settings.base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('QQ 音乐需要有效的 HTTPS API 地址');
  }
  const base = url.href.replace(/\/+$/, '');
  return { base, identity: JSON.stringify([base, auth.scope]), token: auth.token };
}

function sessionKey(identity) { return 'cm.qq.session:' + identity; }

export function hasQqSession() {
  try {
    const site = connection();
    return !!site.token && SESSION.test(sessionStorage.getItem(sessionKey(site.identity)) || '');
  } catch { return false; }
}

export function qqQuality(value) {
  const key = 'cm.qq.quality:' + connection().identity;
  if (value && QQ_QUALITIES.some(quality => quality.key === value)) localStorage.setItem(key, value);
  const saved = localStorage.getItem(key);
  return QQ_QUALITIES.some(quality => quality.key === saved) ? saved : 'auto';
}

export async function qqRequest(path, { query, body, requireLogin = false, withSession = true, signal } = {}) {
  const site = connection();
  const key = sessionKey(site.identity);
  const session = withSession && site.token ? sessionStorage.getItem(key) : '';
  if (requireLogin && !site.token) throw new Error('请先登录 CurrentMusic');
  const headers = { Accept: 'application/json' };
  if (requireLogin || session) headers.Authorization = 'Bearer ' + site.token;
  if (session) headers['X-QQ-Session'] = session;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const response = await fetch(site.base + '/qqmusic' + path + qs, {
    method: body !== undefined ? 'POST' : 'GET', headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal,
  });
  const result = await response.json().catch(() => null);
  const current = connection();
  if (current.identity !== site.identity || site.token !== current.token) {
    throw new Error('账号或服务器已切换，请重试');
  }
  if (!response.ok) {
    if (response.status === 401 && session && sessionStorage.getItem(key) === session) sessionStorage.removeItem(key);
    throw Object.assign(new Error(result?.error || 'QQ 音乐请求失败（HTTP ' + response.status + '）'), { status: response.status });
  }
  if (!result || ![undefined, 0, 200, 800, 801, 802, 803].includes(result.code)) {
    throw new Error(result?.message || 'QQ 音乐上游未完成请求');
  }
  if (path === '/login/refresh' && SESSION.test(result.data?.token || '')) sessionStorage.setItem(key, result.data.token);
  if (path === '/logout') sessionStorage.removeItem(key);
  return result;
}

export function saveQqSession(confirmed) {
  if (!SESSION.test(confirmed || '')) throw new Error('QQ 音乐未返回可用的会话');
  sessionStorage.setItem(sessionKey(connection().identity), confirmed);
}

export function isQqSong(song) { return song?.provider === 'qqmusic'; }

export function qqSongs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(raw => {
    const row = raw?.songInfo || raw?.musicData || raw;
    const mid = String(row?.qq_mid || row?.mid || row?.songmid || row?.id || '');
    if (!QQ_ID.test(mid)) return [];
    const source = Array.isArray(row.singer) ? row.singer : [];
    const albumMid = row.album?.mid;
    const number = Number(row.qq_id || row.id);
    return [{
      provider: 'qqmusic', ncm_id: 'qq:' + mid, qq_mid: mid,
      qq_id: Number.isSafeInteger(number) && number > 0 ? String(number) : '',
      name: row.name || row.title || row.songname || '未知单曲',
      artists: row.artists || source.map(artist => artist.name).filter(Boolean).join(' / '),
      album: typeof row.album === 'string' ? row.album : row.album?.name || '',
      pic: row.pic || (QQ_ID.test(albumMid || '') ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + albumMid + '.jpg' : ''),
      duration: Number(row.duration ?? row.interval * 1000) || 0,
    }];
  });
}

export async function resolveQqSong(song, level) {
  if (!hasQqSession()) {
    throw Object.assign(new Error('请在 QQ 音乐页面扫码登录后再播放'), { noAutoNext: true });
  }
  try {
    const selected = QQ_QUALITIES.some(quality => quality.key === level) ? level : qqQuality();
    const result = await qqRequest('/song/url', { query: { id: song.qq_mid, level: selected }, requireLogin: true });
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('QQ 音乐未提供安全 HTTPS 音源');
    return { ...result, url: url.href, provider: 'qqmusic', type: result.type || result.format || 'mp3' };
  } catch (error) {
    error.noAutoNext = true;
    throw error;
  }
}
