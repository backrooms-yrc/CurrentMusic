// Run: node tools/test-api-transport.cjs (uses the existing web esbuild dependency).
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('../web/node_modules/esbuild');
const code = buildSync({entryPoints:[require.resolve('../web/src/api.js')], bundle:true,
  format:'cjs', write:false}).outputFiles[0].text;

function setup(host, stored = {}, native = false) {
  const requests = [];
  const values = new Map(Object.entries(stored));
  const context = {
    module: { exports: {} }, exports: {}, URL, URLSearchParams, Map, JSON,
    window: native ? { NativeApi: { http() {} } } : {},
    location: new URL('https://' + host + '/app/'),
    navigator: { userAgent: 'transport-test' },
    localStorage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) },
    fetch: async (url, options) => { requests.push({url, ...options}); return { ok: true, json: async () => ({ok:true}) }; },
  };
  vm.runInNewContext(code, context);
  return { ...context.module.exports, requests };
}

(async () => {
  for (const host of ['music.20110208.xyz','music.ctcehs.com','currentmusic.geekertao.com','cm.bileizhen.top']) {
    const t = setup(host);
    await t.call('GET', '/announcements');
    assert.equal(t.requests[0].url, 'https://' + host + '/cm/announcements');
    assert.equal(t.requests[0].headers['Content-Type'], undefined);
    assert.equal(t.requests[0].body, undefined);
  }
  assert.equal(setup('cm.local', {}, true).settings.base, 'https://music.20110208.xyz/cm');
  assert.equal(setup('unconfigured.example').settings.base, 'https://music.20110208.xyz/cm');
  const t = setup('music.ctcehs.com', {'cm.base':'https://custom.example/cm','cm.token':'test-session'});
  await t.call('POST', '/profile', {body:{nickname:'test'},auth:true});
  assert.equal(t.requests[0].url, 'https://custom.example/cm/profile');
  assert.equal(t.requests[0].headers['Content-Type'], 'application/json');
  assert.equal(t.requests[0].headers.Authorization, 'Bearer test-session');
  assert.equal(t.requests[0].body, '{"nickname":"test"}');
  console.log('PASS: four same-origin entrances, bodyless GET, JSON writes, authentication and explicit/Android fallback');
})().catch(error => { console.error(error); process.exitCode = 1; });
