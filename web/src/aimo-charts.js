// ==========================================================================
// Aimo 设计主题：纯平矢量定制榜单封面（Archive Editorial System）
// 规范：
// 1. 全面扁平化，彻底去除所有 linear/radial-gradient 渐变与模糊滤镜
// 2. 纯平中性纸墨 / 陶土与典雅纯色底板 + 1px 细结构边框
// 3. 严格限定在 html[data-ui-preset="aimo"] 生效
// ==========================================================================

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

function svgToDataUrl(svgString) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

// 1. 热歌榜 (Hot Songs · 3778678) —— 纯平陶土赤褐
const HOT_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#8F3B30"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.08)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="130"/>
    <circle cx="280" cy="140" r="95"/>
    <circle cx="280" cy="140" r="60"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="82" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end" letter-spacing="-3">HOT</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#ffffff"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">热歌榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">DAILY HIT 100 CHARTS</text>
  </g>
</svg>`;

// 2. 飙升榜 (Trending / Surge · 19723756) —— 纯平极夜群青
const SURGE_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#1E293B"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" stroke-width="1.5" stroke-dasharray="4 6">
    <line x1="240" y1="360" x2="350" y2="170"/>
    <line x1="200" y1="380" x2="310" y2="190"/>
    <line x1="160" y1="400" x2="270" y2="210"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="78" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end" letter-spacing="-3">SURGE</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#38BDF8"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#38BDF8" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">飙升榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">FASTEST RISING TRACKS</text>
  </g>
</svg>`;

// 3. 新歌榜 (New Releases · 3779629) —— 纯平橄榄苍绿
const NEW_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#2A3A2F"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g transform="translate(290, 135)" fill="rgba(255,255,255,0.14)">
    <polygon points="0,-40 8,-12 36,-16 16,8 28,34 2,18 -18,32 -12,6 -36,-4 -10,-14"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="82" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end" letter-spacing="-3">NEW</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#A3E635"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#A3E635" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">新歌榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">NEW SOUNDS &amp; RELEASES</text>
  </g>
</svg>`;

// 4. 原创榜 (Original Songs · 2884035) —— 纯平烟熏黑紫
const ORIGINAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#3B263F"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.5">
    <circle cx="280" cy="140" r="100"/>
    <circle cx="280" cy="140" r="65"/>
    <circle cx="280" cy="140" r="30"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">ORIGIN</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#E879F9"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#E879F9" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">原创榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">CHINESE INDIE &amp; ORIGINAL</text>
  </g>
</svg>`;

// 5. 国风榜 (Chinese Heritage · 5059642708) —— 纯平墨砚赭朱
const GUOFENG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#4A201B"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" stroke-width="1.2" fill="none">
    <rect x="230" y="80" width="90" height="90" rx="8" transform="rotate(45 275 125)"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="76" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">FOLK</text>
  <g transform="translate(36, 236)">
    <rect x="0" y="0" width="16" height="16" rx="3" fill="none" stroke="#F87171" stroke-width="1.8"/>
    <line x1="24" y1="8" x2="46" y2="8" stroke="#F87171" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">国风榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">TRADITIONAL HERITAGE</text>
  </g>
</svg>`;

// 6. 电音榜 (Electronic · 1978921795) —— 纯平深海靛青
const ELECTRO_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#0F2837"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M160 150 L200 120 L240 170 L280 100 L320 155 L350 130"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">EDM</text>
  <g transform="translate(36, 236)">
    <polygon points="2,1 13,8 2,15" fill="#2DD4BF"/>
    <line x1="20" y1="8" x2="42" y2="8" stroke="#2DD4BF" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">电音榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">SYNTHESIS &amp; CLUB BEATS</text>
  </g>
</svg>`;

// 7. 说唱榜 (Hip-Hop & Rap · 991319590 / 14028249541) —— 纯平暗金黑曜
const RAP_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#24211A"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g fill="rgba(255,255,255,0.1)">
    <rect x="235" y="115" width="7" height="45" rx="3.5"/>
    <rect x="250" y="90" width="7" height="70" rx="3.5"/>
    <rect x="265" y="105" width="7" height="55" rx="3.5"/>
    <rect x="280" y="65" width="7" height="95" rx="3.5"/>
    <rect x="295" y="95" width="7" height="65" rx="3.5"/>
    <rect x="310" y="125" width="7" height="35" rx="3.5"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">RAP</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#FACC15"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#FACC15" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">说唱榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">RHYME &amp; FLOW HITLIST</text>
  </g>
</svg>`;

// 8. ACG 榜 (Anime / Comic / Games · 71385702 / 3001835560) —— 纯平浆果紫
const ACG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#3B1E2D"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g transform="translate(290, 135)" fill="rgba(255,255,255,0.14)">
    <polygon points="0,-32 10,-8 34,-6 14,10 22,34 0,18 -22,34 -14,10 -34,-6 -10,-8"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">ACG</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#F472B6"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#F472B6" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">ACG 榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">ANIMATION &amp; GAME SOUNDS</text>
  </g>
</svg>`;

