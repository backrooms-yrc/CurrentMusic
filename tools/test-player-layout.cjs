// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

const longName = '星光下的梦想(《喜羊羊与灰太狼之兔年顶呱呱》动画电影插曲)';
const sizes = [[1920, 1056], [1280, 704], [1440, 900], [1024, 600], [900, 500],
  [844, 390], [768, 1024], [600, 480], [390, 844], [360, 640], [320, 480], [240, 240]];

async function checkLayout(page, label) {
  const layout = await page.evaluate(() => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const controls = [...document.querySelectorAll('.pl-top, .pl-ctrl, .pl-seek, .pl-transport')].map(rect);
    const cover = document.getElementById('plCover');
    return { width: innerWidth, height: innerHeight, controls,
      buttons: [...document.querySelectorAll('.pl-ctrl .pl-btn, .pl-transport .pl-btn')].map(rect),
      cover: cover.getClientRects().length ? rect(cover) : null,
      scrollWidth: document.documentElement.scrollWidth };
  });
  const details = label + ': ' + JSON.stringify(layout);
  assert(layout.scrollWidth <= layout.width, 'page must not scroll horizontally: ' + details);
  for (const r of layout.controls) {
    assert(r.width > 0 && r.height > 0, 'controls must remain visible: ' + details);
    assert(r.left >= -.5 && r.right <= layout.width + .5 && r.top >= -.5 && r.bottom <= layout.height + .5,
      'controls must stay inside viewport: ' + details);
  }
  for (let i = 1; i < layout.controls.length; i++) {
    assert(layout.controls[i].top >= layout.controls[i - 1].bottom - .5,
      'control rows must not overlap: ' + details);
  }
  for (const r of layout.buttons) {
    assert(r.left >= -.5 && r.right <= layout.width + .5 && r.bottom <= layout.height + .5,
      'every action must stay inside viewport: ' + details);
  }
  if (layout.cover && layout.cover.height > 1) {
    assert(Math.abs(layout.cover.width - layout.cover.height) < 1, 'cover must remain square: ' + details);
    assert(layout.cover.top >= layout.controls[0].bottom - .5 && layout.cover.bottom <= layout.controls[1].top + .5,
      'cover must leave controls clear: ' + details);
  }
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ?
    { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 1280);
    await page.evaluate(() => {
      MiniTest.auth.saveLogin('layout-fixture', { username: 'layout-fixture' });
      MiniTest.player.meta.pic = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="seagreen"/></svg>');
    });
    await page.locator('.cm-mini-inner').click();
    await page.locator('#plSeek').waitFor({ state: 'visible' });
    await page.locator('#playerOverlay').evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const preset of ['cmx', 'md3', 'frost', 'glass']) {
        for (const scale of [1, 1.25, 1.5]) {
          await page.evaluate(async ({ preset, scale, longName }) => {
            document.documentElement.dataset.uiPreset = preset;
            document.documentElement.style.setProperty('--cm-fs', scale);
            MiniTest.player.meta = { ...MiniTest.player.meta, name: longName,
              artists: '郭易YoYo · ' + '超长歌手名称'.repeat(8), album: '音乐原声带合辑'.repeat(8) };
            MiniTest.player.queue = [MiniTest.player.meta];
            await MiniTest.player.playAt(0); MiniTest.notifyState();
            document.getElementById('plStats').innerHTML = '<span>♥ 36.5万 红心</span><span>热度 100</span><span>评论 3262</span><span>网易云最热评论 7809 赞</span>';
          }, { preset, scale, longName });
          await checkLayout(page, `${width}x${height}/${preset}/${scale}/cover`);
          assert.equal(await page.locator('.pl-name').getAttribute('title'), longName);
          if (width < 600) {
            await page.evaluate(() => document.querySelector('.pl-body').classList.replace('view-cover', 'view-lyric'));
            await checkLayout(page, `${width}x${height}/${preset}/${scale}/lyric`);
            await page.evaluate(() => document.querySelector('.pl-body').classList.replace('view-lyric', 'view-cover'));
          }
          // A track change must recover space without rebuilding playback controls.
          await page.evaluate(async () => {
            window.layoutSlider = document.getElementById('plSeek');
            MiniTest.player.meta = { ...MiniTest.player.meta, name: 'Short', artists: 'Artist', album: '' };
            MiniTest.player.queue = [MiniTest.player.meta];
            await MiniTest.player.playAt(0); MiniTest.notifyState();
          });
          await checkLayout(page, `${width}x${height}/${preset}/${scale}/short`);
          assert(await page.evaluate(() => layoutSlider === document.getElementById('plSeek')));
        }
      }
      console.log(`PASS player layout ${width}x${height}: four skins, long/short metadata, late statistics, enlarged fonts, view switching`);
    }
    // Even when controls alone exceed a very short window, neither end is clipped.
    await page.setViewportSize({ width: 900, height: 260 });
    await page.evaluate(async () => {
      document.documentElement.dataset.uiPreset = 'cmx';
      MiniTest.player.meta = { ...MiniTest.player.meta, name: 'LongTitleWithoutSpaces'.repeat(12) };
      MiniTest.player.queue = [MiniTest.player.meta];
      await MiniTest.player.playAt(0); MiniTest.notifyState();
    });
    for (const id of ['plLike', 'plSeek', 'plPlay']) {
      await page.locator('#' + id).scrollIntoViewIfNeeded();
      assert(await page.locator('#' + id).evaluate(el => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), 'extreme height must keep ' + id + ' reachable');
    }
    console.log('PASS extreme height: all playback controls remain reachable by scrolling');
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
