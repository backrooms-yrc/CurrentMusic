// ==========================================================================
// Aimo 风格排行榜专属艺术封面 (Artisan Handcrafted Editorial Covers)
// 为核心官方榜单与主流垂直音乐榜单定制的别出心裁的高级设计
// 彻底去除生硬机械的通用生成，纯手搓精致几何微结构、人文排版与专属色域
// 仅在 html[data-ui-preset="aimo"] 生效
// ==========================================================================

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

function svgToDataUrl(svgString) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
}

// --------------------------------------------------------------------------
// 1. 热歌榜 (Hot Songs · 3778678) —— 陶土赤褐、声波同心律动与余烬火光
// --------------------------------------------------------------------------
const HOT_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="hotBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1f1512"/>
      <stop offset="55%" stop-color="#2c1a13"/>
      <stop offset="100%" stop-color="#120c0a"/>
    </linearGradient>
    <radialGradient id="hotGlow1" cx="82%" cy="18%" r="62%">
      <stop offset="0%" stop-color="#e0693a" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#e0693a" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="hotGlow2" cx="15%" cy="85%" r="55%">
      <stop offset="0%" stop-color="#e8a855" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#e8a855" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#hotBg)"/>
  <rect width="400" height="400" fill="url(#hotGlow1)"/>
  <rect width="400" height="400" fill="url(#hotGlow2)"/>
  
  <!-- 声学共振同心圆弧环 -->
  <g stroke="rgba(255,255,255,0.04)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="140"/>
    <circle cx="280" cy="140" r="105"/>
    <circle cx="280" cy="140" r="70"/>
    <circle cx="280" cy="140" r="35"/>
  </g>
  
  <!-- 艺术背景大水印 -->
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="82" font-weight="900" fill="rgba(224,105,58,0.11)" text-anchor="end" letter-spacing="-3">HOT</text>
  
  <!-- 标题与排版区 -->
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#e0693a"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#e0693a" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">热歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">DAILY HIT 100 CHARTS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 2. 飙升榜 (Trending / Surge · 19723756) —— 极夜群青、破晓冰蓝与上升阶梯
// --------------------------------------------------------------------------
const SURGE_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="surgeBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#101720"/>
      <stop offset="55%" stop-color="#182535"/>
      <stop offset="100%" stop-color="#0c1117"/>
    </linearGradient>
    <radialGradient id="surgeGlow1" cx="80%" cy="15%" r="65%">
      <stop offset="0%" stop-color="#3c7f9f" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#3c7f9f" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="surgeGlow2" cx="18%" cy="85%" r="55%">
      <stop offset="0%" stop-color="#5fa9b5" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#5fa9b5" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#surgeBg)"/>
  <rect width="400" height="400" fill="url(#surgeGlow1)"/>
  <rect width="400" height="400" fill="url(#surgeGlow2)"/>
  
  <!-- 向上气流上升几何线与破晓光影 -->
  <g stroke="rgba(255,255,255,0.05)" stroke-width="1.5" stroke-dasharray="4 6">
    <line x1="240" y1="360" x2="350" y2="170"/>
    <line x1="200" y1="380" x2="310" y2="190"/>
    <line x1="160" y1="400" x2="270" y2="210"/>
  </g>
  
  <!-- 艺术背景大水印 -->
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="78" font-weight="900" fill="rgba(94,168,219,0.11)" text-anchor="end" letter-spacing="-3">SURGE</text>
  
  <!-- 标题与排版区 -->
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#5ea8db"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#5ea8db" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">飙升榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">FASTEST RISING TRACKS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 3. 新歌榜 (New Releases · 3779629) —— 橄榄苍绿、晨雾浅青与罗盘星芒
// --------------------------------------------------------------------------
const NEW_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="newBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141a13"/>
      <stop offset="55%" stop-color="#1f2a1b"/>
      <stop offset="100%" stop-color="#0f140e"/>
    </linearGradient>
    <radialGradient id="newGlow" cx="80%" cy="15%" r="65%">
      <stop offset="0%" stop-color="#8da85d" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#8da85d" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#newBg)"/>
  <rect width="400" height="400" fill="url(#newGlow)"/>
  
  <!-- 别致星芒与罗盘细线 -->
  <g transform="translate(290, 135)" fill="rgba(201,190,139,0.14)">
    <polygon points="0,-40 8,-12 36,-16 16,8 28,34 2,18 -18,32 -12,6 -36,-4 -10,-14"/>
  </g>
  
  <!-- 艺术背景大水印 -->
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="82" font-weight="900" fill="rgba(168,191,121,0.11)" text-anchor="end" letter-spacing="-3">NEW</text>
  
  <!-- 标题与排版区 -->
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#a8bf79"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#a8bf79" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">新歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">NEW SOUNDS &amp; RELEASES</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 4. 原创榜 (Original Songs · 2884035) —— 烟熏黑紫、母带黑胶同心环与独立灵光
// --------------------------------------------------------------------------
const ORIGINAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="origBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#18111d"/>
      <stop offset="55%" stop-color="#24162c"/>
      <stop offset="100%" stop-color="#100b14"/>
    </linearGradient>
    <radialGradient id="origGlow" cx="78%" cy="20%" r="62%">
      <stop offset="0%" stop-color="#a45bb3" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#a45bb3" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#origBg)"/>
  <rect width="400" height="400" fill="url(#origGlow)"/>
  
  <!-- 黑胶母带轨迹弧线 -->
  <g stroke="rgba(216,160,230,0.08)" fill="none" stroke-width="1.5">
    <circle cx="280" cy="140" r="100"/>
    <circle cx="280" cy="140" r="65"/>
    <circle cx="280" cy="140" r="30"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(196,134,212,0.1)" text-anchor="end">ORIGIN</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#c486d4"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#c486d4" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">原创榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">CHINESE INDIE &amp; ORIGINAL</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 5. 国风榜 (Chinese Heritage · 5059642708) —— 墨砚黛色、朱砂红与金石方印
