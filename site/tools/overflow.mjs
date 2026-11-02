/**
 * 横向溢出定位（仅本机排查用）
 * 在指定视口下找出所有右边界超出视口的元素，便于定位响应式问题。
 * 用法：CDP_WS=ws://... node tools/overflow.mjs [width]
 */
const W = Number(process.argv[2] || 320);
const H = Number(process.argv[3] || 640);
const ws = new WebSocket(process.env.CDP_WS);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
});
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
const wait = ms => new Promise(r => setTimeout(r, ms));

ws.addEventListener('open', async () => {
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: W < 900, screenWidth: W, screenHeight: H,
  });
  await send('Page.navigate', { url: process.env.SITE_URL || 'http://127.0.0.1:8899/' });
  await wait(3000);

  const out = await evaluate(`(() => {
    const vw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > vw + 0.5 || r.left < -0.5) {
        // 只报告自身溢出、而非被父级裁掉的元素
        bad.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.toString().slice(0, 70)) || '',
          left: +r.left.toFixed(1), right: +r.right.toFixed(1), w: +r.width.toFixed(1),
        });
      }
    });
    return {
      vw,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      bad: bad.slice(0, 25),
      total: bad.length,
    };
  })()`);

  console.log(JSON.stringify(out, null, 1));
  ws.close();
  process.exit(0);
});
