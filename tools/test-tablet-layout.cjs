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

async function openHome(browser, options, { preset = 'cmx', font = 'standard', windowWidth } = {}) {
  const page = await browser.newPage({ reducedMotion: 'reduce', ...options });
  await page.addInitScript(({ preset, font, song, windowWidth }) => {
    if (windowWidth) Object.defineProperty(window, 'outerWidth', { value: windowWidth });
    document.addEventListener('opened', event => {
      if (event.target.matches('mdui-dialog')) event.target.dataset.fixtureOpened = 'true';
    }, true);
    localStorage.setItem('cm.recReset', 'rec-1.28.74');
    localStorage.setItem('cm.uiPreset', preset);
    localStorage.setItem('cm.fontScale', font);
    localStorage.setItem('cm.lastq', JSON.stringify({ queue: [song], index: 0 }));
  }, { preset, font, song: tracks[0], windowWidth });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && url.pathname.startsWith('/app/')) {
      const name = url.pathname.slice('/app/'.length) || 'index.html';
      if (['index.html', 'app.css', 'app.js', 'brand-icon.png', 'material-icons-outlined.woff2'].includes(name)) {
        return route.fulfill({ path: path.join(assets, name) });
      }
    }
    if (url.pathname === '/cm/bootstrap') return route.fulfill({ json: { daily: { daily: tracks, forYou: tracks } } });
    if (url.pathname === '/cm/announcements') {
      return route.fulfill({ json: { items: [{ title: 'Fixture announcement', body: ('This is a test paragraph. '.repeat(8) + '\n\n').repeat(8) }] } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(origin + '/app/#/home');
  await page.locator('#dailyRow .cm-card').first().waitFor();
  await page.locator('#boot').waitFor({ state: 'hidden' });
  await page.locator('mdui-dialog[data-fixture-opened] .cm-ann').waitFor();
  return page;
}

async function geometry(page) {
  return page.evaluate(() => {
    const out = document.getElementById('out');
    const sizes = {};
    for (const [key, element] of Object.entries({
      rail: document.getElementById('bottomNav'), top: document.getElementById('topbar'),
      dialog: document.querySelector('mdui-dialog').shadowRoot.querySelector('[part="panel"]'),
      announcement: document.querySelector('.cm-ann'), cover: out.querySelector('#dailyRow .cm-card img'),
      song: out.querySelector('.cm-song'), mini: document.getElementById('mini'),
    })) {
      const r = element.getBoundingClientRect();
      sizes[key] = [r.x, r.width, r.height].map(value => value * devicePixelRatio);
    }
    const scale = Number(getComputedStyle(document.documentElement).zoom);
    return {
      sizes, scale, width: innerWidth / scale, overflow: out.scrollWidth - out.clientWidth,
      font: getComputedStyle(document.documentElement).getPropertyValue('--cm-fs'),
    };
  });
}

function assertParity(actual, expected, label) {
  for (const key of Object.keys(expected)) {
    for (let i = 0; i < expected[key].length; i++) {
      assert(Math.abs(actual[key][i] - expected[key][i]) <= 3,
        `${label} ${key}: ${actual[key]} vs ${expected[key]}`);
    }
  }
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ?
    { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const screen = { width: 1280, height: 800 };
    const pc = await openHome(browser, { viewport: { width: 1280, height: 655 } });
    const expected = await geometry(pc);
    await pc.close();
    for (const [label, userAgent, windowWidth, dpr] of [
      ['Android Chrome desktop site', desktop, 1280, 1.2],
      ['Android Edge', android + ' EdgA/131.0.0.0', 1280, 1.2],
      ['Low-density Android tablet', android, 1067, 1.2],
      ['High-density tablet with browser zoom', desktop, 1280, 2.4],
    ]) {
      const page = await openHome(browser, { viewport: { width: 1067, height: 546 }, screen,
        userAgent, isMobile: userAgent.includes('Android'), hasTouch: true, deviceScaleFactor: dpr }, { windowWidth });
      const g = await geometry(page);
      assert(Math.abs(g.scale - 1 / 1.2) < .002 && g.overflow <= 0 && Math.abs(g.width - 1280) <= 1, `${label}: ${JSON.stringify(g)}`);
      const density = dpr / 1.2;
      const sizes = Object.fromEntries(Object.entries(g.sizes).map(([key, values]) => [key, values.map(value => value / density)]));
      assertParity(sizes, expected.sizes, label);
      await page.getByText('知道了', { exact: true }).tap();
      await page.locator('.cm-ann').waitFor({ state: 'hidden' });
      await page.locator('#bottomNav [href="#/library"]').tap();
      await page.waitForURL('**/#/library');
      await page.locator('.cm-mini-inner').tap();
      await page.locator('#plSeek').waitFor({ state: 'visible' });
      const play = await page.locator('#plPlay').boundingBox();
      assert(play && play.y >= 0 && play.y + play.height <= page.viewportSize().height);
      console.log('PASS', label, 'desktop-sized shell, artwork and modal; touch navigation');
      await page.close();
    }

    const portrait = { viewport: { width: 667, height: 917 }, screen: { width: 800, height: 1280 },
      userAgent: android, isMobile: true, hasTouch: true, deviceScaleFactor: 1.2 };
    const page = await openHome(browser, portrait, { font: 'xl', windowWidth: 800 });
    const g = await geometry(page);
    assert(g.scale < 1 && g.font.trim() === '1.28' && g.overflow <= 0);
    await page.getByText('知道了', { exact: true }).tap();
    await page.locator('.cm-ann').waitFor({ state: 'hidden' });
    const selected = page.locator('#bottomNav [aria-current="page"]');
    const indicator = page.locator('#navDrop');
    await page.waitForFunction(() => document.getElementById('navDrop').getBoundingClientRect().width > 0);
    const [item, pill] = await Promise.all([selected.boundingBox(), indicator.boundingBox()]);
    assert(Math.abs(item.x + item.width / 2 - pill.x - pill.width / 2) < 2, 'bottom indicator stays centered');
    const target = await page.locator('#bottomNav [href="#/library"]').boundingBox();
    const cdp = await page.context().newCDPSession(page);
    const y = item.y + item.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: item.x + item.width / 2, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x + target.width / 2, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForURL('**/#/library');
    await page.setViewportSize({ width: 510, height: 917 });
    assert.equal(await page.evaluate(() => Number(getComputedStyle(document.documentElement).zoom)), 1);
    await page.close();

    for (const [options, windowWidth] of [
      [{ viewport: { width: 390, height: 800 }, screen: { width: 390, height: 844 }, userAgent: android, isMobile: true, hasTouch: true, deviceScaleFactor: 1.2 }, 468],
      [{ viewport: { width: 800, height: 1050 }, screen, userAgent: desktop, hasTouch: true, deviceScaleFactor: 2 }, 800],
      [{ viewport: { width: 1067, height: 546 }, screen, userAgent: desktop, deviceScaleFactor: 1.2 }, 1280],
    ]) {
      const page = await openHome(browser, options, { windowWidth });
      assert.equal((await geometry(page)).scale, 1);
      await page.close();
    }
    console.log('PASS portrait drag, split view, font preferences, and phone/desktop scale');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
