import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest, downloadTarget, handleRequest, RequestGuard, signRequest } from '../src/worker.js';

const now = 1791288000;
const asset = 'https://updates.bileizhen.top/download/v1.1.1/CurrentMusic-Android-v1.1.1.apk';
const secret = 'fixture-secret-never-used-in-production-0123456789';
function storageFixture() {
  const items = new Map();
  let alarm = null;
  const storage = {
    async get(key) { return items.get(key); }, async put(key, value) { items.set(key, value); },
    async delete(keys) { for (const key of keys) items.delete(key); }, async list() { return new Map(items); },
    async transaction(fn) { return fn(storage); }, async getAlarm() { return alarm; }, async setAlarm(value) { alarm = value; }
  };
  return storage;
}
function environment() {
  const guard = new RequestGuard({ storage: storageFixture() });
  return { APP_SECRET: secret, APP_KEY_ID: 'update-v1', REQUEST_GUARD: {
    idFromName: name => name, get: () => ({ fetch: (url, options) => guard.fetch(new Request(url, options)) })
  } };
}
async function signed(url = asset, overrides = {}) {
  const headers = new Headers({ 'X-CurrentMusic-App': 'com.bileizhen.currentmusic', 'X-CurrentMusic-Key-Id': 'update-v1',
    'X-CurrentMusic-Timestamp': String(now), 'X-CurrentMusic-Nonce': '1234567890abcdef1234567890abcdef', 'CF-Connecting-IP': '192.0.2.1', ...overrides });
  const request = new Request(url, { headers });
  headers.set('X-CurrentMusic-Signature', await signRequest(request, secret));
  return new Request(url, { headers });
}
test('only the exact CurrentMusic native asset/version is allowed', () => {
  assert.equal(downloadTarget(new URL(asset)).href, 'https://github.com/bileizhen/CurrentMusicX/releases/download/v1.1.1/CurrentMusic-Android-v1.1.1.apk');
  for (const path of ['/download/v1.1.1/other.apk', '/download/v1.1.1/CurrentMusic-Android-v1.1.0.apk', '/https://github.com/other/repo', '/download/v1.1.1/CurrentMusic-Android-v1.1.1.apk?q=x']) {
    assert.equal(downloadTarget(new URL('https://updates.bileizhen.top' + path)), null);
  }
});
test('browser, missing secret, expired credentials and modified range never reach GitHub', async () => {
  const env = environment();
  const fetcher = () => assert.fail('Unauthorized request reached upstream');
  assert.equal((await handleRequest(new Request(asset), env, { now, fetcher })).status, 403);
  assert.equal((await handleRequest(await signed(), { ...env, APP_SECRET: '' }, { now, fetcher })).status, 503);
  assert.equal((await handleRequest(await signed(asset, { 'X-CurrentMusic-Timestamp': String(now - 121) }), env, { now, fetcher })).status, 403);
  const tampered = await signed(); tampered.headers.set('Range', 'bytes=0-31');
  assert.equal((await handleRequest(tampered, env, { now, fetcher })).status, 403);
});
test('signed streaming download follows only GitHub CDN and strips all application credentials', async () => {
  const request = await signed(asset, { Cookie: 'private', Authorization: 'Bearer fixture', Range: 'bytes=0-31' });
  const seen = [];
  const response = await handleRequest(request, environment(), { now, fetcher: async (url, init) => {
    seen.push(url);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('X-CurrentMusic-Signature'), null);
    assert.equal(init.headers.get('Cookie'), null); assert.equal(init.headers.get('Authorization'), null);
    assert.equal(init.headers.get('Range'), 'bytes=0-31');
    if (seen.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/file?sig=fixture' } });
    return new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 206, headers: { 'Content-Length': '4', 'Content-Range': 'bytes 0-3/4' } });
  } });
  assert.equal(response.status, 206); assert.equal(seen.length, 2);
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-3/4');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0x50, 0x4b, 3, 4]);
});
test('arbitrary redirects, errors and upstream HTML are rejected', async () => {
  for (const upstream of [new Response(null, { status: 302, headers: { Location: 'https://example.com/file.apk' } }),
    new Response('error', { status: 429 }), new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    assert.equal((await handleRequest(await signed(), environment(), { now, fetcher: async () => upstream })).status, 502);
  }
});
test('replayed requests and per-IP floods are denied', async () => {
  const env = environment();
  const fetcher = async () => new Response(null, { headers: { 'Content-Length': '4' } });
  const request = await signed();
  assert.equal((await handleRequest(request, env, { now, fetcher })).status, 200);
  assert.equal((await handleRequest(request, env, { now, fetcher })).status, 409);
  for (let index = 1; index < 48; index++) {
    const next = await signed(asset, { 'X-CurrentMusic-Nonce': index.toString(16).padStart(32, '0') });
    assert.equal((await handleRequest(next, env, { now, fetcher })).status, 200);
  }
  const next = await signed(asset, { 'X-CurrentMusic-Nonce': 'f'.repeat(32) });
  assert.equal((await handleRequest(next, env, { now, fetcher })).status, 429);
});
test('fixed request signing vector matches the Android protocol', async () => {
  const request = await signed();
  assert.equal(canonicalRequest(request), ['v1', 'GET', 'updates.bileizhen.top', '/download/v1.1.1/CurrentMusic-Android-v1.1.1.apk', '',
    'com.bileizhen.currentmusic', 'update-v1', String(now), '1234567890abcdef1234567890abcdef'].join('\n'));
  assert.equal(request.headers.get('X-CurrentMusic-Signature'), '00eba3480896867cd816287b9051077258364fd7c15b626a047c05e28a29ef70');
});