// --------------------------------------------------------------------------
const GUOFENG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="gfBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14181c"/>
      <stop offset="55%" stop-color="#1c252c"/>
      <stop offset="100%" stop-color="#0e1114"/>
    </linearGradient>
    <radialGradient id="gfRed" cx="80%" cy="18%" r="58%">
      <stop offset="0%" stop-color="#bd4739" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#bd4739" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#gfBg)"/>
  <rect width="400" height="400" fill="url(#gfRed)"/>
  
  <!-- 传统八角金石窗棂细线 -->
  <g stroke="rgba(255,255,255,0.04)" stroke-width="1.2" fill="none">
    <rect x="230" y="80" width="90" height="90" rx="8" transform="rotate(45 275 125)"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="76" font-weight="900" fill="rgba(214,92,79,0.11)" text-anchor="end">FOLK</text>
  
  <g transform="translate(32, 230)">
    <rect x="2" y="2" width="16" height="16" rx="3" fill="none" stroke="#d65c4f" stroke-width="1.8"/>
    <line x1="26" y1="10" x2="48" y2="10" stroke="#d65c4f" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">国风榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">TRADITIONAL HERITAGE</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 6. 电音榜 (Electronic · 1978921795) —— 幽邃深海青、高纯霓虹电光与合成波形
// --------------------------------------------------------------------------
const ELECTRO_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="elecBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d151f"/>
      <stop offset="55%" stop-color="#112230"/>
      <stop offset="100%" stop-color="#080e15"/>
    </linearGradient>
    <radialGradient id="elecGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#00d2c4" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#00d2c4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#elecBg)"/>
  <rect width="400" height="400" fill="url(#elecGlow)"/>
  
  <!-- 脉冲声学波形折线 -->
  <g fill="none" stroke="rgba(0,210,196,0.18)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M160 150 L200 120 L240 170 L280 100 L320 155 L350 130"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(0,210,196,0.11)" text-anchor="end">EDM</text>
  
  <g transform="translate(32, 230)">
    <polygon points="4,3 15,10 4,17" fill="#00d2c4"/>
    <line x1="22" y1="10" x2="44" y2="10" stroke="#00d2c4" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">电音榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">SYNTHESIS &amp; CLUB BEATS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 7. 说唱榜 (Hip-Hop & Rap · 991319590 / 14028249541) —— 黄金黑曜石与律动标杆
