import './polyfill.js';   // 旧版 WebView 兼容垫片（必须在 mdui 之前）
// CurrentMusic 入口：mdui 注册、主题、路由、播放器 UI 挂载。
import 'mdui/mdui.css';
import '@material-design-icons/font/outlined.css';
import './app.css';
import { auth, settings, setAuthExpiredHandler } from './api.js';
import { toast, initRipple, bootColorScheme, initImageFade } from './ui.js';
import { checkUpdate } from './update.js';
import { initPullToRefresh } from './ptr.js';
import { engineChrome, engineOutdated } from './version.js';
import { player } from './player.js';
import { initPlayerUI } from './player-ui.js';
import { applyTheme } from './pages/settings.js';

import * as home from './pages/home.js';
import * as search from './pages/search.js';
import * as library from './pages/library.js';
import * as playlist from './pages/playlist.js';
import * as user from './pages/user.js';
import * as settingsPage from './pages/settings.js';
import * as adminPage from './pages/admin.js';
import * as roomsPage from './pages/rooms.js';
import * as roomPage from './pages/room.js';
import * as squarePage from './pages/square.js';
import * as profilePage from './pages/profile.js';
import * as artistPage from './pages/artist.js';
import * as followedPage from './pages/followed.js';

const ROUTES = [
  { re: /^#\/home$/, page: home, title: 'CurrentMusic' },
  { re: /^#\/search$/, page: search, title: '搜索' },
  { re: /^#\/square$/, page: squarePage, title: '发现' },
  { re: /^#\/u\/(\d+)$/, page: profilePage, title: '用户主页', fixed: m => [m[1]] },
  { re: /^#\/artist\/(\d+)$/, page: artistPage, title: '歌手', fixed: m => [m[1]] },
  { re: /^#\/followed$/, page: followedPage, title: '关注的歌手' },
  { re: /^#\/library$/, page: library, title: '歌单' },
  { re: /^#\/user$/, page: user, title: '我的' },
  { re: /^#\/settings$/, page: settingsPage, title: '设置' },
  { re: /^#\/admin$/, page: adminPage, title: '管理员' },
  { re: /^#\/rooms$/, page: roomsPage, title: '一起听' },
  { re: /^#\/room\/(\d+)$/, page: roomPage, title: '听歌房', fixed: m => [m[1]] },
  { re: /^#\/pl\/(.+)$/, page: playlist, title: '歌单', fixed: m => ['pl', m[1]] },
  { re: /^#\/daily$/, page: playlist, title: '每日推荐', fixed: ['daily'] },
  { re: /^#\/ncmpl\/(\d+)$/, page: playlist, title: '排行榜', fixed: m => ['ncmpl', m[1]] },
];

const out = () => document.getElementById('out');

// ---------- 路由方向感知（前进=上入 / 后退=左入） ----------
let navStack = [];
let navDirection = 'fwd';

window.addEventListener('hashchange', () => {
  const hash = location.hash || '#/home';
  const idx = navStack.lastIndexOf(hash);
  if (idx >= 0 && idx < navStack.length - 1) {
    // 跳回栈内更早页面（点导航返回/返回键）→ 后退，栈截断
    navStack = navStack.slice(0, idx + 1);
    navDirection = 'back';
  } else if (navStack[navStack.length - 1] !== hash) {
    navStack.push(hash);
    navDirection = 'fwd';
  }
});

async function router() {
  const hash = location.hash || '#/home';
  if (!navStack.length) navStack.push(hash);
  let matched = null, params = null;
  for (const r of ROUTES) {
    const m = hash.match(r.re);
    if (m) {
      matched = r;
      params = r.fixed ? (typeof r.fixed === 'function' ? r.fixed(m) : r.fixed) : m.slice(1);
      break;
    }
  }
  if (!matched) { location.hash = '#/home'; return; }

  document.getElementById('pageTitle').textContent = matched.title;
  document.querySelectorAll('#bottomNav .navItem').forEach(a => {
    a.classList.toggle('cur', a.getAttribute('href') === hash.split('/').slice(0, 2).join('/'));
  });
  // MD3 页面过渡：每页包一层；后退时用 back 变体（左入）
  const wrap = document.createElement('div');
  wrap.className = 'cm-page' + (navDirection === 'back' ? ' cm-page-back' : '');
  out().replaceChildren(wrap);
  try {
    await matched.page.render(wrap, params);
  } catch (e) {
    wrap.innerHTML = `<div class="cm-empty">页面加载失败：${e.message}</div>`;
  }
  out().scrollTop = 0;
  window.scrollTo(0, 0);
}

function boot() {
  applyTheme();
  bootColorScheme();   // 配色方案（默认动态取色，取色随播放封面变化）
  // 原生窗口 insets（env(safe-area-inset-*) 在多数 WebView 上恒为 0，用桥值兜底）
  if (window.NativeApi && window.NativeApi.insets) {
    try {
      const i = JSON.parse(window.NativeApi.insets());
      const rt = document.documentElement.style;
      rt.setProperty('--safe-t', (i.t || 0) + 'px');
      rt.setProperty('--safe-b', (i.b || 0) + 'px');
      rt.setProperty('--safe-l', (i.l || 0) + 'px');
      rt.setProperty('--safe-r', (i.r || 0) + 'px');
    } catch { /* 忽略 */ }
  }
  initRipple();
  initImageFade();   // 全局图片加载动画（骨架微光 → 渐显）
  window.__cmBooted = true;   // 供 index.html 的启动诊断判定
  document.getElementById('boot').remove();

  document.getElementById('topAction').onclick = () => { location.hash = '#/settings'; };   // 齿轮直达设置页

  // 网页版顶栏「下载安卓版 APP」入口（App 内有 NativeApi，不渲染）
  if (!(window.NativeApi && window.NativeApi.versionCode)) {
    const dl = document.createElement('a');
    dl.id = 'dlApkTop';
    dl.className = 'cm-dl-apk-top';
    dl.title = '下载安卓版 APP';
    dl.innerHTML = '<span class="material-icons-outlined">android</span><span>下载 APP</span>';
    dl.href = settings.base + '/download/latest';
    document.getElementById('topAction').before(dl);
  }
  // MD3 top app bar：内容滚动时切换 surface 层级 + elevation
  const outEl = out();
  outEl.addEventListener('scroll', () => {
    document.getElementById('topbar').classList.toggle('scrolled', outEl.scrollTop > 8);
  }, { passive: true });
  window.addEventListener('hashchange', router);
  if (!location.hash) location.hash = '#/home';
  router();

  // 全局下拉刷新：重跑当前路由（页面 render 自带骨架屏与数据重取）
  initPullToRefresh(() => router());

  player.restore();          // 恢复上次队列（不自动播放）
  initPlayerUI();

  setAuthExpiredHandler(() => toast('登录已失效，请重新登录'));

  // 旧版渲染引擎一次性提示（引导更新 WebView，更新后可恢复最佳效果）
  if (engineOutdated() && !sessionStorage.getItem('cm.engineHint')) {
    sessionStorage.setItem('cm.engineHint', '1');
    setTimeout(() => toast(`当前系统 WebView 较旧（Chromium ${engineChrome()}），建议在应用商店更新以获得最佳体验`), 4000);
  }

  // 启动自动检测更新（延迟启动，不与首屏渲染抢资源）
  setTimeout(() => { checkUpdate({ silent: true }).catch(() => {}); }, 1500);

  // 系统深浅色切换时（Android 壳转发 cmthemechange），auto 模式即时跟随
  window.addEventListener('cmthemechange', applyTheme);

  // Android 系统返回统一入口（壳调用）：关闭浮层（带动画）→ 原生历史栈返回（吃到后退动画）→ 逐级回首页
  window.__cmHandleBack = function () {
    var cb = document.getElementById('cmtClose');
    if (cb) { cb.click(); return true; }
    var ov = document.getElementById('playerOverlay');
    if (ov && !ov.hidden) {
      var pc = document.getElementById('plClose');
      if (pc) { pc.click(); return true; }
    }
    var d = document.querySelector('mdui-dialog');
    if (d && d.open) { d.open = false; return true; }
    if (navStack.length > 1 && (location.hash || '#/home') !== navStack[0]) {
      history.back();          // 原生栈返回 → hashchange → 后退左入动画
      return true;
    }
    if (location.hash && location.hash !== '#/home') {
      location.hash = '#/home';
      return true;
    }
    return false;
  };
}

boot();
