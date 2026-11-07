// Build the Web bundle first. Browser settings match test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const origin = 'https://music.20110208.xyz';
const assets = path.resolve(__dirname, '../app/src/main/assets/www');
const android = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const desktop = android.replace('Linux; Android 14; K', 'X11; Linux x86_64');
const tracks = Array.from({ length: 12 }, (_, i) => ({
  ncm_id: i + 1, name: `Fixture song ${i + 1}`, artists: 'Fixture artist',
  pic: origin + '/app/brand-icon.png', duration: 240000,
}));

async function openHome(browser, options, { preset = 'cmx', font = 'standard' } = {}) {
  const page = await browser.newPage({ reducedMotion: 'reduce', ...options });
  await page.addInitScript(({ preset, font, song }) => {
    localStorage.setItem('cm.recReset', 'rec-1.28.74');
    localStorage.setItem('cm.uiPreset', preset);
    localStorage.setItem('cm.fontScale', font);
    localStorage.setItem('cm.lastq', JSON.stringify({ queue: [song], index: 0 }));
  }, { preset, font, song: tracks[0] });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith('/app/')) {
      const name = url.pathname.slice('/app/'.length) || 'index.html';
      if (['index.html', 'app.css', 'app.js', 'brand-icon.png', 'material-icons-outlined.woff2'].includes(name)) {
        return route.fulfill({ path: path.join(assets, name) });
      }
    }
    if (url.pathname === '/cm/bootstrap') return route.fulfill({ json: { daily: { daily: tracks, forYou: tracks } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(origin + '/app/#/home');
  await page.locator('#dailyRow .cm-card').first().waitFor();
  await page.locator('#boot').waitFor({ state: 'hidden' });
  return page;
}

async function geometry(page) {
  return page.evaluate(() => {
    const out = document.getElementById('out');
    const card = out.querySelector('#dailyRow .cm-card');
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    return {
      width: innerWidth, zoom: visualViewport.scale, overflow: out.scrollWidth - out.clientWidth,
      card: card.getBoundingClientRect().width, image: card.querySelector('img').getBoundingClientRect().width,
      shortcut: rect('.cm-quick').height, song: rect('.cm-song').height, nav: rect('#bottomNav').width,
      navTarget: rect('.navItem.cur').height, mini: rect('#mini').width,
      titleFont: parseFloat(getComputedStyle(document.getElementById('pageTitle')).fontSize),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ?
    { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const [label, userAgent, isMobile] of [
      ['Chrome Android', android, true], ['Edge Android', android + ' EdgA/131.0.0.0', true],
      ['Android desktop site', desktop, false],
    ]) {
      const portrait = { width: 800, height: 1100 };
      const page = await openHome(browser, { viewport: portrait, userAgent, isMobile, hasTouch: true, deviceScaleFactor: 2 });
      for (const viewport of [portrait, { width: 1100, height: 620 }, { width: 600, height: 840 }]) {
        await page.setViewportSize(viewport);
        const g = await geometry(page);
        assert.equal(g.width, viewport.width);
        assert.equal(g.zoom, 1);
        assert(g.overflow <= 0 && g.card === 128 && g.image === 128 && g.shortcut < 100 && g.song <= 60, JSON.stringify(g));
        assert(g.navTarget >= 44 && g.mini <= 640);
        assert(g.nav <= (viewport.width < 900 ? 480 : 88), JSON.stringify(g));
      }
      await page.locator('#bottomNav [href="#/library"]').tap();
      await page.waitForURL('**/#/library');
      await page.locator('.cm-mini-inner').tap();
      await page.locator('#plSeek').waitFor({ state: 'visible' });
      assert(await page.locator('#plCover').evaluate(el => el.getBoundingClientRect().width <= 290));
      const play = await page.locator('#plPlay').boundingBox();
      assert(play && play.y >= 0 && play.y + play.height <= page.viewportSize().height);
      console.log('PASS', label, 'portrait, landscape and 600px split view');
      await page.close();
    }

    const tablet = { viewport: { width: 800, height: 1100 }, userAgent: android, isMobile: true, hasTouch: true };
    for (const preset of ['frost', 'glass', 'md3', 'aimo', 'soaringbird']) {
      const page = await openHome(browser, tablet, { preset });
      const g = await geometry(page);
      assert(g.overflow <= 0 && g.card === 128 && g.image === 128, `${preset}: ${JSON.stringify(g)}`);
      if (preset === 'soaringbird') {
        const cards = await page.locator('.cm-hero__card').evaluateAll(els => els.map(el => el.getBoundingClientRect().y));
        assert.equal(cards.length, 2);
        assert.equal(cards[0], cards[1]);
      }
      await page.close();
    }

    const page = await openHome(browser, tablet, { font: 'xl' });
    assert(Math.abs((await geometry(page)).titleFont - 23 * 1.28) < .1, 'saved font setting still applies');
    await page.setViewportSize({ width: 840, height: 390 });
    assert.equal((await geometry(page)).card, 150, 'landscape phones use existing layout');
    await page.setViewportSize({ width: 390, height: 840 });
    assert.equal((await geometry(page)).card, 117, 'portrait phones use existing layout');
    await page.close();

    const mouse = await openHome(browser, { viewport: tablet.viewport });
    assert.equal((await geometry(mouse)).card, 150, 'mouse desktops use existing layout');
    await mouse.close();
    console.log('PASS tablet themes, font preferences, phone and desktop scope');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
