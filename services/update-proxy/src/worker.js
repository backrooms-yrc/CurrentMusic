// Streaming GitHub release proxy adapted from hubporg/CF-GitHub-Proxy (MIT).
// Copyright (c) 2025 Geekertao; CurrentMusic restrictions and authentication added 2026.
const APP_ID = 'com.bileizhen.currentmusic';
const REPOSITORY = 'https://github.com/bileizhen/CurrentMusicX';
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_BYTES = 128 * 1024 * 1024;
const TTL = 120;
const encoder = new TextEncoder();
const redirects = new Set([301, 302, 303, 307, 308]);

function failure(status, message) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function downloadTarget(url) {
  if (url.search || url.hash || url.username || url.password) return null;
  const match = /^\/download\/(v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)\/(CurrentMusic-Android-v[A-Za-z0-9.-]+\.apk)$/.exec(url.pathname);
  if (!match || match[1].length > 80 || match[2] !== `CurrentMusic-Android-${match[1]}.apk`) return null;
  return new URL(`${REPOSITORY}/releases/download/${match[1]}/${match[2]}`);
}
export function canonicalRequest(request) {
  const url = new URL(request.url);
  return ['v1', request.method, url.host, url.pathname, request.headers.get('Range') || '',
    request.headers.get('X-CurrentMusic-App') || '', request.headers.get('X-CurrentMusic-Key-Id') || '',
    request.headers.get('X-CurrentMusic-Timestamp') || '', request.headers.get('X-CurrentMusic-Nonce') || ''].join('\n');
}
export async function signRequest(request, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalRequest(request)));
  return Array.from(new Uint8Array(signature), value => value.toString(16).padStart(2, '0')).join('');
}
async function authorized(request, env, now) {
  if (request.headers.get('X-CurrentMusic-App') !== APP_ID || request.headers.get('X-CurrentMusic-Key-Id') !== env.APP_KEY_ID) return false;
  const stamp = request.headers.get('X-CurrentMusic-Timestamp') || '';
  const nonce = request.headers.get('X-CurrentMusic-Nonce') || '';
  const signature = request.headers.get('X-CurrentMusic-Signature') || '';
  if (!/^\d{10}$/.test(stamp) || Math.abs(now - Number(stamp)) > TTL || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.match(/../g), value => parseInt(value, 16));
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(canonicalRequest(request)));
}
function safeRedirect(url, target) {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  if (url.host === 'github.com') return url.href === target.href;
  return CDN_HOSTS.has(url.hostname) && url.pathname.startsWith('/github-production-release-asset');
}
export async function handleRequest(request, env, { fetcher = fetch, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    if (!['GET', 'HEAD'].includes(request.method)) return failure(405, 'Method not allowed');
    const incoming = new URL(request.url);
    if (incoming.protocol !== 'https:' || incoming.hostname !== 'updates.bileizhen.top' || incoming.port) return failure(403, 'Forbidden');
    const target = downloadTarget(incoming);
    if (!target) return failure(404, 'Not found');
    if (!env.APP_SECRET || env.APP_SECRET.length < 32 || !env.APP_KEY_ID || !env.REQUEST_GUARD) return failure(503, 'Unavailable');
    const range = request.headers.get('Range');
    if (range && (!/^bytes=(\d+-\d*|-\d+)$/.test(range) || range.length > 80)) return failure(400, 'Invalid range');
    if (!await authorized(request, env, now)) return failure(403, 'Forbidden');
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipDigest = await crypto.subtle.digest('SHA-256', encoder.encode(ip));
    const ipKey = Array.from(new Uint8Array(ipDigest), value => value.toString(16).padStart(2, '0')).join('');
    const gate = env.REQUEST_GUARD.get(env.REQUEST_GUARD.idFromName('request-v1'));
    const allowed = await gate.fetch('https://guard/check', { method: 'POST', body: JSON.stringify({
      nonce: request.headers.get('X-CurrentMusic-Nonce'), ip: ipKey,
      now, expires: Number(request.headers.get('X-CurrentMusic-Timestamp')) + TTL
    }) });
    if (!allowed.ok) return failure(allowed.status, allowed.status === 429 ? 'Too many requests' : 'Request already used');
    // Never forward application credentials, cookies, user bearer tokens, or arbitrary headers.
    const headers = new Headers({ Accept: 'application/vnd.android.package-archive, application/octet-stream', 'User-Agent': 'CurrentMusic update proxy' });
    if (range) headers.set('Range', range);
    let upstream = target;
    for (let hop = 0; hop <= 5; hop++) {
      const response = await fetcher(upstream.href, { method: request.method, headers, redirect: 'manual' });
      if (redirects.has(response.status)) {
        const location = response.headers.get('Location');
        await response.body?.cancel();
        if (!location || hop === 5) return failure(502, 'Invalid upstream redirect');
        const next = new URL(location, upstream);
        if (!safeRedirect(next, target)) return failure(502, 'Blocked upstream redirect');
        upstream = next;
        continue;
      }
      if (![200, 206].includes(response.status)) { await response.body?.cancel(); return failure(502, 'Upstream unavailable'); }
      const length = Number(response.headers.get('Content-Length'));
      const media = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (length > MAX_BYTES || ['text/html', 'application/json', 'application/xhtml+xml'].includes(media)) {
        await response.body?.cancel(); return failure(502, 'Invalid upstream asset');
      }
      const returned = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'application/vnd.android.package-archive' });
      for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Content-Encoding']) {
        const value = response.headers.get(name); if (value) returned.set(name, value);
      }
      if (request.method === 'HEAD' || !response.body) return new Response(null, { status: response.status, headers: returned });
      let bytes = 0;
      const limit = new TransformStream({ transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_BYTES) throw new Error('Asset exceeds size limit');
        controller.enqueue(chunk);
      } });
      return new Response(response.body.pipeThrough(limit), { status: response.status, headers: returned });
    }
    return failure(502, 'Upstream unavailable');
  } catch { return failure(502, 'Upstream unavailable'); }
}
export default { fetch: handleRequest };

/** Durable replay prevention and a 48-request/minute budget per hashed source IP. */
export class RequestGuard {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const input = await request.json();
    if (!/^[a-f0-9]{32}$/.test(input.nonce) || !/^[a-f0-9]{64}$/.test(input.ip) || !Number.isInteger(input.now) || !Number.isInteger(input.expires)) return failure(400, 'Invalid request');
    const result = await this.state.storage.transaction(async storage => {
      const nonceKey = `nonce:${input.nonce}`;
      if (await storage.get(nonceKey)) return 409;
      const rateKey = `rate:${input.ip}`;
      const window = Math.floor(input.now / 60);
      const previous = await storage.get(rateKey);
      const used = previous?.window === window ? previous.used : 0;
      if (used >= 48) return 429;
      await storage.put(nonceKey, { expires: input.expires });
      await storage.put(rateKey, { window, used: used + 1 });
      return 204;
    });
    if (!await this.state.storage.getAlarm()) await this.state.storage.setAlarm(Date.now() + 180000);
    return new Response(null, { status: result });
  }
  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    const entries = await this.state.storage.list({ limit: 1000 });
    const expired = [];
    for (const [key, value] of entries) {
      if ((key.startsWith('nonce:') && value.expires < now) || (key.startsWith('rate:') && value.window < Math.floor(now / 60) - 1)) expired.push(key);
    }
    if (expired.length) await this.state.storage.delete(expired);
    if (entries.size > expired.length) await this.state.storage.setAlarm(Date.now() + 180000);
  }
}