// --------------------------------------------------------------------------
const RAP_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="rapBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181611"/>
      <stop offset="55%" stop-color="#242016"/>
      <stop offset="100%" stop-color="#110f0b"/>
    </linearGradient>
    <radialGradient id="rapGold" cx="80%" cy="18%" r="62%">
      <stop offset="0%" stop-color="#d4af37" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#d4af37" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#rapBg)"/>
  <rect width="400" height="400" fill="url(#rapGold)"/>
  
  <!-- 均衡器节奏柱 -->
  <g fill="rgba(212,175,55,0.09)">
    <rect x="235" y="115" width="7" height="45" rx="3.5"/>
    <rect x="250" y="90" width="7" height="70" rx="3.5"/>
    <rect x="265" y="105" width="7" height="55" rx="3.5"/>
    <rect x="280" y="65" width="7" height="95" rx="3.5"/>
    <rect x="295" y="95" width="7" height="65" rx="3.5"/>
    <rect x="310" y="125" width="7" height="35" rx="3.5"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(212,175,55,0.11)" text-anchor="end">RAP</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#d4af37"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#d4af37" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">说唱榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">RHYME &amp; FLOW HITLIST</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 8. ACG 榜 (Anime / Comic / Games · 71385702 / 3001835560) —— 幻梦樱粉与二次元棱镜
// --------------------------------------------------------------------------
const ACG_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="acgBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1d1318"/>
      <stop offset="55%" stop-color="#281822"/>
      <stop offset="100%" stop-color="#120c10"/>
    </linearGradient>
    <radialGradient id="acgGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#f072a4" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#f072a4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#acgBg)"/>
  <rect width="400" height="400" fill="url(#acgGlow)"/>
  
  <g transform="translate(290, 135)" fill="rgba(240,114,164,0.14)">
    <polygon points="0,-32 10,-8 34,-6 14,10 22,34 0,18 -22,34 -14,10 -34,-6 -10,-8"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(240,114,164,0.11)" text-anchor="end">ACG</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#f072a4"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#f072a4" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">ACG 榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">ANIMATION &amp; GAME SOUNDS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 9. 摇滚榜 (Rock · 5059633707) —— 炽热朱红、斜切断裂带与地下朋克
// --------------------------------------------------------------------------
const ROCK_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="rockBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a1111"/>
      <stop offset="55%" stop-color="#261414"/>
      <stop offset="100%" stop-color="#110a0a"/>
    </linearGradient>
    <radialGradient id="rockGlow" cx="80%" cy="18%" r="62%">
      <stop offset="0%" stop-color="#e63946" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#e63946" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#rockBg)"/>
  <rect width="400" height="400" fill="url(#rockGlow)"/>
  
  <!-- 重金属断裂斜切线 -->
  <g stroke="rgba(230,57,70,0.18)" stroke-width="2.5" stroke-linecap="round">
    <line x1="250" y1="90" x2="330" y2="180"/>
    <line x1="270" y1="80" x2="350" y2="170"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(230,57,70,0.11)" text-anchor="end">ROCK</text>
  
  <g transform="translate(32, 230)">
    <polygon points="10,2 2,14 9,14 6,22 17,9 10,9" fill="#e63946"/>
    <line x1="24" y1="10" x2="46" y2="10" stroke="#e63946" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">摇滚榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">ELECTRIC &amp; ALTERNATIVE</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 10. 古典榜 (Classical · 71384707) —— 雅致香槟金与乐章椭圆弧
