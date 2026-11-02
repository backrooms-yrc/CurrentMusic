/**
 * 无头浏览器验收脚本（仅用于本机验证，不参与站点产物）
 * 通过 CDP 打开构建后的页面，检查：组件是否升级、主题切换、图标字形、
 * 移动端抽屉、复制按钮、横向溢出、控制台报错，并输出截图。
 */
const BASE = process.env.SITE_URL || 'http://127.0.0.1:8899/';
const WS = process.env.CDP_WS;
const OUT = process.env.SHOT_DIR || '/tmp/shots';

let id = 0;
const pending = new Map();
const events = [];
const ws = new WebSocket(WS);

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
  });

const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    logs.push('[network/log] ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
  events.push(m);
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const wait = ms => new Promise(r => setTimeout(r, ms));

const setViewport = (width, height, mobile = false) =>
  send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile,
    screenWidth: width, screenHeight: height,
  });

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const fs = await import('node:fs/promises');
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
};

const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok, label, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

ws.addEventListener('open', async () => {
  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    /* ── 桌面端 ── */
    await setViewport(1440, 900);
    await send('Page.navigate', { url: BASE });
    await wait(3000);

    check(await evaluate(`!!customElements.get('mdui-button')`), 'MDUI 自定义元素已注册');
    check(await evaluate(`document.querySelectorAll('mdui-button').length >= 8`), '按钮组件存在');

    // 组件内部渲染（shadow DOM）成功 → 说明 MDUI 样式生效
    check(await evaluate(`(()=>{const b=document.querySelector('mdui-button');return !!(b&&b.shadowRoot&&b.shadowRoot.querySelector('[part=button]'))})()`),
      '按钮 shadow DOM 已渲染');

    // 图标字形：连字会把图标名合成为单个字形，宽度应接近 font-size；
    // 若退化成按字母排版，宽度会大好几倍（这正是之前图标显示成文字的故障）。
    const glyph = await evaluate(`(() => {
      const measure = (family, text) => {
        const s = document.createElement('span');
        s.style.position = 'absolute';
        s.style.visibility = 'hidden';
        s.style.fontSize = '24px';
        s.style.fontFeatureSettings = '"liga"';
        s.style.fontFamily = family;
        s.textContent = text;
        document.body.appendChild(s);
        const w = s.getBoundingClientRect().width;
        s.remove();
        return w;
      };
      return {
        icon: measure('"Material Icons Outlined", sans-serif', 'music_note'),
        plain: measure('sans-serif', 'music_note'),
      };
    })()`);
    check(glyph.icon < 40 && glyph.plain > 60, '图标字体(liga)已生效：图标名合成为单个字形',
      `图标宽 ${glyph.icon.toFixed(1)}px vs 字母排版 ${glyph.plain.toFixed(1)}px`);
    check(await evaluate(`[...document.querySelectorAll('mdui-icon')].every(e => {
      const cs = getComputedStyle(e);
      return cs.fontFamily.includes('Material Icons') && cs.fontFeatureSettings.includes('liga');
    })`), '所有 mdui-icon 均应用图标字体与 liga');

    // 主题切换
    const themeBefore = await evaluate(`document.documentElement.classList.contains('mdui-theme-dark')`);
    await evaluate(`document.getElementById('themeToggle').click()`);
    await wait(400);
    const themeAfter = await evaluate(`document.documentElement.classList.contains('mdui-theme-dark')`);
    check(themeBefore !== themeAfter, '主题切换生效', `${themeBefore ? 'dark' : 'light'} → ${themeAfter ? 'dark' : 'light'}`);
    check(await evaluate(`localStorage.getItem('cm.theme')`) === (themeAfter ? 'dark' : 'light'), '主题偏好已持久化');

    // 亮/暗底色确实不同
    const bgLight = await evaluate(`getComputedStyle(document.body).backgroundColor`);

    await evaluate(`document.getElementById('themeToggle').click()`); await wait(300);
    const bgBack = await evaluate(`getComputedStyle(document.body).backgroundColor`);
    check(bgLight !== bgBack, '浅色/深色底色不同', `${bgLight} vs ${bgBack}`);

    // 页面横向不溢出
    check(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
      '桌面端无横向溢出',
      `scrollWidth=${await evaluate('document.documentElement.scrollWidth')}`);

    // 外部链接属性
    const badLinks = await evaluate(`[...document.querySelectorAll('a[href^="http"]')]
      .filter(a=>a.target!=='_blank'||!/noopener/.test(a.rel)).map(a=>a.href).length`);
    check(badLinks === 0, '所有外部链接均为新窗口打开且带 noopener');

    // 长链接完整展示（未被 CSS 截断）
    const truncated = await evaluate(`[...document.querySelectorAll('.ll-url')]
      .filter(el=>el.scrollHeight - el.clientHeight > 4).length`);
    const linkLens = await evaluate(`[...document.querySelectorAll('.ll-url')].map(e=>e.textContent.length)`);
    check(truncated === 0, '长链接未被截断', `长度 ${linkLens.join(', ')} 字符`);

    // 复制功能（剪贴板权限在 headless 下可能不可用，这里验证兜底路径不抛错）
    const copyOk = await evaluate(`(async()=>{
      const btn=document.querySelector('.copy-btn');
      if(!btn) return 'no-button';
      btn.click();
      await new Promise(r=>setTimeout(r,300));
      return 'clicked';
    })()`);
    check(copyOk === 'clicked', '复制按钮可点击且未抛错');

    await evaluate(`document.querySelector('#github').scrollIntoView()`); await wait(600);
    await shot('desktop-github');
    await evaluate(`window.scrollTo(0,0)`); await wait(400);
    await shot('desktop-hero');
    await evaluate(`document.querySelector('#clients').scrollIntoView()`); await wait(600);
    await shot('desktop-clients');
    await evaluate(`document.querySelector('#about').scrollIntoView()`); await wait(600);
    await shot('desktop-about');
    await evaluate(`document.querySelector('#contact').scrollIntoView()`); await wait(600);
    await shot('desktop-contact');

    // 深色主题截图
    await evaluate(`document.getElementById('themeToggle').click()`); await wait(500);
    await evaluate(`window.scrollTo(0,0)`); await wait(400);
    await shot('desktop-hero-dark');
    await evaluate(`document.querySelector('#contact').scrollIntoView()`); await wait(600);
    await shot('desktop-contact-dark');
    // 切回浅色
    await evaluate(`document.getElementById('themeToggle').click()`); await wait(400);

    /* ── 移动端 ── */
    await setViewport(390, 844, true);
    await send('Page.navigate', { url: BASE });
    await wait(3000);

    check(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
      '移动端无横向溢出',
      `scrollWidth=${await evaluate("document.documentElement.scrollWidth")} vs clientWidth=${await evaluate("document.documentElement.clientWidth")}`);
    check(await evaluate(`getComputedStyle(document.querySelector('.nav-toggle')).display !== 'none'`),
      '移动端显示抽屉按钮');
    check(await evaluate(`getComputedStyle(document.querySelector('.site-nav')).display === 'none'`),
      '移动端隐藏桌面导航');

    await shot('mobile-hero');
    await evaluate(`document.querySelector('#clients').scrollIntoView()`); await wait(600);
    await shot('mobile-clients');
    await evaluate(`document.querySelector('#contact').scrollIntoView()`); await wait(600);
    await shot('mobile-contact');

    // 抽屉可打开
    await evaluate(`window.scrollTo(0,0); document.getElementById('navToggle').click()`); await wait(900);
    const drawerOpen = await evaluate(`(()=>{const d=document.getElementById('mobileDrawer');
      return !!(d.open||d.hasAttribute('open'))})()`);
    check(drawerOpen, '移动端抽屉可打开');
    check(await evaluate(`document.getElementById('navToggle').getAttribute('aria-expanded')==='true'`),
      '抽屉按钮 aria-expanded 同步');
    await shot('mobile-drawer');

    await evaluate(`document.getElementById('navToggle').click()`); await wait(700);
    check(!(await evaluate(`(()=>{const d=document.getElementById('mobileDrawer');return !!(d.open||d.hasAttribute('open'))})()`)),
      '移动端抽屉可关闭');

    /* ── 极度窄屏 ── */
    await setViewport(320, 640, true);
    await send('Page.navigate', { url: BASE });
    await wait(2500);
    check(await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`),
      '320px 窄屏无横向溢出',
      `scrollWidth=${await evaluate('document.documentElement.scrollWidth')}`);
    await shot('mobile-320');

    /* ── 汇总 ── */
    console.log('\n控制台输出：');
    const noisy = logs.filter(l => !/favicon|theme-color/i.test(l));
    if (!noisy.length) console.log('  （无错误与警告）');
    else noisy.forEach(l => console.log('  ' + l));
    check(noisy.filter(l => l.startsWith('[exception]')).length === 0, '无未捕获异常');

    const failed = results.filter(r => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过`);
    if (failed.length) {
      console.log('未通过：');
      failed.forEach(f => console.log(`  ✗ ${f.label} ${f.detail}`));
    }
    ws.close();
    process.exit(failed.length ? 1 : 0);
  } catch (e) {
    console.error('验收脚本出错：', e);
    process.exit(2);
  }
});

ws.addEventListener('error', e => {
  console.error('WebSocket 错误：', e.message || e);
  process.exit(3);
});
