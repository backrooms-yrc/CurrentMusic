// ==========================================================================
// Aimo 风格官方榜单专属艺术封面
// 专为三大核心热榜（热歌榜、飙升榜、新歌榜）定制的高辨识度排版艺术封面
// 仅在 html[data-ui-preset="aimo"] 生效
// ==========================================================================

const isAimoActive = () => document.documentElement.getAttribute('data-ui-preset') === 'aimo';

function svgToDataUrl(svgString) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgString.trim())}`;
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
  
  <!-- 声波同心环 -->
  <g stroke="rgba(255,255,255,0.04)" fill="none" stroke-width="1">
    <circle cx="200" cy="200" r="160"/>
    <circle cx="200" cy="200" r="120"/>
    <circle cx="200" cy="200" r="80"/>
  </g>
  
  <!-- 水印字 -->
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(224,112,60,0.12)" text-anchor="end" letter-spacing="-3">HOT</text>
  
  <!-- 顶部角标 -->
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(224,112,60,0.2)" stroke="rgba(224,112,60,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#f0966a" text-anchor="middle" letter-spacing="1.5">TOP 01</text>
  
  <!-- 火焰徽标与主标题 -->
  <g transform="translate(32, 230)">
    <!-- 简练火苗图标 -->
    <path d="M14 0 C14 0 20 8 20 14 C20 19.5 15.5 24 10 24 C4.5 24 0 19.5 0 14 C0 10 4 5 7 2 C7 5 9 7 11 7 C11 5 11 2 14 0 Z" fill="#e0703c"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">热歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">DAILY HIT 100 CHARTS</text>
  </g>
</svg>
`;

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
  
  <!-- 向上气流上升线 -->
  <g stroke="rgba(255,255,255,0.05)" stroke-width="1.5" stroke-dasharray="4 6">
    <line x1="260" y1="360" x2="360" y2="180"/>
    <line x1="220" y1="380" x2="320" y2="200"/>
    <line x1="180" y1="400" x2="280" y2="220"/>
  </g>
  
  <!-- 水印字 -->
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(94,168,219,0.12)" text-anchor="end" letter-spacing="-3">SURGE</text>
  
  <!-- 顶部角标 -->
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(94,168,219,0.2)" stroke="rgba(94,168,219,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#78bfe8" text-anchor="middle" letter-spacing="1.5">TOP 02</text>
  
  <!-- 飙升箭头与主标题 -->
  <g transform="translate(32, 230)">
    <!-- 简约上升折线箭头 -->
    <path d="M0 18 L10 8 L16 14 L26 4 M20 4 L26 4 L26 10" fill="none" stroke="#5ea8db" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">飙升榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">FASTEST RISING TRACKS</text>
  </g>
</svg>
`;

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
  
  <!-- 八角星芒 -->
  <g transform="translate(300, 140)" fill="rgba(201,190,139,0.15)">
    <polygon points="0,-36 7,-10 33,-14 14,7 26,30 2,16 -16,28 -10,6 -32,-3 -9,-12"/>
  </g>
  
  <!-- 水印字 -->
  <text x="370" y="110" font-family="serif" font-size="78" font-weight="800" fill="rgba(168,191,121,0.12)" text-anchor="end" letter-spacing="-3">NEW</text>
  
  <!-- 顶部角标 -->
  <rect x="28" y="28" width="68" height="24" rx="12" fill="rgba(168,191,121,0.2)" stroke="rgba(168,191,121,0.4)" stroke-width="1"/>
  <text x="62" y="44" font-family="sans-serif" font-size="10" font-weight="700" fill="#bed68d" text-anchor="middle" letter-spacing="1.5">TOP 03</text>
  
  <!-- 四角星标与主标题 -->
  <g transform="translate(32, 230)">
    <!-- 灵动星芒图标 -->
    <path d="M12 0 L15 8 L23 11 L15 14 L12 22 L9 14 L1 11 L9 8 Z" fill="#a8bf79"/>
    <text x="0" y="68" font-family="'Cinzel', 'Noto Serif SC', serif" font-size="38" font-weight="700" fill="#f8f4ed" letter-spacing="1">新歌榜</text>
    <text x="2" y="98" font-family="sans-serif" font-size="12" font-weight="600" fill="rgba(248,244,237,0.55)" letter-spacing="2">NEW SOUNDS &amp; RELEASES</text>
  </g>
</svg>
`;

const CHART_COVERS = {
  '3778678': svgToDataUrl(HOT_COVER_SVG),
  '19723756': svgToDataUrl(SURGE_COVER_SVG),
  '3779629': svgToDataUrl(NEW_COVER_SVG),
};

export function getAimoChartCover(chartId) {
  if (!isAimoActive()) return null;
  const idStr = String(chartId || '');
  return CHART_COVERS[idStr] || null;
}
