// CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-top-account.cjs
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = 'https://music.20110208.xyz/app/';
const controls = buildSync({ stdin: { contents: "export {auth, api} from './web/src/api.js';", resolveDir: root }, bundle: true, format: 'iife', globalName: 'AccountTest', write: false }).outputFiles[0].text;
const user = { id: 1, username: 'fixture', nickname: '音乐朋友', avatar: 'fixture.png', avatarDecoration: 'fixture', isOwner: true, isSuper: true, isAdmin: true, stat: {} };
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" rx="60" fill="#6750a4"/><circle cx="60" cy="42" r="20" fill="#fff"/><path d="M24 100a36 36 0 0 1 72 0" fill="#fff"/></svg>';
const decoration = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="56" fill="none" stroke="#edb64a" stroke-width="7"/></svg>';

async function fixture(browser, { width = 390, height = 844, preset = 'cmx', reduced = false, stored = false, fallback = false, broken = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let currentUser = { ...user }, delayMe = 0;
  await page.addInitScript(({ preset, stored, fallback, user }) => {
    localStorage.setItem('cm.recReset', 'rec-1.28.74');
    localStorage.setItem('cm.uiPreset', preset);
    if (stored) { localStorage.setItem('cm.token', 'fixture-session'); localStorage.setItem('cm.user', JSON.stringify(user)); }
  }, { preset, stored, fallback, user });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/app/')) {
      const file = path.join(root, 'app/src/main/assets/www', u.pathname.slice(5) || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
    }
    if (u.pathname.startsWith('/cm/avatar/') || u.pathname.startsWith('/cm/decor/')) {
      if (broken) return route.abort();
      return route.fulfill({ contentType: 'image/svg+xml', body: u.pathname.includes('/decor/') ? decoration : picture });
    }
    if (u.pathname === '/cm/auth/login') return route.fulfill({ json: { token: 'fixture-session', user: currentUser } });
    if (u.pathname === '/cm/auth/me') {
      const response = currentUser;
      if (delayMe) await new Promise(resolve => setTimeout(resolve, delayMe));
      return route.fulfill({ json: response });
    }
    return route.fulfill({ json: { announcements: [], playlists: [], songs: [], artists: [], decorations: [], data: [] } });
  });
  await page.goto(base + (stored ? '#/settings' : '#/user'));
  await page.locator('#boot').waitFor({ state: 'detached' });
  await page.addScriptTag({ content: controls });
  if (fallback) await page.locator('#topAccount').evaluate(account => { account.animate = undefined; });
  return { page, context, errors, setUser(value) { currentUser = value; }, delayMe(value) { delayMe = value; } };
}

async function login(page) {
  await page.locator('#go').waitFor();
  await page.evaluate(() => { document.getElementById('fUser').value = 'fixture'; document.getElementById('fPass').value = 'fixture-password'; document.getElementById('go').click(); });
}

