import { auth } from './api.js';

const WELCOME_KEY = 'cm.welcome.pending';
export function needsWelcome() {
  try { return !!auth.token && localStorage.getItem(WELCOME_KEY) === String((auth.user || {}).id); } catch { return false; }
}
export function startWelcome({ replay = false } = {}) {
  try {
    sessionStorage.removeItem('cm.welcome.step');
    if (replay) sessionStorage.setItem('cm.welcome.return', 'settings');
    else sessionStorage.removeItem('cm.welcome.return');
  } catch { /* 隐私模式 */ }
  try { localStorage.setItem(WELCOME_KEY, String(auth.user.id)); } catch { /* 可继续当前流程 */ }
  location.hash = '#/welcome';
}
export function afterLogin() {
  if (needsWelcome()) { location.hash = '#/welcome'; return; }
  let back = '';
  try { back = sessionStorage.getItem('cm.ppBack') || ''; sessionStorage.removeItem('cm.ppBack'); } catch { /* 隐私模式 */ }
  location.hash = back.startsWith('#/passport/authorize?') ? back : '#/home';
}
export function isWelcomeReplay() {
  try { return sessionStorage.getItem('cm.welcome.return') === 'settings'; } catch { return false; }
}
export function completeWelcome() {
  const replay = isWelcomeReplay();
  try {
    localStorage.removeItem(WELCOME_KEY);
    sessionStorage.removeItem('cm.welcome.step');
    sessionStorage.removeItem('cm.welcome.return');
  } catch { /* 隐私模式 */ }
  if (replay) location.hash = '#/settings';
  else afterLogin();
}

export function authArt(kind = 'music') {
  const icon = { music: 'headphones', library: 'library_music', style: 'palette', security: 'verified_user' }[kind] || 'headphones';
  return `<div class="cm-auth-art cm-art-${kind}" aria-hidden="true">
    <div class="cm-art-orbit"></div><div class="cm-art-orbit second"></div>
    <div class="cm-art-tile"><span class="material-icons-outlined">${icon}</span></div>
    <div class="cm-art-chip one"><span class="material-icons-outlined">${kind === 'security' ? 'lock' : 'music_note'}</span></div>
    <div class="cm-art-chip two"><span class="material-icons-outlined">${kind === 'style' ? 'dark_mode' : 'favorite'}</span></div>
    <div class="cm-art-bars">${Array.from({ length: 9 }, (_, i) => `<i style="--bar:${i}"></i>`).join('')}</div>
  </div>`;
}
export function authFrame({ eyebrow = 'CURRENTSTATION', title, description, art = 'security', body, footer = '' }) {
  return `<section class="cm-auth-layout cm-account-flow">
    <aside class="cm-auth-story">${authArt(art)}<span class="cm-auth-eyebrow">${eyebrow}</span><h1>${title}</h1><p>${description}</p><span class="cm-auth-brand">CurrentMusic <span>·</span> 让喜欢的音乐，陪着你</span></aside>
    <div class="cm-auth-panel">${body}${footer}</div></section>`;
}