// 9. 摇滚榜 (Rock · 5059633707) —— 纯平炭黑朱红
const ROCK_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#2E1616"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.12)" stroke-width="2.5" stroke-linecap="round">
    <line x1="250" y1="90" x2="330" y2="180"/>
    <line x1="270" y1="80" x2="350" y2="170"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">ROCK</text>
  <g transform="translate(36, 236)">
    <polygon points="8,0 0,12 7,12 4,20 15,7 8,7" fill="#EF4444"/>
    <line x1="22" y1="8" x2="44" y2="8" stroke="#EF4444" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">摇滚榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">ELECTRIC &amp; ALTERNATIVE</text>
  </g>
</svg>`;

// 10. 古典榜 (Classical · 71384707) —— 纯平深曜青灰
const CLASSICAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#23272D"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.5">
    <ellipse cx="280" cy="140" rx="70" ry="110" transform="rotate(-25 280 140)"/>
    <ellipse cx="280" cy="140" rx="40" ry="70" transform="rotate(-25 280 140)"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">OPUS</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#FBBF24"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#FBBF24" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">古典榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">SYMPHONY &amp; SONATA</text>
  </g>
</svg>`;

// 11. 民谣榜 (Folk · 5059661515) —— 纯平浅木原棕
const MINYAO_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#2F2922"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.2">
    <ellipse cx="280" cy="140" rx="85" ry="60"/>
    <line x1="160" y1="125" x2="360" y2="125"/>
    <line x1="160" y1="140" x2="360" y2="140"/>
    <line x1="160" y1="155" x2="360" y2="155"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">FOLK</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#D97706"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#D97706" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">民谣榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">ACOUSTIC &amp; BALLADS</text>
  </g>
</svg>`;

// 12. 欧美榜 (Western Charts · 2809513713 / 2809577409) —— 纯平深蓝灰
const WESTERN_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#1C2735"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="110"/>
    <line x1="170" y1="140" x2="390" y2="140"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">WEST</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#60A5FA"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#60A5FA" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">欧美榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">GLOBAL WESTERN HITLIST</text>
  </g>
</svg>`;

// 13. 日语榜 (Japanese Tracks · 5059644681 / 60131) —— 纯平静谧墨绀
const JAPANESE_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#202530"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <circle cx="280" cy="140" r="75" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>
  <circle cx="280" cy="140" r="8" fill="rgba(255,255,255,0.2)"/>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">J-POP</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#FB7185"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#FB7185" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">日语榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">J-POP &amp; SOUNDTRACKS</text>
  </g>
</svg>`;

// 14. 韩语榜 (K-Pop Hits · 745956260) —— 纯平深紫罗兰
const KOREAN_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#2E1C33"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5">
    <polygon points="280,75 330,140 280,205 230,140"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">K-POP</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#C084FC"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#C084FC" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">韩语榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">KOREAN WAVE TRENDS</text>
  </g>
</svg>`;

// 15. Billboard / 全球权威榜 (Global Official · 60198 / 180106 / 3812895) —— 纯平黑金底
const BILLBOARD_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#222120"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="105"/>
    <circle cx="280" cy="140" r="90"/>
    <circle cx="280" cy="140" r="45"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="64" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">GLOBAL</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#EAB308"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#EAB308" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">权威榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">OFFICIAL GLOBAL CHARTS</text>
  </g>
</svg>`;

// 16. 黑胶 VIP 爱听榜 (Vinyl VIP · 5453912201 / 7785066739 / 7785123708) —— 纯平碳黑
const VIP_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <rect width="400" height="400" fill="#181818"/>
  <rect x="18" y="18" width="364" height="364" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" rx="4"/>
  <g stroke="rgba(255,255,255,0.1)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="115"/>
    <circle cx="280" cy="140" r="95"/>
    <circle cx="280" cy="140" r="75"/>
    <circle cx="280" cy="140" r="55"/>
  </g>
  <text x="364" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="78" font-weight="900" fill="rgba(255,255,255,0.12)" text-anchor="end">VIP</text>
  <g transform="translate(36, 236)">
    <circle cx="8" cy="8" r="4" fill="#CA8A04"/>
    <line x1="18" y1="8" x2="40" y2="8" stroke="#CA8A04" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="66" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#ffffff" letter-spacing="1">VIP 榜</text>
    <text x="2" y="96" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(255,255,255,0.72)" letter-spacing="2">VINYL VIP SELECTION</text>
  </g>
</svg>`;

