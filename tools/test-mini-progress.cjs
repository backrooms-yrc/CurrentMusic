// CM_PLAYWRIGHT_MODULE=/path/to/playwright CM_CHROMIUM_EXECUTABLE=/path/to/chrome node tools/test-mini-progress.cjs
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const assert = require('node:assert/strict'), path = require('node:path');
const root = path.resolve(__dirname, '..'), base = 'https://music.20110208.xyz/app/';
const assets = buildSync({ stdin: { resolveDir: root, contents: `
  import './web/src/polyfill.js';
  import './web/node_modules/@material-design-icons/font/outlined.css';
  import './web/node_modules/mdui/mdui.css';
  import './web/src/apple-hig.css';
  import './web/src/app.css';
  import './web/src/watch.css';
  import { initPlayerUI } from './web/src/player-ui.js';
  export { player, tick, notifyState, setClockSource } from './web/src/player.js';
  export { api, auth, settings } from './web/src/api.js';
  export { ensureNcmLiked, isNcmLiked, setNcmLiked, resetNcmLiked, resetNcmBound } from './web/src/ui.js';
  export { render as renderSearch } from './web/src/pages/search.js';
  initPlayerUI();
` }, bundle: true, format: 'iife', globalName: 'MiniTest', write: false,
  outfile: 'fixture.js', loader: { '.png': 'dataurl', '.svg': 'text', '.woff2': 'file' }, logLevel: 'silent' }).outputFiles;
// Real decodable media verifies that the control also drives the local audio clock.
const wav = Buffer.alloc(44 + 8000 * 2 * 12);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

