// 原创音符盾章。级别由配色和底部刻度共同区分，终阶使用星章和双翼。
const PALETTES = [
  ['#edf5ff', '#566c87', '#293f59'],
  ['#d6ffea', '#148774', '#075549'],
  ['#d6f2ff', '#257be4', '#184a9d'],
  ['#efdcff', '#874fdd', '#572d9c'],
  ['#ffe2c5', '#cc6531', '#8e391a'],
  ['#fff1b5', '#b47b16', '#77490a'],
  ['#fff0ab', '#a6467a', '#612b68'],
];

export function levelLabel(level) {
  if (level === 7) return 'Lv.6 Plus';
  return Number.isInteger(level) && level >= 1 && level <= 6 ? `Lv.${level}` : '';
}

export function levelBadge(level) {
  const label = levelLabel(level);
  if (!label) return '';
  const [light, edge, base] = PALETTES[level - 1];
  const plus = level === 7;
  const pips = Array.from({ length: Math.min(level, 6) }, (_, i) =>
    `<circle cx="${32 + (i - (Math.min(level, 6) - 1) / 2) * 5.5}" cy="44" r="1.7"/>`).join('');
  return `<svg class="cm-level-badge" viewBox="0 0 64 64" role="img" aria-label="${label}" focusable="false">
    ${plus ? `<path fill="${light}" stroke="${edge}" stroke-width="2" stroke-linejoin="round"
      d="M17 27 2 19l4 13 6 4-4-1 6 10 9 2m24-20 15-8-4 13-6 4 4-1-6 10-9 2"/>` : ''}
    <path d="m32 4 20 9v20c0 13-8 22-20 27-12-5-20-14-20-27V13z"
      fill="${base}" stroke="${light}" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="m32 8 16 7v18c0 10-6 18-16 23-10-5-16-13-16-23V15z" fill="${edge}"/>
    <path d="m32 8 16 7v10L16 40V15z" fill="${light}" opacity=".18"/>
    <g fill="${light}">
      ${plus ? '<path d="m32 13 3.8 8.3 9 .9-6.8 6.1 1.9 9-7.9-4.5-7.9 4.5 1.9-9-6.8-6.1 9-.9z"/>'
        : '<path d="M30 18.5 41 16v14.7c0 2.8-2.5 5-5.7 5-2.4 0-4.2-1.4-4.2-3.3 0-2.5 2.9-4.5 6.4-4.1v-7.6l-7.5 1.7v11c0 2.8-2.5 5-5.7 5-2.4 0-4.2-1.4-4.2-3.3 0-2.5 2.9-4.5 6.4-4.1V19.3z"/>'}
      ${pips}
    </g>
  </svg>`;
}
