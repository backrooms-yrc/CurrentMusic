// Chromium fixture with intercepted APIs and a decodable local test track.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');

(async () => {
  const browser = await chromium.launch({
    ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const { page, errors } = await fixture(browser, 390);
    await page.evaluate(() => {
      const { api, auth, player, setClockSource, renderSearch } = MiniTest;
      auth.saveLogin('fixture-token', { id: 1, username: 'fixture' });
      setClockSource(null);
      player.setPlayMode('shuffle');
      window.calls = [];
      window.pending = [];
      const songs = [
        { ncm_id: 11, name: '慢音源', duration: 12000 },
        { ncm_id: 22, name: '新音源', duration: 12000 },
      ];
      api.searchDefault = async () => ({ data: { realkeyword: '测试关键词', showKeyword: '推荐词' } });
      api.searchSuggest = async () => ({ result: { allMatch: [] } });
      api.ncm = async (path, query) => {
        calls.push([path, query]);
        if (path === '/search/suggest/pc') {
          return { data: { suggests: [{ keyword: '测试关键词' }, { keyword: '测试关键词' }] } };
        }
        if (path === '/search/multimatch') return { result: { artist: [{ id: 42, name: '示例歌手' }] } };
        return {};
      };
      api.search = async (keyword, offset, limit, type) => {
        calls.push(['search', { keyword, offset, limit, type }]);
        if (type === 'lyric') return {
          songs: offset ? [] : [{ ...songs[1], lyricContext: [
            { txt: '前一句' }, { txt: '命中的一句', matched: true }, { txt: '后一句' },
          ] }], totals: { song: 2 }, hasMore: { song: !offset },
        };
        return type === 'song' ? { songs } : {};
      };
      api.songUrl = id => new Promise((resolve, reject) => pending.push({ id, resolve, reject }));
      return renderSearch(document.getElementById('out'));
    });
    const input = page.locator('#kw');
    await input.evaluate(el => {
      el.value = '试着输入';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const suggestion = page.locator('.cm-sug-item');
    await suggestion.waitFor();
    assert.equal(await suggestion.count(), 1, 'duplicate suggestions collapse');
    assert(await page.evaluate(() => calls.some(([path, query]) => path === '/search/suggest/pc' && query.keyword === '试着输入')));
    assert.equal(await page.evaluate(() => calls.filter(([path]) => path === 'search').length), 0);
    await input.dispatchEvent('keydown', { key: 'ArrowDown' });
    assert(await suggestion.evaluate(el => document.activeElement === el));
    await page.keyboard.press('Enter');

    const first = page.locator('.cm-song[data-song-id="11"]');
    const second = page.locator('.cm-song[data-song-id="22"]');
    const busy = row => row.locator('.cm-song-loading');
    await first.click();
    await busy(first).waitFor();
    await page.locator('#miniPlay .cm-play-spinner').waitFor();
    await first.click();
    await page.locator('#miniPlay').click();
    assert.deepEqual(await page.evaluate(() => pending.map(item => item.id)), [11]);

    await second.click();
    await busy(first).waitFor({ state: 'hidden' });
    await busy(second).waitFor();
    await page.evaluate(url => pending[0].resolve({ url, level: 'standard' }), base + 'tone.wav');
    assert.equal(await page.evaluate(() => MiniTest.player.meta.ncm_id), 22);
    await page.evaluate(url => pending[1].resolve({ url, level: 'standard' }), base + 'tone.wav');
    await page.waitForFunction(() => MiniTest.player.starting);
    await busy(second).waitFor();
    await second.click();
    assert.deepEqual(await page.evaluate(() => pending.map(item => item.id)), [11, 22]);
    await busy(second).waitFor({ state: 'hidden', timeout: 15000 });
    await page.waitForFunction(() => MiniTest.player.audio.currentTime > 0);

    await page.locator('#srchTabs [data-k="match"]').click();
    assert.equal(await page.getByRole('link', { name: /示例歌手/ }).getAttribute('href'), '#/artist/42');
    assert(await page.evaluate(() => calls.some(([path, query]) => path === '/search/multimatch' && query.keywords === '测试关键词')));
    await page.locator('#srchTabs [data-k="lyric"]').click();
    assert.equal(await page.locator('.cm-song-lyric mark').textContent(), '命中的一句');
    await page.locator('#srchPanel [data-more="lyric"]').click();
    await page.locator('#srchPanel [data-more="lyric"]').waitFor({ state: 'detached' });
    assert(await page.evaluate(() => calls.some(([path, query]) => path === 'search' && query.type === 'lyric' && query.offset === 1)));

    await second.click();
    await busy(second).waitFor();
    await page.evaluate(() => pending[2].reject(new Error('fixture 音源失败')));
    await busy(second).waitFor({ state: 'hidden' });
    await page.getByText(/fixture 音源失败/).waitFor();
    assert.deepEqual(errors, []);
    console.log('PASS search suggestions, lyrics and pagination, keyword matching, playback loading, duplicate taps and stale requests');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
