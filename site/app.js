/* ============================================================================
   CurrentMusic 官方网站交互
   ----------------------------------------------------------------------------
   负责：主题切换、移动端抽屉导航、长链接/群号复制、平滑滚动、滚动定位高亮、
        滚动入场动画、页脚年份。
   所有功能均为渐进增强：MDUI 未加载或脚本报错时，页面内容与链接依然可用。
   ========================================================================== */

/* 注册 MDUI 2.1.5 的全部 Web Components 与中文语言包。
   使用原生 ESM，无需打包器；文件为本地产物，不依赖任何 CDN。
   放在最前，确保后续逻辑操作组件时元素已完成升级。 */
import './vendor/mdui/mdui.esm.js';
import './vendor/mdui/locales/zh-cn.js';

const root = document.documentElement;

/* 标记“已启用 JS”，供 CSS 打开滚动入场动画（无 JS 时内容始终可见） */
root.classList.add('js');

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const THEME_KEY = 'cm.theme';
const header = document.getElementById('siteHeader');

/* ── 1. 主题切换 ───────────────────────────────────────────────────────── */

function applyTheme(dark) {
  root.classList.toggle('mdui-theme-dark', dark);
  root.classList.toggle('mdui-theme-light', !dark);

  const btn = document.getElementById('themeToggle');
  if (btn) {
    const label = dark ? '切换浅色主题' : '切换深色主题';
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    const icon = btn.querySelector('mdui-icon');
    if (icon) icon.setAttribute('name', dark ? 'light_mode' : 'dark_mode');
  }

  // 同步浏览器地址栏配色（只改当前生效的那一条）
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    const isDarkMeta = (meta.getAttribute('media') || '').includes('dark');
    meta.setAttribute('content', isDarkMeta ? '#0a0913' : '#f4f2fb');
  });
}

function initTheme() {
  // 首帧主题已由 <head> 内联脚本按“localStorage → 系统偏好”的顺序设定，这里只同步按钮状态
  applyTheme(root.classList.contains('mdui-theme-dark'));

  const btn = document.getElementById('themeToggle');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const dark = !root.classList.contains('mdui-theme-dark');
    applyTheme(dark);
    try {
      // 记录用户显式选择，之后不再跟随系统
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    } catch (e) { /* 隐私模式下忽略 */ }
  });

  // 用户尚未显式选择时，跟随系统主题变化
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = e => {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (err) { /* 忽略 */ }
    if (!saved) applyTheme(e.matches);
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else if (mq.addListener) mq.addListener(onChange);
}

/* ── 2. 移动端抽屉导航 ─────────────────────────────────────────────────── */

let drawerOpen = false;

function setDrawer(open) {
  const drawer = document.getElementById('mobileDrawer');
  if (!drawer) return;
  drawerOpen = open;

  try {
    drawer.open = open;          // MDUI 自定义元素：Lit 响应式属性
    if (typeof drawer.updateComplete?.then === 'function') {
      drawer.updateComplete.then(() => { drawer.open = open; }).catch(() => {});
    }
  } catch (e) { /* 忽略 */ }
  // 兜底：自定义元素未升级时，属性是唯一可见的状态
  drawer.toggleAttribute('open', open);

  const toggle = document.getElementById('navToggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  }
}

function initDrawer() {
  const drawer = document.getElementById('mobileDrawer');
  const toggle = document.getElementById('navToggle');
  if (!drawer) return;

  toggle?.addEventListener('click', () => setDrawer(!drawerOpen));

  // 点击抽屉内链接后自动收起
  drawer.querySelectorAll('a[href^="#"]').forEach(a =>
    a.addEventListener('click', () => setDrawer(false)));

  // 点击遮罩关闭（MDUI 已处理，此处兜底）
  drawer.addEventListener('click', e => {
    if (e.target === drawer) setDrawer(false);
  });

  // 视口变宽回到桌面布局时收起抽屉，避免残留遮罩
  const mq = window.matchMedia('(min-width: 900px)');
  const onWide = e => { if (e.matches) setDrawer(false); };
  if (mq.addEventListener) mq.addEventListener('change', onWide);
  else if (mq.addListener) mq.addListener(onWide);
}

/* ── 3. 平滑滚动（带吸顶导航偏移与焦点转移）───────────────────────────── */

function scrollToTarget(target) {
  if (!target) return;
  const headerH = header ? header.offsetHeight : 0;
  const top = target.getBoundingClientRect().top + window.pageYOffset - headerH - 20;

  window.scrollTo({
    top: Math.max(top, 0),
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });

  // 让键盘/读屏用户跟随焦点到目标区块
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
}

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;                       // 无对应区块时交给浏览器处理
      e.preventDefault();
      scrollToTarget(target);
      // 同步地址栏，便于复制分享当前位置
      if (history.replaceState) history.replaceState(null, '', id);
      else location.hash = id;
    });
  });
}

/* ── 4. 复制群号 / 长链接 ──────────────────────────────────────────────── */

