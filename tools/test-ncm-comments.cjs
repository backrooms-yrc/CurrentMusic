const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CM_PLAYWRIGHT_MODULE || 'playwright');

const assets = path.resolve(__dirname, '../app/src/main/assets/www');
const base = 'https://music.20110208.xyz';
const row = (id, content, fields = {}) => ({ id, content, userId: 8, nickname: '测试听众', liked: 0, ...fields });

(async () => {
  const browser = await chromium.launch({ ...(process.env.CM_CHROMIUM_EXECUTABLE ?
    { executablePath: process.env.CM_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('cm.recReset', 'rec-1.28.74'));
      let releaseRecommended, receivedRecommended;
      const holdRecommended = new Promise(resolve => { releaseRecommended = resolve; });
      const startRecommended = new Promise(resolve => { receivedRecommended = resolve; });
      let hotCount = 0, floorCount = 0, rejectLike = true;
      const mutations = [];
      await page.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const q = url.searchParams;
        if (url.pathname.startsWith('/app/')) {
          const file = path.join(assets, url.pathname.slice(5) || 'index.html');
          if (fs.existsSync(file)) return route.fulfill({ path: file });
        }
        if (url.pathname === '/cm/ncm/mv/detail') return route.fulfill({ json: { data: { id: 42, name: '示例 MV' } } });
        const response = (comments, more = false, nextCursor = null) => route.fulfill({
          json: { meUid: 55, comments, total: 12, more, nextCursor },
        });
        if (url.pathname === '/cm/ncm/comments/page') {
          assert.equal(q.get('type'), '1');
          if (q.get('sort') === 'recommended') {
            receivedRecommended();
            await holdRecommended;
            return response([row('99', '过期推荐响应')]);
          }
          if (q.get('sort') === 'hot') {
            if (++hotCount === 1) return route.fulfill({ status: 502, json: { error: '暂时失败' } });
            return response([row('10', '热评正文', { replyCount: 2, liked: 12000 })]);
          }
          if (q.get('page') === '2') {
            assert.equal(q.get('cursor'), '170001');
            return response([row('20', '最新评论'), row('21', '下一页评论')]);
          }
          assert.equal(q.get('sort'), 'latest');
          return response([row('20', '最新评论')], true, '170001');
        }
        if (url.pathname === '/cm/ncm/comments/replies') {
          assert.equal(q.get('commentId'), '10');
          if (++floorCount === 1) return route.fulfill({ status: 502, json: { error: '楼层暂时失败' } });
          if (q.has('cursor')) {
            assert.equal(q.get('cursor'), '170002');
            return response([row('12', '第二条回复')]);
          }
          return response([row('11', '第一条回复', { userId: 55, likedByMe: true, liked: 1 })], true, '170002');
        }
        if (['/cm/ncm/comment', '/cm/ncm/comment/like'].includes(url.pathname)) {
          assert.equal(request.method(), 'POST');
          const body = request.postDataJSON();
          assert.equal(body.confirm, 1);
          mutations.push(body);
          if (url.pathname.endsWith('/like') && rejectLike) {
            rejectLike = false;
            return route.fulfill({ status: 502, json: { error: '操作失败' } });
          }
          return route.fulfill({ json: { code: 200 } });
        }
        return route.fulfill({ json: {} });
      });

      await page.goto(base + '/app/#/mv/42');
      await page.locator('#mvCmt').click();
      await startRecommended;
      const overlay = page.locator('#commentOverlay');
      await overlay.getByRole('button', { name: '最热', exact: true }).click();
      await overlay.getByText(/评论加载失败/).waitFor();
      await overlay.getByRole('button', { name: '重新加载' }).click();
      await overlay.getByText('热评正文').waitFor();
      releaseRecommended();
      const toggle = overlay.getByRole('button', { name: '展开 2 条回复' });
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(floorCount, 0);
      await toggle.click();
      await overlay.getByText(/回复加载失败/).waitFor();
      await overlay.getByRole('button', { name: '重试加载回复' }).click();
      const reply = overlay.locator('[data-cid="11"]');
      await reply.waitFor();
      const like = reply.locator('.cmt-like');
      assert.equal(await like.getAttribute('aria-pressed'), 'true');
      await like.click();
      await page.getByText('操作失败').waitFor();
      assert.equal(await like.getAttribute('aria-pressed'), 'true');
      await like.click();
      await reply.getByRole('button', { name: '点赞 0' }).waitFor();
      assert.equal(await like.getAttribute('aria-pressed'), 'false');
      assert.equal(await like.locator('.cmt-like-count').textContent(), '赞');
      await like.click();
      await reply.getByRole('button', { name: '点赞 1' }).waitFor();
      assert.equal(await like.locator('.cmt-like-count').textContent(), '1');
      assert.deepEqual(mutations.map(x => [x.cid, x.t]), [['11', 0], ['11', 0], ['11', 1]]);
      await overlay.getByRole('button', { name: '加载更多回复' }).click();
      await overlay.getByText('第二条回复').waitFor();
      await overlay.getByRole('button', { name: '收起回复' }).click();
      assert.equal(await reply.isVisible(), false);
      await toggle.click();
      assert.equal(await reply.isVisible(), true);
      assert.equal(floorCount, 3);
      await reply.getByRole('button', { name: '回复', exact: true }).click();
      await overlay.locator('#cmtInput').fill('回复测试');
      await overlay.locator('#cmtInput').press('Enter');
      await page.getByText('回复已同步到网易云').waitFor();
      assert.deepEqual(mutations.at(-1), { type: 1, id: 42, content: '回复测试', t: 2, commentId: '11', confirm: 1 });
      await overlay.getByRole('button', { name: '最新', exact: true }).click();
      await overlay.getByRole('button', { name: '加载更多评论' }).click();
      await overlay.getByText('下一页评论').waitFor();
      assert.equal(await overlay.getByText('最新评论', { exact: true }).count(), 1);
      assert.equal(await overlay.getByText('过期推荐响应').count(), 0);
      assert(await overlay.evaluate(el => el.scrollWidth <= el.clientWidth));
      assert.deepEqual(errors, []);
      await page.close();
      console.log(`PASS ${width}px sort races, retry, lazy replies, reply cursor, likes and posting`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
