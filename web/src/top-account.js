import { api, auth } from './api.js';
import { avatarHTML, userTags, userTagsText } from './ui.js';

// 独立于路由挂载；页面切换、滚动与登录后的跳转不会销毁顶部账号。
export function initTopAccount(bootDismissed) {
  const account = document.getElementById('topAccount');
  if (!account) return;
  let owner = '', markup = '', flight = null, timer = 0, resizeTimer = 0, generation = 0;
  let startupToken = window.NativeApi?.versionCode ? '' : auth.token;

  function settle() {
    generation++;
    clearTimeout(timer);
    clearTimeout(resizeTimer);
    if (flight) { const old = flight; flight = null; old.cancel(); }
    account.classList.remove('cm-account-arriving', 'cm-account-flying');
  }

  async function arrive() {
    settle();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !account.animate || !account.getClientRects().length) {
      startupToken = '';
      return;
    }
    const own = generation;
    account.classList.add('cm-account-arriving');
    // 等头像/挂件加载，但图片失败或慢网不能卡住账号入口。
    const imagesReady = Promise.race([
      Promise.all(Array.from(account.querySelectorAll('img')).map(img => img.complete ? Promise.resolve() : new Promise(resolve => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }))),
      new Promise(resolve => setTimeout(resolve, 650)),
    ]);
    await Promise.all([bootDismissed, imagesReady]);
    if (own !== generation || account.hidden) return;
    startupToken = '';
    const r = account.querySelector('.cm-top-avatar').getBoundingClientRect();
    account.style.transformOrigin = `50% ${r.top - account.getBoundingClientRect().top + r.height / 2}px`;
    const dx = innerWidth / 2 - (r.left + r.width / 2);
    const dy = innerHeight / 2 - (r.top + r.height / 2);

    const isAimo = document.documentElement.getAttribute('data-ui-preset') === 'aimo';
    if (isAimo) {
      // Aimo 主题：头像收拢至顶栏右上角，遵从物理克制微动效（280ms），精准落位
      account.classList.add('cm-account-flying');
      const startEl = document.querySelector('.cm-auth-panel, #go, .cm-detail-cover') || null;
      let fromX = dx, fromY = dy;
      if (startEl && startEl.getClientRects().length) {
        const sr = startEl.getBoundingClientRect();
        fromX = (sr.left + sr.width / 2) - (r.left + r.width / 2);
        fromY = (sr.top + Math.min(sr.height / 2, 80)) - (r.top + r.height / 2);
      }
      flight = account.animate([
        { opacity: 0, transform: `translate(${fromX}px, ${fromY}px) scale(1.15)` },
        { opacity: 1, transform: 'none' },
      ], { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      account.classList.remove('cm-account-arriving');
      const finish = () => { if (own === generation) settle(); };
      flight.onfinish = finish;
      timer = setTimeout(finish, 320);
      return;
    }

    account.classList.add('cm-account-flying');
    flight = account.animate([
      { opacity: 0, transform: `translate(${dx}px, ${dy + 18}px) scale(1.7)`, offset: 0, easing: 'ease-out' },
      { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(2.5)`, offset: .2 },
      { opacity: 1, transform: `translate(${dx}px, ${dy}px) scale(2.5)`, offset: .44, easing: 'cubic-bezier(.65,0,.2,1)' },
      { opacity: 1, transform: 'none', offset: 1 },
    ], { duration: 1550, easing: 'linear' });
    account.classList.remove('cm-account-arriving');
    const finish = () => { if (own === generation) settle(); };
    flight.onfinish = finish;
    // 老 WebView 不支持 Animation.finished；定时兜底防止残留高层级/不可点击状态。
    timer = setTimeout(finish, 1750);
  }

  function sync(event) {
    const token = auth.token;
    if (startupToken !== token) startupToken = '';
    const user = token && auth.user;
    const nextOwner = user ? user.username : '';
    if (nextOwner !== owner) settle();
    owner = nextOwner;
    account.hidden = !user;
    document.body.classList.toggle('cm-has-account', !!user);
    document.body.classList.toggle('cm-has-account-title', !!(user && String(user.title || '').trim()));
    if (!user) { settle(); account.innerHTML = ''; markup = ''; return; }
    const html = `<span class="cm-top-avatar" aria-hidden="true">${avatarHTML(user, 34)}</span><span class="cm-top-tags">${userTags(user)}</span>`;
    if (html !== markup) { account.innerHTML = html; markup = html; }
    const label = [user.nickname || user.username, userTagsText(user), '我的账号'].filter(Boolean).join(' · ');
    account.setAttribute('aria-label', label);
    account.title = label;
    if (event?.detail?.login || (startupToken && !document.hidden && !account.classList.contains('cm-account-arriving'))) arrive();
  }

  const refresh = () => { if (auth.token) api.me().catch(() => {}); };
  window.addEventListener('cm-authchange', sync);
  window.addEventListener('storage', event => {
    if (!event.key || ['cm.token', 'cm.user'].includes(event.key)) { sync(); if (event.key !== 'cm.user') refresh(); }
  });
  window.addEventListener('resize', () => {
    const arriving = account.classList.contains('cm-account-arriving') || account.classList.contains('cm-account-flying');
    settle();
    // 手机登录后软键盘收起会改变视口；等尺寸稳定后从新的屏幕中心飞入。
    if (arriving && !account.hidden) {
      account.classList.add('cm-account-arriving');
      resizeTimer = setTimeout(arrive, 150);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) settle(); else { sync(); refresh(); }
  });
  sync();
  refresh();
}
