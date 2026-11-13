// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, errors } = await fixture(browser, 1280);
    const requests = [];
    let releaseAuto;
    const pendingAuto = new Promise(resolve => { releaseAuto = resolve; });
    await page.route(url => url.pathname === '/cm/ncm/lyric', async route => {
      const auto = new URL(route.request().url()).searchParams.get('strategy') === 'auto';
      requests.push(auto);
      if (auto) await pendingAuto;
      return route.fulfill({ json: auto
        ? { source: 'lddc:qm', wordLevel: true, lines: [{ t: 0, txt: 'QQ 逐字', w: [[0, 'QQ'], [3000, ' 逐字']],
          words: [{ start: 0, end: 500, text: 'QQ' }, { start: 3000, end: 4000, text: ' 逐字' }] }] }
        : { source: 'ncm:lrc', wordLevel: false, lines: [{ t: 0, txt: '网易云逐行' }] } });
    });
    await page.locator('.cm-mini-inner').click();
    await page.locator('#plMore').click();
    const toggle = page.locator('#mAutoLyrics');
    assert.equal(await toggle.evaluate(el => el.checked), true);
    assert.deepEqual(requests, [true]);
    await toggle.click();
    await page.getByText('网易云音乐 · 逐行', { exact: true }).waitFor();
    const firstAuto = page.waitForResponse(response => response.url().includes('strategy=auto'));
    releaseAuto();
    await (await firstAuto).finished();
    assert.equal(await page.locator('#mLyricSource').textContent(), '网易云音乐 · 逐行');
    assert.equal(await page.evaluate(() => localStorage.getItem('cm.autoLyrics')), '0');

    await toggle.click();
    await page.getByText('QQ 音乐 · 逐字', { exact: true }).waitFor();
    assert.deepEqual(requests, [true, false, true]);
    assert.equal(await page.locator('#plLyric .ch').count(), 2);
    assert.equal(await page.evaluate(() => localStorage.getItem('cm.autoLyrics')), '1');
    await page.getByText('关闭', { exact: true }).click();
    await page.evaluate(() => {
      clock.posMs = 800;
      clock.playing = true;   // 逐字扫光由 rAF 循环驱动，只在播放态运行
      MiniTest.setUiPreset('soaringbird');
      MiniTest.notifyState();
    });
    const tokens = page.locator('#plLyric .lp-tk');
    await tokens.first().waitFor();
    await page.evaluate(() => MiniTest.tick());
    await page.waitForFunction(() => {
      const nodes = document.querySelectorAll('#plLyric .lp-tk');
      return nodes.length === 2 && [...nodes].every(node => node.style.getPropertyValue('--cp') !== '');
    });
    assert.deepEqual(await tokens.evaluateAll(nodes => nodes.map(node => node.style.getPropertyValue('--cp'))), ['100', '0']);
    assert.deepEqual(errors, []);
    console.log('PASS player lyrics: default QQ-first, line fallback, persisted toggle and stale request');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
