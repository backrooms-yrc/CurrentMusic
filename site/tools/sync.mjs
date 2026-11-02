#!/usr/bin/env node
/**
 * 把构建产物同步到线上域名根目录
 * ----------------------------------------------------------------------------
 * 产物结构（data/www）：
 *   <OUT>/home/index.html          ← 首页（URL：/）
 *   <OUT>/home/{styles.css,app.js,assets/,vendor/}   ← 资源（URL：/home/...）
 *
 * 线上 music.20110208.xyz 的 nginx 已配置：
 *   location = /        → try_files /index.html（root 指向 <root>/home）
 *   location ^~ /home/  → 静态托管 <root>/home/
 *
 * 因此只需把产物内容整体铺到 /www/wwwroot/music.20110208.xyz/，
 * 得到 <root>/home/**（含 index.html）即可，不需要额外目录层级。
 *
 * 用法：
 *   node tools/sync.mjs
 *   ROOT=/some/path node tools/sync.mjs
 */

import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(HERE, '..');
const OUT = resolve(SITE, '..', 'data', 'www');
const ROOT = process.env.ROOT || '/www/wwwroot/music.20110208.xyz';

const log = (...a) => console.log(...a);

if (!existsSync(join(OUT, 'home', 'index.html'))) {
  console.error(`构建产物不存在：${OUT}/home/index.html —— 请先运行 node build.mjs`);
  process.exit(1);
}

/* ── 清理历史遗留结构 ────────────────────────────────────────────────── */
// 早期版本把产物放成 <root>/home/home/**，并在根目录留了一个 index.html，
// 那两个位置现在都不需要，先清掉，避免下次又读到旧文件。
for (const junk of ['index.html', 'home/home']) {
  const p = join(ROOT, junk);
  if (existsSync(p)) {
    await rm(p, { recursive: true, force: true });
    log(`  · 清理遗留：${p}`);
  }
}

/* ── 部署 ────────────────────────────────────────────────────────────── */
log('[1/2] 同步到线上域名根目录');
const webHome = join(ROOT, 'home');
await rm(webHome, { recursive: true, force: true });
await mkdir(webHome, { recursive: true });
await cp(join(OUT, 'home'), webHome, { recursive: true });
log(`  · ${webHome}/`);

try {
  const { execFileSync } = await import('node:child_process');
  execFileSync('chown', ['-R', 'www:www', webHome]);
  log('  · 属主已设为 www:www（nginx worker 以 www 运行）');
} catch (e) {
  log(`  ! 设置属主失败（可能不是 root）：${e.message}`);
}

/* ── 汇总 ────────────────────────────────────────────────────────────── */
async function countFiles(dir) {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    n += e.isDirectory() ? await countFiles(join(dir, e.name)) : 1;
  }
  return n;
}
log(`\n[2/2] 完成：${await countFiles(webHome)} 个文件 → ${webHome}/`);
log('本地预览：node site/tools/serve.mjs <端口>（根目录为 data/www，/ 会映射到 home/index.html）');
