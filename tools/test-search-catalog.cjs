// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 390);
    await page.evaluate(() => {
      window.searchOffsets = [];
      MiniTest.api.search = async (keywords, offset, limit, type) => {
        if (type !== 'song') return { [type + 's']: [], totals: { [type]: 0 }, hasMore: { [type]: false } };
        searchOffsets.push(offset);
        return { songs: Array.from({ length: 10 }, (_, i) => ({ ncm_id: offset + i + 100, name: '搜索结果' + (offset + i), artists: '其他歌手' })),
          ...(offset ? {} : { catalogSongs: [{ ncm_id: 1, name: '七里香', artists: '周杰伦', album: '七里香' }] }),
          totals: { song: 30 }, hasMore: { song: offset < 20 } };
      };
      MiniTest.api.songsStatus = async () => ({ liked: [], ncmCounts: {} });
      MiniTest.renderSearch(document.getElementById('out'), { query: { q: '七里香' } });
    });
    await page.waitForFunction(() => document.querySelectorAll('#songList .cm-song').length === 11);
    assert((await page.locator('#songList .cm-song').first().innerText()).includes('周杰伦'));
    await page.locator('[data-more="song"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#songList .cm-song').length === 21);
    assert.deepEqual(await page.evaluate(() => searchOffsets), [0, 10]);
    assert.equal(await page.locator('#songList .cm-song').filter({ hasText: '周杰伦' }).count(), 1);
    await page.evaluate(() => {
      MiniTest.api.search = async (_, offset, limit, type) => ({ [type === 'song' ? 'songs' : type + 's']: [],
        ...(type === 'song' ? { catalogSongs: [{ ncm_id: 1, name: '七里香', artists: '周杰伦' }] } : {}),
        totals: { [type]: 0 }, hasMore: { [type]: false } });
      MiniTest.renderSearch(document.getElementById('out'), { query: { q: '七里香' } });
    });
    await page.waitForFunction(() => document.querySelectorAll('#songList .cm-song').length === 1);
    assert.equal(await page.locator('[data-k="song"] i').innerText(), '1');
    assert.deepEqual(errors, []);
    console.log('PASS exact album catalog match appears first, standard results stay intact and load-more uses upstream offset without skips or duplicates');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
