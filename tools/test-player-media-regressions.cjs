// Same Playwright variables as test-mini-progress.cjs.
// CM_HEADFUL=1 also checks actual tab visibility; disable Playwright's focus emulation in that test driver.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');
const { buildSync } = require('../web/node_modules/esbuild');
const assert = require('node:assert/strict');
const waveCode = buildSync({ entryPoints: ['web/src/waveform.js'], bundle: true, format: 'iife', globalName: 'WaveTest', write: false }).outputFiles[0].text;
const sampleRate = 48000, seconds = 30, pcm = Buffer.alloc(44 + sampleRate * seconds * 2);
pcm.write('RIFF'); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write('WAVEfmt ', 8);
pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(sampleRate, 24); pcm.writeUInt32LE(sampleRate * 2, 28); pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(pcm.length - 44, 40);
for (let i = 0; i < sampleRate * seconds; i++) pcm.writeInt16LE(Math.round(32767 *
  (.18 * Math.sin(2 * Math.PI * 440 * i / sampleRate) + .07 * Math.sin(2 * Math.PI * 7000 * i / sampleRate))), 44 + i * 2);

(async () => {
  const browser = await chromium.launch({ headless: !process.env.CM_HEADFUL,
    ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 390, { initScript: () => {
      window.contexts = []; window.waveDraws = 0;
      localStorage.setItem('cm.eq', JSON.stringify({ preset: 'pop', gains: [3, 1, 0, -1, 2] }));
      const AC = window.AudioContext;
      window.AudioContext = function(...args) {
        const ctx = new AC(...args), original = ctx.createAnalyser.bind(ctx);
        ctx.createAnalyser = () => { const analyser = original(); ctx.testAnalyser = analyser; return analyser; };
        contexts.push(ctx); return ctx;
      };
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function(...args) {
        if (this.canvas.id === 'plWaveCanvas') waveDraws++;
        return clear.apply(this, args);
      };
    } });
    await page.route('**/tone.wav', route => {
      const match = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      const start = match ? Number(match[1]) : 0, end = match && match[2] ? Math.min(Number(match[2]), pcm.length - 1) : pcm.length - 1;
      return route.fulfill({ status: match ? 206 : 200, body: pcm.subarray(start, end + 1), contentType: 'audio/wav',
        headers: { 'accept-ranges': 'bytes', ...(match ? { 'content-range': `bytes ${start}-${end}/${pcm.length}` } : {}) } });
    });
    await page.route('**/cm/ncm/comments/page?*', route => route.fulfill({ json: {
      total: 20, more: false, meUid: 0, comments: Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), userId: i + 1, nickname: 'Fixture', content: '评论动画回归', liked: 0 }))
    } }));
    await page.evaluate(src => {
      const p = MiniTest.player; MiniTest.setClockSource(null); p.seek = originalSeek; p.bufferPct = originalBuffer;
      p.urlInfo = { level: 'lossless', sr: 48000, url: src }; MiniTest.settings.quality = 'lossless';
      p.audio.crossOrigin = 'anonymous'; p.audio.volume = .35; p.audio.src = src;
    }, base + 'tone.wav');
    await page.waitForFunction(() => MiniTest.player.audio.readyState >= 1);
    await page.locator('#play').click();
    await page.waitForFunction(() => __cmPlayer.wave.ready && MiniTest.player.audio.currentTime > .2);
    await page.locator('.cm-mini-inner').click(); await page.locator('#plWaveCanvas').waitFor({ state: 'visible' });
    await page.waitForFunction(() => __cmWave.levels().some(v => v > .05));
    await page.evaluate(async () => {
      window.initialMedia = MiniTest.player.audio; window.initialEq = __cmEqNodes; window.initialUrl = initialMedia.src;
      window.rms = async () => {
        const analyser = contexts.find(c => c.testAnalyser)?.testAnalyser, samples = new Float32Array(analyser.fftSize);
        let value = 0;
        for (let i = 0; i < 8; i++) { analyser.getFloatTimeDomainData(samples); value += Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length); await new Promise(r => setTimeout(r, 20)); }
        return value / 8;
      };
      window.beforeRms = await rms();
    });
    await page.evaluate(() => { localStorage.setItem('cm.waveTilt', '0'); document.dispatchEvent(new Event('cm-wavecfg')); window.initialWave = __cmWave; });
    await page.waitForTimeout(400);
    const uncompensated = await page.evaluate(() => { const v = __cmWave.levels(); return Math.max(...v.slice(v.length / 2)); });
    await page.evaluate(() => { localStorage.setItem('cm.waveTilt', '12'); document.dispatchEvent(new Event('cm-wavecfg')); });
    await page.waitForTimeout(400);
    assert(await page.evaluate(() => __cmWave === initialWave && __cmWave.getTilt() === 12), 'tilt adjustment must retain the active analyser/controller');
    const compensated = await page.evaluate(() => { const v = __cmWave.levels(); return Math.max(...v.slice(v.length / 2)); });
    assert(compensated > uncompensated + .02, JSON.stringify({ uncompensated, compensated }));
    assert(await page.evaluate(async () => Math.abs(await rms() / beforeRms - 1) < .05), 'visual compensation must not change output RMS');
    await page.locator('#plComments').click(); await page.locator('#commentOverlay').waitFor({ state: 'visible' });
    await page.waitForTimeout(320);
    const coveredDraws = await page.evaluate(() => waveDraws);
    await page.waitForTimeout(350); assert.equal(await page.evaluate(() => waveDraws), coveredDraws, 'covered spectrum must stop drawing during comments');
    await page.locator('#cmtClose').click(); await page.locator('#commentOverlay').waitFor({ state: 'detached' });
    await page.waitForFunction(count => waveDraws > count, coveredDraws);
    assert(await page.evaluate(() => __cmWave === initialWave && initialMedia === MiniTest.player.audio && initialEq === __cmEqNodes));
    if (process.env.CM_HEADFUL) {
      const backgroundStart = await page.evaluate(() => MiniTest.player.audio.currentTime);
      const other = await context.newPage(); await other.goto('about:blank'); await other.bringToFront();
      await page.waitForFunction(() => document.hidden, null, { polling: 100 });
      await page.waitForFunction(start => MiniTest.player.audio.currentTime > start + 1, backgroundStart, { polling: 200 });
      assert(await page.evaluate(() => !MiniTest.player.audio.paused && MiniTest.player.audio === initialMedia && __cmEqNodes === initialEq));
      await page.bringToFront(); await other.close();
      await page.waitForFunction(() => !document.hidden);
    }
    const unchanged = await page.evaluate(async () => ({ sameMedia: initialMedia === MiniTest.player.audio, sameEq: initialEq === __cmEqNodes,
      sameUrl: initialUrl === MiniTest.player.audio.src, volume: MiniTest.player.audio.volume, level: MiniTest.player.urlInfo.level,
      quality: MiniTest.settings.quality, rmsRatio: await rms() / beforeRms }));
    assert(unchanged.sameMedia && unchanged.sameEq && unchanged.sameUrl);
    assert.equal(unchanged.volume, .35); assert.equal(unchanged.level, 'lossless'); assert.equal(unchanged.quality, 'lossless');
    assert(Math.abs(unchanged.rmsRatio - 1) < .05, JSON.stringify(unchanged));
    for (const preset of ['cmx', 'frost', 'glass', 'md3']) {
      await page.evaluate(() => {
        localStorage.setItem('cm.volume', '0');
        MiniTest.setUiPreset('soaringbird');
      });
      assert.equal(await page.evaluate(() => MiniTest.player.audio.volume), 0);
      await page.evaluate(key => MiniTest.setUiPreset(key), preset);
      assert.deepEqual(await page.evaluate(() => ({
        volume: MiniTest.player.audio.volume,
        sameMedia: MiniTest.player.audio === initialMedia,
        playing: !MiniTest.player.audio.paused,
        saved: localStorage.getItem('cm.volume'),
      })), { volume: .35, sameMedia: true, playing: true, saved: '0' });
    }
    assert(await page.evaluate(async () => Math.abs(await rms() / beforeRms - 1) < .05), 'leaving the theme must restore audible PCM');
    await page.evaluate(() => MiniTest.player.pause());
    // Frequency compensation must rebuild even when only the sample rate changes.
    await page.addScriptTag({ content: waveCode });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.style.cssText = 'position:fixed;top:0;width:600px;height:80px'; document.body.appendChild(canvas);
      window.testRate = 48000;
      window.rateWave = WaveTest.createWaveform(canvas, { read: bytes => { bytes.fill(100); return true; }, bins: () => 1024, rate: () => testRate, tilt: 4.5 });
      rateWave.setPlaying(true);
    });
    await page.waitForTimeout(300);
    const beforeRate = await page.evaluate(() => rateWave.levels().at(-1));
    await page.evaluate(() => { testRate = 96000; }); await page.waitForTimeout(350);
    assert(await page.evaluate(before => rateWave.levels().at(-1) > before + .02, beforeRate));
    await page.evaluate(() => rateWave.destroy());
    assert.deepEqual(errors, []);
    console.log('PASS real PCM: stable source/quality/volume/EQ/RMS, live tilt and sample-rate compensation, suspended covered animations, resumed spectrum' + (process.env.CM_HEADFUL ? ', actual background tab retains playback' : ''));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