// --------------------------------------------------------------------------
const CLASSICAL_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="clsBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#151618"/>
      <stop offset="55%" stop-color="#1f2125"/>
      <stop offset="100%" stop-color="#0f1012"/>
    </linearGradient>
    <radialGradient id="clsGlow" cx="80%" cy="18%" r="65%">
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
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(212,175,55,0.1)" text-anchor="end">OPUS</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#dfc670"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#dfc670" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">古典榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">SYMPHONY &amp; SONATA</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 11. 民谣榜 (Folk · 5059661515) —— 浅草木色、晨光与木吉他指弹弧度
// --------------------------------------------------------------------------
const MINYAO_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="myBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#181714"/>
      <stop offset="55%" stop-color="#24211a"/>
      <stop offset="100%" stop-color="#12110e"/>
    </linearGradient>
    <radialGradient id="myGlow" cx="80%" cy="18%" r="62%">
      <stop offset="0%" stop-color="#c49a5b" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#c49a5b" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#myBg)"/>
  <rect width="400" height="400" fill="url(#myGlow)"/>
  
  <!-- 原木音孔与吉他琴弦弧光 -->
  <g stroke="rgba(196,154,91,0.12)" fill="none" stroke-width="1.2">
    <ellipse cx="280" cy="140" rx="85" ry="60"/>
    <line x1="160" y1="125" x2="360" y2="125"/>
    <line x1="160" y1="140" x2="360" y2="140"/>
    <line x1="160" y1="155" x2="360" y2="155"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="74" font-weight="900" fill="rgba(196,154,91,0.11)" text-anchor="end">FOLK</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#c49a5b"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#c49a5b" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">民谣榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">ACOUSTIC &amp; BALLADS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 12. 欧美榜 (Western Charts · 2809513713 / 2809577409) —— 大都会深夜冷蓝与时代先声
// --------------------------------------------------------------------------
const WESTERN_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="westBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#12161e"/>
      <stop offset="55%" stop-color="#1a222f"/>
      <stop offset="100%" stop-color="#0e1117"/>
    </linearGradient>
    <radialGradient id="westGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#4f89b8" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#4f89b8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#westBg)"/>
  <rect width="400" height="400" fill="url(#westGlow)"/>
  
  <g stroke="rgba(255,255,255,0.05)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="110"/>
    <line x1="170" y1="140" x2="390" y2="140"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(79,137,184,0.11)" text-anchor="end">WEST</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#6ba7d6"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#6ba7d6" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">欧美榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">GLOBAL WESTERN HITLIST</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 13. 日语榜 (Japanese Tracks · 5059644681 / 60131) —— 墨白日和、静谧藏青与落樱微弧
// --------------------------------------------------------------------------
const JAPANESE_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="jpBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#14171d"/>
      <stop offset="55%" stop-color="#1c212a"/>
      <stop offset="100%" stop-color="#0f1115"/>
    </linearGradient>
    <radialGradient id="jpGlow" cx="80%" cy="18%" r="62%">
      <stop offset="0%" stop-color="#e27387" stop-opacity="0.36"/>
      <stop offset="100%" stop-color="#e27387" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#jpBg)"/>
  <rect width="400" height="400" fill="url(#jpGlow)"/>
  
  <circle cx="280" cy="140" r="75" fill="none" stroke="rgba(226,115,135,0.12)" stroke-width="1.5"/>
  <circle cx="280" cy="140" r="8" fill="rgba(226,115,135,0.2)"/>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(226,115,135,0.1)" text-anchor="end">J-POP</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#e27387"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#e27387" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">日语榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">J-POP &amp; SOUNDTRACKS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 14. 韩语榜 (K-Pop Hits · 745956260) —— 紫晶魅影与舞台炫光
// --------------------------------------------------------------------------
const KOREAN_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="krBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1a121d"/>
      <stop offset="55%" stop-color="#28162d"/>
      <stop offset="100%" stop-color="#120c14"/>
    </linearGradient>
    <radialGradient id="krGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#b65fc9" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#b65fc9" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#krBg)"/>
  <rect width="400" height="400" fill="url(#krGlow)"/>
  
  <g fill="none" stroke="rgba(182,95,201,0.15)" stroke-width="1.5">
    <polygon points="280,75 330,140 280,205 230,140"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="70" font-weight="900" fill="rgba(182,95,201,0.1)" text-anchor="end">K-POP</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#c478d6"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#c478d6" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">韩语榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">KOREAN WAVE TRENDS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 15. Billboard / 全球权威榜 (Global Official · 60198 / 180106 / 3812895) —— 经典烫金白金与唱片殿堂
