// CurrentMusic 前端构建：esbuild 打成单 IIFE（js + css），输出到 Android assets。
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT = '../app/src/main/assets/www';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome100'],
  minify: true,
  outfile: `${OUT}/app.js`,
  loader: { '.woff2': 'file' },
  assetNames: '[name]',
  logLevel: 'info',
});

// 图标字体随 css import 已由 esbuild 拷到 OUT；index.html 直接复制
await cp('index.html', `${OUT}/index.html`);
console.log('web 构建完成 →', OUT);
