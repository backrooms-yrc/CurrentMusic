const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { buildSync } = require('../web/node_modules/esbuild');
const { fixture } = require('./test-mini-progress.cjs');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const { page, errors } = await fixture(browser, 390);
    const script = buildSync({
      entryPoints: ['web/src/local-lyrics.js'], bundle: true, format: 'iife', globalName: 'LyricFile', write: false,
    }).outputFiles[0].text;
    await page.addScriptTag({ content: script });
    const formats = await page.evaluate(async () => {
      const files = {
        lrc: '[00:01.000]<00:01.000>甲<00:01.500>乙<00:02.000>',
        yrc: '[1000,1000](1000,500,0)甲(1500,500,0)乙',
        qrc: '<?xml version="1.0"?><Lyrics><LyricInfo LyricContent="[1000,1000]甲(1000,500)乙(1500,500)"></LyricInfo></Lyrics>',
        krc: '[1000,1000]<0,500,0>甲<500,500,0>乙',
        ttml: '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"><span begin="1s" end="1.5s">甲</span><span begin="1.5s" end="2s">乙</span></p></div></body></tt>',
        vtt: 'WEBVTT\n\n00:01.000 --> 00:02.000\n甲乙\n',
      };
      const expected = [];
      for (const [ext, value] of Object.entries(files)) {
        const { data } = await LyricFile.importLyricFile(new File([value], 'fixture.' + ext));
        const { t, txt, w } = data.lines[0];
        expected.push([ext, t, txt, w || []]);
      }
      const { data } = await LyricFile.importLyricFile(new File([files.yrc], 'fixture.yrc'));
      const content = LyricFile.exportLyric('fia', data.lines, { ncm_id: 1, name: '歌曲' }, 200);
      const fia = await LyricFile.importLyricFile(new File([content], 'fixture.fia'));
      expected.push(['fia', fia.data.lines[0].t, fia.data.lines[0].txt, fia.data.lines[0].w, fia.offsetMs]);
      const estimated = [{ t: 1000, txt: '估算', wSynth: true, words: [{ start: 1000, end: 2000, text: '估算' }] }];
      const exportFia = JSON.parse(LyricFile.exportLyric('fia', estimated, { ncm_id: 1, name: '歌曲' }, 200));
      if (exportFia.lyrics.lines[0].words.length || exportFia.lyrics.lines[0].startTime !== 1) throw new Error('false timing exported');
      return expected;
    });
    const words = [[1000, '甲'], [1500, '乙']];
    assert.deepEqual(formats, [
      ...['lrc', 'yrc', 'qrc', 'krc', 'ttml'].map(ext => [ext, 1000, '甲乙', words]),
      ['vtt', 1000, '甲乙', []], ['fia', 1000, '甲乙', words, 200],
    ]);
    await page.route(url => url.pathname === '/cm/ncm/search', route => route.fulfill({
      json: { songs: [{ ncm_id: 2, name: '候选歌曲', artists: '测试歌手' }] },
    }));
    await page.route(url => url.pathname === '/cm/ncm/lyric', route => route.fulfill({
      json: { lines: [{ t: 500, txt: new URL(route.request().url()).searchParams.get('id') === '2' ? '候选行' : '自动行' }] },
    }));
    await page.locator('.cm-mini-inner').click();
    await page.locator('#plMore').click();
    await page.locator('#mLyricManager').click();
    await page.locator('#lyricFile').setInputFiles({
      name: 'locally-written.lrc', mimeType: 'text/plain', buffer: Buffer.from('[00:01.000]本地歌词第一行\n[00:04.000]本地歌词第二行'),
    });
    await page.locator('#lyricPreview').getByText('本地歌词第一行', { exact: false }).waitFor();
    await page.locator('#lyricUse').click();
    await page.locator('#plLyric').getByText('本地歌词第一行', { exact: true }).waitFor({ state: 'attached' });
    await page.locator('#lyricOffset').fill('250');
    await page.locator('#lyricApplyOffset').click();
    await page.getByText('已应用 250 毫秒偏移。', { exact: true }).waitFor();
    const download = page.waitForEvent('download');
    await page.locator('[data-export="lrc"]').click();
    const exported = await fs.readFile(await (await download).path(), 'utf8');
    assert(exported.startsWith('[00:01.000]本地歌词第一行\n'), 'export must keep original timestamps');
    await page.locator('#lyricLookup button').click();
    await page.getByRole('button', { name: '候选歌曲 · 测试歌手' }).click();
    await page.getByText('候选行', { exact: true }).waitFor();
    await page.locator('#lyricUse').click();
    await page.locator('#plLyric').getByText('候选行', { exact: true }).waitFor({ state: 'attached' });
    await page.locator('#lyricRemove').click();
    await page.locator('#plLyric').getByText('自动行', { exact: true }).waitFor({ state: 'attached' });
    assert.deepEqual(errors, []);
    console.log('PASS: lyrics file formats, real word timing, offset, browser export, manual lookup and restoring automatic lyrics');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
