const assert = require('node:assert/strict');
const http = require('node:http');
const { MatchError, checkDuration, inspectAudio, matchCandidates } = require('../backend/ncm-match-core.cjs');
const { createService, matchEndpoint, wrapPlayback } = require('../backend/ncm-match-runtime.cjs');
const { qqCandidates, selectQQSong } = require('../backend/ncm-fallback-providers.cjs');

const reference = { id: 186001, duration: 299000 };
const verified = { url: 'https://audio.example.test/full.mp3', type: 'mp3', durationMs: 299000,
  expectedDurationMs: 299000, validated: true, validationVersion: 1, source: 'valid', br: 320000, size: 11960000 };
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

function wav(seconds) {
  const buffer = Buffer.alloc(44 + Math.round(8000 * 2 * seconds));
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}

async function run() {
  const full = wav(299), short = wav(2.61), html = Buffer.from('<!DOCTYPE html><html>404, not music</html>');
  let transferred = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/html' }); response.end(); return; }
    const body = request.url === '/full' ? full : request.url === '/short' ? short : html;
    const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
    const content = body.subarray(start, end + 1);
    response.writeHead(match ? 206 : 200, { 'content-type': 'audio/wav', 'content-length': content.length,
      'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}) });
    response.end(content); transferred += content.length;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await rejects(inspectAudio(base + '/html', reference), 'not_audio');
    await rejects(inspectAudio(base + '/redirect', reference), 'not_audio');
    await rejects(inspectAudio(base + '/short', reference), 'duration_mismatch');
    const info = await inspectAudio(base + '/full', reference);
    assert.equal(info.type, 'wav'); assert.equal(info.durationMs, 299000); assert.equal(info.size, full.length);
    assert.equal(info.validated, true);
    console.log('PASS real media validation: HTML disguised as audio, redirect to HTML and 2.61-second clip rejected; complete 299-second WAV accepted');

    const result = await matchCandidates(reference, [
      { name: 'html', get: async () => base + '/html' },
      { name: 'short', get: async () => base + '/short' },
      { name: 'full', get: async () => ({ url: base + '/full', type: 'flac', br: 999000 }) },
    ]);
    assert.equal(result.source, 'full'); assert.equal(result.type, 'wav');
    assert(result.attempts.some(item => item.reason === 'not_audio'));
    assert(result.attempts.some(item => item.reason === 'duration_mismatch' && item.durationMs === 2610));
    let checks = 0;
    await rejects(matchCandidates(reference, [0, 1].map(i => ({ name: 'duplicate' + i, get: async () => verified.url })),
      async () => { checks++; throw new MatchError('not_audio'); }), 'no_verified_source');
    assert.equal(checks, 1);
    await rejects(matchCandidates({ id: 1, duration: 0 }, []), 'reference_duration_missing');
    assert.throws(() => checkDuration(NaN, 299000), error => error.code === 'audio_duration_missing');
    checkDuration(299500, 299000);
    console.log('PASS source iteration: invalid candidates skipped, later complete source accepted, duplicate URLs checked once, missing durations fail closed');

    const rescued = await matchCandidates(reference, [
      { name: 'hung-a', timeoutMs: 15, get: () => new Promise(() => {}) },
      { name: 'hung-b', timeoutMs: 15, get: () => new Promise(() => {}) },
      { name: 'later', get: async () => base + '/full' },
    ]);
    assert.equal(rescued.source, 'later');
    assert.equal(rescued.attempts.filter(a => a.reason === 'provider_timeout').length, 2);
    console.log('PASS provider deadlines: two stalled providers cannot prevent a later complete source from running');

    const songReference = { ...reference, name: '七里香', artists: [{ name: '周杰伦' }], album: { name: '七里香' } };
    const qq = { mid: '004Z8Ihr0JIu5s', song: '七里香', singer_list: [{ name: '周杰伦' }], album: '七里香', interval: '4分59秒' };
    const cover = { ...qq, singer_list: [{ name: '翻唱歌手' }] };
    const live = { ...qq, song: '七里香 (Live)' };
    const shortMetadata = { ...qq, interval: '0分30秒' };
    assert.equal(selectQQSong(songReference, [cover, live, shortMetadata, qq]), qq);
    for (const wrong of [cover, live, shortMetadata, { ...qq, subtitle: 'Live' }, { ...qq, singer_list: [] }]) {
      assert.throws(() => selectQQSong(songReference, [wrong]), error => error.code === 'identity_mismatch');
    }
    const requests = [];
    const fetchQQ = async (url, options) => {
      url = new URL(url); requests.push(url);
      assert(!Object.keys(options.headers).some(k => /cookie|authorization|real-ip|forwarded/i.test(k)));
      const result = url.pathname === '/v2/music/tencent' ? { code: 200, data: [cover, live, qq] }
        : { code: 0, data: { songMID: qq.mid, url: base + (url.searchParams.get('quality') === '2' ? '/short' : '/full') } };
      return { ok: true, text: async () => JSON.stringify(result) };
    };
    const qqOptions = qqCandidates(songReference, { fetchImpl: fetchQQ });
    await rejects(matchCandidates(songReference, [qqOptions[0]]), 'no_verified_source');
    const alternatives = await matchCandidates(songReference, qqOptions);
    assert.equal(alternatives.source, 'vkeys:qq:1');
    assert.equal(alternatives.durationMs, 299000);
    assert.equal(requests.filter(u => u.pathname === '/v2/music/tencent').length, 1, 'parallel qualities share the metadata lookup');
    assert(requests.filter(u => u.pathname.endsWith('/song/link')).every(u => u.searchParams.get('mid') === qq.mid));
    const malformed = qqCandidates(songReference, { fetchImpl: async url => ({ ok: true, text: async () =>
      JSON.stringify(String(url).includes('/v2/') ? { code: 200, data: [qq] } : { code: 0, data: { songMID: 'wrong', url: base + '/full' } }) }) });
    await rejects(matchCandidates(songReference, malformed), 'no_verified_source');
    console.log('PASS cross-platform fallback: exact singer/title/version/duration required, current QQ link API used, previews rejected, next quality tried, cookies/IP never forwarded');

    let calls = 0, release;
    const engine = createService('/fixture', async () => { calls++; await new Promise(resolve => { release = resolve; }); return { ...verified }; });
    const first = engine.match(1, undefined, { realIP: '198.51.100.1' });
    const second = engine.match(1, undefined, { realIP: '198.51.100.1' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); release();
    const values = await Promise.all([first, second]); values[0].url = 'tampered';
    assert.equal((await engine.match(1, undefined, { realIP: '198.51.100.1' })).url, verified.url);
    const third = engine.match(1, undefined, { realIP: '198.51.100.2' });
    await new Promise(resolve => setImmediate(resolve)); release(); await third; assert.equal(calls, 2);
    const refreshed = engine.match(1, undefined, { realIP: '198.51.100.1', refresh: true });
    await new Promise(resolve => setImmediate(resolve)); release(); await refreshed; assert.equal(calls, 3);
    let failed = 0;
    const failureEngine = createService('/fixture', async () => { failed++; throw new MatchError('no_verified_source'); });
    await rejects(failureEngine.match(1), 'no_verified_source'); await rejects(failureEngine.match(1), 'no_verified_source');
    assert.equal(failed, 2);
    const blocked = [];
    const busy = createService('/fixture', () => new Promise(resolve => blocked.push(() => resolve(verified))));
    const jobs = [1, 2, 3, 4].map(id => busy.match(id));
    await new Promise(resolve => setImmediate(resolve));
    await rejects(busy.match(5), 'matching_busy'); blocked.forEach(fn => fn()); await Promise.all(jobs);
    await rejects(engine.match('1,2'), 'invalid_id'); await rejects(engine.match(1, '../file'), 'invalid_source');
    console.log('PASS bounded service: identical requests merged, IP isolation, refresh, cache mutation protection, failed results retryable, concurrency cap and input validation');

    const query = { id: '186001', level: 'lossless', unblock: 'true', realIP: '198.51.100.1', source: 'unm' };
    const jobsSeen = [];
    const fake = { match: async (...args) => { jobsSeen.push(args); if (args[3]) throw new MatchError('not_audio'); return verified; } };
    const official = async args => { assert.equal(args.unblock, 'false'); return { status: 200, body: { data: [{ url: 'https://audio.example.test/error.html' }] } }; };
    const direct = await matchEndpoint('/fixture', fake)(query);
    assert.equal(direct.body.data, verified.url); assert.equal(direct.body.matchInfo.durationMs, 299000);
    assert.equal(jobsSeen[0][1], 'unm'); assert.equal(jobsSeen[0][2].realIP, query.realIP);
    const v1 = await wrapPlayback(official, '/fixture', false, fake)(query);
    assert.equal(v1.body.data[0].type, 'mp3'); assert.equal(v1.body.data[0].level, 'matched');
    assert.equal(v1.body.data[0].requestedLevel, 'lossless');
    const redirected = await wrapPlayback(async () => ({ status: 200, body: { data: [] } }), '/fixture', true, fake)(query);
    assert.equal(redirected.status, 302); assert.equal(redirected.redirectUrl, verified.url);
    const failedEndpoint = await matchEndpoint('/fixture', failureEngine)(query);
    assert.equal(failedEndpoint.status, 502); assert.equal(failedEndpoint.body.data, null);
    const ordinary = { status: 200, body: { data: [{ url: verified.url }] } };
    assert.equal(await wrapPlayback(async () => ordinary, '/fixture', false, fake)({ ...query, unblock: 'false' }), ordinary);
    let batchSeen;
    const batch = wrapPlayback(async args => { batchSeen = args; return ordinary; }, '/fixture', false, fake);
    assert.equal(await batch({ ...query, id: '1,2' }), ordinary);
    assert.equal(batchSeen.unblock, 'false');
    console.log('PASS API contracts: single source and user IP preserved, raw match returns validated metadata, v1 reports actual quality, 302 honors unblock and all-source failure returns 502');
    console.log('Fixture transfer total:', transferred, 'bytes');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
