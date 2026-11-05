// Same Playwright/Chromium environment variables as test-cmx-desktop.cjs.
// All account data lives in a throwaway backend/database, never production.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = 'https://music.20110208.xyz/app/';
const controls = buildSync({ stdin: { resolveDir: root, contents: `
  export * from './web/src/search-history.js'; export {auth} from './web/src/api.js';
  import './web/node_modules/mdui/mdui.css'; import './web/node_modules/@material-design-icons/font/outlined.css';
  import './web/src/apple-hig.css'; import './web/src/app.css';
  export {render} from './web/src/pages/search.js';
` }, bundle: true, format: 'iife', globalName: 'HistoryTest', write: false, outfile: 'fixture.js',
  loader: { '.png': 'dataurl', '.svg': 'text', '.woff2': 'file' }, logLevel: 'silent' }).outputFiles;

async function backend() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-search-history-'));
  const child = spawn('python3', ['-u', '-c', `
import json, sys
sys.path.insert(0, 'backend')
import cm_db, cm_server
cm_db.init()
cm_server.cm_region.note = lambda *args: None
uid = cm_db.create_user('history', 'fixture-password', 'History')
other = cm_db.create_user('other', 'fixture-password', 'Other')
server = cm_server.ThreadingHTTPServer(('127.0.0.1', 0), cm_server.Handler)
print(json.dumps({'origin': 'http://127.0.0.1:' + str(server.server_port),
 'a': cm_db.issue_token(uid, 'Device A'), 'b': cm_db.issue_token(uid, 'Device B'),
 'other': cm_db.issue_token(other, 'Other account')}), flush=True)
server.serve_forever()
`], { cwd: root, env: { ...process.env, CM_DB: path.join(tmp, 'test.db'), CM_DATA_DIR: tmp } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const info = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (const line of buffer.split('\n')) if (line.startsWith('{')) {
        try { resolve(JSON.parse(line)); } catch { /* Wait for the complete line. */ }
      }
    });
    child.once('exit', code => reject(Error(`Temporary backend exited ${code}: ${stderr}`)));
    child.once('error', reject);
  });
  return { ...info, async close() { child.kill(); await new Promise(resolve => child.once('exit', resolve)); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

async function device(browser, server, token, { width = 1440, legacy = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
  const errors = [];
  let offline = false, holdRead = null;
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ token, legacy }) => {
    if (token) { localStorage.setItem('cm.token', token); localStorage.setItem('cm.user', JSON.stringify({ username: 'history' })); }
    localStorage.setItem('cm.searchHistory', JSON.stringify(legacy));
  }, { token, legacy });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()), name = u.pathname.split('/').pop();
    if (u.pathname.startsWith('/cm/search/history')) {
      if (offline) return route.abort('internetdisconnected');
      const response = await route.fetch({ url: server.origin + u.pathname.slice(3) + u.search });
      if (route.request().method() === 'GET' && holdRead) {
        const gate = holdRead; holdRead = null; gate.started(); await gate.done;
      }
      return route.fulfill({ response });
    }
    const file = controls.find(f => path.basename(f.path) === name);
    if (file) return route.fulfill({ body: Buffer.from(file.contents), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' });
    if (u.pathname === '/app/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html data-ui-preset="cmx"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><main id="out"></main><div id="sheets"></div><script src="fixture.js"></script></html>` });
    return route.fulfill({ json: {} });
  });
  await page.goto(base);
  await page.evaluate(() => HistoryTest.render(document.getElementById('out')));
  await page.evaluate(() => HistoryTest.syncSearchHistory());
  return { context, page, errors, offline(value) { offline = value; }, holdNextRead() {
    let release, started;
    const done = new Promise(r => { release = r; }), ready = new Promise(r => { started = r; });
    holdRead = { done, started }; return { release, ready };
  } };
}
const history = page => page.evaluate(() => HistoryTest.searchHistory());
const sync = page => page.evaluate(() => HistoryTest.syncSearchHistory());
const add = (page, keyword) => page.evaluate(keyword => { HistoryTest.recordSearch(keyword); return HistoryTest.syncSearchHistory(); }, keyword);