async function fixture(browser, width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: width === 240 ? 240 : 900 },
    hasTouch: width < 900, isMobile: width < 900, reducedMotion: width === 240 ? 'reduce' : 'no-preference' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  if (options.initScript) await page.addInitScript(options.initScript);
  await page.route('**/*', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    if (name === 'tone.wav') {
      const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      return route.fulfill({ status: range ? 206 : 200, body: wav.subarray(start, end + 1), contentType: 'audio/wav',
        headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
    }
    const asset = assets.find(file => path.basename(file.path) === name);
    if (asset) return route.fulfill({ body: Buffer.from(asset.contents), contentType: name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/javascript' });
    if (name) return route.fulfill({ json: {} });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
      <link rel="stylesheet" href="fixture.css"><div id="out"></div><div id="mini"></div>
      <div id="bottomNav"></div><div id="playerOverlay" hidden></div><div id="sheets"></div>
      <button id="play" style="position:fixed;right:8px;top:8px;z-index:100">Play fixture</button><script src="fixture.js"></script>` });
  });
  await page.goto(base);
  await page.evaluate(() => {
    const p = MiniTest.player;
    window.originalSeek = p.seek; window.originalBuffer = p.bufferPct;
    window.clock = { posMs: 60000, durMs: 240000, playing: false }; window.seeks = [];
    p.meta = { ncm_id: 1, name: '进度条测试', artists: 'CurrentMusic', duration: 240000 };
    p.urlInfo = { level: 'lossless' }; p.bufferPct = () => 55;
    MiniTest.setClockSource(() => clock);
    p.seek = sec => { seeks.push(sec); clock.posMs = sec * 1000; MiniTest.tick(); };
    MiniTest.notifyState();
    document.getElementById('play').onclick = () => p.audio.play();
  });
  return { page, context, errors };
}

async function run() {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440, 240]) {
      const { page, context, errors } = await fixture(browser, width);
      const slider = page.getByRole('slider', { name: '播放进度' });
      assert.equal(await slider.inputValue(), '25');
      assert.equal(await slider.getAttribute('aria-valuetext'), '1:00 / 4:00');
      for (const preset of ['cmx', 'frost', 'glass', 'md3']) for (const dark of [false, true]) {
        await page.evaluate(({ preset, dark }) => {
          document.documentElement.dataset.uiPreset = preset;
          document.documentElement.classList.toggle('mdui-theme-dark', dark);
        }, { preset, dark });
        const geometry = await page.evaluate(() => {
          const range = document.getElementById('miniSeek').getBoundingClientRect();
          const mini = document.getElementById('mini').getBoundingClientRect();
          const play = document.getElementById('miniPlay').getBoundingClientRect();
          const track = document.querySelector('.cm-mini-track');
          return { left: range.left, right: range.right, height: range.height, miniLeft: mini.left,
            miniRight: mini.right, rangeBottom: range.bottom, playTop: play.top, trackHeight: track.getBoundingClientRect().height };
        });
        assert(geometry.left > geometry.miniLeft && geometry.right < geometry.miniRight);
        assert(geometry.height >= 32 && geometry.rangeBottom <= geometry.playTop, 'seek target must leave playback controls clear');
        assert.equal(geometry.trackHeight, width === 240 ? 3 : 4);
      }
      await page.evaluate(() => { document.documentElement.dataset.uiPreset = 'cmx'; });
      const box = await slider.boundingBox(), y = box.y + 26;
      await page.mouse.move(box.x + box.width * .25, y); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .75, y, { steps: 5 });
      assert(Math.abs(Number(await slider.inputValue()) - 75) < 5);
      assert.equal(await page.evaluate(() => seeks.length), 0, 'drag preview must not seek the audio repeatedly');
      await page.evaluate(() => { window.heldSlider = document.getElementById('miniSeek'); MiniTest.notifyState(); MiniTest.tick(); });
      assert(await page.evaluate(() => heldSlider === document.getElementById('miniSeek')));
      assert(Number(await slider.inputValue()) > 70, 'time/state updates must preserve the drag preview');
      await page.mouse.up();
      assert.equal(await page.evaluate(() => seeks.length), 1);
      assert(await page.locator('#playerOverlay').evaluate(el => el.hidden), 'seeking must not open the full player');

      await slider.focus(); await page.keyboard.press('Home');
      assert.equal(await page.evaluate(() => clock.posMs), 0);
      await page.keyboard.press('End'); assert.equal(await page.evaluate(() => clock.posMs), 240000);
      const count = await page.evaluate(() => seeks.length);
      await page.mouse.move(box.x + box.width * .3, y); await page.mouse.down();
      await page.mouse.move(box.x + box.width * .6, y);
      await slider.dispatchEvent('pointercancel'); await page.mouse.up();
      assert.equal(await page.evaluate(() => seeks.length), count, 'cancelled gestures must not seek');

      if (width === 390) {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * .4, y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * .6, y }] });
        assert.equal(await page.evaluate(() => seeks.length), count);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        assert.equal(await page.evaluate(() => seeks.length), count + 1, 'touch release commits once');
      }
      await page.evaluate(() => { clock.posMs = 120000; MiniTest.tick(); });
      const stable = await slider.inputValue();
      await page.evaluate(() => MiniTest.notifyState()); assert.equal(await slider.inputValue(), stable);
      if (process.env.CM_MINI_SCREENSHOT_DIR) {
        const mini = await page.locator('#mini').boundingBox();
        const y = Math.max(0, mini.y - 60);
        await page.screenshot({ path: path.join(process.env.CM_MINI_SCREENSHOT_DIR, `mini-${width}.png`),
          clip: { x: 0, y, width, height: Math.min(160, page.viewportSize().height - y) } });
      }
      await page.evaluate(() => { MiniTest.player.meta.duration = 0; });
      for (const dur of [0, Infinity, NaN]) {
        await page.evaluate(dur => { clock.durMs = dur; MiniTest.tick(); }, dur);
        assert(await slider.isDisabled()); assert.equal(await slider.inputValue(), '0');
      }
      await page.evaluate(() => { clock.durMs = 240000; MiniTest.player.loading = true; MiniTest.notifyState(); });
      assert(await slider.isDisabled());
      await page.evaluate(() => { MiniTest.player.loading = false; MiniTest.notifyState(); });
      assert(await slider.isEnabled());
      // A detached slider from the previous song must never seek the next song.
      const beforeSwitch = await page.evaluate(() => seeks.length);
      await page.evaluate(() => {
        const old = document.getElementById('miniSeek'); old.value = 30; old.dispatchEvent(new Event('input'));
        MiniTest.player.meta = { ...MiniTest.player.meta, ncm_id: 2 }; MiniTest.notifyState();
        old.dispatchEvent(new Event('change'));
      });
      assert.equal(await page.evaluate(() => seeks.length), beforeSwitch);
      if (width === 240) assert.equal(await page.locator('#miniProg').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      // Restore the real local media methods, then verify pause/resume and seek against audio.
      await page.evaluate(src => {
        MiniTest.setClockSource(null); window.localSeeks = [];
        MiniTest.player.seek = function(sec) { localSeeks.push(sec); originalSeek.call(this, sec); };
        MiniTest.player.bufferPct = originalBuffer;
        MiniTest.player.audio.src = src;
      }, base + 'tone.wav');
      await page.waitForFunction(() => MiniTest.player.audio.readyState >= 1);
      await page.evaluate(() => MiniTest.notifyState()); await page.locator('#play').click();
      await page.waitForFunction(() => MiniTest.player.audio.currentTime > .1);
      await page.evaluate(() => { window.mediaSlider = document.getElementById('miniSeek'); window.mediaPosition = MiniTest.player.audio.currentTime; });
      await page.locator('#miniPlay').click(); await page.waitForFunction(() => MiniTest.player.audio.paused);
      assert(await page.evaluate(() => mediaSlider === document.getElementById('miniSeek')));
      await page.locator('#miniPlay').click();
      await page.waitForFunction(() => MiniTest.player.audio.currentTime > mediaPosition + .1);
      assert(await page.evaluate(() => mediaSlider === document.getElementById('miniSeek')));
      assert(Number(await slider.inputValue()) > 0);
      await page.evaluate(() => MiniTest.player.pause());
      await slider.focus(); await page.keyboard.press('End');
      const local = await page.evaluate(() => ({ pos: MiniTest.player.audio.currentTime, dur: MiniTest.player.durMs(),
        range: document.getElementById('miniSeek').value, disabled: document.getElementById('miniSeek').disabled, seeks: localSeeks }));
      assert(Math.abs(local.pos - 12) < .1, JSON.stringify(local));
      assert.deepEqual(errors, []);
      console.log('PASS mini progress:', width, 'four skins/light-dark, hit areas, drag/commit/cancel, keyboard, clock updates, no reset, invalid duration, track switch, local audio and reduced motion');
      await context.close();
    }
  } finally { await browser.close(); }
}
module.exports = { fixture, base };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