// --------------------------------------------------------------------------
const BILLBOARD_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="bbBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#171718"/>
      <stop offset="55%" stop-color="#242322"/>
      <stop offset="100%" stop-color="#111112"/>
    </linearGradient>
    <radialGradient id="bbGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#e5b869" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="#e5b869" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#bbBg)"/>
  <rect width="400" height="400" fill="url(#bbGlow)"/>
  
  <g stroke="rgba(229,184,105,0.12)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="105"/>
    <circle cx="280" cy="140" r="90"/>
    <circle cx="280" cy="140" r="45"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="64" font-weight="900" fill="rgba(229,184,105,0.12)" text-anchor="end">GLOBAL</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#e5b869"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#e5b869" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">权威榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">OFFICIAL GLOBAL CHARTS</text>
  </g>
</svg>`;

// --------------------------------------------------------------------------
// 16. 黑胶 VIP 爱听榜 (Vinyl VIP · 5453912201 / 7785066739 / 7785123708) —— 极简纯黑质感、流金同心齿纹
// --------------------------------------------------------------------------
const VIP_COVER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="100%" height="100%">
  <defs>
    <linearGradient id="vipBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#131314"/>
      <stop offset="55%" stop-color="#1e1d1a"/>
      <stop offset="100%" stop-color="#0d0d0e"/>
    </linearGradient>
    <radialGradient id="vipGlow" cx="80%" cy="18%" r="65%">
      <stop offset="0%" stop-color="#cca762" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#cca762" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#vipBg)"/>
  <rect width="400" height="400" fill="url(#vipGlow)"/>
  
  <g stroke="rgba(204,167,98,0.1)" fill="none" stroke-width="1.2">
    <circle cx="280" cy="140" r="115"/>
    <circle cx="280" cy="140" r="95"/>
    <circle cx="280" cy="140" r="75"/>
    <circle cx="280" cy="140" r="55"/>
  </g>
  
  <text x="372" y="105" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="78" font-weight="900" fill="rgba(204,167,98,0.11)" text-anchor="end">VIP</text>
  
  <g transform="translate(32, 230)">
    <circle cx="10" cy="10" r="4" fill="#cca762"/>
    <line x1="20" y1="10" x2="42" y2="10" stroke="#cca762" stroke-width="1.5" stroke-linecap="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">VIP 榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="11.5" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">VINYL VIP SELECTION</text>
  </g>
</svg>`;

// 精确手工定制字典映射
const CHART_COVERS = {
  // 核心三大榜
  '3778678': svgToDataUrl(HOT_COVER_SVG),        // 热歌榜
  '19723756': svgToDataUrl(SURGE_COVER_SVG),     // 飙升榜
  '3779629': svgToDataUrl(NEW_COVER_SVG),        // 新歌榜
  // 热门核心垂类手搓榜单
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

// 语义关键词识别（用于在发现页或详情页如果命中了包含特定字眼的特色榜单，智能匹配我们古法手搓的专属艺术设计）
function matchHandcraftedCover(name = '') {
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
 * 获取 Aimo 风格榜单封面
 * 完全去除程序化自动拼装生成，纯手工定制艺术设计
 * @param {string|number} chartId 榜单 ID
 * @param {string} [chartName] 榜单名称（用于语义命中手搓设计）
 * @returns {string|null} DataURL 字符串，非 Aimo 主题或未匹配返回 null（保持原生）
 */
export function getAimoChartCover(chartId, chartName = '') {
  if (!isAimoActive()) return null;
  const idStr = String(chartId || '');
  if (CHART_COVERS[idStr]) {
    return CHART_COVERS[idStr];
  }
  if (chartName) {
    const matched = matchHandcraftedCover(chartName);
    if (matched) return matched;
  }
  return null;
}
