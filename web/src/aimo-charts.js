// ==========================================================================
// Aimo 风格官方榜单专属艺术封面
// 专为官方排行榜与发现页榜单定制的高辨识度排版艺术封面
// 包含官方三大榜单定制、高频垂直分类定制与智能哈希风格化封面生成
// 仅在 html[data-ui-preset="aimo"] 生效
// ==========================================================================

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

function svgToDataUrl(svgString) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 1. 热歌榜 (Hot Songs · 3778678) —— 暖调焦糖、陶土琥珀与声波同心环
const HOT_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="hotBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1f1613"/>
      <stop offset="50%" stop-color="#2a1b14"/>
      <stop offset="100%" stop-color="#140f0d"/>
    </linearGradient>
    <radialGradient id="hotGlow1" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#d96b43" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#d96b43" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="hotGlow2" cx="20%" cy="80%" r="50%">
      <stop offset="0%" stop-color="#e8a855" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#e8a855" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#hotBg)"/>
  <rect width="400" height="400" fill="url(#hotGlow1)"/>
  <rect width="400" height="400" fill="url(#hotGlow2)"/>
  <g stroke="rgba(255,255,255,0.04)" fill="none" stroke-width="1">
    <circle cx="200" cy="200" r="160"/>
    <circle cx="200" cy="200" r="120"/>
    <circle cx="200" cy="200" r="80"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(224,112,60,0.12)" text-anchor="end" letter-spacing="-3">HOT</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(224,112,60,0.2)" stroke="rgba(224,112,60,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#f0966a" text-anchor="middle" letter-spacing="1.5">TOP 01</text>
  <g transform="translate(32, 230)">
    <path d="M14 0 C14 0 20 8 20 14 C20 19.5 15.5 24 10 24 C4.5 24 0 19.5 0 14 C0 10 4 5 7 2 C7 5 9 7 11 7 C11 5 11 2 14 0 Z" fill="#e0703c"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">热歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">DAILY HIT 100 CHARTS</text>
  </g>
</svg>`;

// 2. 飙升榜 (Trending / Surge · 19723756) —— 深邃石墨、极光冰蓝与向上气流阶梯
const SURGE_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="surgeBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#121820"/>
      <stop offset="50%" stop-color="#182432"/>
      <stop offset="100%" stop-color="#0e1319"/>
    </linearGradient>
    <radialGradient id="surgeGlow1" cx="80%" cy="15%" r="65%">
      <stop offset="0%" stop-color="#3b789e" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#3b789e" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="surgeGlow2" cx="20%" cy="85%" r="55%">
      <stop offset="0%" stop-color="#5fa9b5" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#5fa9b5" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#surgeBg)"/>
  <rect width="400" height="400" fill="url(#surgeGlow1)"/>
  <rect width="400" height="400" fill="url(#surgeGlow2)"/>
  <g stroke="rgba(255,255,255,0.05)" stroke-width="1.5" stroke-dasharray="4 6">
    <line x1="260" y1="360" x2="360" y2="180"/>
    <line x1="220" y1="380" x2="320" y2="200"/>
    <line x1="180" y1="400" x2="280" y2="220"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(94,168,219,0.12)" text-anchor="end" letter-spacing="-3">SURGE</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(94,168,219,0.2)" stroke="rgba(94,168,219,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#78bfe8" text-anchor="middle" letter-spacing="1.5">TOP 02</text>
  <g transform="translate(32, 230)">
    <path d="M0 18 L10 8 L16 14 L26 4 M20 4 L26 4 L26 10" fill="none" stroke="#5ea8db" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">飙升榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">FASTEST RISING TRACKS</text>
  </g>
</svg>`;

