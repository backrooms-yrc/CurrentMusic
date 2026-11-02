#!/usr/bin/env node
/**
 * CurrentMusic 官方网站构建脚本
 * ----------------------------------------------------------------------------
 * 做什么：
 *   1. 把 MDUI 与 Material Icons 从 node_modules 复制到输出目录的 vendor/ 下
 *      —— 站点不依赖任何 CDN，离线 / 内网 / 被墙环境都能正常打开；
 *   2. 校验 index.html 是否引用了本地产物、外链是否都带 target/rel；
 *   3. 输出到 ../data/home（与 data/app 的部署惯例一致，可被站点根目录直接托管）。
 *
 * 用法：
 *   node build.mjs             # 输出到 ../data/home
 *   node build.mjs /tmp/site   # 输出到指定目录
 */

import { cp, mkdir, rm, readFile, writeFile, access, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Reuse the dependencies pinned by web/package-lock.json in a fresh checkout.
const require = createRequire(join(HERE, '../web/package.json'));

const OUT = resolve(HERE, process.argv[2] || '../data/www');

/** 来自 node_modules 的依赖（用 require.resolve 定位真实路径） */
const VENDOR = [
  // mdui 2.1.5：ESM 自包含包（组件 + 样式令牌）
  ['mdui/mdui.css', 'home/vendor/mdui/mdui.css'],
  ['mdui/mdui.esm.js', 'home/vendor/mdui/mdui.esm.js'],
  // 中文语言包（组件的确定/取消等内置文案）
  ['mdui/locales/zh-cn.js', 'home/vendor/mdui/locales/zh-cn.js'],
  // Material Icons Outlined：图标字体 + 字体规则
  ['@material-design-icons/font/outlined.css', 'home/vendor/material-icons/outlined.css'],
  ['@material-design-icons/font/material-icons-outlined.woff2', 'home/vendor/material-icons/material-icons-outlined.woff2'],
];

/** 站点自身文件（相对本目录） */
const LOCAL = [
  // 站点自身资源统一放在 home/ 命名空间下：
  // 根路径 / 由 nginx 精确匹配指向本页，资源走 /home/ 前缀，
  // 这样就不会侵占 /styles.css、/assets/、/vendor/ 这类通用路径
  // （那些路径在 music.20110208.xyz 上由兜底反代和其他页面使用）。
  // 注意：这里的 to 是相对 OUT 的路径，OUT 根 = 部署根。
  ['index.html', 'home/index.html'],
  ['styles.css', 'home/styles.css'],
  ['app.js', 'home/app.js'],
  ['assets/favicon.svg', 'home/assets/favicon.svg'],
  ['assets/apple-touch-icon.png', 'home/assets/apple-touch-icon.png'],
  ['assets/og-cover.svg', 'home/assets/og-cover.svg'],   // 封面源文件（矢量）
  ['assets/og-cover.jpg', 'home/assets/og-cover.jpg'],   // 社交分享封面（1200×630，平台兼容性更好）
];

/** 必须出现在页面里的关键内容（缺任何一条都算构建失败） */
const REQUIRED_IN_HTML = [
  // 定位与首屏
  '免费畅听网易云音乐 SVIP 曲目的音乐社区',
  '立即体验 Web 端',
  '查看客户端下载',
  '阅读 API 文档',
  // 四项客户端与入口
  'CurrentMusicX', 'bileizhen',
  '精美的 UI，流畅的动画，为您带来最佳的音乐体验。',
  '概念版', 'Android WebView', '显示异常、版式错乱、性能降低',
  'CurrentMusic Web 网页端', '随时随地，打开网页，想听即听',
  'CurrentStation 控制台', '将你的应用免费接入 CurrentMusic',
  // 联系我们的两个群
  '1106353813', 'Current 系项目 QQ 交流群', '200+ 人',
  '946064821', 'CurrentMusicX 项目 QQ 交流群', '25+ 人',
  // 必须是完整的加群链接与仓库链接，不得截断
  'https://qun.qq.com/universal-share/share?ac=1&authKey=Y4c39DZ%2B5qe4El%2BEkTtA0oVd%2Fd8fNpeeM6L%2FzBL66MmmYdzkxbKppptGLY6gKNq3',
  'https://qun.qq.com/universal-share/share?ac=1&authKey=iqIyjZ7V4UyQaP8wfNUYZ0abTor%2F9rNpMQy94zUsD178YelEuVY9NYh4Frh8059v',
  'https://github.com/bileizhen/CurrentMusicX/releases',
  'https://music.20110208.xyz/app',
  'https://music.20110208.xyz/api-docs/',
  // 概念版的两个下载源（服务器源 + 本仓库 Releases）必须都在
  'https://music.20110208.xyz/cm/download/latest',
  'https://github.com/backrooms-yrc/CurrentMusic/releases',
  // 主仓库（取自 README「相关仓库」）与导航栏/页脚的 GitHub 落点
  'https://github.com/backrooms-yrc/CurrentMusic',
  // CurrentStation 不单独开源，页面上的说明文字
  'CurrentStation 通行证与控制台不单独开源',
  // 页脚
  '免责声明', '友情链接',
  // SEO
  'og:title', 'og:description', 'og:image', 'name="description"', 'name="keywords"',
];

/** 公开页面里不允许残留的占位符（曾经因为没翻工作区而留下“待补充”） */
const FORBIDDEN_IN_HTML = ['待补充', 'TODO', 'TBD', '占位', '示例链接', '即将上线'];

const log = (...a) => console.log(...a);
let failed = false;
function check(ok, label, detail = '') {
  log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

/* ── 0. 清理输出目录 ─────────────────────────────────────────────────── */
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
log(`输出目录：${OUT}\n`);

/* ── 1. 复制静态资源 ─────────────────────────────────────────────────── */
log('[1/4] 复制静态资源');
for (const [from, to] of VENDOR) {
  const src = require.resolve(from);
  const dest = join(OUT, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
  const { size } = await stat(dest);
  log(`  · ${to}  (${(size / 1024).toFixed(1)} KB，来自 node_modules)`);
}
for (const [from, to] of LOCAL) {
  const src = join(HERE, from);
  const dest = join(OUT, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest);
  const { size } = await stat(dest);
  log(`  · ${to}  (${(size / 1024).toFixed(1)} KB)`);
}

/* ── 2. 资源路径改写 + 内容指纹 ──────────────────────────────────────── */
// 页面以「根路径精确匹配」对外提供，但资源不能因此占用 /styles.css、
// /assets/、/vendor/ 这类通用路径（该域名下它们归兜底反代与其他页面）。
// 所以把站点自身资源统一挂到 ASSET_PREFIX 命名空间，并在 HTML/JS 里改写引用。
const ASSET_PREFIX = '/home/';

log('\n[2/4] 改写资源路径并写入指纹');
{
  const { createHash } = await import('node:crypto');
  const hash = async f => createHash('sha1').update(await readFile(join(OUT, f))).digest('hex').slice(0, 10);
  const [css, js] = await Promise.all([hash('home/styles.css'), hash('home/app.js')]);

  const file = join(OUT, 'home/index.html');
  let html = await readFile(file, 'utf8');
  const before = html;

  // 裸相对引用 -> 带命名空间的绝对路径（favicon / styles.css / app.js / assets/*）
  html = html
    .replace(/(href|src)="(?!https?:|\/|#|mailto:)([^"]+)"/g, `$1="${ASSET_PREFIX}$2"`);
  // 内联 script JSON-LD 等处的 assets 引用（og:image 由运行时改写，这里只处理已绝对化的）
  html = html
    .replace(/(href="\/home\/styles\.css)(\?v=[^"]*)?(")/, `$1?v=${css}$3`)
    .replace(/(src="\/home\/app\.js)(\?v=[^"]*)?(")/, `$1?v=${js}$3`);
  await writeFile(file, html);
  check(html !== before, 'index.html 资源路径已改写为 ' + ASSET_PREFIX,
    `styles.css=${css} app.js=${js}`);

  // app.js 里的静态 import 同样要带上命名空间。
  // 注意这里是「裸导入」（import './x' 无 from），别写成 from '...' 匹配不到。
  const jsFile = join(OUT, 'home/app.js');
  let jsSrc = await readFile(jsFile, 'utf8');
  const jsBefore = jsSrc;
  jsSrc = jsSrc.replace(/import\s+'\.\/(vendor\/[^']+)'/g, `import '${ASSET_PREFIX}$1'`);
  await writeFile(jsFile, jsSrc);
  check(jsSrc !== jsBefore, 'app.js 的 vendor import 已改写',
    (jsSrc.match(/import '\/home\/vendor\/[^']+'/g) || []).length + ' 处');
}

/* ── 3. 校验产物内容 ─────────────────────────────────────────────────── */
log('\n[3/4] 校验页面内容与链接');
const html = await readFile(join(OUT, 'home/index.html'), 'utf8');
// 源码里为了可读性会在句子中间换行，浏览器渲染时那只是空白。
// 校验前先折叠空白，并去掉“中文字符之间”由换行产生的多余空格，
// 避免“文案其实在、却因换行缩进判为缺失”的假失败。
const flat = html
  .replace(/\s+/g, ' ')
  .replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '$1');
const missing = REQUIRED_IN_HTML.filter(s => !flat.includes(s));
check(missing.length === 0, `关键内容齐全（${REQUIRED_IN_HTML.length} 项）`,
  missing.length ? `缺少：${missing.join(' | ')}` : '');

// 公开页面不得残留占位符；确实找不到的地址应写清原因，而不是写“待补充”
const leftovers = FORBIDDEN_IN_HTML.filter(s => flat.includes(s));
check(leftovers.length === 0, '页面无占位符残留（待补充 / TODO 等）',
  leftovers.length ? `发现：${leftovers.join(' | ')}` : '');

// 本地引用的文件必须真实存在
const localRefs = [...html.matchAll(/(?:href|src)="((?!https?:|#|mailto:)[^"]+)"/g)].map(m => m[1]);
for (const ref of localRefs) {
  const clean = ref.replace(/\?.*$/, '');
  try { await access(join(OUT, clean)); check(true, `本地资源存在：${ref}`); }
  catch { check(false, `本地资源缺失：${ref}`); }
}

// 外部链接必须新窗口打开，且带 rel=noopener
// [^<>] 允许属性跨行书写，同时避免把相邻两个 <a> 匹配成同一个标签
const extLinks = [...html.matchAll(/<a\b[^<>]*?href="https?:[^"]*"[^<>]*?>/g)].map(m => m[0]);
const unsafe = extLinks.filter(t => !/target="_blank"/.test(t) || !/rel="noopener/.test(t));
check(unsafe.length === 0, `全部 ${extLinks.length} 个外部链接均为 target=_blank + rel=noopener`,
  unsafe.length ? `${unsafe.length} 个不合规` : '');

// 页面里出现的全部 http(s) 地址（含 JSON-LD 与文本展示）——用于核对具体链接
const allUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map(m => m[0]))];
const allowedUrls = [
  // 本官网自身地址（canonical / og:url / og:image）——正式域名。
  // 页面运行时 initSelfUrl() 也会按实际访问地址自动改写。
  'https://music.20110208.xyz/home/assets/og-cover.jpg',
  // 同域下的其他页面（本官网不接管，链接保持指向它们）
  'https://music.20110208.xyz/app',
  'https://music.20110208.xyz/api-docs/',
  'https://music.20110208.xyz/cm/download/latest',   // 概念版「服务器源」下载
  'https://github.com/bileizhen/CurrentMusicX',   // 仅用于 JSON-LD sameAs
  'https://github.com/bileizhen/CurrentMusicX/releases',
  // 主项目仓库（README「相关仓库」/ App 内更新检查所用）
  'https://github.com/backrooms-yrc/CurrentMusic',
  'https://github.com/backrooms-yrc/CurrentMusic/releases',
  'https://schema.org',
  'https://qun.qq.com/',
];
// 只允许 music.20110208.xyz 与 qun.qq.com 带任意子路径；
// GitHub / schema.org / 自身地址必须精确命中白名单，避免前缀匹配被绕过。
const PATH_PREFIX_HOSTS = ['https://music.20110208.xyz/', 'https://qun.qq.com/'];
const allowed = u => allowedUrls.includes(u)
  || PATH_PREFIX_HOSTS.some(p => u === p || u.startsWith(p));
const unexpected = allUrls.filter(u => !allowed(u));
check(unexpected.length === 0, `页面内 ${allUrls.length} 个地址全部来自已知来源（无臆测链接）`,
  unexpected.length ? unexpected.join(', ') : '');

// 指向本站自身的绝对地址，必须在产物里真有对应文件。
// （曾出现 og:image 写 /assets/og-cover.jpg，而资源实际在 /home/assets/ 下 → 404）
// 例外：同域下由其他服务提供的路径（音乐网页版 / 控制台 / 后端接口），
// 它们不属于本产物，无法也不应在这里校验。
const SELF_ORIGIN = 'https://music.20110208.xyz/';
const OTHER_SERVICES = ['app', 'station', 'cm', 'developer', 'ui-preview', 'api-docs'];
const selfUrls = allUrls.filter(u => u.startsWith(SELF_ORIGIN));
const brokenSelf = [];
for (const u of selfUrls) {
  const rel = u.slice(SELF_ORIGIN.length).split(/[?#]/)[0];
  if (!rel) continue;                                      // 站点根
  if (OTHER_SERVICES.some(p => rel === p || rel.startsWith(p + '/'))) continue;
  if (!existsSync(join(OUT, rel))) brokenSelf.push(u);
}
check(brokenSelf.length === 0,
  `本站自身的 ${selfUrls.length} 个地址均已核实（其余由同域其他服务提供）`,
  brokenSelf.length ? `无对应文件：${brokenSelf.join(', ')}` : '');

// 指向 GitHub 的链接只能来自已核实的公开仓库。
// CurrentMusic 统一公开库包含后端、客户端、部署模板与文档。
const KNOWN_GH = [
  'https://github.com/bileizhen/CurrentMusicX',
  'https://github.com/bileizhen/CurrentMusicX/releases',
  'https://github.com/backrooms-yrc/CurrentMusic',
  'https://github.com/backrooms-yrc/CurrentMusic/releases',
];
const fabricated = allUrls
  .filter(u => u.startsWith('https://github.com/'))
  .filter(u => !KNOWN_GH.includes(u));
check(fabricated.length === 0, '未编造未提供的 GitHub 仓库地址',
  fabricated.length ? fabricated.join(', ') : '');

/* ── 4. 汇总 ─────────────────────────────────────────────────────────── */
log('\n[4/4] 构建结果');
if (failed) {
  console.error('\n构建失败：存在未通过校验的项。');
  process.exit(1);
}
log(`\n完成 → ${OUT}`);
log('部署提示：将该目录内容放到站点根目录（或 /home 路径）即可直接访问。');
