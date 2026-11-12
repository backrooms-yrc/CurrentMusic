// 播放地址解析（阶段二）：三级回退，解决「地区受限 / 已下架」的曲目播放
//
//   1) 项目路由 /ncm/song/url —— 服务端按客户端能力并行探测音质，必要时匹配
//   2) /song/url/match        —— 兼容旧服务端
//   3) /song/url              —— 老接口，兜底
//   4) /check/music           —— 都失败时判断「是版权不可播还是网络问题」，给出准确文案
import { network, sourceIdentity } from './network.js';
import { api } from './api.js';

// EC-3 解码能力由当前浏览器报告。实际输出由系统和音频设备决定。
function supportsDolby() {
  if (typeof Audio === 'undefined') return false;
  const support = new Audio().canPlayType?.('audio/mp4; codecs="ec-3"');
  return support === 'probably' || support === 'maybe';
}

/** 把上游三种不同的响应形状统一成 { url, type, level }。 */
function pickUrl(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (typeof d.url === 'string' && d.url) return d.url;                       // /song/url
  if (typeof d.data === 'string' && d.data) return d.data;                    // /song/url/match
  if (d.data && typeof d.data.url === 'string' && d.data.url) return d.data.url; // /song/url/v1
  if (Array.isArray(d.data) && d.data[0] && d.data[0].url) return d.data[0].url;
  return null;
}

/**
 * 解析可播放地址。
 * @param {object} meta 歌曲对象（需 ncm_id）
 * @param {string} level 音质档（auto 时由服务端择优）
 * @param {string} [immerse] 仅 sky 生效：c51(5.1) / ste(环绕立体声)
 * @param {object} [opts] 透传给后端的开关：{ refresh:true 重拿地址、host: 指定 CDN 边缘 }
 *   常规请求固定带 alts（响应含 host/hosts 已验证可换边缘）——线路优选
 *   （player.js lineBest）靠它判断「锁定的最优线」对当前对象是否适用。
 * @returns {Promise<{url:string,type:string,level:string,host?:string,hosts?:string[]}>}
 */
export async function resolveSongUrl(meta, level, immerse, opts) {
  const identity = sourceIdentity();
  let info;
  try { info = await resolveProviderUrl(meta, level, immerse, opts); }
  catch (e) {
    if (/Key/.test(e.message || '') || identity !== sourceIdentity()) e.noAutoNext = true;
    throw e;
  }
  if (identity !== sourceIdentity()) throw Object.assign(new Error('音源设置已改变，请重新播放'), { noAutoNext: true });
  return info;
}

async function resolveProviderUrl(meta, level, immerse, opts, provider = network.provider) {
  if (!meta || !meta.ncm_id) throw new Error('缺少歌曲信息');
  if (provider === 'leiz') {
    const key = network.key;
    if (!key) throw new Error('请先填写 LeiZ API Key');
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const q = new URLSearchParams({ id: meta.ncm_id, level: level === 'auto' ? 'jymaster' : (level || 'exhigh') });
      const r = await fetch('https://api.bileizhen.top/api/netease?' + q,
        { headers: { 'x-api-key': key, Accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: ctl.signal });
      if (!r.ok) throw Error(r.status === 401 || r.status === 403 ? 'LeiZ API Key 无效或无权限' : 'LeiZ 请求失败（HTTP ' + r.status + '）');
      const d = await r.json();
      if (d.success !== true || !d.data || !d.data.url) throw Error('LeiZ 未提供可用音源');
      const url = new URL(d.data.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error('音源未提供安全 HTTPS 地址');
      return { ...d.data, url: url.href, provider };
    } finally { clearTimeout(timer); }
  }
  return resolveCurrentMusicUrl(meta, level, immerse, opts);
}

async function resolveCurrentMusicUrl(meta, level, immerse, opts) {
  if (!meta || !meta.ncm_id) throw new Error('缺少歌曲信息');
  const id = meta.ncm_id;
  let lastErr = null;

  // 1) 主路径：服务端 SVIP 档位择优
  try {
    // immerse 必须一起传：音效「沉浸环绕声·环绕」就是 sky + immerseType=ste，
    // 漏传会静默降级成默认的 c51(5.1) 流。
    const options = { alts: true, ...opts };
    if (level === 'auto' && options.supportsDolby === undefined) options.supportsDolby = supportsDolby();
    const info = await api.songUrl(id, level, immerse, options);
    const url = pickUrl(info);
    // 透传上游字段：sr/bits/ch（文件头解析出的真实规格，客户端据此提示高解析度档位）、
    // br/size/md5（展示与缓存判断）、host（卡顿上报要指名是哪条 CDN 线）——
    // 曾经只挑 url/type/level，导致规格信息丢失。
    if (url) return Object.assign({}, info, {
      url, type: (info && info.type) || 'mp3', level: (info && info.level) || level || 'auto',
      autoDolby: level === 'auto' && options.supportsDolby && info.level === 'dolby',
    });
    lastErr = new Error('该音质档位无可用地址');
  } catch (e) {
    if (e.status === 401) throw e;
    lastErr = e;
  }

  // 2) 旧服务端兼容：主路径已尝试匹配时，跳过这次耗时的重复请求。
  if (lastErr?.code !== 'playback_match_failed') {
    try {
      const d = await api.ncm('/song/url/match', { id });
      const url = pickUrl(d);
      if (url) return { url, type: 'mp3', level: 'unblock' };
    } catch { /* 解灰服务不可用时继续兜底 */ }
  }

  // 3) 老接口兜底
  try {
    const d = await api.ncm('/song/url', { id, br: 320000 });
    const url = pickUrl(d);
    const song = Array.isArray(d?.data) ? d.data[0] : d?.data || d;
    if (url && !song?.freeTrialInfo) return { url, type: song?.type || 'mp3', level: 'legacy' };
  } catch { /* 继续 */ }

  // 4) 明确失败原因：能区分「版权不可播」与「网络/上游异常」
  try {
    const c = await api.ncm('/check/music', { id });
    if (c && c.success === false) throw new Error('该歌曲当前不可播放（版权或地区限制）');
  } catch (e) {
    if (e && /不可播放/.test(e.message || '')) throw e;
  }

  throw new Error(lastErr && lastErr.message ? lastErr.message : '无法获取播放地址');
}
