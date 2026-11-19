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
    const key = 'a'.repeat(48), session = 'b'.repeat(64);
    const cover = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=';
    const song = { id: 'FixtureSong', qq_mid: 'FixtureSong', qq_id: '18', name: 'QQ 测试曲', artists: '测试歌手', duration: 12000 };
    const observed = [];
    await page.route('**/cm/qqmusic/**', route => {
      const request = route.request(), url = new URL(request.url());
      const path = url.pathname.slice('/cm/qqmusic'.length), headers = request.headers();
      observed.push({ path, headers, body: request.postDataJSON?.() || null });
      const responses = {
        '/login/channels': { code: 200, data: { channels: ['qqmusic', 'qq'] } },
        '/login/qr/key': { code: 200, data: { unikey: key } },
        '/login/qr/create': { code: 200, data: { qrimg: cover } },
        '/login/qr/check': { code: 803, data: { session } },
        '/login/status': { code: 200, data: { profile: { nickname: '测试 QQ' } } },
        '/search': { songs: [song], hasMore: { song: false } },
        '/native/search/hot': { code: 200, hotkeys: [{ keyword: '本周热搜' }] },
        '/native/search/suggest': { code: 200, suggestions: ['音符候选'] },
        '/native/comment/hot': { code: 200, comments: [{ id: 'hot', nick: '听众', content: '热门 QQ 评论' }] },
        '/native/comment/new': { code: 200, comments: [{ id: 'new', nick: '听众', content: '最新 QQ 评论' }] },
        '/song/url': { url: base + 'tone.wav', level: 'standard' },
        '/lyric': { source: 'qqmusic:lrc', lines: [{ t: 1000, txt: 'QQ 歌词测试' }] },
        '/logout': { code: 200 },
      };
      return route.fulfill({ json: responses[path] || {}, status: responses[path] ? 200 : 404 });
    });
    await page.evaluate(() => {
      const { auth, player, setClockSource, renderQqMusic } = MiniTest;
      auth.saveLogin('mock-qq-owner', { id: 1, username: 'qq-test-owner' });
      player.setPlayMode('order');
      setClockSource(null);
      renderQqMusic(document.getElementById('out'));
    });
    await page.locator('#qqConnect').click();
    await page.locator('#qqMakeCode').click();
    await page.getByText('测试 QQ', { exact: true }).waitFor();
    assert.equal(observed.find(row => row.path === '/login/qr/key').body.channel, 'qqmusic');
    assert.equal(observed.find(row => row.path === '/login/qr/check').body.key, key);
    assert.equal(observed.find(row => row.path === '/login/status').headers['x-qq-session'], session);
    await page.locator('#qqKeyword').fill('音符');
    await page.getByRole('button', { name: '音符候选' }).click();
    await page.getByRole('button', { name: '评论', exact: true }).click();
    await page.getByText('热门 QQ 评论').waitFor();
    await page.getByRole('button', { name: '最新' }).click();
    await page.getByText('最新 QQ 评论').waitFor();
    await page.locator('mdui-dialog[open]').getByText('关闭', { exact: true }).click();
    await page.getByRole('button', { name: /QQ 测试曲/ }).click();
    await page.waitForFunction(() => {
      const { player } = MiniTest;
      return player.meta?.provider === 'qqmusic' && player.audio.currentTime > 0;
    }, null, { timeout: 17000 });
    await page.locator('.cm-mini-inner').click();
    await page.getByText('QQ 歌词测试', { exact: true }).waitFor({ state: 'attached' });
    assert.equal(observed.find(row => row.path === '/song/url').headers['x-qq-session'], session);
    assert.equal(await page.locator('#plHeart').isVisible(), false);
    await page.evaluate(() => {
      MiniTest.auth.saveLogin('mock-other-owner', { id: 2, username: 'other-owner' });
      MiniTest.renderQqMusic(document.getElementById('out'));
    });
    await page.locator('#qqConnect').waitFor();
    await page.locator('#qqKeyword').fill('音符');
    await page.locator('#qqSearch button[type=submit]').click();
    await page.getByRole('button', { name: /QQ 测试曲/ }).waitFor();
    const search = observed.filter(row => row.path === '/search').at(-1);
    assert.equal(search.headers['x-qq-session'], undefined);
    assert.deepEqual(errors, []);
    console.log('PASS: QQ QR, session isolation, catalog search, shared player and QQ lyric requests');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