(async () => {
  const server = await backend();
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  const devices = [];
  try {
    const a = await device(browser, server, server.a, { legacy: ['旧历史', '更早历史'] }); devices.push(a);
    const b = await device(browser, server, server.b, { width: 390, legacy: ['其他旧设备'] }); devices.push(b);
    assert.deepEqual(await history(a.page), ['旧历史', '更早历史']);
    assert.deepEqual(await history(b.page), ['旧历史', '更早历史']);
    await a.page.locator('#kw').evaluate(input => {
      input.value = '电脑搜索'; input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sync(a.page);
    assert.equal((await history(a.page)).includes('电脑搜索'), false, 'typing a suggestion must not record a search');
    await Promise.all([a.page.locator('#kw').evaluate(input => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return HistoryTest.syncSearchHistory();
    }), add(b.page, '手机搜索')]);
    await sync(a.page); await sync(b.page);
    assert.deepEqual(await history(a.page), await history(b.page));
    assert((await history(a.page)).includes('电脑搜索') && (await history(a.page)).includes('手机搜索'));
    await a.page.locator('.cm-hist-x[data-x="旧历史"]').click(); await sync(a.page);
    await b.page.evaluate(() => window.dispatchEvent(new Event('focus'))); await sync(b.page);
    assert.equal((await history(b.page)).includes('旧历史'), false);
    await b.page.locator('#clearHist').click(); await sync(b.page); await sync(a.page);
    assert.deepEqual(await history(a.page), []);
    const old = await device(browser, server, server.a, { legacy: ['旧历史'] }); devices.push(old);
    assert.deepEqual(await history(old.page), [], 'a stale device import must not restore cleared history');
    console.log('PASS two real sessions share one history; concurrent devices, delete, clear, focus refresh and once-only legacy migration');

    a.offline(true);
    await add(a.page, '离线搜索');
    assert.deepEqual(await history(a.page), ['离线搜索']);
    await a.page.reload();
    await a.page.evaluate(() => HistoryTest.render(document.getElementById('out')));
    assert.deepEqual(await history(a.page), ['离线搜索'], 'pending edits survive offline reload');
    a.offline(false);
    await a.page.evaluate(() => window.dispatchEvent(new Event('online'))); await sync(a.page); await sync(b.page);
    assert.deepEqual(await history(b.page), ['离线搜索']);
    const held = a.holdNextRead();
    await a.page.evaluate(() => { void HistoryTest.syncSearchHistory(); }); await held.ready;
    await a.page.evaluate(token => HistoryTest.auth.saveLogin(token, { username: 'other' }), server.other);
    await sync(a.page);
    assert.deepEqual(await history(a.page), []);
    held.release(); await a.page.waitForTimeout(100);
    assert.deepEqual(await history(a.page), [], 'old-account response must never appear after switching');
    await add(a.page, '另一个账号'); await sync(b.page);
    assert.deepEqual(await history(b.page), ['离线搜索']);
    await a.page.evaluate(token => HistoryTest.auth.saveLogin(token, { username: 'history' }), server.a); await sync(a.page);
    assert.deepEqual(await history(a.page), ['离线搜索']);
    console.log('PASS offline retry/reload, account isolation and switching during a delayed response');

    const guest = await device(browser, server, '', { legacy: ['游客搜索'] }); devices.push(guest);
    await add(guest.page, '未登录新搜索');
    assert.deepEqual(await history(guest.page), ['未登录新搜索', '游客搜索']);
    await sync(b.page); assert.deepEqual(await history(b.page), ['离线搜索']);
    for (const f of devices) assert.deepEqual(f.errors, []);
    console.log('PASS guest history stays local, desktop/mobile UI and no browser errors');
  } finally {
    for (const f of devices) await f.context.close();
    await browser.close(); await server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
