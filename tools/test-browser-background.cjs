// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 390, { initScript: () => {
      window.testHidden = false; window.mediaActions = {};
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => testHidden });
      Object.defineProperty(navigator, 'audioSession', { configurable: true, value: { type: 'ambient' } });
      if (navigator.mediaSession) navigator.mediaSession.setActionHandler = (kind, action) => { mediaActions[kind] = action; };
    } });
    assert.equal(await page.evaluate(() => navigator.audioSession.type), 'playback');
    await page.evaluate(src => {
      MiniTest.setClockSource(null);
      const p = MiniTest.player;
      p.seek = originalSeek; p.bufferPct = originalBuffer;
      p.audio.crossOrigin = 'anonymous'; p.audio.src = src; p.audio.volume = .35; p.audio.playbackRate = 1.25;
      MiniTest.notifyState();
    }, base + 'tone.wav');
    await page.waitForFunction(() => MiniTest.player.audio.readyState >= 1);
    await page.locator('#play').click();
    await page.waitForFunction(() => MiniTest.player.audio.currentTime > .1 && __cmPlayer.wave.ready);
    await page.evaluate(() => {
      window.previousAudio = MiniTest.player.audio; window.previousPosition = previousAudio.currentTime;
      testHidden = true; document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => MiniTest.player.audio !== previousAudio && MiniTest.player.audio.currentTime > previousPosition + .3);
    const background = await page.evaluate(() => ({ playing: !MiniTest.player.audio.paused, intended: MiniTest.player.wantPlaying,
      connected: MiniTest.player.audio.isConnected, oldRemoved: !previousAudio.isConnected, graph: __cmPlayer.wave.ready,
      volume: MiniTest.player.audio.volume, rate: MiniTest.player.audio.playbackRate }));
    assert.deepEqual(background, { playing: true, intended: true, connected: true, oldRemoved: true, graph: false, volume: .35, rate: 1.25 });
    assert.equal(await page.evaluate(() => navigator.mediaSession.playbackState), 'playing');
    await page.evaluate(() => mediaActions.pause());
    await page.waitForFunction(() => MiniTest.player.audio.paused);
    assert.equal(await page.evaluate(() => MiniTest.player.wantPlaying), false);
    await page.evaluate(() => { testHidden = false; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('pageshow')); });
    await page.waitForTimeout(1000);
    assert(await page.evaluate(() => MiniTest.player.audio.paused), 'foreground restoration must respect an intentional media-session pause');
    await page.evaluate(() => mediaActions.play());
    await page.waitForFunction(() => !MiniTest.player.audio.paused);
    await page.evaluate(() => {
      MiniTest.player.audio.pause(); // Simulate a system interruption, preserving user intent.
      testHidden = false; document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => !MiniTest.player.audio.paused);
    await page.evaluate(() => MiniTest.player.pause());
    assert.deepEqual(errors, []);
    console.log('PASS background audio: direct media survives graph suspension, media remains attached, position/settings preserved, foreground interruption recovery and intentional lock-screen pause respected');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