async function writeClipboard(text) {
  // 优先用异步剪贴板 API（需安全上下文）
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { /* 落到兜底方案 */ }
  }
  // 兜底：临时 textarea + execCommand（http 环境、旧 WebView 可用）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function notify(message) {
  let done = false;
  try {
    // MDUI 未注册时 <mdui-snackbar> 退化为不可见空元素，不会影响页面
    const bar = document.createElement('mdui-snackbar');
    bar.setAttribute('placement', 'bottom');
    bar.textContent = message;
    document.body.appendChild(bar);
    bar.open = true;
    done = true;
    setTimeout(() => { try { bar.open = false; } catch (e) {} }, 2200);
    setTimeout(() => bar.remove(), 3200);
  } catch (e) { /* 忽略 */ }

  if (!done) {
    // 极端兜底：用轻量提示条，避免“点了没反应”
    const tip = document.createElement('div');
    tip.textContent = message;
    tip.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
      'z-index:300;padding:10px 20px;border-radius:999px;font-size:14px;' +
      'background:rgb(var(--mdui-color-inverse-surface));color:rgb(var(--mdui-color-inverse-on-surface));' +
      'box-shadow:var(--mdui-elevation-level3)';
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), 2200);
  }
}

function flashCopied(btn) {
  const icon = btn.querySelector('mdui-icon');
  if (!icon) return;
  const old = icon.getAttribute('name');
  icon.setAttribute('name', 'check');
  btn.classList.add('is-copied');
  setTimeout(() => {
    icon.setAttribute('name', old || 'content_copy');
    btn.classList.remove('is-copied');
  }, 1600);
}

function initCopyButtons() {
  const resolveText = btn => {
    const direct = btn.getAttribute('data-copy');
    if (direct) return direct;
    const targetId = btn.getAttribute('data-copy-target');
    if (targetId) {
      const el = document.getElementById(targetId);
      if (el) return el.textContent.trim();
    }
    return '';
  };

  document.querySelectorAll('[data-copy], [data-copy-target]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = resolveText(btn);
      if (!text) return;
      const ok = await writeClipboard(text);
      if (ok) {
        flashCopied(btn);
        notify('已复制到剪贴板');
      } else {
        notify('复制失败，请长按选中后手动复制');
      }
    });
  });
}

/* ── 5. 滚动：导航阴影 + 当前区块高亮 ──────────────────────────────────── */

function initScrollEffects() {
  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.pageYOffset > 6);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // 滚动定位高亮（IntersectionObserver 不可用时静默跳过）
  if (typeof IntersectionObserver !== 'function') return;

  const links = new Map();
  document.querySelectorAll('.site-nav .nav-link[href^="#"]').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    if (id) links.set(id, a);
  });
  if (!links.size) return;

  const sections = [...links.keys()]
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!sections.length) return;

  const visible = new Map();   // id -> 可见比例

  const observer = new IntersectionObserver(entries => {
    entries.forEach(en => visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0));

    let bestId = null;
    let bestRatio = 0;
    visible.forEach((ratio, id) => {
      if (ratio > bestRatio) { bestRatio = ratio; bestId = id; }
    });

    links.forEach((a, id) => {
      if (id === bestId) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }, {
    // 顶部留出导航高度，底部收缩，使“当前区块”判断更接近视觉
    rootMargin: '-88px 0px -55% 0px',
    threshold: [0, 0.15, 0.35, 0.6, 0.85],
  });

  sections.forEach(s => observer.observe(s));
}

/* ── 6. 滚动入场动画 ───────────────────────────────────────────────────── */

function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length) return;

  // 无 IntersectionObserver 或用户要求减少动效：直接全部显示
  if (typeof IntersectionObserver !== 'function' || prefersReducedMotion()) {
    items.forEach(el => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.classList.add('is-visible');
      obs.unobserve(en.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  items.forEach((el, i) => {
    // 同屏元素做轻微错峰，避免整块一起跳出来
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 60}ms`;
    observer.observe(el);
  });
}

/* ── 7. 页脚年份 ───────────────────────────────────────────────────────── */

function initFooterYear() {
  const el = document.getElementById('year');
  if (el) el.textContent = String(new Date().getFullYear());
}

/* ── 8. 自身地址自适应 ─────────────────────────────────────────────────── */

// canonical / og:url / og:image 必须是绝对地址，但站点换域名或换端口后
// 写死的地址就会失效（曾经因此指向过 404 的 host）。这里按实际访问地址改写，
// 让页面在任意部署位置都自洽；HTML 里保留一份可被爬虫直接读取的静态兜底值。
function initSelfUrl() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const absolute = p => new URL(p, base).href;

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute('href', absolute(''));

  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) ogUrl.setAttribute('content', absolute(''));

  // 封面在站点资源命名空间 /home/ 下，路径必须与之一致
  // （写错会得到 404 的 og:image，社交平台就抓不到封面）
  const cover = absolute('home/assets/og-cover.jpg');
  document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')
    .forEach(m => m.setAttribute('content', cover));
}

/* ── 启动 ──────────────────────────────────────────────────────────────── */

function boot() {
  initTheme();
  initDrawer();
  initSmoothScroll();
  initCopyButtons();
  initScrollEffects();
  initReveal();
  initFooterYear();
  initSelfUrl();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