// 3. 新歌榜 (New Releases · 3779629) —— 沉静橄榄青、香槟金与星芒
const NEW_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="newBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#151a14"/>
      <stop offset="50%" stop-color="#212a1d"/>
      <stop offset="100%" stop-color="#111510"/>
    </linearGradient>
    <radialGradient id="newGlow1" cx="80%" cy="15%" r="65%">
      <stop offset="0%" stop-color="#8da85d" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#8da85d" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="newGlow2" cx="20%" cy="85%" r="55%">
      <stop offset="0%" stop-color="#c9be8b" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#c9be8b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#newBg)"/>
  <rect width="400" height="400" fill="url(#newGlow1)"/>
  <rect width="400" height="400" fill="url(#newGlow2)"/>
  <g transform="translate(300, 140)" fill="rgba(201,190,139,0.15)">
    <polygon points="0,-36 7,-10 33,-14 14,7 26,30 2,16 -16,28 -10,6 -32,-3 -9,-12"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(168,191,121,0.12)" text-anchor="end" letter-spacing="-3">NEW</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(168,191,121,0.2)" stroke="rgba(168,191,121,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#bed68d" text-anchor="middle" letter-spacing="1.5">TOP 03</text>
  <g transform="translate(32, 230)">
    <path d="M12 0 L15 8 L23 11 L15 14 L12 22 L9 14 L1 11 L9 8 Z" fill="#a8bf79"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">新歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">NEW SOUNDS &amp; RELEASES</text>
  </g>
</svg>`;

// 4. 原创榜 (Original Songs · 2884035) —— 浓郁烟熏紫与音符羽翼
const ORIGINAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="origBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1d1421"/>
      <stop offset="50%" stop-color="#2a1832"/>
      <stop offset="100%" stop-color="#130d17"/>
    </linearGradient>
    <radialGradient id="origGlow" cx="75%" cy="25%" r="65%">
      <stop offset="0%" stop-color="#a862b8" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#a862b8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#origBg)"/>
  <rect width="400" height="400" fill="url(#origGlow)"/>
  <circle cx="280" cy="160" r="90" stroke="rgba(216,160,230,0.08)" stroke-width="2" fill="none"/>
  <circle cx="280" cy="160" r="50" stroke="rgba(216,160,230,0.12)" stroke-width="1.5" fill="none"/>
  <text x="370" y="110" font-family="serif" font-size="70" font-weight="800" fill="rgba(196,134,212,0.1)" text-anchor="end">ORIGIN</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(168,98,184,0.2)" stroke="rgba(168,98,184,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#d896e8" text-anchor="middle" letter-spacing="1.5">CHART</text>
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="8" fill="#c486d4"/>
    <rect x="16" y="2" width="2.5" height="18" fill="#c486d4"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">原创榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">CHINESE INDIE &amp; ORIGINAL</text>
  </g>
</svg>`;

