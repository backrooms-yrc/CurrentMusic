/*! @license SVG paths adapted from Lucide and Feather.
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// ==========================================================================
// Aimo 设计主题：Lucide 风格细线 SVG 图标注入器
// 来源：参考项目 (aimo-account / aimo-chat 规范，stroke-width 1.75，round 端点)
// 约束：仅在 html[data-ui-preset="aimo"] 下激活生效，非 Aimo 主题自动退回原生
// ==========================================================================

export const isAimo = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

export const AIMO_ICONS = {
  search: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  home: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
  explore: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>`,
  user: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  radio: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,
  play: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3" fill="currentColor"></polygon></svg>`,
  pause: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><rect x="6" y="4" width="4" height="16" fill="currentColor"></rect><rect x="14" y="4" width="4" height="16" fill="currentColor"></rect></svg>`,
  prev: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="19 20 9 12 19 4 19 20" fill="currentColor"></polygon><line x1="5" y1="19" x2="5" y2="5"></line></svg>`,
  next: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4" fill="currentColor"></polygon><line x1="19" y1="5" x2="19" y2="19"></line></svg>`,
  order: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"></path></svg>`,
  repeat: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>`,
  repeatOne: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path><path d="M11 10h1v4"></path></svg>`,
  shuffle: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"></path><path d="m18 2 4 4-4 4"></path><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"></path><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"></path><path d="m18 14 4 4-4 4"></path></svg>`,
  heart: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>`,
  heartFilled: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"></path></svg>`,
  queue: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M21 15V6"></path><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"></path><path d="M12 12H3"></path><path d="M16 6H3"></path><path d="M12 18H3"></path></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`,
  chevronDown: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`,

  // --- “我的”页面与全站 Lucide 极简细线扩展库 ---
  award: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="8" r="6"></circle><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"></path></svg>`,
  quote: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"></path></svg>`,
  disc: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>`,
  sparkles: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path></svg>`,
  key: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6"></path><path d="m15.5 7.5 3 3L22 7l-2-2"></path></svg>`,
  bookOpen: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`,
  activity: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"></path></svg>`,
  messageSquare: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  users: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  rss: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>`,
  userCog: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><circle cx="19" cy="11" r="2"></circle><path d="m19 8 .5 1"></path><path d="m19 14 .5-1"></path><path d="m21.6 9.5-.9.5"></path><path d="m16.4 12.5.9-.5"></path></svg>`,
  cloud: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>`,
  podcast: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="11" r="1"></circle><path d="M16.8 7.2a6.8 6.8 0 0 1 0 7.6"></path><path d="M7.2 14.8a6.8 6.8 0 0 1 0-7.6"></path><path d="M19.6 4.4a10.8 10.8 0 0 1 0 13.2"></path><path d="M4.4 17.6a10.8 10.8 0 0 1 0-13.2"></path><path d="M12 12v7"></path><path d="M9 19h6"></path></svg>`,
  shieldCheck: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"></path><path d="m9 12 2 2 4-4"></path></svg>`,
  compass: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon></svg>`,
  badgeCheck: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"></path><path d="m9 12 2 2 4-4"></path></svg>`,
  listPlus: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M11 12H3"></path><path d="M16 6H3"></path><path d="M16 18H3"></path><path d="M18 9v6"></path><path d="M21 12h-6"></path></svg>`,
  moreHorizontal: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>`,
  bot: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><rect width="18" height="10" x="3" y="11" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" x2="8" y1="16" y2="16"></line><line x1="16" x2="16" y1="16" y2="16"></line></svg>`,
  camera: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path><circle cx="12" cy="13" r="3"></circle></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path></svg>`,
  android: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="m5 16 1.5-3"></path><path d="m19 16-1.5-3"></path><path d="M6 14h12"></path><path d="M7 10h10a5 5 0 0 0-10 0v4"></path><line x1="9" y1="6" x2="8" y2="3"></line><line x1="15" y1="6" x2="16" y2="3"></line></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a1 1 0 0 0 0-2H8a1 1 0 0 0 0 2h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path></svg>`,
  externalLink: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`,
  chevronRight: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`,
  music: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="aimo-icon" aria-hidden="true"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
};

export function injectSlot(el, iconKey) {
  if (!el || !isAimo()) return;
  const svg = AIMO_ICONS[iconKey];
  if (!svg) return;

  let slot = el.querySelector(':scope > .aimo-icon-slot');
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'aimo-icon-slot';
    slot.setAttribute('aria-hidden', 'true');
    el.prepend(slot);
  }
  if (slot.__iconKey !== iconKey) {
    slot.innerHTML = svg;
    slot.__iconKey = iconKey;
  }
  if (!el.hasAttribute('data-aimo-icon-ready')) el.setAttribute('data-aimo-icon-ready', '1');
}

export function syncAimoIcons() {
  if (!isAimo()) return;

  // 1. 顶栏操作区
  const topSearch = document.getElementById('topSearch');
  if (topSearch) injectSlot(topSearch, 'search');

  const topAction = document.getElementById('topAction');
  if (topAction) injectSlot(topAction, 'settings');

  const dlApkTop = document.getElementById('dlApkTop');
  if (dlApkTop) {
    const ic = dlApkTop.querySelector('.material-icons-outlined') || dlApkTop;
    injectSlot(ic, 'android');
  }

  // 2. 底部/桌面侧栏导航
  const bottomNav = document.getElementById('bottomNav');
  if (bottomNav) {
    const navItems = bottomNav.querySelectorAll('.navItem');
    navItems.forEach(item => {
      const href = item.getAttribute('href') || '';
      let key = '';
      if (href.includes('home')) key = 'home';
      else if (href.includes('search')) key = 'search';
      else if (href.includes('discover') || href.includes('square')) key = 'explore';
      else if (href.includes('library')) key = 'queue';
      else if (href.includes('user')) key = 'user';
      else if (href.includes('room')) key = 'radio';
      if (key) {
        const ic = item.querySelector('.nav-ic') || item;
        injectSlot(ic, key);
      }
    });
  }

  // 3. 全屏播放器的固定图标，播放状态由播放器直接渲染。

  const plPrev = document.getElementById('plPrev');
  if (plPrev) injectSlot(plPrev, 'prev');

  const plNext = document.getElementById('plNext');
  if (plNext) injectSlot(plNext, 'next');

  const plQueue = document.getElementById('plQueue');
  if (plQueue) injectSlot(plQueue, 'queue');

  const plClose = document.getElementById('plClose');
  if (plClose) injectSlot(plClose, 'chevronDown');

  const plAdd = document.getElementById('plAdd');
  if (plAdd) injectSlot(plAdd, 'listPlus');

  const plComments = document.getElementById('plComments');
  if (plComments) injectSlot(plComments, 'messageSquare');

  const plHeart = document.getElementById('plHeart');
  if (plHeart) injectSlot(plHeart, 'sparkles');

  const plMore = document.getElementById('plMore');
  if (plMore) injectSlot(plMore, 'moreHorizontal');

  injectSlot(document.querySelector('#plAskAi .pl-ai-ava.material-icons-outlined'), 'bot');

  // 4. “我的”页面 (User Profile) 全量图标替换
  const quickCards = [
    { sel: '.cm-quick[href*="levels"]', icon: 'award' },
    { sel: '.cm-quick[href*="likes"]', icon: 'heart' },
    { sel: '.cm-quick[href*="library"]', icon: 'queue' },
    { sel: '.cm-quick[href*="lyricmarks"]', icon: 'quote' },
    { sel: '.cm-quick[href*="assets"]', icon: 'disc' },
  ];
  quickCards.forEach(({ sel, icon }) => {
    document.querySelectorAll(sel).forEach(card => {
      const ic = card.querySelector('.material-icons-outlined') || card.querySelector('.material-icons');
      if (ic) injectSlot(ic, icon);
    });
  });

  const settingMap = {
    setDecor: 'sparkles',
    chgPass: 'key',
    goUgc: 'bookOpen',
    goFoot: 'activity',
    goMsg: 'messageSquare',
    goFollow: 'users',
    goEvents: 'rss',
    goAccount: 'userCog',
    goCloud: 'cloud',
    goRadio: 'radio',
    goPodcast: 'podcast',
    goMember: 'shieldCheck',
    goServices: 'compass',
    goRep: 'badgeCheck',
  };
  Object.keys(settingMap).forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      const ic = el.querySelector('.material-icons-outlined') || el.querySelector('.material-icons');
      if (ic) injectSlot(ic, settingMap[id]);
    }
  });

  document.querySelectorAll('.cm-setting[data-sw]').forEach(item => {
    const ic = item.querySelector('.material-icons-outlined') || item.querySelector('.material-icons');
    if (ic) injectSlot(ic, 'user');
  });

  const avaCam = document.querySelector('.cm-ava-cam');
  if (avaCam) {
    const ic = avaCam.querySelector('.material-icons-outlined') || avaCam;
    injectSlot(ic, 'camera');
  }

  const editNick = document.getElementById('editNick');
  if (editNick) {
    const ic = editNick.querySelector('.material-icons-outlined') || editNick;
    injectSlot(ic, 'edit');
  }

  const editBio = document.getElementById('editBio');
  if (editBio) {
    const ic = editBio.querySelector('.material-icons-outlined') || editBio;
    injectSlot(ic, 'edit');
  }

  // 5. 弹窗公告（Announcements Dialog）图标
  document.querySelectorAll('.cm-ann-pin .material-icons-outlined, .cm-ann-pin .material-icons').forEach(ic => injectSlot(ic, 'pin'));
  document.querySelectorAll('.cm-ann-link .material-icons-outlined, .cm-ann-link .material-icons').forEach(ic => injectSlot(ic, 'externalLink'));

  // 6. 首页横幅图标
  const cmxBanner = document.getElementById('cmxBanner');
  if (cmxBanner) {
    const ic = cmxBanner.querySelector('.material-icons-outlined');
    if (ic) injectSlot(ic, 'android');
    const go = cmxBanner.querySelector('.cm-cmx-go .material-icons-outlined');
    if (go) injectSlot(go, 'chevronRight');
  }
  document.querySelectorAll('.cm-bindbanner > .material-icons-outlined').forEach(ic => injectSlot(ic, 'cloud'));
  document.querySelectorAll('.cm-decor-banner > .material-icons-outlined').forEach(ic => injectSlot(ic, 'sparkles'));

  // 7. 歌曲列表红心按钮
  document.querySelectorAll('.cm-song-like').forEach(btn => {
    const isLiked = btn.classList.contains('on');
    injectSlot(btn, isLiked ? 'heartFilled' : 'heart');
  });
}

let syncTimer = 0;
function scheduleSync() {
  if (!isAimo() || syncTimer) return;
  syncTimer = requestAnimationFrame(() => {
    syncTimer = 0;
    syncAimoIcons();
  });
}

export function initAimoIcons() {
  syncAimoIcons();
  document.addEventListener('cm-uipreset', scheduleSync);
  window.addEventListener('hashchange', scheduleSync);

  // 监听全屏播放器与主路由挂载点，异步内容装载完成即时无缝换装
  const ov = document.getElementById('playerOverlay');
  if (ov && typeof MutationObserver !== 'undefined') {
    const mo = new MutationObserver(() => scheduleSync());
    mo.observe(ov, { childList: true });
  }

  const outEl = document.getElementById('out');
  if (outEl && typeof MutationObserver !== 'undefined') {
    const moOut = new MutationObserver(records => {
      const hasNewContent = records.some(record => Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && !node.closest('.aimo-icon-slot')));
      if (hasNewContent) scheduleSync();
    });
    moOut.observe(outEl, { childList: true, subtree: true });
  }

  // 监听 body 直属子节点插入（针对 mdui-dialog / .cm-ann 动态弹窗），弹窗开启瞬间自动挂载细线图标
  if (typeof MutationObserver !== 'undefined') {
    const moBody = new MutationObserver((mutations) => {
      let shouldSync = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1 && (node.tagName === 'MDUI-DIALOG' || node.classList?.contains('cm-ann') || node.querySelector?.('.cm-ann, mdui-dialog'))) {
              shouldSync = true;
              break;
            }
          }
        }
        if (shouldSync) break;
      }
      if (shouldSync) scheduleSync();
    });
    moBody.observe(document.body, { childList: true });
  }
}
