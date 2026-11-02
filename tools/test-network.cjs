// Run: node tools/test-network.cjs. No live accounts or production data.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('../web/node_modules/esbuild');
function setup(entry = 'network') {
  const code = buildSync({ entryPoints: [`web/src/${entry}.js`], bundle: true, format: 'cjs', write: false }).outputFiles[0].text;
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: k => map.get(k) || null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) });
  const context = { module: { exports: {} }, URL, URLSearchParams, AbortController, performance, setTimeout, clearTimeout,
    localStorage: storage(local), sessionStorage: storage(session), window: {}, location: new URL('https://music.20110208.xyz/app/'),
    navigator: {}, fetch: () => { throw Error('unexpected fetch'); } };
  vm.runInNewContext(code, context);
  return { api: context.module.exports, context, local, session };
}
(async () => {
  const { api: n, context: c, local, session } = setup();
  n.network.key = 'test-key'; assert(!local.has('cm.leizKey')); assert.equal(session.get('cm.leizKey'), 'test-key');
  n.network.key = ''; assert.equal(session.size, 0);
  const requests = [];
  c.fetch = async (url, opts) => { requests.push(opts); return {ok:true,json: async () => ({service:'wrong',ok:true})}; };
  assert.equal((await n.probeMirror('https://example.test')).ok, false);
  assert.equal(requests.length, 2); assert(requests.every(r => r.credentials === 'omit' && !r.headers));
  c.fetch = async () => ({ok:true,json:async()=>({service:'CurrentMusic',ok:true})});
  assert.equal((await n.probeMirror('https://example.test')).successes, 2);
  for (const [ok, type] of [[false, 'audio/mpeg'], [true, 'text/html']]) {
    c.fetch = async () => ({ok,headers:{get:()=>type}});
    assert.equal((await n.probeMedia('https://example.test/a')).ok, false);
  }
  let reads = 0, cancelled = 0;
  c.fetch = async (url, opts) => {
    assert.equal(opts.credentials,'omit'); assert.equal(opts.headers.Range,'bytes=0-262143'); assert(!opts.headers.Authorization);
    return {ok:true,headers:{get:()=> 'audio/mpeg'},body:{getReader:()=>({read:async()=> {reads++;return {done:false,value:new Uint8Array(131072)};}, cancel:async()=>{cancelled++;}})}};
  };
  const result = await n.probeMedia('https://example.test/a');
  assert(result.ok); assert.equal(reads,2); assert.equal(cancelled,1); assert.equal(result.bytes,262144);
  const info={host:'m7.music.test',hosts:['m8.music.test'],url:'https://m7.music.test/a?signature=keep'};
  n.lineBest.byFam.f2='m8.music.test';
  assert.equal(n.swapLine(info),'https://m8.music.test/a?signature=keep');
  n.network.cdn='unverified.test'; assert.equal(n.swapLine(info),null);
  n.network.cdn='original'; assert.equal(n.swapLine(info),null);
  n.network.cdn='auto';
  c.fetch = async()=>({ok:false,headers:{get:()=> 'audio/mpeg'}});
  await n.probeLines(info,true); assert.equal(n.lineBest.byFam.f2,undefined);
  const { api:s, context:sc, local:sl, session:ss }=setup('songurl');
  sl.set('cm.audioProvider','leiz'); ss.set('cm.leizKey','example-key'); sl.set('cm.token','private-site-token');
  let request;
  sc.fetch=async(url,opts)=>{request={url,opts};return {ok:true,json:async()=>({success:true,data:{url:'https://audio.test/music.mp3',level:'jymaster'}})}};
  assert.equal((await s.resolveSongUrl({ncm_id:1},'auto')).url,'https://audio.test/music.mp3');
  assert(request.url.includes('level=jymaster')); assert.equal(request.opts.headers['x-api-key'],'example-key');
  assert(!request.opts.headers.Authorization); assert.equal(request.opts.credentials,'omit'); assert.equal(request.opts.redirect,'error');
  sc.fetch=async()=>({ok:false,status:403});
  await assert.rejects(s.resolveSongUrl({ncm_id:1},'auto'), e => /Key/.test(e.message) && e.noAutoNext === true);
  sc.fetch=async()=>({ok:true,json:async()=>({success:true,data:{url:'http://audio.test/insecure'}})});
  await assert.rejects(s.resolveSongUrl({ncm_id:1},'auto'),/HTTPS/);
  sc.fetch=async()=>{sl.set('cm.audioProvider','currentmusic'); return {ok:true,json:async()=>({success:true,data:{url:'https://audio.test/music'}})}};
  await assert.rejects(s.resolveSongUrl({ncm_id:1},'auto'),/设置已改变/);
  console.log('PASS: mirror identity, partial reads and cancellation, HTTP/MIME failures, verified CDN switching, stale source rejection, LeiZ credentials isolated and errors preserved');
})().catch(e=>{console.error(e);process.exitCode=1;});
