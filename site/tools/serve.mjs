#!/usr/bin/env node
/**
 * CurrentMusic 官网静态服务（公网部署用）
 * ----------------------------------------------------------------------------
 * · 绑定 0.0.0.0，端口由参数指定（默认 0 = 由系统随机分配）
 * · 只提供 data/home 内的文件，拒绝目录穿越
 * · 无需任何依赖，Node 内置模块即可
 *
 * 用法：
 *   node tools/serve.mjs 39517          # 指定端口
 *   node tools/serve.mjs                # 系统随机端口
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', 'data', 'www');    // 站点产物根目录
const PORT = Number(process.argv[2] || 0);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const started = Date.now();

  // 只接受 GET / HEAD
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('405 Method Not Allowed');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  if (pathname === '/') pathname = '/home/index.html';        // 首页在 home/ 命名空间内
  else if (pathname.endsWith('/')) pathname += 'index.html';

  // 目录穿越防护：规范化后必须仍在 ROOT 之内
  const target = normalize(join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');

    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'public, max-age=604800',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });

    if (req.method === 'HEAD') return res.end();
    createReadStream(target)
      .on('error', () => res.destroy())
      .pipe(res)
      .on('close', () => {
        const ip = req.socket.remoteAddress || '-';
        console.log(`${new Date().toISOString()} ${ip} ${req.method} ${pathname} ${res.statusCode} ${info.size}B ${Date.now() - started}ms`);
      });
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, HOST, () => {
  const { port, address } = server.address();
  console.log(`CurrentMusic 官网已启动`);
  console.log(`  根目录: ${ROOT}`);
  console.log(`  监听:   ${address}:${port}`);
  console.log(`  本机:   http://127.0.0.1:${port}/`);
});
