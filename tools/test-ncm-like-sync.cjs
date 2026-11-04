// Same Playwright/Chromium environment variables as test-mini-progress.cjs.
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');
const { fixture } = require('./test-mini-progress.cjs');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ? { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    const { page, context, errors } = await fixture(browser, 390);
    await page.evaluate(() => {
      MiniTest.auth.saveLogin('like-fixture-session', { username: 'fixture' });
      MiniTest.api.bindStatus = async () => ({ bound: true });
      window.listRequests = 0;
      MiniTest.api.ncmLikelist = () => { listRequests++; return new Promise(resolve => { window.resolveList = resolve; }); };
      window.firstList = MiniTest.ensureNcmLiked(); window.secondList = MiniTest.ensureNcmLiked();
    });
    assert.equal(await page.evaluate(() => listRequests), 1);
    await page.evaluate(async () => {
      MiniTest.setNcmLiked('1', true); resolveList({ ids: [] }); await Promise.all([firstList, secondList]);
    });
    assert(await page.evaluate(() => MiniTest.isNcmLiked(1)), 'late list must not erase a successful like');
    await page.evaluate(async () => {
      MiniTest.resetNcmLiked(); window.oldList = MiniTest.ensureNcmLiked(); window.resolveOld = resolveList;
      MiniTest.auth.saveLogin('other-fixture-session', { username: 'other' });
      MiniTest.api.ncmLikelist = async () => ({ ids: ['2'] }); await MiniTest.ensureNcmLiked();
      resolveOld({ ids: [1] }); await oldList;
    });
    assert(await page.evaluate(() => MiniTest.isNcmLiked('2')));
    assert.equal(await page.evaluate(() => MiniTest.isNcmLiked(1)), false);
    await page.evaluate(async () => {
      MiniTest.resetNcmLiked(); window.attempts = 0;
      MiniTest.api.ncmLikelist = async () => { if (++attempts === 1) throw Error('temporary'); return { ids: ['1'] }; };
      await MiniTest.ensureNcmLiked(); await MiniTest.ensureNcmLiked();
    });
    assert.equal(await page.evaluate(() => attempts), 2);
    assert(await page.evaluate(() => MiniTest.isNcmLiked(1)));
    await page.evaluate(async () => {
      MiniTest.resetNcmLiked(); MiniTest.resetNcmBound(); MiniTest.settings.likeMode = 'ncm';
      MiniTest.api.ncmLikelist = async () => ({ ids: [] });
      MiniTest.api.ncmLike = async (song, like) => ({ liked: like, count: 8 });
      MiniTest.api.songsStatus = () => new Promise(resolve => { (window.statsResolvers ||= []).push(resolve); });
      await MiniTest.ensureNcmLiked();
    });
    await page.locator('.cm-mini-inner').click(); await page.locator('#plLike').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#plLike .material-icons-outlined').textContent === 'favorite_border');
    await page.locator('#plLike').click();
    await page.waitForFunction(() => document.querySelector('#plLike .material-icons-outlined').textContent === 'favorite');
    assert(await page.locator('#plLike').evaluate(el => el.classList.contains('on')));
    await page.evaluate(() => statsResolvers.splice(0).forEach(resolve => resolve({ liked: [], ncmCounts: { 1: 9 } })));
    assert.equal(await page.locator('#plLike .material-icons-outlined').innerText(), 'favorite');
    await page.locator('#plLike').click();
    await page.waitForFunction(() => document.querySelector('#plLike .material-icons-outlined').textContent === 'favorite_border');
    assert.deepEqual(errors, []);
    console.log('PASS NetEase hearts: single-flight list reads, late-response protection, normalized IDs, account isolation, retry after failure and immediate filled/outline UI before slow statistics finish');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