// 精确手工定制字典映射
const CHART_COVERS = {
  '3778678': svgToDataUrl(HOT_COVER_SVG),        // 热歌榜
  '19723756': svgToDataUrl(SURGE_COVER_SVG),     // 飙升榜
  '3779629': svgToDataUrl(NEW_COVER_SVG),        // 新歌榜
  '2884035': svgToDataUrl(ORIGINAL_COVER_SVG),   // 原创榜
  '5059642708': svgToDataUrl(GUOFENG_COVER_SVG), // 国风榜
  '1978921795': svgToDataUrl(ELECTRO_COVER_SVG), // 电音榜
  '991319590': svgToDataUrl(RAP_COVER_SVG),      // 中文说唱榜
  '14028249541': svgToDataUrl(RAP_COVER_SVG),    // 全球说唱榜
  '71385702': svgToDataUrl(ACG_COVER_SVG),       // ACG 榜
  '3001835560': svgToDataUrl(ACG_COVER_SVG),     // ACG 动画榜
  '3001795926': svgToDataUrl(ACG_COVER_SVG),     // ACG 游戏榜
  '3001890046': svgToDataUrl(ACG_COVER_SVG),     // ACG VOCALOID 榜
  '5059633707': svgToDataUrl(ROCK_COVER_SVG),    // 摇滚榜
  '71384707': svgToDataUrl(CLASSICAL_COVER_SVG), // 古典榜
  '5059661515': svgToDataUrl(MINYAO_COVER_SVG),  // 民谣榜
  '2809513713': svgToDataUrl(WESTERN_COVER_SVG), // 欧美热歌榜
  '2809577409': svgToDataUrl(WESTERN_COVER_SVG), // 欧美新歌榜
  '12225155968': svgToDataUrl(WESTERN_COVER_SVG),// 欧美 R&B 榜
  '5059644681': svgToDataUrl(JAPANESE_COVER_SVG),// 日语榜
  '60131': svgToDataUrl(JAPANESE_COVER_SVG),     // 日本 Oricon 榜
  '745956260': svgToDataUrl(KOREAN_COVER_SVG),   // 韩语榜
  '60198': svgToDataUrl(BILLBOARD_COVER_SVG),    // 美国 Billboard 榜
  '180106': svgToDataUrl(BILLBOARD_COVER_SVG),   // UK 排行榜
  '3812895': svgToDataUrl(BILLBOARD_COVER_SVG),  // Beatport 舞曲榜
  '27135204': svgToDataUrl(BILLBOARD_COVER_SVG), // 法国 NRJ 榜
  '5453912201': svgToDataUrl(VIP_COVER_SVG),     // 黑胶 VIP 爱听榜
  '7785066739': svgToDataUrl(VIP_COVER_SVG),     // 黑胶 VIP 热歌榜
  '7785123708': svgToDataUrl(VIP_COVER_SVG),     // 黑胶 VIP 新歌榜
  '12344472377': svgToDataUrl(VIP_COVER_SVG),    // 黑胶 VIP 限免榜
};

// 语义模糊匹配兜底
function matchHandcraftedCover(name) {
  if (!name) return null;
  if (/国风/i.test(name)) return svgToDataUrl(GUOFENG_COVER_SVG);
  if (/电音|电子/i.test(name)) return svgToDataUrl(ELECTRO_COVER_SVG);
  if (/说唱|RAP/i.test(name)) return svgToDataUrl(RAP_COVER_SVG);
  if (/ACG|动画|二次元/i.test(name)) return svgToDataUrl(ACG_COVER_SVG);
  if (/摇滚|ROCK/i.test(name)) return svgToDataUrl(ROCK_COVER_SVG);
  if (/古典|交响/i.test(name)) return svgToDataUrl(CLASSICAL_COVER_SVG);
  if (/民谣/i.test(name)) return svgToDataUrl(MINYAO_COVER_SVG);
  if (/欧美/i.test(name)) return svgToDataUrl(WESTERN_COVER_SVG);
  if (/日语|Oricon/i.test(name)) return svgToDataUrl(JAPANESE_COVER_SVG);
  if (/韩语/i.test(name)) return svgToDataUrl(KOREAN_COVER_SVG);
  if (/Billboard|UK|NRJ|全球/i.test(name)) return svgToDataUrl(BILLBOARD_COVER_SVG);
  if (/VIP|黑胶/i.test(name)) return svgToDataUrl(VIP_COVER_SVG);
  if (/原创/i.test(name)) return svgToDataUrl(ORIGINAL_COVER_SVG);
  if (/新歌/i.test(name)) return svgToDataUrl(NEW_COVER_SVG);
  if (/飙升/i.test(name)) return svgToDataUrl(SURGE_COVER_SVG);
  if (/热歌/i.test(name)) return svgToDataUrl(HOT_COVER_SVG);
  return null;
}

/**
 * 获取定制榜单封面 DataURL
 * @param {string|number} chartId 榜单 ID
 * @param {string} [chartName] 榜单名称（用于语义命中手搓设计）
 * @returns {string|null} DataURL 字符串，非 Aimo 主题或未匹配返回 null（保持原生）
 */
export function getAimoChartCover(chartId, chartName = '') {
  if (!isAimoActive()) return null;
  const idStr = String(chartId || '');
  if (Object.prototype.hasOwnProperty.call(CHART_COVERS, idStr)) {
    return CHART_COVERS[idStr];
  }
  if (chartName) {
    const matched = matchHandcraftedCover(chartName);
    if (matched) return matched;
  }
  return null;
}
