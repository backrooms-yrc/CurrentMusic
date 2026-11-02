// Device-side probes never send account headers or cookies to mirrors/CDNs.
export const MIRRORS = [
  ['主站', 'https://music.20110208.xyz'], ['CTCEHS 镜像', 'https://music.ctcehs.com'],
  ['Geekertao 镜像', 'https://currentmusic.geekertao.com'], ['Bileizhen 镜像', 'https://cm.bileizhen.top'],
];
export const PROVIDERS = { currentmusic: 'CurrentMusic', leiz: 'LeiZ API' };
export const network = {
  get provider() { const v = localStorage.getItem('cm.audioProvider'); return PROVIDERS[v] ? v : 'currentmusic'; },
  set provider(v) { if (PROVIDERS[v]) localStorage.setItem('cm.audioProvider', v); },
  // Browser storage has no native keystore: keep the key for this tab only.
  get key() { return sessionStorage.getItem('cm.leizKey') || ''; },
  set key(v) { if (v) sessionStorage.setItem('cm.leizKey', v); else sessionStorage.removeItem('cm.leizKey'); },
  get cdn() { return localStorage.getItem('cm.audioCdn') || 'auto'; },
  set cdn(v) { localStorage.setItem('cm.audioCdn', v); },
};
export function sourceIdentity() { return [network.provider, network.key, network.cdn, localStorage.getItem('cm.base'), localStorage.getItem('cm.token')].join('\n'); }
export function withHost(url, host) { const u = new URL(url); u.hostname = host; return u.href; }
export function famOf(h) { return /^m\d\./.test(h) ? 'f2' : /^m\d{3}\./.test(h) ? 'f3' : ''; }
export const lineBest = { byFam: {}, probing: {} };
export const cdnResults = new Map();

export async function probeMirror(origin) {
  const samples = [];
  for (let i = 0; i < 2; i++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 4500);
    const start = performance.now();
    try {
      const r = await fetch(origin + '/cm/network/probe?t=' + Date.now() + '-' + i,
        { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctl.signal });
      const d = await r.json();
      if (!r.ok || d.ok !== true || d.service !== 'CurrentMusic') throw Error('无效探针');
      samples.push(performance.now() - start);
    } catch { /* Includes browser CORS failures. */ }
    finally { clearTimeout(timer); }
  }
  return { ok: samples.length === 2, successes: samples.length,
    ms: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null };
}

export async function probeMedia(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 6000);
  const start = performance.now();
  let reader;
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-262143' }, credentials: 'omit',
      cache: 'no-store', signal: ctl.signal });
    if (!r.ok || !/^(audio\/|video\/mp4|application\/octet-stream)/i.test(r.headers.get('content-type') || '')) throw Error('未返回音频');
    if (!r.body || !r.body.getReader) throw Error('浏览器不支持流式测速');
    reader = r.body.getReader();
    let bytes = 0;
    while (bytes < 262144) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
    }
    if (!bytes) throw Error('音频为空');
    const ms = performance.now() - start;
    return { ok: true, ms, bytes, kbps: bytes / Math.max(ms, 1) * 1000 / 1024 };
  } catch { return { ok: false, ms: null }; }
  finally { ctl.abort(); clearTimeout(timer); if (reader) await reader.cancel().catch(() => {}); }
}

export async function probeLines(info, force = false) {
  const fam = famOf(info.host || '');
  const cands = [...new Set([info.host, ...(info.hosts || [])])].filter(Boolean);
  if (!fam || !cands.length) return;
  if (lineBest.probing[fam]) return lineBest.probing[fam];
  if (!force && (network.cdn !== 'auto' || lineBest.byFam[fam])) return;
  lineBest.probing[fam] = (async () => {
    const ranked = await Promise.all(cands.map(async host => {
      const result = await probeMedia(withHost(info.url, host));
      cdnResults.set(host, result);
      return { host, ...result };
    }));
    const good = ranked.filter(r => r.ok).sort((a, b) => b.kbps - a.kbps);
    if (good.length) lineBest.byFam[fam] = good[0].host;
    else delete lineBest.byFam[fam];
    return ranked;
  })();
  try { return await lineBest.probing[fam]; } finally { delete lineBest.probing[fam]; }
}
export function swapLine(info) {
  if (!info || !info.host) return null;
  const best = network.cdn === 'auto' ? lineBest.byFam[famOf(info.host)] : network.cdn;
  if (!best || best === info.host || !(info.hosts || []).includes(best)) return null;
  return withHost(info.url, best);
}

export function testAudio(url) {
  return new Promise(resolve => {
    const el = new Audio();
    const done = ok => { clearTimeout(timer); el.onloadeddata = el.onerror = null; el.removeAttribute('src'); el.load(); resolve(ok); };
    const timer = setTimeout(() => done(false), 10000);
    el.preload = 'auto'; el.muted = true;
    el.onloadeddata = () => done(true); el.onerror = () => done(false);
    el.src = url; el.load();
  });
}
