// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict'), path = require('node:path');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440, 240]) {
      const requests = [];
      let releaseChorus;
      const pendingChorus = new Promise(resolve => { releaseChorus = resolve; });
      const { page, context, errors } = await fixture(browser, width, { chorus: async (route, id) => {
        requests.push(id);
        if (id === '2') await pendingChorus;
        if (id === '3') return route.fulfill({ status: 502, json: { error: '副歌资料暂时不可用' } });
        return route.fulfill({ json: { id, segments: [
          { startMs: 60000, endMs: 120000 },
          { startMs: 180000, endMs: 260000 },
          { startMs: 240000, endMs: 300000 },
          { startMs: -1000, endMs: 2000 },
        ] } });
      } });
      await page.locator('.cm-mini-inner').click();
      const slider = page.locator('#plSeek');
      await slider.waitFor({ state: 'visible' });
      await page.locator('#playerOverlay').evaluate(async el => {
        await Promise.all(el.getAnimations({ subtree: true }).filter(a => a.effect.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      });
      assert.equal(await slider.inputValue(), '25');
      assert.equal(await page.locator('#plCur').innerText(), '1:00');
      assert.equal(await page.locator('#plDur').innerText(), '4:00');
      assert.equal(await slider.getAttribute('aria-valuetext'), '1:00 / 4:00');
      const miniBands = page.locator('.cm-mini-track .cm-chorus-track span');
      const fullBands = page.locator('.pl-seek-track .cm-chorus-track span');
      for (const bands of [miniBands, fullBands]) {
        await bands.first().waitFor({ state: 'attached' });
        assert.deepEqual(await bands.evaluateAll(els => els.map(el => [el.style.left, el.style.width])),
          [['25%', '25%'], ['75%', '25%']]);
      }
      assert.deepEqual(requests, ['1'], 'the progress bars share the song request');
      assert.equal(await page.locator('#plSeekChorus').textContent(), '高潮（副歌） 1:00–2:00、3:00–4:00');
      assert.equal(await slider.getAttribute('aria-describedby'), 'plSeekChorus');
      for (const preset of ['cmx', 'frost', 'glass', 'md3']) for (const dark of [false, true]) {
        await page.evaluate(({ preset, dark }) => {
          document.documentElement.dataset.uiPreset = preset;
          document.documentElement.classList.toggle('mdui-theme-dark', dark);
        }, { preset, dark });
        const dimensions = await slider.boundingBox();
        assert(dimensions.width > 40 && dimensions.height >= (width === 240 ? 28 : 36));
        const play = await page.locator('#plPlay').boundingBox();
        assert(dimensions.y + dimensions.height <= play.y + .5,
          'seek hit area must leave transport controls clear: ' + JSON.stringify({ width, preset, dark, dimensions, play }));
        assert(play.y + play.height <= page.viewportSize().height + .5,
          'play button must fit even on a watch: ' + JSON.stringify({ width, preset, dark, dimensions, play }));
      }
      await page.evaluate(() => { document.documentElement.dataset.uiPreset = 'cmx'; });
      const box = await slider.boundingBox(), y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width * .25, y); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .75, y, { steps: 5 });
      const preview = await slider.inputValue();
      assert(Math.abs(Number(preview) - 75) < 5);
      assert.equal(await page.evaluate(() => seeks.length), 0);
      assert((await page.locator('#plCur').innerText()).startsWith('2:') || (await page.locator('#plCur').innerText()).startsWith('3:'));
      assert.equal(await page.locator('.pl-seek-time').evaluate(el => getComputedStyle(el).opacity), '1');
      await page.evaluate(() => { window.heldFullSlider = document.getElementById('plSeek'); MiniTest.tick(); MiniTest.notifyState(); });
      assert.equal(await slider.inputValue(), preview);
      assert(await page.evaluate(() => heldFullSlider === document.getElementById('plSeek')));
      const fill = await page.locator('#plFill').evaluate(el => getComputedStyle(el).transform);
      assert(Math.abs(Number(fill.match(/matrix\(([^,]+)/)[1]) - Number(preview) / 100) < .01, 'fill must follow drag preview');
      if (process.env.CM_PLAYER_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.CM_PLAYER_SCREENSHOT_DIR, `player-${width}.png`) });
      await page.mouse.up(); assert.equal(await page.evaluate(() => seeks.length), 1);
      assert.equal(await page.locator('#miniSeek').inputValue(), await slider.inputValue());
      await slider.focus(); await page.keyboard.press('Home'); assert.equal(await page.evaluate(() => clock.posMs), 0);
      await page.keyboard.press('End'); assert.equal(await page.evaluate(() => clock.posMs), 240000);

      const count = await page.evaluate(() => seeks.length);
      await page.mouse.move(box.x + box.width * .3, y); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .6, y);
      await slider.dispatchEvent('pointercancel'); await page.mouse.up();
      assert.equal(await page.evaluate(() => seeks.length), count);
      assert.equal(await page.locator('#plCur').innerText(), '4:00');
      if (width === 390) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * .4, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * .6, y }] });
        assert.equal(await page.evaluate(() => seeks.length), count);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await page.evaluate(() => seeks.length), count + 1);
      }
      const beforeSwitch = await page.evaluate(() => seeks.length);
      await page.mouse.move(box.x + box.width * .3, y); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .5, y);
      const secondRequest = page.waitForRequest(r => r.url().endsWith('/song/chorus?id=2'));
      await page.evaluate(() => { clock.posMs = 0; MiniTest.player.meta = { ...MiniTest.player.meta, ncm_id: 2 }; MiniTest.notifyState(); });
      await secondRequest;
      assert.equal(await fullBands.count(), 0, 'the previous song clears before the next response');
      await page.mouse.move(box.x + box.width * .8, y); await page.mouse.up();
      assert.equal(await page.evaluate(() => seeks.length), beforeSwitch, 'old drag must not seek the next song');
      assert.equal(await slider.inputValue(), '0');
      assert.equal(await page.locator('#plCur').innerText(), '0:00');
      const failedChorus = page.waitForResponse(r => r.url().endsWith('/song/chorus?id=3'));
      await page.evaluate(() => { MiniTest.player.meta = { ...MiniTest.player.meta, ncm_id: 3 }; MiniTest.notifyState(); });
      assert.equal((await failedChorus).status(), 502);
      const staleChorus = page.waitForResponse(r => r.url().endsWith('/song/chorus?id=2'));
      releaseChorus();
      await (await staleChorus).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await fullBands.count(), 0, 'a delayed response cannot add bands to the next song');
      assert.equal(await miniBands.count(), 0);
      assert.equal(await slider.getAttribute('aria-describedby'), null);
      assert.deepEqual(requests, ['1', '2', '3']);
      for (const dur of [0, Infinity, NaN]) {
        await page.evaluate(dur => { clock.durMs = dur; MiniTest.player.meta.duration = 0; MiniTest.tick(); }, dur);
        assert(await slider.isDisabled()); assert.equal(await page.locator('#plDur').innerText(), '0:00');
      }
      await page.evaluate(() => { clock.durMs = 240000; clock.posMs = 48000; MiniTest.player.loading = true; MiniTest.notifyState(); });
      assert(await slider.isDisabled());
      await page.evaluate(() => { MiniTest.player.loading = false; MiniTest.notifyState(); });
      assert.equal(await slider.inputValue(), '20');
      const beforeClose = await page.evaluate(() => seeks.length);
      await slider.evaluate(el => { window.closedSlider = el; el.value = 60; el.dispatchEvent(new Event('input')); });
      await page.locator('#plClose').click();
      await page.evaluate(() => closedSlider.dispatchEvent(new Event('change')));
      assert.equal(await page.evaluate(() => seeks.length), beforeClose);
      await page.locator('#playerOverlay').waitFor({ state: 'hidden' });
      await page.locator('.cm-mini-inner').click(); await slider.waitFor({ state: 'visible' });
      assert.equal(await slider.inputValue(), '20');
      assert.equal(await page.locator('#plCur').innerText(), '0:48');
      if (width === 240) assert.equal(await page.locator('#plFill').evaluate(el => getComputedStyle(el).transitionDuration), '0s');

      await page.evaluate(src => {
        MiniTest.setClockSource(null); MiniTest.player.seek = originalSeek; MiniTest.player.bufferPct = originalBuffer;
        MiniTest.player.audio.src = src;
      }, base + 'tone.wav');
      await page.waitForFunction(() => MiniTest.player.audio.readyState >= 1);
      await page.evaluate(() => MiniTest.notifyState());
      await page.locator('#plPlay').click(); await page.waitForFunction(() => MiniTest.player.audio.currentTime > .1);
      await page.locator('#plPlay').click(); await page.waitForFunction(() => MiniTest.player.audio.paused);
      await slider.focus(); await page.keyboard.press('End');
      assert(Math.abs(await page.evaluate(() => MiniTest.player.audio.currentTime) - 12) < .1);
      assert.equal(await page.locator('#plCur').innerText(), '0:12');
      assert.deepEqual(errors, []);
      console.log('PASS player progress:', width, 'chorus ranges and stale responses, four skins/light-dark, touch/keyboard, synchronized preview, song switch, close/reopen and real audio');
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
