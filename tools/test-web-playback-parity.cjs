const assert = require('node:assert/strict');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const { context, page, errors } = await fixture(browser, 390);
    try {
      await page.evaluate(url => {
        const { api, auth, player, setClockSource } = MiniTest;
        setClockSource(null);
        player.seek = originalSeek;
        player.bufPct = originalBuffer;
        auth.saveLogin('fixture-a', { id: 1, username: 'listener-a' });
        api.songUrl = async () => ({ url, level: 'matched' });
        window.testTracks = [1, 2, 3, 4].map(id => ({ ncm_id: id, name: '歌曲 ' + id, duration: 12000 }));
        document.getElementById('play').onclick = () => player.playList(testTracks.slice(0, 3), 0, { playlist: '#/ncmpl/123' });
      }, base + 'tone.wav');
      await page.locator('#play').click();
      await page.waitForFunction(() => MiniTest.player.isPlaying());
      await page.locator('.cm-mini-inner').click();
      await page.locator('#plQueue').click();
      await page.locator('.cm-queue-item[data-i="0"]').getByRole('button', { name: '下移' }).click();
      assert.deepEqual(await page.evaluate(() => MiniTest.player.queue.map(s => s.ncm_id)), [2, 1, 3]);
      assert.deepEqual(await page.evaluate(() => [MiniTest.player.index, MiniTest.player.meta.ncm_id, MiniTest.player.isPlaying()]), [1, 1, true]);
      await page.locator('.cm-queue-item[data-i="0"]').getByRole('button', { name: '移除' }).click();
      assert.deepEqual(await page.evaluate(() => MiniTest.player.queue.map(s => s.ncm_id)), [1, 3]);
      await page.locator('mdui-dialog[open]').getByText('关闭', { exact: true }).click();

      await page.locator('#plMore').click();
      await page.locator('#mSleep').click();
      await page.locator('#cmSleepMinutes').fill('1');
      await page.locator('#cmSleepFinish').check();
      await page.locator('#cmSleepStart').click();
      await page.evaluate(() => {
        const now = Date.now;
        Date.now = () => now() + 61000;
        MiniTest.tick();
        Date.now = now;
      });
      await page.getByText('当前歌曲播完后暂停', { exact: true }).waitFor();
      assert(await page.evaluate(() => MiniTest.player.isPlaying()));
      await page.evaluate(() => {
        const now = Date.now;
        Date.now = () => now() + 61000;
        MiniTest.player.next(true);
        Date.now = now;
      });
      assert.deepEqual(await page.evaluate(() => [MiniTest.player.meta.ncm_id, MiniTest.player.isPlaying()]), [1, false]);
      await page.locator('mdui-dialog[open]').getByText('关闭', { exact: true }).click();

      const restored = await page.evaluate(async () => {
        const { auth, player, settings } = MiniTest;
        const seek = new Promise((resolve, reject) => {
          player.audio.addEventListener('seeked', resolve, { once: true });
          setTimeout(() => reject(new Error('fixture audio seek did not finish')), 2500);
        });
        player.seek(4.25);
        await seek;
        auth.saveLogin('fixture-b', { id: 2, username: 'listener-b' });
        if (player.meta) throw new Error('previous account playback leaked');
        player.enqueue(testTracks[3]);
        auth.switchTo('listener-a');
        const checkpoint = [player.meta.ncm_id, player.posMs(), player.playlist, player.isPlaying()];
        settings.base = 'https://self-hosted.example/cm';
        if (auth.token || auth.accounts().length || player.meta) throw new Error('account leaked to custom server');
        auth.saveLogin('fixture-custom', { id: 1, username: 'listener-a' });
        player.enqueue(testTracks[2]);
        settings.base = 'https://music.ctcehs.com/cm';
        if (auth.token) throw new Error('custom-server account leaked to preset mirror');
        auth.switchTo('listener-a');
        if (player.meta.ncm_id !== 1) throw new Error('custom-server queue replaced original account queue');
        auth.forget('listener-b');
        if (auth.switchTo('listener-b')) throw new Error('forgotten account can still sign in');
        return checkpoint;
      });
      assert.deepEqual(restored, [1, 4250, '#/ncmpl/123', false]);
      await page.evaluate(() => {
        const { player } = MiniTest;
        player.queue = Array.from({ length: 135 }, (_, i) => ({ ncm_id: i + 1, name: '歌曲 ' + (i + 1), duration: 12000 }));
        player.index = 115;
        player.meta = player.queue[115];
        player.pendingPosition = 8000;
        player.persist();
      });
      await page.reload();
      assert.deepEqual(await page.evaluate(() => {
        const { player } = MiniTest;
        player.restore();
        return [player.meta.ncm_id, player.posMs(), player.queue[player.index + 1].ncm_id, player.isPlaying()];
      }), [116, 8000, 117, false]);
      assert.deepEqual(errors, []);
      console.log('PASS: queue editing, sleep timer at track end, account/server isolation, long-queue checkpoint after reload');
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