async function landed(page, role = '站长') {
  await page.waitForFunction(() => {
    const a = document.getElementById('topAccount');
    return !a.hidden && !a.classList.contains('cm-account-flying') && !a.classList.contains('cm-account-arriving');
  });
  const geometry = await page.evaluate(() => {
    const a = document.querySelector('#topAccount .cm-top-avatar').getBoundingClientRect();
    const title = document.getElementById('pageTitle').getBoundingClientRect();
    const acts = document.getElementById('topActs').getBoundingClientRect();
    return { x: a.x + a.width / 2, width: innerWidth, y: a.y, titleRight: title.right, actsLeft: acts.left, avatarLeft: a.left, avatarRight: a.right };
  });
  assert(Math.abs(geometry.x - geometry.width / 2) < 1, 'avatar must stay at viewport center');
  assert(geometry.y >= 0 && geometry.y < 100);
  assert(geometry.titleRight < geometry.avatarLeft, 'title must leave room for avatar and decoration');
  assert(geometry.actsLeft > geometry.avatarRight, 'actions must leave room for avatar and decoration');
  assert.equal((await page.locator('#topAccount .cm-top-tags').innerText()).trim(), role);
  assert.equal(await page.locator('#topAccount .cm-decor img').count(), 1);
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const preset of ['cmx', 'md3', 'glass', 'frost']) {
      for (const width of [390, 1440]) {
        const f = await fixture(browser, { preset, width }), { page } = f;
        await login(page);
        await page.waitForFunction(() => document.getElementById('topAccount').classList.contains('cm-account-flying'));
        await page.evaluate(() => { const a = document.getElementById('topAccount').getAnimations()[0]; a.pause(); a.currentTime = 500; });
        const center = await page.locator('#topAccount .cm-top-avatar').boundingBox();
        assert(Math.abs(center.x + center.width / 2 - width / 2) < 1);
        assert(Math.abs(center.y + center.height / 2 - 422) < 1, 'avatar must appear at screen center');
        assert(center.width > 80, 'login avatar must float at a larger size');
        if (preset === 'cmx') await page.screenshot({ path: `/tmp/cm-account-center-${width}.png` });
        await page.evaluate(() => document.getElementById('topAccount').getAnimations()[0].play());
        await landed(page);
        if (preset === 'cmx') await page.screenshot({ path: `/tmp/cm-account-top-${width}.png` });
        await page.evaluate(() => { window.accountNode = document.getElementById('topAccount'); location.hash = '#/settings'; });
        await page.locator('#pageTitle').getByText('设置', { exact: true }).waitFor();
        assert(await page.evaluate(() => accountNode === document.getElementById('topAccount')));
        await landed(page);
        await page.evaluate(() => { document.getElementById('out').scrollTop = 100; document.getElementById('out').dispatchEvent(new Event('scroll')); });
        await landed(page);
        assert.deepEqual(f.errors, []);
        console.log('PASS login center/flight, persistent viewport-centered decorated avatar, owner precedence, route/scroll and collision checks:', preset, width);
        await f.context.close();
      }
    }
    const f = await fixture(browser, { stored: true, width: 320 }), { page } = f;
    await landed(page);
    assert.equal(await page.locator('.cm-account-flying').count(), 0, 'restored login must not replay arrival');
    for (const [fields, role] of [[{ isSuper: true, isAdmin: true }, '超级管理员'], [{ isAdmin: true }, '管理员'], [{}, '']]) {
      const updated = { ...user, isOwner: false, isSuper: false, isAdmin: false, ...fields, avatar: 'changed.png', avatarDecoration: 'changed' };
      f.setUser(updated);
      await page.evaluate(u => AccountTest.auth.updateUser(u, AccountTest.auth.token), updated);
      await landed(page, role);
      assert.equal(await page.locator('.cm-account-flying').count(), 0, 'profile refresh must not replay arrival');
      assert((await page.locator('#topAccount .cm-avatar').getAttribute('src')).includes('changed.png'));
    }
    await page.locator('#topAccount').click();
    await page.waitForFunction(() => location.hash === '#/user');
    // A late profile response for account A must never overwrite account B.
    f.delayMe(350);
    await page.evaluate(() => { window.oldProfile = AccountTest.api.me(); });
    await page.waitForTimeout(80);
    const other = { id: 2, username: 'other', nickname: '另一个账号', stat: {} };
    await page.evaluate(u => { AccountTest.auth.clear(); AccountTest.auth.saveLogin('other-fixture-session', u); }, other);
    await page.evaluate(() => oldProfile);
    assert.equal(await page.evaluate(() => AccountTest.auth.user.username), 'other');
    await page.evaluate(() => AccountTest.auth.clear());
    assert.equal(await page.locator('#topAccount').isVisible(), false);
    assert.equal(await page.locator('.cm-account-flying, .cm-account-arriving').count(), 0);
    assert.equal(await page.locator('body.cm-has-account').count(), 0);
    assert.deepEqual(f.errors, []);
    console.log('PASS restored session, narrow layout, roles, avatar/decoration refresh, account navigation, stale response protection and logout during animation');
    await f.context.close();

    const resized = await fixture(browser, { width: 240, height: 240 });
    await login(resized.page);
    await resized.page.waitForFunction(() => document.getElementById('topAccount').classList.contains('cm-account-flying'));
    await resized.page.setViewportSize({ width: 360, height: 780 });
    await landed(resized.page);
    await resized.page.evaluate(() => document.documentElement.style.setProperty('--safe-t', '24px'));
    await landed(resized.page);
    assert((await resized.page.locator('#topAccount .cm-top-avatar').boundingBox()).y >= 24);
    assert.deepEqual(resized.errors, []);
    console.log('PASS watch layout, keyboard/viewport resize during arrival and safe-area inset');
    await resized.context.close();

    for (const options of [{ reduced: true }, { fallback: true }, { broken: true }]) {
      const f = await fixture(browser, options);
      await login(f.page);
      await landed(f.page);
      if (!options.broken) assert.equal(await f.page.locator('.cm-account-flying').count(), 0);
      assert.deepEqual(f.errors, []);
      console.log('PASS accessible/fallback login:', options);
      await f.context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
