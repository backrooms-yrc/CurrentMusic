// CurrentMusic 前端构建：esbuild 打成单 IIFE（js + css），输出到 Android assets。
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const OUT = '../app/src/main/assets/www';

// 挂件比例表随包签发：把 decorations/manifest.json 里的 id→scale 内联成模块，
// 首屏无需等接口即可拿到正确比例；同时写入目录版本号，供前端做缓存版本门控。
// （比例是素材留白补偿，用户不可感知，随包分发安全；服务端版本变化时会在线刷新覆盖。）
const MANIFEST = '../decorations/manifest.json';
const SCALES_MOD = 'src/decor-scales.js';
{
  let scales = {}, version = 'dev';
  try {
    const items = JSON.parse(await readFile(MANIFEST, 'utf8'));
    const h = createHash('sha1');
    for (const d of items) {
      const s = d.scale || 1;
      scales[d.id] = s;
      // 与后端 cm_decor.catalog_version() 保持同一算法（固定两位小数，避免 1 与 1.0 的差异）
      h.update(`${d.id}:${s.toFixed(2)};`);
    }
    version = h.digest('hex').slice(0, 12);
    await writeFile(SCALES_MOD,
      '// 本文件由 web/build.mjs 依据 decorations/manifest.json 生成，请勿手改。\n' +
      `export const CATALOG_VERSION = ${JSON.stringify(version)};\n` +
      `export const DECOR_SCALES = ${JSON.stringify(scales)};\n`);
    console.log(`挂件比例表 → ${SCALES_MOD}（${items.length} 项，版本 ${version}）`);
  } catch (e) {
    await writeFile(SCALES_MOD,
      '// 清单缺失时的空基线（运行时由 /decorations/scales 补齐）\n' +
      'export const CATALOG_VERSION = "dev";\nexport const DECOR_SCALES = {};\n');
    console.warn('未读到挂件清单，已写入空基线：', e.message);
  }
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome58'],   // Android 8.0 出厂 WebView 起可用（55~57 需升级 WebView，App 内会提示）
  // 注意：不要用 supported:{arrow:false} 强制降级箭头——esbuild 在 mdui 的类构造里
  // 会因此生成访问 this 先于 super() 的代码，导致每个组件构造都抛 "Must call super..."。
  minify: true,
  outfile: `${OUT}/app.js`,
  loader: { '.woff2': 'file' },
  assetNames: '[name]',
  logLevel: 'info',
});

// 图标字体随 css import 已由 esbuild 拷到 OUT；index.html 直接复制
await cp('index.html', `${OUT}/index.html`);
console.log('web 构建完成 →', OUT);
