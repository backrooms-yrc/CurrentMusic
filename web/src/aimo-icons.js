// ==========================================================================
// Aimo 设计主题：Lucide 风格细线 SVG 图标注入器
// 来源：参考项目 (aimo-account / aimo-chat 规范，stroke-width 1.75，round 端点)
// 约束：仅在 html[data-ui-preset="aimo"] 下激活生效，非 Aimo 主题自动退回原生
// ==========================================================================

const isAimo = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

export const AIMO_ICONS = {
  search: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  home: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
  explore: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>`,
  user: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  radio: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,
  play: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" fill="currentColor"></polygon></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><rect x="6" y="4" width="4" height="16" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" fill="currentColor"></rect></svg>`,
  prev: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="19 20 9 12 19 4 19 20" fill="currentColor"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`,
  next: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`,
  repeat: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>`,
  repeatOne: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path><path d="M11 10h1v4"></path></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"></path><path d="m18 2 4 4-4 4"></path><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"></path><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"></path><path d="m18 14 4 4-4 4"></path></svg>`,
  heart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>`,
  heartFilled: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>`,
  queue: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M21 15V6"></path><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"></path><path d="M12 12H3"></path><path d="M16 6H3"></path><path d="M12 18H3"></path></svg>`,
  volume: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`,
  volumeMute: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="22" y1="9" x2="16" y2="15"></line><line x1="16" y1="9" x2="22" y2="15"></line></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  chevronDown: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
};

function injectSlot(el, iconKey) {
  if (!el) return;
  let slot = el.querySelector(':scope > .aimo-icon-slot');
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'aimo-icon-slot';
    slot.setAttribute('aria-hidden', 'true');
    el.prepend(slot);
  }
  const svg = AIMO_ICONS[iconKey];
  if (svg && slot.__iconKey !== iconKey) {
    slot.innerHTML = svg;
    slot.__iconKey = iconKey;
  }
  el.setAttribute('data-aimo-icon-ready', '1');
}

export function syncAimoIcons() {
  if (!isAimo()) return;

  // 1. 顶栏操作
  const topSearch = document.getElementById('topSearch');
  if (topSearch) injectSlot(topSearch, 'search');

  const topAction = document.getElementById('topAction');
  if (topAction) injectSlot(topAction, 'settings');

  // 2. 底部/桌面侧栏导航
  const bottomNav = document.getElementById('bottomNav');
  if (bottomNav) {
    const navItems = bottomNav.querySelectorAll('.navItem');
    navItems.forEach(item => {
      const href = item.getAttribute('href') || '';
      let key = '';
      if (href.includes('home')) key = 'home';
      else if (href.includes('search')) key = 'search';
      else if (href.includes('discover')) key = 'explore';
      else if (href.includes('user')) key = 'user';
      else if (href.includes('room')) key = 'radio';
      if (key) {
        const ic = item.querySelector('.nav-ic') || item;
        injectSlot(ic, key);
      }
    });
  }

  // 3. 播放器核心操作传输控件
  const plPlay = document.getElementById('plPlay');
  if (plPlay) {
    const isPlaying = plPlay.querySelector('.material-icons-outlined')?.textContent?.trim() === 'pause';
    injectSlot(plPlay, isPlaying ? 'pause' : 'play');
  }

  const plPlaySm = document.getElementById('plPlaySm');
  if (plPlaySm) {
    const isPlaying = plPlaySm.querySelector('.material-icons-outlined')?.textContent?.trim() === 'pause';
    injectSlot(plPlaySm, isPlaying ? 'pause' : 'play');
  }

  const plPrev = document.getElementById('plPrev');
  if (plPrev) injectSlot(plPrev, 'prev');

  const plNext = document.getElementById('plNext');
  if (plNext) injectSlot(plNext, 'next');

  const plQueue = document.getElementById('plQueue');
  if (plQueue) injectSlot(plQueue, 'queue');

  const plClose = document.getElementById('plClose');
  if (plClose) injectSlot(plClose, 'chevronDown');

  const plMode = document.getElementById('plMode');
  if (plMode) {
    const modeText = plMode.querySelector('.material-icons-outlined')?.textContent?.trim() || '';
    let modeKey = 'repeat';
    if (modeText.includes('one')) modeKey = 'repeatOne';
    else if (modeText.includes('shuffle')) modeKey = 'shuffle';
    injectSlot(plMode, modeKey);
  }

  const plLike = document.getElementById('plLike');
  if (plLike) {
    const isLiked = plLike.classList.contains('liked') || plLike.querySelector('.material-icons-outlined')?.textContent?.trim() === 'favorite';
    injectSlot(plLike, isLiked ? 'heartFilled' : 'heart');
  }

  const plVolIcon = document.getElementById('plVolIcon');
  if (plVolIcon) {
    const isMute = plVolIcon.textContent?.trim()?.includes('off') || plVolIcon.textContent?.trim()?.includes('mute');
    injectSlot(plVolIcon, isMute ? 'volumeMute' : 'volume');
  }
}

export function initAimoIcons() {
  syncAimoIcons();
  document.addEventListener('cm-uipreset', syncAimoIcons);
  window.addEventListener('hashchange', () => {
    if (isAimo()) requestAnimationFrame(syncAimoIcons);
  });
  window.addEventListener('cm-play-state', () => {
    if (isAimo()) requestAnimationFrame(syncAimoIcons);
  });
  // 仅在主播放容器状态变动时按需同步
  const ov = document.getElementById('playerOverlay');
  if (ov && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => {
      if (isAimo()) requestAnimationFrame(syncAimoIcons);
    });
    mo.observe(ov, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
}
