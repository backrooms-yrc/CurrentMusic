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
