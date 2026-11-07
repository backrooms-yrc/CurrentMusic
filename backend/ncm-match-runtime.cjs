const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { createRequire } = require('node:module');
const { MatchError, inspectAudio, matchCandidates } = require('./ncm-match-core.cjs');
const { qqCandidates } = require('./ncm-fallback-providers.cjs');

function stopWorker(child) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
}

function runWorker(job) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LOG_LEVEL: 'silent' };
    delete env.LOG_FILE;
    const child = fork(__filename, [], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); stopWorker(child);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new MatchError('matching_timeout')), 18000);
    child.once('message', result => result.ok ? finish(null, result.data) : finish(new MatchError(result.code, result.attempts)));
    child.once('error', () => finish(new MatchError('worker_failed')));
    child.once('exit', () => finish(new MatchError('worker_failed')));
    child.send(job, error => { if (error) finish(new MatchError('worker_failed')); });
  });
}

function createService(root, runner = runWorker) {
  const pending = new Map(), cache = new Map();
  let active = 0;
  return {
    async match(id, source, context = {}, candidate) {
      id = Number(id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new MatchError('invalid_id');
      if (source && !/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new MatchError('invalid_source');
      const key = crypto.createHash('sha256').update(JSON.stringify([id, source || '', context.realIP || '', candidate || ''])).digest('hex');
      const hit = cache.get(key);
      if (!context.refresh && hit && hit.until > Date.now()) return structuredClone(hit.data);
      if (pending.has(key)) return structuredClone(await pending.get(key));
      if (active >= 4) throw new MatchError('matching_busy');
      active++;
      const task = Promise.resolve().then(() => runner({ root, id, source, realIP: context.realIP, candidate }))
        .then(data => {
          cache.set(key, { until: Date.now() + 120000, data });
          while (cache.size > 400) cache.delete(cache.keys().next().value);
          return data;
        }).finally(() => { active--; pending.delete(key); });
      pending.set(key, task);
      return structuredClone(await task);
    },
  };
}

const services = new Map();
function service(root) {
  if (!services.has(root)) services.set(root, createService(root));
  return services.get(root);
}
const context = query => ({ realIP: query.realIP, refresh: !!query.timestamp || ['1', 'true'].includes(String(query.refresh)) });
function failure(error) {
  const reason = error instanceof MatchError ? error.code : 'matching_failed';
  const status = ['invalid_id', 'invalid_source'].includes(reason) ? 400 : reason === 'unknown_source' ? 404 : reason === 'matching_busy' ? 503 : 502;
  return { status, body: { code: status, msg: '没有找到通过完整音频校验的可用音源',
    reason, attempts: error?.attempts || [], data: null }, cookie: [] };
}

function matchID(root) {
  return async (id, source, ctx) => {
    try { return { code: 200, message: 'success', data: await service(root).match(id, source, ctx) }; }
    catch (error) { return failure(error).body; }
  };
}

function matchEndpoint(root, engine = service(root)) {
  return async query => {
    try {
      const info = await engine.match(query.id, query.source, context(query));
      return { status: 200, body: { code: 200, data: info.url, proxyUrl: '', matchInfo: info }, cookie: [] };
    } catch (error) { return failure(error); }
  };
}

function wrapPlayback(original, root, redirect = false, engine = service(root)) {
  return async (query, request) => {
    if (String(query.unblock) !== 'true') return original(query, request);
    // Upstream's batch URL lookup remains available; matching itself takes one song ID.
    if (!redirect && String(query.id).includes(',')) return original({ ...query, unblock: 'false' }, request);
    try {
      // Preserve official streams when they validate as the complete requested track.
      const official = await original({ ...query, unblock: 'false' }, request);
      const item = official?.body?.data?.[0];
      const url = redirect ? official?.redirectUrl : item?.url;
      if (url && !item?.freeTrialInfo) {
        await engine.match(query.id, undefined, context(query), url);
        return official;
      }
    } catch { /* continue through independently verified providers */ }
    try {
      const info = await engine.match(query.id, query.source, context(query));
      if (redirect) return { status: 302, redirectUrl: info.url, body: '', cookie: [] };
      return { status: 200, body: { code: 200, data: [{ ...info, id: Number(query.id), level: 'matched',
        requestedLevel: query.level, freeTrialInfo: null, fee: 0 }] }, cookie: [] };
    } catch (error) { return failure(error); }
  };
}

async function worker(job) {
  const req = createRequire(path.join(job.root, 'package.json'));
  const base = process.env.CM_NCM_MATCH_REFERENCE_BASE || 'http://127.0.0.1:' + (process.env.PORT || '3000');
  const endpoint = new URL('/song/detail', base);
  endpoint.searchParams.set('ids', String(job.id));
  endpoint.searchParams.set('cmMatchReference', '1');
  if (job.realIP) endpoint.searchParams.set('realIP', job.realIP);
  let data;
  try {
    const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: {}, noCookie: true }) });
    if (!response.ok) throw new Error();
    data = await response.json();
  } catch { throw new MatchError('reference_unavailable'); }
  const song = data?.songs?.find(item => item.id === job.id);
  if (!song || !Number.isFinite(song.dt) || song.dt <= 0) throw new MatchError('reference_duration_missing');
  const reference = { id: job.id, duration: song.dt, name: song.name, artists: song.ar, album: song.al };
  if (job.candidate) return inspectAudio(job.candidate, reference);
  const utils = fs.realpathSync(path.dirname(req.resolve('@neteasecloudmusicapienhanced/unblockmusic-utils/package.json')));
  const modules = path.join(utils, 'modules');
  const names = fs.readdirSync(modules).filter(name => /^[a-z][a-z0-9_-]*\.js$/.test(name)).map(name => name.slice(0, -3));
  if (job.source && job.source !== 'vkeys' && !names.includes(job.source)) throw new MatchError('unknown_source');
  const candidates = [];
  // Try alternate QQ quality immediately after the first one fails validation.
  // The group occupies one slot, leaving the other slot for independent sources.
  const qq = !job.source || job.source === 'vkeys' ? qqCandidates(reference) : [];
  if (qq.length) candidates.push(qq);
  for (const name of job.source === 'vkeys' ? [] : job.source ? [job.source] : names) {
    if (name === 'unm') {
      const localRequire = createRequire(path.join(utils, 'package.json'));
      const native = localRequire('@unblockneteasemusic/server');
      const publicData = { id: reference.id, name: song.name, duration: song.dt, alias: song.alia || [], album: song.al, artists: song.ar };
      // Check each native source separately: an error sound must not win the native Promise.any race.
      for (const source of ['pyncmd', 'bodian', 'qq', 'kugou', 'kuwo', 'migu']) {
        candidates.push({ name: 'unm:' + source, get: () => native(job.id, [source], publicData) });
      }
    } else {
      candidates.push({ name, get: async () => {
        const adapter = req(path.join(modules, name + '.js'));
        const fn = typeof adapter === 'function' ? adapter : adapter[name] || Object.values(adapter).find(value => typeof value === 'function');
        if (!fn) throw new MatchError('provider_failed');
        return fn(job.id);
      } });
    }
  }
  return matchCandidates(reference, candidates);
}

if (require.main === module && process.send) {
  process.once('message', async job => {
    try { process.send({ ok: true, data: await worker(job) }); }
    catch (error) { process.send({ ok: false, code: error instanceof MatchError ? error.code : 'provider_failed', attempts: error.attempts || [] }); }
  });
  process.once('disconnect', () => process.exit(0));
}

module.exports = { createService, matchID, matchEndpoint, wrapPlayback, runWorker, worker };
