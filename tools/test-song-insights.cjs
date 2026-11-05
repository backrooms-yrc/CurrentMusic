// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const assert = require('node:assert/strict'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const assets = buildSync({ stdin: { resolveDir: root, contents: `
  import './web/src/polyfill.js';
  import './web/node_modules/mdui/mdui.css';
  import './web/src/app.css';
  export { openSongInfo, seekSongChorus } from './web/src/songinfo.js';
  export { player } from './web/src/player.js';
` }, bundle: true, format: 'iife', globalName: 'SongTest', write: false,
  outfile: 'fixture.js', loader: { '.png': 'dataurl', '.svg': 'text', '.woff2': 'file' }, logLevel: 'silent' }).outputFiles;
const wav = Buffer.alloc(44 + 8000 * 2 * 12);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [], requests = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url()), name = url.pathname.split('/').pop();
        requests.push(url.pathname);
        const file = assets.find(f => path.basename(f.path) === name);
        if (file) return route.fulfill({ body: Buffer.from(file.contents), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (name === 'tone.wav') {
          const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
          const start = range ? Number(range[1]) : 0;
          const end = range && range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
          return route.fulfill({ status: range ? 206 : 200, body: wav.subarray(start, end + 1), contentType: 'audio/wav',
            headers: { 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
        }
        if (url.pathname === '/cm/song/qualities') return route.fulfill({ json: { qualities: [
          { label: '高清臻音', br: 800000, sr: 48000, size: 1000000 },
          { label: '臻音全景声', br: 830000 }, { label: '沉浸环绕声', variants: [{ immerseType: 'ste2' }] },
        ] } });
        if (url.pathname === '/cm/song/chorus') return route.fulfill({ json: { segments: [
          { startMs: 10000, endMs: 20000 }, { startMs: 30000, endMs: 40000 },
        ] } });
        if (url.pathname === '/cm/song/versions') return route.fulfill({ json: { songs: [
          { ncm_id: 2, name: '版本二', artists: '歌手二', album: '专辑' },
          { ncm_id: 3, name: '<img src=x onerror=alert(1)>', artists: '歌手三' },
        ] } });
        if (url.pathname.startsWith('/cm/')) return route.fulfill({ json: {} });
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><script src="fixture.js"></script>' });
      });
      await page.goto('https://music.20110208.xyz/app/');
      await page.evaluate(() => SongTest.openSongInfo({ ncm_id: 1, name: '测试歌曲', artists: '测试歌手' }));
      assert.equal(await page.locator('.cm-si-chorus').count(), 2);
      assert.equal(await page.locator('.cm-si-version').count(), 2);
      assert.equal(await page.locator('#si302copy, #si302play').count(), 2, 'external player actions remain available');
      const text = await page.locator('#siBody').innerText();
      for (const label of ['高清臻音', '臻音全景声', '沉浸环绕声', 'ste2']) assert(text.includes(label));
      assert.equal(await page.locator('.cm-si-version img').count(), 0, 'song names must remain escaped');
      assert(!requests.some(p => p.endsWith('/song/url/v1/302')), 'opening metadata must not fetch an audio stream as JSON');
      await page.evaluate(() => { SongTest.player.playList = (songs, i) => { window.selectedVersion = songs[i].ncm_id; }; });
      await page.locator('.cm-si-version').nth(1).click();
      assert.equal(await page.evaluate(() => selectedVersion), 3);

      // The previous song must never be sought while the requested song loads.
      await page.evaluate(() => {
        const p = SongTest.player;
        window.originalAudio = p.audio; window.originalSeek = p.seek;
        window.seeks = []; window.fakeAudio = new EventTarget(); fakeAudio.readyState = 0;
        Object.defineProperty(p, 'audio', { configurable: true, get: () => fakeAudio });
        p.seek = sec => seeks.push([p.meta.ncm_id, sec]);
        p.meta = { ncm_id: 9 }; p.queue = [{ ncm_id: 9 }, { ncm_id: 1, duration: 60000 }];
        p.playAt = async i => { p.meta = p.queue[i]; p.urlInfo = {}; p.loading = false; };
        window.pendingJump = SongTest.seekSongChorus({ ncm_id: 1 }, 10000);
      });
      assert.deepEqual(await page.evaluate(() => seeks), []);
      await page.evaluate(() => { fakeAudio.readyState = 1; fakeAudio.dispatchEvent(new Event('loadedmetadata')); });
      assert.equal(await page.evaluate(() => pendingJump), true);
      assert.deepEqual(await page.evaluate(() => seeks), [[1, 10]]);
      await page.evaluate(() => {
        fakeAudio.readyState = 0;
        window.pendingJump = SongTest.seekSongChorus({ ncm_id: 1 }, 30000);
        SongTest.player.meta = { ncm_id: 5 }; SongTest.player.urlInfo = {};
        fakeAudio.dispatchEvent(new Event('loadedmetadata'));
      });
      assert.equal(await page.evaluate(() => pendingJump), false);
      assert.deepEqual(await page.evaluate(() => seeks), [[1, 10]]);
      assert.equal(await page.evaluate(async () => {
        const p = SongTest.player;
        p.meta = { ncm_id: 1 }; p.loading = false; p.urlInfo = null;
        return SongTest.seekSongChorus(p.meta, 10000);
      }), false, 'failed resolution must not report a successful seek');

      // Verify seconds conversion against a real decodable media element.
      await page.evaluate(async () => {
        const p = SongTest.player;
        Object.defineProperty(p, 'audio', { configurable: true, get: () => originalAudio });
        p.seek = originalSeek; p.urlInfo = {};
        p.audio.src = 'tone.wav'; p.audio.load();
        await new Promise(resolve => p.audio.addEventListener('loadedmetadata', resolve, { once: true }));
      });
      assert.equal(await page.evaluate(() => SongTest.seekSongChorus(SongTest.player.meta, 5000)), true);
      assert.equal(await page.evaluate(() => SongTest.player.audio.currentTime), 5);
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: song insights on mobile/desktop; alternate versions, escaping, metadata readiness, track-switch isolation, real audio seek');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
