import { auth, call, settings } from './api.js';

const SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/;

function identifyServer() {
  const url = new URL(settings.base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('服务器音源需要有效的 HTTPS API 地址');
  }
  if (!auth.scope) throw new Error('请先登录后导入服务器音源');
  return { base: url.href.replace(/\/+$/, ''), scope: auth.scope };
}

function storageKey({ base, scope }) {
  return 'cm.serverAudioSource:' + JSON.stringify([base, scope]);
}

function normalize(source) {
  if (!source || typeof source.id !== 'string' || !SOURCE_ID.test(source.id)
      || typeof source.name !== 'string' || !source.name.trim() || source.name.length > 120) return null;
  return { id: source.id, name: source.name };
}

async function sourceRequest(server, path) {
  if (server.base !== identifyServer().base || server.scope !== auth.scope) {
    throw new Error('登录或服务器已改变，请重新选择音源');
  }
  const data = await call('GET', path, { base: server.base, auth: true, redirect: 'error' });
  if (server.base !== identifyServer().base || server.scope !== auth.scope) {
    throw new Error('登录或服务器已改变，请重新选择音源');
  }
  return data;
}

export function importedServerAudio() {
  try {
    const entry = JSON.parse(localStorage.getItem(storageKey(identifyServer())));
    const source = normalize(entry);
    return source ? { ...source, selected: entry.selected === true } : null;
  } catch { return null; }
}

export async function listServerAudio() {
  const server = identifyServer();
  let catalog;
  try { catalog = await sourceRequest(server, '/audio-sources'); }
  catch (error) {
    if (error.status === 404) throw new Error('当前服务器暂不支持音源导入');
    throw error;
  }
  if (catalog?.version !== 1 || !Array.isArray(catalog.sources)) throw new Error('服务器音源目录版本不受支持');
  const sources = catalog.sources.filter(item => Array.isArray(item?.platforms) && item.platforms.includes('netease')).map(normalize).filter(Boolean);
  return { server, sources };
}

export function importServerAudio(server, source) {
  const current = identifyServer();
  if (current.base !== server.base || current.scope !== server.scope) throw new Error('登录或服务器已改变，请重新载入音源目录');
  const config = normalize(source);
  if (!config) throw new Error('服务器音源配置无效');
  localStorage.setItem(storageKey(server), JSON.stringify({ ...config, selected: true }));
}

export function selectServerAudio(selected) {
  const source = importedServerAudio();
  if (source && source.selected !== selected) {
    localStorage.setItem(storageKey(identifyServer()), JSON.stringify({ ...source, selected }));
  }
}

export function removeServerAudio() {
  localStorage.removeItem(storageKey(identifyServer()));
}

export async function resolveServerAudio(id, level, { refresh = false, supportsDolby = false } = {}) {
  const source = importedServerAudio();
  if (!source?.selected) throw new Error('请先导入并选择服务器音源');
  const query = new URLSearchParams({ id, level: level || 'auto' });
  if (refresh) query.set('refresh', '1');
  if (supportsDolby) query.set('supportsDolby', '1');
  const result = await sourceRequest(identifyServer(), '/audio-sources/' + source.id + '/resolve?' + query);
  if (typeof result?.url !== 'string') throw new Error('服务器音源未提供可用地址');
  const url = new URL(result.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('服务器音源未提供安全 HTTPS 地址');
  return { ...result, url: url.href, provider: 'server', autoDolby: level === 'auto' && supportsDolby && result.level === 'dolby' };
}
