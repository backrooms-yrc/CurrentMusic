// Uses the same Playwright/Chromium environment variables as test-page-motion.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..'), base = 'https://music.20110208.xyz/app/';
const user = { id: 1, username: 'fixture', nickname: '音乐朋友', stat: { likes: 1 } };
const songs = [101, 102].map(ncm_id => ({ ncm_id, name: `歌曲 ${ncm_id}`, artists: '测试歌手', duration: 180000 }));
function gate() { let release; const done = new Promise(resolve => { release = resolve; }); return { done, release }; }

async function fixture(browser, { width = 1440, dark = false, reduced = false, failStatus = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? 'dark' : 'light',
    reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage(), errors = [], status = gate(), binding = gate(), likes = gate(), oldSearch = gate();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ user }) => {
    localStorage.setItem('cm.recReset', 'rec-1.28.74'); localStorage.setItem('cm.uiPreset', 'cmx');
    localStorage.setItem('cm.token', 'fixture-session'); localStorage.setItem('cm.user', JSON.stringify(user));
  }, { user });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/app/')) {
      const file = path.join(root, 'app/src/main/assets/www', u.pathname.slice(5) || 'index.html');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return route.fulfill({ path: file });
    }
    if (u.pathname === '/cm/auth/me') return route.fulfill({ json: user });
    if (u.pathname === '/cm/playlists/11') return route.fulfill({ json: { id: 11, name: '桌面测试歌单', user_id: 1, tracks: songs } });
    if (u.pathname === '/cm/likes/mine') return route.fulfill({ json: { songs } });
    if (u.pathname === '/cm/likes/101') return route.fulfill({ json: { on: true } });
    if (u.pathname === '/cm/ncm/playlist') return route.fulfill({ json: { name: '网易云测试歌单', songs } });
    if (u.pathname === '/cm/playlists') return route.fulfill({ json: { playlists: [{ id: 11, name: '桌面测试歌单', track_count: 2 }] } });
    if (u.pathname === '/cm/songs/status') {
      await status.done;
      return route.fulfill(failStatus ? { status: 503, json: { error: 'fixture unavailable' } }
        : { json: { liked: [], ncmCounts: { 101: 7 } } });
    }
    if (u.pathname === '/cm/ncmbind') { await binding.done; return route.fulfill({ json: { bound: true } }); }
    if (u.pathname === '/cm/ncmbind/likelist') { await likes.done; return route.fulfill({ json: { ids: [101] } }); }
    if (u.pathname === '/cm/ncm/search') {
      const kw = u.searchParams.get('keywords'), type = u.searchParams.get('type');
      if (kw === '旧搜索') await oldSearch.done;
      if (kw === '失败') return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
      return route.fulfill({ json: { [type === 'song' ? 'songs' : type + 's']: kw === '空结果' || type !== 'song' ? []
        : [{ ...songs[0], name: kw }], totals: { [type]: kw === '空结果' ? 0 : 1 }, hasMore: {} } });
    }
    return route.fulfill({ json: {} });
  });
  return { page, context, errors, status, binding, likes, oldSearch };
}