// 5. 国风榜 (Chinese Folk / Traditional · 5059642708) —— 黛蓝、朱砂红与印章留白
const GUOFENG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="gfBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161b1f"/>
      <stop offset="60%" stop-color="#1f282e"/>
      <stop offset="100%" stop-color="#101417"/>
    </linearGradient>
    <radialGradient id="gfRed" cx="80%" cy="20%" r="55%">
      <stop offset="0%" stop-color="#b84537" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#b84537" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#gfBg)"/>
  <rect width="400" height="400" fill="url(#gfRed)"/>
  <g stroke="rgba(255,255,255,0.04)" stroke-width="1" fill="none">
    <rect x="250" y="80" width="100" height="100" rx="8" transform="rotate(45 300 130)"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="76" font-weight="800" fill="rgba(214,92,79,0.12)" text-anchor="end">FOLK</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(184,69,55,0.2)" stroke="rgba(184,69,55,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#e88578" text-anchor="middle" letter-spacing="1.5">CLASSIC</text>
  <g transform="translate(32, 230)">
    <rect x="0" y="0" width="22" height="22" rx="4" fill="none" stroke="#d65c4f" stroke-width="2"/>
    <text x="11" y="15" font-family="'Noto Serif SC', serif" font-size="12" font-weight="900" fill="#d65c4f" text-anchor="middle">国</text>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">国风榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">TRADITIONAL HERITAGE</text>
  </g>
</svg>`;

// 6. 电音榜 (Electronic · 1978921795) —— 霓虹电子青、赛博暗紫与波形方块
const ELECTRO_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="elecBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f1622"/>
      <stop offset="60%" stop-color="#122533"/>
      <stop offset="100%" stop-color="#0a1018"/>
    </linearGradient>
    <radialGradient id="elecGlow" cx="80%" cy="20%" r="65%">
      <stop offset="0%" stop-color="#00d2c4" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#00d2c4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#elecBg)"/>
  <rect width="400" height="400" fill="url(#elecGlow)"/>
  <g fill="none" stroke="rgba(0,210,196,0.15)" stroke-width="2">
    <path d="M150 160 L200 120 L250 170 L300 110 L350 150"/>
  </g>
  <text x="370" y="110" font-family="sans-serif" font-size="70" font-weight="900" fill="rgba(0,210,196,0.12)" text-anchor="end">EDM</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(0,210,196,0.15)" stroke="rgba(0,210,196,0.35)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#44e5da" text-anchor="middle" letter-spacing="1.5">PULSE</text>
  <g transform="translate(32, 230)">
    <polygon points="4,2 18,11 4,20" fill="#00d2c4"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">电音榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">SYNTHESIS &amp; CLUB BEATS</text>
  </g>
</svg>`;

// 7. 说唱榜 (Hip-Hop & Rap · 991319590 / 14028249541) —— 黄金黑曜石与律动标杆
const RAP_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="rapBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1813"/>
      <stop offset="60%" stop-color="#262217"/>
      <stop offset="100%" stop-color="#12100d"/>
    </linearGradient>
    <radialGradient id="rapGold" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#rapBg)"/>
  <rect width="400" height="400" fill="url(#rapGold)"/>
  <g fill="rgba(212,175,55,0.08)">
    <rect x="240" y="120" width="8" height="50" rx="4"/>
    <rect x="256" y="95" width="8" height="75" rx="4"/>
    <rect x="272" y="110" width="8" height="60" rx="4"/>
    <rect x="288" y="70" width="8" height="100" rx="4"/>
    <rect x="304" y="100" width="8" height="70" rx="4"/>
    <rect x="320" y="130" width="8" height="40" rx="4"/>
  </g>
  <text x="370" y="110" font-family="sans-serif" font-size="74" font-weight="900" fill="rgba(212,175,55,0.12)" text-anchor="end">RAP</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(212,175,55,0.2)" stroke="rgba(212,175,55,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#e8c85c" text-anchor="middle" letter-spacing="1.5">FLOW</text>
  <g transform="translate(32, 230)">
    <path d="M6 3 L16 3 L14 16 L8 16 Z M9 16 L9 22 M6 22 L14 22" fill="none" stroke="#d4af37" stroke-width="2"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">说唱榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">RHYME &amp; FLOW HITLIST</text>
  </g>
</svg>`;

// 8. ACG 榜 (Anime / Comic / Games · 71385702 / 3001835560) —— 梦幻樱粉与二次元棱镜
const ACG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="acgBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1f1419"/>
      <stop offset="60%" stop-color="#2b1a23"/>
      <stop offset="100%" stop-color="#140d11"/>
    </linearGradient>
    <radialGradient id="acgGlow" cx="80%" cy="20%" r="65%">
      <stop offset="0%" stop-color="#f072a4" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#f072a4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#acgBg)"/>
  <rect width="400" height="400" fill="url(#acgGlow)"/>
  <g transform="translate(300, 140)" fill="rgba(240,114,164,0.14)">
    <polygon points="0,-32 10,-8 34,-6 14,10 22,34 0,18 -22,34 -14,10 -34,-6 -10,-8"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="74" font-weight="900" fill="rgba(240,114,164,0.12)" text-anchor="end">ACG</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(240,114,164,0.2)" stroke="rgba(240,114,164,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#f594bd" text-anchor="middle" letter-spacing="1.5">ANIME</text>
  <g transform="translate(32, 230)">
    <path d="M2 14 Q10 0 18 14 Q26 28 34 14" fill="none" stroke="#f072a4" stroke-width="2.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">ACG 榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">ANIMATION &amp; GAME SOUNDS</text>
  </g>
</svg>`;

// 9. 摇滚榜 (Rock · 5059633707) —— 炽烈火红与重金属质感
const ROCK_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="rockBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1c1212"/>
      <stop offset="60%" stop-color="#281515"/>
      <stop offset="100%" stop-color="#120c0c"/>
    </linearGradient>
    <radialGradient id="rockGlow" cx="80%" cy="20%" r="60%">
      <stop offset="0%" stop-color="#e63946" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#e63946" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#rockBg)"/>
  <rect width="400" height="400" fill="url(#rockGlow)"/>
  <path d="M260 80 L340 180 M280 70 L360 170" stroke="rgba(230,57,70,0.18)" stroke-width="3" stroke-linecap="round"/>
  <text x="370" y="110" font-family="sans-serif" font-size="74" font-weight="900" fill="rgba(230,57,70,0.12)" text-anchor="end">ROCK</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(230,57,70,0.2)" stroke="rgba(230,57,70,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#f27d86" text-anchor="middle" letter-spacing="1.5">PUNK</text>
  <g transform="translate(32, 230)">
    <polygon points="12,0 0,16 10,16 6,26 20,8 11,8" fill="#e63946"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">摇滚榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">ELECTRIC &amp; ALTERNATIVE</text>
  </g>
</svg>`;

// 10. 古典榜 (Classical · 71384707) —— 雅致香槟金与提琴律动曲线
const CLASSICAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="clsBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#161719"/>
      <stop offset="60%" stop-color="#202226"/>
      <stop offset="100%" stop-color="#111214"/>
    </linearGradient>
    <radialGradient id="clsGlow" cx="80%" cy="20%" r="65%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.32"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#clsBg)"/>
  <rect width="400" height="400" fill="url(#clsGlow)"/>
  <g stroke="rgba(212,175,55,0.08)" fill="none" stroke-width="1.5">
    <ellipse cx="280" cy="140" rx="70" ry="110" transform="rotate(-25 280 140)"/>
    <ellipse cx="280" cy="140" rx="40" ry="70" transform="rotate(-25 280 140)"/>
  </g>
  <text x="370" y="110" font-family="serif" font-size="70" font-weight="800" fill="rgba(212,175,55,0.1)" text-anchor="end">OPUS</text>
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(212,175,55,0.18)" stroke="rgba(212,175,55,0.38)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#dfc670" text-anchor="middle" letter-spacing="1.5">ORCHESTRA</text>
  <g transform="translate(32, 230)">
    <circle cx="10" cy="12" r="7" stroke="#d4af37" stroke-width="2" fill="none"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">古典榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">SYMPHONY &amp; SONATA</text>
  </g>
</svg>`;

// 精确匹配字典
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
  '5059633707': svgToDataUrl(ROCK_COVER_SVG),    // 摇滚榜
  '71384707': svgToDataUrl(CLASSICAL_COVER_SVG), // 古典榜
};

// 预定义色板，用于风格化智能生成（保持微冷纸墨与深邃高级质感）
const PALETTES = [
  { bg1: '#1b1a18', bg2: '#27241e', bg3: '#131210', accent: '#c8a25c', glow: '#d8b26c', tag: 'CHART' },
  { bg1: '#14181d', bg2: '#1b232c', bg3: '#0f1216', accent: '#629ec2', glow: '#78b0d2', tag: 'TREND' },
  { bg1: '#1a1418', bg2: '#281d24', bg3: '#130e11', accent: '#bd6a8b', glow: '#d27d9e', tag: 'SELECT' },
  { bg1: '#141a17', bg2: '#1d2621', bg3: '#0e1310', accent: '#72a884', glow: '#88bc9a', tag: 'SOUND' },
  { bg1: '#18151c', bg2: '#241e2b', bg3: '#110e14', accent: '#9b76b8', glow: '#ae89cc', tag: 'VIBE' },
  { bg1: '#1d1714', bg2: '#2b211b', bg3: '#140f0c', accent: '#cf7c53', glow: '#e08f67', tag: 'HITLIST' },
];

/**
 * 智能哈希风格化封面生成：
 * 为所有未录入具体 SVG 的榜单动态生成符合 Aimo 杂志感设计的美学封面
 */
function generateProceduralCover(chartId, chartName = '') {
  let seed = 0;
  const str = String(chartId) + String(chartName);
  for (let i = 0; i < str.length; i++) {
    seed = (seed << 5) - seed + str.charCodeAt(i);
    seed |= 0;
  }
  const pal = PALETTES[Math.abs(seed) % PALETTES.length];

  // 标题清洗
  let cleanTitle = String(chartName || '').trim();
  cleanTitle = cleanTitle.replace(/^(网易云|法国|美国|日本|腾讯)/g, '');
  if (cleanTitle.length > 7) {
    cleanTitle = cleanTitle.substring(0, 6) + '…';
  }
  if (!cleanTitle) cleanTitle = '榜单';

  // 提取拼音/英文或固定文字
  let subText = 'CHARTS &amp; DISCOVERY';
  if (/Billboard/i.test(chartName)) subText = 'BILLBOARD HOT LIST';
  else if (/UK/i.test(chartName)) subText = 'UK OFFICIAL TOP 40';
  else if (/Oricon/i.test(chartName)) subText = 'JAPAN ORICON WEEKLY';
  else if (/欧美/i.test(chartName)) subText = 'WESTERN POPULAR SOUNDS';
  else if (/韩语/i.test(chartName)) subText = 'KOREAN WAVE TRENDS';
  else if (/日语/i.test(chartName)) subText = 'JAPANESE SOUNDTRACKS';
  else if (/民谣/i.test(chartName)) subText = 'ACOUSTIC &amp; BALLADS';
  else if (/VIP/i.test(chartName)) subText = 'PREMIUM SELECTION';

  const watermark = cleanTitle.length <= 4 ? cleanTitle : 'TOP';

  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="pBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${pal.bg1}"/>
      <stop offset="55%" stop-color="${pal.bg2}"/>
      <stop offset="100%" stop-color="${pal.bg3}"/>
    </linearGradient>
    <radialGradient id="pGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="${pal.glow}" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="${pal.glow}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#pBg)"/>
  <rect width="400" height="400" fill="url(#pGlow)"/>
  
  <!-- 装饰几何细线 -->
  <g stroke="rgba(255,255,255,0.04)" fill="none" stroke-width="1.2">
    <circle cx="270" cy="150" r="130"/>
    <circle cx="270" cy="150" r="90"/>
    <line x1="160" y1="360" x2="360" y2="160"/>
  </g>

  <!-- 艺术背景暗印 -->
  <text x="372" y="112" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="64" font-weight="900" fill="rgba(255,255,255,0.06)" text-anchor="end" letter-spacing="-1">${escapeXml(watermark)}</text>

  <!-- 顶部胶囊角标 -->
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(255,255,255,0.08)" stroke="${pal.accent}" stroke-opacity="0.4" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="${pal.accent}" text-anchor="middle" letter-spacing="1.5">${pal.tag}</text>

  <!-- 下部排版区 -->
  <g transform="translate(32, 230)">
    <!-- 极简微徽标 -->
    <circle cx="10" cy="10" r="5" fill="${pal.accent}"/>
    <line x1="20" y1="10" x2="36" y2="10" stroke="${pal.accent}" stroke-width="1.5" stroke-linecap="round"/>
    <!-- 衬线大标题 -->
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="${cleanTitle.length >= 6 ? '32' : '38'}" font-weight="700" fill="#f8f4ed" letter-spacing="1">${escapeXml(cleanTitle)}</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11" font-weight="600" fill="rgba(248,244,237,0.5)" letter-spacing="1.8">${subText}</text>
  </g>
</svg>`;

  return svgToDataUrl(svg);
}

/**
 * 获取 Aimo 风格榜单封面
 * @param {string|number} chartId 榜单 ID
 * @param {string} [chartName] 榜单名称（可选，用于智能生成）
 * @returns {string|null} DataURL 字符串，非 Aimo 主题返回 null
 */
export function getAimoChartCover(chartId, chartName = '') {
  if (!isAimoActive()) return null;
  const idStr = String(chartId || '');
  if (CHART_COVERS[idStr]) {
    return CHART_COVERS[idStr];
  }
  // 如果提供了名称或者存在 chartId，生成符合 Aimo 杂志风格的封面
  if (chartName || idStr) {
    return generateProceduralCover(idStr, chartName);
  }
  return null;
}
