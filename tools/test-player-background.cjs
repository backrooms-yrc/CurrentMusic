// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

const covers = 'https://p1.music.126.net/';
const red = '#cc2222', blue = '#2277cc', green = '#2ac661';
const svg = color => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`;

async function play(page, id, pic) {
  await page.evaluate(async ({ id, pic }) => {
    const { player } = MiniTest;
    player.queue = [{ ...player.meta, ncm_id: id, pic }];
    await player.playAt(0);
  }, { id, pic });
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ?
    { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 390);
    let releaseOld;
    const holdOld = new Promise(resolve => { releaseOld = resolve; });
    let redSamples = 0, proxySamples = 0;
    await page.route(covers + '**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/broken.svg') return route.fulfill({ status: 404 });
      const color = { '/red.svg': red, '/old.svg': blue, '/new.svg': green }[url.pathname];
      if (url.searchParams.has('param')) {
        if (color === red) redSamples++;
        if (color === blue) await holdOld;
        // The displayed original is available, but the browser rejects the sampling request.
        if (color === green) return route.abort('blockedbyresponse');
      }
      await route.fulfill({ contentType: 'image/svg+xml', body: svg(color),
        headers: { 'access-control-allow-origin': '*' } });
    });
    await page.route(url => url.pathname === '/cm/img', route => {
      const source = new URL(route.request().url()).searchParams.get('url');
      if (!source.startsWith(covers + 'new.svg')) return route.fulfill({ status: 400 });
      proxySamples++;
      return route.fulfill({ contentType: 'image/svg+xml', body: svg(green) });
    });
    await page.evaluate(() => {
      MiniTest.auth.saveLogin('background-fixture', { username: 'background-fixture' });
      MiniTest.setUiPreset('cmx');
    });
    await page.locator('.cm-mini-inner').click();
    const bg = page.locator('#plBg');
    const ambient = bg.locator('.pl-ambient');
    const durations = () => ambient.evaluate(el => ['::before', '::after']
      .map(pseudo => getComputedStyle(el, pseudo).animationDuration));
    const paletteIs = color => page.waitForFunction(color =>
      document.getElementById('plBg').style.getPropertyValue('--pl-bg-main') === color, color);
    await play(page, 2, covers + 'red.svg');
    await paletteIs(red);
    assert.equal(redSamples, 1, 'theme and player must share the cover request');
    assert(await ambient.isVisible(), 'dynamic background must be visible by default');
    assert.deepEqual(await durations(), ['24s', '33s']);
    assert(await ambient.evaluate(el => {
      const read = () => getComputedStyle(el, '::before').transform;
      const drift = el.getAnimations({ subtree: true }).find(a => a.animationName === 'plAmbientDrift');
      const start = read();
      drift.currentTime = 16000;
      return read() !== start;
    }), 'the gradient must move on mobile');
    await page.evaluate(() => {
      const comments = document.createElement('div');
      comments.id = 'commentOverlay';
      document.body.append(comments);
      document.dispatchEvent(new Event('cm-comments-visibility'));
    });
    assert.equal(await ambient.evaluate(el => getComputedStyle(el, '::before').animationPlayState), 'paused');
    await page.evaluate(() => {
      document.getElementById('commentOverlay').remove();
      document.dispatchEvent(new Event('cm-comments-visibility'));
    });
    await page.locator('#plMore').click();
    const speed = page.getByRole('slider', { name: '背景速度' });
    assert.equal(await speed.inputValue(), '1');
    await speed.press('Home');
    assert.deepEqual(await durations(), ['48s', '66s']);
    const phase = await ambient.evaluate(async el => {
      const drift = el.getAnimations({ subtree: true }).find(a => a.animationName === 'plAmbientDrift');
      drift.pause();
      await drift.ready;
      drift.currentTime = 18000;
      return drift.effect.getComputedTiming().progress;
    });
    await speed.press('End');
    assert.deepEqual(await durations(), ['12s', '16.5s']);
    assert.equal(await page.locator('#mBgSpeedValue').textContent(), '2.0×');
    assert.equal(await speed.getAttribute('aria-valuetext'), '2.0 倍');
    assert.equal(await ambient.evaluate(el => {
      const drift = el.getAnimations({ subtree: true }).find(a => a.animationName === 'plAmbientDrift');
      const progress = drift.effect.getComputedTiming().progress;
      drift.play();
      return progress;
    }), phase, 'changing speed preserves the position of the gradient');
    await page.getByText('关闭', { exact: true }).click();
    await speed.waitFor({ state: 'hidden' });

    const oldThumb = covers + 'old.svg?param=240y240';
    await Promise.all([page.waitForRequest(oldThumb), play(page, 3, covers + 'old.svg')]);
    await paletteIs(red);
    await play(page, 4, covers + 'new.svg');
    await paletteIs(green);
    assert.equal(proxySamples, 1);
    assert(await ambient.evaluate(el => el.getAnimations({ subtree: true })
      .some(a => a.transitionProperty === 'background-color')), 'palette changes must transition');
    const oldResponse = page.waitForResponse(oldThumb);
    releaseOld();
    await (await oldResponse).finished();
    await ambient.evaluate(el => Promise.all(el.getAnimations({ subtree: true })
      .filter(a => a.transitionProperty === 'background-color').map(a => a.finished)));
    assert.equal(await bg.evaluate(el => el.style.getPropertyValue('--pl-bg-main')), green);

    for (const preset of ['aimo', 'soaringbird', 'frost', 'glass', 'md3', 'cmx']) {
      await page.evaluate(preset => MiniTest.setUiPreset(preset), preset);
      await paletteIs(green);
      assert(await ambient.isVisible(), `${preset} must show the background`);
      assert.deepEqual(await durations(), ['12s', '16.5s']);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await ambient.evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await play(page, 5, covers + 'broken.svg');
    await paletteIs('');
    assert.equal(await ambient.evaluate(el => getComputedStyle(el, '::before').backgroundColor), 'rgb(85, 85, 116)');
    await play(page, 6, '');
    await paletteIs('');

    await page.locator('#plMore').click();
    const toggle = page.locator('#mGrad');
    assert(await toggle.evaluate(el => el.checked));
    await toggle.click();
    assert.equal(await page.evaluate(() => localStorage.getItem('cm.bgGrad')), '0');
    assert.equal(await ambient.isVisible(), false);
    assert(await speed.isDisabled());
    await play(page, 7, covers + 'red.svg');
    await page.reload();
    await page.evaluate(() => { MiniTest.player.restore(); MiniTest.notifyState(); });
    await page.locator('.cm-mini-inner').click();
    assert.equal(await ambient.isVisible(), false, 'saved preference must survive reload');
    assert((await bg.evaluate(el => getComputedStyle(el).backgroundImage)).includes(covers + 'red.svg'));
    await page.locator('#plMore').click();
    assert.equal(await speed.inputValue(), '2', 'saved speed must survive reload');
    await toggle.click();
    assert(await speed.isEnabled());
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.deepEqual(await durations(), ['12s', '16.5s']);
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS player background: cover colors, proxy fallback, mobile drift, song changes, themes, speed and settings');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
