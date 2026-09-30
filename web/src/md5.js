// MD5（RFC 1321）——只为了网易云云盘上传：上游要用文件 md5 换上传令牌，
// 而 WebCrypto 只提供 SHA-1/256/384/512，**没有 MD5**，所以自带一份。
//
// 为什么不去拉个 npm 包：整个前端是零依赖打包（web/build.mjs 只打 src/），
// 为一个 60 行的纯函数引入依赖不划算；而且这里是文件完整性校验，
// 自己实现反而更容易审计（无字符串编码歧义：一律按字节算）。
//
// 用法：md5Hex(await file.arrayBuffer()) → 32 位小写十六进制。

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i+1)) * 2^32)
const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

/**
 * 计算 MD5。
 * @param {Uint8Array|ArrayBuffer} input 原始字节
 * @returns {string} 32 位小写十六进制
 */
export function md5Hex(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const len = u8.length;
  // 补位：0x80 + 若干 0，末尾 8 字节小端存比特长度
  const total = ((len + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(total);
  buf.set(u8);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  const bits = len * 8;
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
}
