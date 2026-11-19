const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const { page, errors } = await fixture(browser, 800);
    await page.evaluate(url => {
      const { player, setClockSource } = MiniTest;
      localStorage.setItem('cm.eq', JSON.stringify({ preset: 'pop', gains: [3, 1, 0, -1, 2] }));
      setClockSource(null);
      player.audio.crossOrigin = 'anonymous';
      player.audio.src = url;
    }, base + 'tone.wav');
    await page.locator('#play').click();
    await page.waitForFunction(() => window.__cmEqNodes?.length === 10);
    const response = () => page.evaluate(() => __cmEqNodes.map(item => [item.frequency.value, item.gain.value]));
    assert.deepEqual((await response()).slice(0, 5), [[60, 3], [230, 1], [910, 0], [3600, -1], [14000, 2]]);
    await page.locator('.cm-mini-inner').click();
    await page.locator('#plMore').click();
    await page.locator('#mEq').click();
    assert.equal(await page.locator('.cm-eq-slider').count(), 10);
    await page.getByRole('slider', { name: '16000 Hz 增益' }).fill('5');
    assert.deepEqual((await response()).at(-1), [16000, 5]);
    await page.locator('#eqPresets [data-p="bass"]').click();
    assert.deepEqual((await response())[1], [63, 7]);
    await page.locator('#eqPresets [data-p="flat"]').click();
    assert((await response()).every(([, gain]) => gain === 0));

    const { page: wallPage, errors: wallErrors } = await fixture(browser, 390);
    await wallPage.route(url => url.pathname === '/cm/ncmbind', route =>
      route.fulfill({ json: { bound: true, profile: { uid: 7 } } }));
    await wallPage.route(url => url.pathname === '/cm/ncm/listen/data/song/play/rank', route =>
      route.fulfill({ json: { data: { songItems: [{ songId: '7', songName: '本周常听' }] } } }));
    await wallPage.evaluate(() => {
      MiniTest.auth.saveLogin('fixture-listening', { id: 7, username: 'listener' });
      return MiniTest.renderFootprint(document.getElementById('out'));
    });
    await wallPage.getByRole('button', { name: '生成唱片墙' }).click();
    const preview = wallPage.getByAltText('唱片墙预览');
    await preview.waitFor();
    assert.equal(await preview.evaluate(img => img.decode().then(() => img.naturalHeight)), 1080);
    await wallPage.locator('#listeningWallLayout').selectOption('wallpaper');
    await wallPage.waitForFunction(() => document.getElementById('listeningWallPreview').naturalHeight === 1920);
    const png = wallPage.waitForEvent('download');
    await wallPage.getByText('保存 PNG', { exact: true }).click();
    const file = await fs.readFile(await (await png).path());
    assert.equal(file.toString('ascii', 1, 4), 'PNG');
    assert.deepEqual([file.readUInt32BE(16), file.readUInt32BE(20)], [1080, 1920]);
    assert.deepEqual([...errors, ...wallErrors], []);
    console.log('PASS: legacy EQ retention, ten live filters and repeated presets, three-layout weekly wall and PNG download');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
