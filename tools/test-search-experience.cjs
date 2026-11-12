// Chromium fixture with intercepted APIs and a decodable local test track.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture, base } = require('./test-mini-progress.cjs');

async function verifyImmediateStart(browser, level, userAgent) {
  const { page, context, errors } = await fixture(browser, 390, userAgent ? {
    initScript: `Object.defineProperty(navigator, 'userAgent', { value: ${JSON.stringify(userAgent)} });`,
  } : {});
  try {
    await page.evaluate(({ level, url }) => {
      const { api, auth, player, setClockSource } = MiniTest;
      auth.saveLogin('fixture-token', { id: 1, username: 'fixture' });
      setClockSource(null);
      api.songUrl = async () => ({ url, level });
      // Simulate a stream that never reports enough data for the fixed startup buffer.
      Object.defineProperty(player.audio, 'buffered', { value: { length: 0 } });
      document.getElementById('play').onclick = () => {
        player.playList([{ ncm_id: 32, name: '音源测试', duration: 12000 }]);
      };
    }, { level, url: base + 'tone.wav' });
    await page.locator('#play').click();
    await page.waitForFunction(() => MiniTest.player.audio.currentTime > 0, null, { timeout: 4000 });
    if (userAgent) assert.equal(await page.evaluate(() => MiniTest.player.audio.crossOrigin), null);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

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
      window.suggestions = [];
      window.originalSongUrl = api.songUrl;
      const songs = [
        { ncm_id: 11, name: '慢音源', duration: 12000 },
        { ncm_id: 22, name: '新音源', duration: 12000 },
      ];
      api.searchDefault = async () => ({ data: { realkeyword: '测试关键词', showKeyword: '推荐词' } });
      api.searchSuggest = async () => ({ result: { allMatch: [] } });
      api.ncm = async (path, query) => {
        calls.push([path, query]);
        if (path === '/search/suggest/pc') {
          return new Promise(resolve => suggestions.push(resolve));
        }
        if (path === '/search/multimatch') return { result: { artist: [{ id: 42, name: '示例歌手' }] } };
        if (path === '/song/url') return { data: [{ url: 'preview.wav', freeTrialInfo: { start: 0, end: 30 } }] };
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
    const type = value => input.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    const skeleton = page.getByRole('status', { name: '搜索候选加载中' });
    await type('先取消这条');
    await skeleton.waitFor();
    await input.dispatchEvent('keydown', { key: 'ArrowDown' });
    await page.waitForFunction(() => suggestions.length === 1);
    await input.dispatchEvent('keydown', { key: 'Escape' });
    await skeleton.waitFor({ state: 'detached' });
    await type('试着输入');
    await page.waitForFunction(() => suggestions.length === 2);
    await page.evaluate(() => suggestions[0]({ data: { suggests: [{ keyword: '已过期' }] } }));
    assert(await skeleton.isVisible());
    await page.evaluate(() => suggestions[1]({ data: { suggests: [{ keyword: '测试关键词' }, { keyword: '测试关键词' }] } }));
    const suggestion = page.locator('.cm-sug-item');
    await suggestion.waitFor();
    assert.equal(await skeleton.count(), 0);
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

    await page.route(url => url.pathname === '/cm/ncm/song/url', route => route.fulfill({
      status: 502, json: { code: 'playback_match_failed', error: 'fixture 音源失败' },
    }));
    await page.evaluate(() => { MiniTest.api.songUrl = originalSongUrl; });
    await second.click();
    await busy(second).waitFor({ state: 'hidden' });
    await page.getByText(/fixture 音源失败/).waitFor();
    assert.equal(await page.evaluate(() => calls.some(([path]) => path === '/song/url/match')), false);
    assert(await page.evaluate(() => calls.some(([path]) => path === '/song/url')));

    await type('按钮搜索');
    await page.waitForFunction(() => suggestions.length === 3);
    await page.evaluate(() => suggestions[2]({ data: { suggests: [] } }));
    await skeleton.waitFor({ state: 'detached' });
    const searchButton = page.locator('.cm-search-submit > mdui-button');
    assert.equal(await searchButton.locator('[slot="icon"]').textContent(), 'search');
    await searchButton.getByRole('button', { name: '搜索', exact: true }).click();
    await searchButton.locator('mdui-ripple .wave').waitFor({ state: 'attached' });
    assert(await page.evaluate(() => calls.some(([path, query]) => path === 'search' && query.keyword === '按钮搜索')));
    assert.deepEqual(errors, []);
    await verifyImmediateStart(browser, 'matched');
    await verifyImmediateStart(browser, 'standard', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1');
    console.log('PASS search skeleton and ripple, search tabs, playback loading, match failure and immediate/native playback');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
