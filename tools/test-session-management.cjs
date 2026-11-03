// CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-session-management.cjs
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = 'https://music.20110208.xyz';
const user = { id: 1, username: 'fixture', nickname: '设备管理测试', stat: {} };
const devices = count => Array.from({ length: count }, (_, i) => ({
  id: i.toString(16).padStart(16, '0'), device: `测试设备 ${i}`, platform: i % 2 ? 'app' : 'web',
  current: i === 0, createdAt: 1700000000, lastSeen: 1700000000,
}));

async function fixture(browser, { width = 390, dark = false, station = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage(), errors = [];
  let sessions = devices(5), fail = false;
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ dark, user }) => {
    localStorage.setItem('cm.recReset', 'rec-1.28.74');
    localStorage.setItem('cm.theme', dark ? 'dark' : 'light');
    for (const prefix of ['cm', 'csstation']) {
      localStorage.setItem(prefix + '.token', 'fixture-session');
      localStorage.setItem(prefix + '.user', JSON.stringify(user));
    }
  }, { dark, user });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url()), method = route.request().method();
    if (u.pathname === '/station') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(root, 'backend/station.html'), 'utf8').replaceAll('{{BASE}}', base) });
    if (u.pathname.startsWith('/app/')) {
      const file = path.join(root, 'app/src/main/assets/www', u.pathname.slice(5) || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
    }
    if (u.pathname === '/cm/auth/sessions' && method === 'GET') {
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
      return route.fulfill({ json: { max: null, sessions } });
    }
    if (u.pathname === '/cm/auth/sessions/others' && method === 'DELETE') {
      const removed = sessions.length - 1; sessions = sessions.filter(s => s.current);
      return route.fulfill({ json: { ok: true, removed } });
    }
    if (u.pathname.startsWith('/cm/auth/sessions/') && method === 'DELETE') {
      sessions = sessions.filter(s => s.id !== u.pathname.split('/').pop());
      return route.fulfill({ json: { ok: true } });
    }
    if (u.pathname === '/cm/auth/me') return route.fulfill({ json: user });
    if (u.pathname === '/cm/bootstrap') return route.fulfill({ json: { me: user, recent: { songs: [] } } });
    return route.fulfill({ json: { announcements: [], grants: [], apps: [], playlists: [], sessions: [], groups: [], endpoints: [] } });
  });
  await page.goto(base + (station ? '/station#/security' : '/app/#/settings/account/security'));
  if (!station) await page.locator('#boot').waitFor({ state: 'detached' });
  return { page, context, errors, setCount(count) { sessions = devices(count); }, fail() { fail = true; } };
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440]) for (const dark of [false, true]) {
      const f = await fixture(browser, { width, dark }), { page } = f;
      await page.waitForFunction(() => document.getElementById('devCount')?.textContent === '5 台');
      await page.locator('#devices').click();
      let dialog = page.locator('mdui-dialog').filter({ has: page.locator('.cm-devs') });
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.locator('.cm-dev').count(), 5);
      assert.equal(await dialog.locator('.cm-dev-risk').isVisible(), false);
      assert.equal(await dialog.getAttribute('headline'), '登录设备（5 台）');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      f.setCount(6);
      await page.locator('#devices').click();
      dialog = page.locator('mdui-dialog').filter({ has: page.locator('.cm-devs') });
      await dialog.locator('.cm-dev-risk').waitFor({ state: 'visible' });
      assert((await dialog.locator('.cm-dev-risk').innerText()).includes('已登录 6 台设备，超过 5 台'));
      assert.equal(await dialog.locator('.cm-dev').count(), 6);
      assert.equal(await dialog.locator('.cm-dev-kick').count(), 5);
      assert.equal(await dialog.locator('.cm-dev-cur').count(), 1);
      assert(!(await dialog.innerText()).includes('最多'));
      await page.waitForTimeout(350); // Inspect the final colors after the dialog's entry fade.
      await page.screenshot({ path: `/tmp/cm-sessions-${width}-${dark ? 'dark' : 'light'}.png` });
      await dialog.locator('.cm-dev-kick').first().click();
      await page.waitForFunction(() => document.getElementById('devCount').textContent === '5 台');
      assert.equal(await dialog.locator('.cm-dev').count(), 5);
      assert.equal(await dialog.locator('.cm-dev-risk').isVisible(), false);
      assert.equal(await dialog.getAttribute('headline'), '登录设备（5 台）');
      await dialog.getByRole('button', { name: '退出其他设备', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.getElementById('devCount')?.textContent === '1 台');
      await page.locator('#devices').click();
      dialog = page.locator('mdui-dialog').filter({ has: page.locator('.cm-devs') });
      await dialog.waitFor({ state: 'visible' });
      assert.equal(await dialog.locator('.cm-dev-kick').count(), 0);
      assert.equal(await dialog.locator('.cm-dev-cur').count(), 1);
      assert.equal(await dialog.locator('.cm-dev-risk').isVisible(), false);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      f.fail();
      await page.locator('#devices').click();
      await page.waitForFunction(() => document.getElementById('devCount').textContent === '查看');
      assert.equal(await page.locator('.cm-devs').count(), 0, 'failed fetch must not show stale device data');
      assert.deepEqual(f.errors, []);
      console.log('PASS device management: 5/6 threshold, single/bulk logout, current device, live warning/count updates and load failure:', width, dark ? 'dark' : 'light');
      await f.context.close();
    }

    const f = await fixture(browser, { station: true }), { page } = f;
    await page.waitForFunction(() => document.getElementById('sessCount').textContent === '5 台在线');
    assert.equal(await page.locator('#sessionRisk').isVisible(), false);
    f.setCount(6);
    await page.reload();
    await page.locator('#sessionRisk').waitFor({ state: 'visible' });
    assert((await page.locator('#sessionRisk').innerText()).includes('已登录 6 台设备，超过 5 台'));
    await page.locator('[data-sid]').first().click();
    await page.waitForFunction(() => document.getElementById('sessCount').textContent === '5 台在线');
    assert.equal(await page.locator('#sessionRisk').isVisible(), false);
    page.on('dialog', d => d.accept());
    await page.locator('#kickOthers').click();
    await page.waitForFunction(() => document.getElementById('sessCount').textContent === '1 台在线');
    assert.equal(await page.locator('#sessions [data-sid]').count(), 0);
    assert.deepEqual(f.errors, []);
    console.log('PASS station console: unlimited count, risk threshold and retained single/bulk device controls');
    await f.context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