async function search(page, text) {
  await page.locator('#kw').evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }, text);
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const options of [{}, { dark: true }, { width: 900, reduced: true }, { width: 390 }, { failStatus: true }]) {
      const f = await fixture(browser, options), { page } = f;
      try {
        await page.goto(base + '#/pl/11');
        await page.locator('#boot').waitFor({ state: 'detached' });
        // Each optional request remains blocked independently while the tracks and controls work.
        assert.equal(await page.locator('#list .cm-song').count(), 2);
        assert(await page.locator('#playAll').evaluate(el => typeof el.onclick === 'function'));
        await page.evaluate(() => { window.firstRow = document.querySelector('#list .cm-song'); });
        f.status.release();
        await page.waitForTimeout(80);
        assert.equal(await page.locator('#list .cm-song').count(), 2);
        f.binding.release();
        await page.waitForTimeout(80);
        assert.equal(await page.locator('#list .cm-song').count(), 2);
        f.likes.release();
        await page.locator('#list .cm-song-like.on').waitFor();
        assert(await page.evaluate(() => firstRow === document.querySelector('#list .cm-song')));
        if (!options.failStatus) assert.equal(await page.locator('#list .cm-like-n').innerText(), 'favorite7');
        assert.equal(await page.locator('[href="#/library"][aria-current="page"]').count(), 1);

        if ((options.width || 1440) >= 900) {
          await page.locator('[href="#/home"].navItem').hover();
          await page.waitForTimeout(320);
          const checkHint = async selector => {
            const boxes = await page.evaluate(selector => ({
              item: document.querySelector(selector).getBoundingClientRect().toJSON(),
              hint: document.getElementById('navHover').getBoundingClientRect().toJSON(),
              opacity: getComputedStyle(document.getElementById('navHover')).opacity,
            }), selector);
            assert.equal(boxes.opacity, '1');
            assert(Math.abs(boxes.item.y - boxes.hint.y) < 1 && Math.abs(boxes.item.height - boxes.hint.height) < 1);
            assert(boxes.item.height >= 44 && boxes.hint.width <= 76);
          };
          await checkHint('[href="#/home"].navItem');
          await page.locator('[href="#/square"].navItem').hover(); await page.waitForTimeout(320);
          await checkHint('[href="#/square"].navItem');
          assert.equal(await page.locator('[href="#/library"].cur').count(), 1, 'hover must preserve current page');
          if (options.reduced) assert.equal(await page.locator('#navHover').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
          await page.screenshot({ path: `/tmp/cm-x-rail-${options.dark ? 'dark' : options.reduced ? 'reduced' : 'light'}.png` });
          await page.mouse.move(800, 500); await page.waitForTimeout(180);
          assert.equal(await page.locator('#navHover').evaluate(el => getComputedStyle(el).opacity), '0');
          await page.locator('[href="#/library"].navItem').focus();
          await page.keyboard.press('Tab'); await page.waitForTimeout(320);
          await checkHint('[href="#/user"].navItem');
          await page.keyboard.press('Tab');
          await page.setViewportSize({ width: 390, height: 844 });
          assert.equal(await page.locator('#navHover').isVisible(), false);
          await page.setViewportSize({ width: options.width || 1440, height: 900 });
        } else {
          assert.equal(await page.locator('#navHover').isVisible(), false);
          assert(await page.locator('#navDrop').isVisible());
        }

        await page.locator('[href="#/library"].navItem').click();
        await page.locator('#plGrid .cm-plcard').click();
        await page.locator('#list .cm-song').first().waitFor();
        await page.evaluate(() => { location.hash = '#/pl/likes'; });
        await page.locator('#list .cm-song-like .cm-ncmdot').waitFor();
        assert.equal(await page.locator('#list .cm-song-like.on').count(), 0, 'local likes keep their own source');
        await page.evaluate(() => { location.hash = '#/ncmpl/12'; });
        await page.getByText('网易云测试歌单', { exact: true }).waitFor();
        assert.equal(await page.locator('#list .cm-song').count(), 2);

        await page.locator('#topSearch').click(); await page.locator('#kw').waitFor();
        await page.locator('.cm-route-loading').waitFor({ state: 'detached' });
        await search(page, '新搜索');
        await page.locator('.cm-search-loading svg').waitFor();
        assert.equal(await page.locator('.cm-route-loading').count(), 0);
        const initialShape = await page.locator('.cm-search-loading .cm-indicator-morph').evaluate(el => el.getTotalLength());
        const loadingStarted = Date.now();
        await page.waitForTimeout(450);
        if (!options.reduced) {
          const nextShape = await page.locator('.cm-search-loading .cm-indicator-morph').evaluate(el => el.getTotalLength());
          assert(Math.abs(nextShape - initialShape) > 1, 'search indicator must visibly morph while waiting');
        }
        assert.equal(await page.locator('#songList .cm-song').count(), 0, 'instant responses still show the loading cycle');
        await page.locator('#songList .cm-song').waitFor();
        assert(Date.now() - loadingStarted >= 1000);
        await search(page, '旧搜索'); await page.locator('.cm-search-loading').waitFor();
        await search(page, '最新搜索');
        await page.locator('#songList').getByText('最新搜索', { exact: true }).waitFor();
        f.oldSearch.release(); await page.waitForTimeout(200);
        assert.equal(await page.locator('#songList').getByText('旧搜索', { exact: true }).count(), 0);
        await search(page, '空结果'); await page.locator('.cm-search-loading').waitFor();
        await page.getByText('没有找到「空结果」的相关结果', { exact: true }).waitFor();
        await search(page, '失败'); await page.locator('.cm-search-loading').waitFor();
        await page.getByText('搜索失败：fixture unavailable', { exact: true }).waitFor();
        assert.equal(await page.locator('.cm-search-loading').count(), 0);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepEqual(f.errors, []);
        console.log('PASS X rail pointer/focus/current selection, responsive layout, nonblocking playlist/status hydration, local/NetEase lists, search cycle/stale/empty/error:', options);
      } finally {
        f.status.release(); f.binding.release(); f.likes.release(); f.oldSearch.release(); await f.context.close();
      }
    }
    const f = await fixture(browser);
    try {
      f.binding.release(); f.likes.release();
      await f.page.goto(base + '#/pl/likes');
      await f.page.locator('#boot').waitFor({ state: 'detached' });
      await f.page.locator('#list .cm-song-like').first().click();
      await f.page.locator('#list .cm-song-like.on').waitFor();
      f.status.release(); await f.page.waitForTimeout(200);
      assert.equal(await f.page.locator('#list .cm-song-like.on').count(), 1, 'late status must preserve a completed local like');
      await f.page.locator('#topSearch').click(); await f.page.locator('#kw').waitFor();
      await search(f.page, '旧搜索'); await f.page.locator('.cm-search-loading').waitFor();
      await f.page.locator('#kw').evaluate(input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
      f.oldSearch.release(); await f.page.waitForTimeout(200);
      assert.equal(await f.page.locator('#resultBox').innerText(), '');
      assert.deepEqual(f.errors, []);
      console.log('PASS completed local like survives late metadata; clearing search cancels the pending loading cycle');
    } finally {
      f.status.release(); f.binding.release(); f.likes.release(); f.oldSearch.release(); await f.context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
