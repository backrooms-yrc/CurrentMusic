import { settings, auth } from '../api.js';
import { player } from '../player.js';
import { resolveSongUrl } from '../songurl.js';
import { MIRRORS, PROVIDERS, network, probeMirror, probeLines, swapLine, testAudio } from '../network.js';
import { esc, toast } from '../ui.js';
import './network.css';

export function render(el) {
  let busy = false, detected = null;
  const active = () => el.isConnected;
  el.innerHTML = `<section class="cm-network"><a href="#/settings/connection/server">← 网络与连接</a>
    <h1>CDN 与音源</h1><p>从当前设备检测连接，选择更顺畅的播放线路。</p>
    <section><h2>网站与 API 镜像</h2><p>进入本页自动测速，每条线路请求两次。切换后沿用当前页面，仅更改 API 入口。仅官方镜像共享本站登录凭据。</p>
    <button id="mirrorTest">重新测速</button><button id="mirrorBest" disabled>使用本次最快线路</button>
    <div id="mirrorResults" class="cm-network-grid"></div><p>当前 API：<span id="apiBase">${esc(settings.base)}</span></p></section>
    <section><h2>音乐音源</h2><label>默认音源 <select id="audioProvider">${Object.entries(PROVIDERS).map(([id, name]) => `<option value="${id}" ${network.provider === id ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <p>CurrentMusic 沿用本站网易云解析和回退链路；LeiZ 使用独立接口。X 侧的网易云原生直连依赖 Android 客户端，网页暂不提供该选项。选定音源失败时会提示，不跨音源回退。音源和 CDN 设置在下一次播放时生效。</p>
    <div id="leizFields" ${network.provider !== 'leiz' ? 'hidden' : ''}><label>LeiZ API Key <input id="leizKey" type="password" autocomplete="off" maxlength="512" placeholder="${network.key ? '当前标签页已配置；留空保留' : '填写 API Key'}"></label>
    <button id="saveKey">保存 Key</button><button id="clearKey">移除 Key</button><p>Key 仅保留在当前标签页会话，直接发送给 LeiZ，不发送给本站或 CDN。第三方服务需允许浏览器跨域请求。</p></div>
    <label>测试歌曲 ID <input id="testSong" inputmode="numeric" value="${esc(String(player.meta?.ncm_id || '33894312'))}"></label>
    <button id="sourceTest">测试所选音源</button><p id="sourceStatus" role="status" aria-live="polite">测试包含解析地址及静音加载音频，不影响正在播放的歌曲；本站音源需要登录。</p></section>
    <section><h2>歌曲音频 CDN</h2><label>线路策略 <select id="audioCdn"><option value="auto">自动测速优选</option><option value="original">使用音源原始线路</option>${!['auto', 'original'].includes(network.cdn) ? `<option selected value="${esc(network.cdn)}">${esc(network.cdn)}</option>` : ''}</select></label>
    <button id="cdnTest">测试歌曲 CDN 可用性与速度</button><p id="cdnStatus" role="status" aria-live="polite">CurrentMusic 支持已验证候选边缘切换。自动模式首次播放时测速；单次每条读取约 256 KiB。速度为短样本传输速率，可能受缓存影响。指定边缘不在当前歌曲的已验证候选中时，使用音源原始线路。</p>
    <div id="cdnResults" class="cm-network-grid"></div></section><p id="networkStatus" role="status" aria-live="polite"></p></section>`;
  const $ = id => el.querySelector('#' + id);
  $('audioCdn').value = network.cdn;
  const invalidate = () => { player._discardPrefetch(); player._prefetch = null; detected = null; };
  $('audioProvider').onchange = () => {
    network.provider = $('audioProvider').value; invalidate();
    $('leizFields').hidden = network.provider !== 'leiz';
    $('sourceStatus').textContent = '音源已保存，下次播放时生效；请重新测试可用性。';
    $('cdnResults').replaceChildren();
  };
  $('saveKey').onclick = () => {
    const v = $('leizKey').value.trim();
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(v)) return toast('请输入有效 API Key');
    network.key = v; $('leizKey').value = ''; $('leizKey').placeholder = '当前标签页已配置；留空保留'; invalidate(); toast('Key 已保存到当前标签页');
  };
  $('clearKey').onclick = () => { network.key = ''; $('leizKey').value = ''; $('leizKey').placeholder = '填写 API Key'; invalidate(); toast('Key 已移除'); };
  $('audioCdn').onchange = () => { network.cdn = $('audioCdn').value; invalidate(); toast('CDN 策略已保存，下次播放时生效'); };
  let best = null;
  function applyMirror(origin) {
    if (!MIRRORS.some(x => x[1] === origin)) return;
    settings.base = origin + '/cm'; invalidate(); $('apiBase').textContent = settings.base;
    toast('API 线路已切换');
  }
  $('mirrorBest').onclick = () => { if (best) applyMirror(best.origin); };
  async function mirrors() {
    $('mirrorTest').disabled = true; $('mirrorBest').disabled = true; best = null;
    $('mirrorResults').innerHTML = MIRRORS.map(([name], i) => `<article id="mirror${i}"><strong>${esc(name)}</strong><p>测速中…</p></article>`).join('');
    await Promise.all(MIRRORS.map(async ([name, origin], i) => {
      const r = await probeMirror(origin);
      if (!active()) return;
      if (r.ok && (!best || r.ms < best.ms)) best = { origin, ms: r.ms };
      const card = $('mirror' + i);
      card.innerHTML = `<strong>${esc(name)}</strong><p>${r.ok ? Math.round(r.ms) + ' ms · 2/2 成功' : r.successes + '/2 成功 · 暂不可用或不稳定'}</p><button ${r.ok ? '' : 'disabled'}>使用此线路</button>`;
      card.querySelector('button').onclick = () => applyMirror(origin);
    }));
    if (!active()) return;
    $('mirrorTest').disabled = false; $('mirrorBest').disabled = !best;
  }
  $('mirrorTest').onclick = mirrors;
  const resolve = async () => {
    if (!/^\d{1,20}$/.test($('testSong').value.trim())) throw Error('请输入有效歌曲 ID');
    if (network.provider !== 'leiz' && !auth.token) throw Error('请先登录后测试音源');
    return resolveSongUrl({ ncm_id: $('testSong').value.trim() }, settings.quality, undefined, { alts: true, refresh: true });
  };
  async function run(kind) {
    if (busy) return;
    busy = true;
    const target = kind === 'source' ? $('sourceStatus') : $('cdnStatus');
    const controls = ['sourceTest', 'cdnTest', 'audioProvider', 'audioCdn', 'saveKey', 'clearKey', 'testSong'];
    controls.forEach(id => $(id).disabled = true);
    target.textContent = '正在解析并检测，请稍候…';
    try {
      detected = await resolve();
      if (kind === 'source') {
        const ok = await testAudio(swapLine(detected) || detected.url);
        if (active()) target.textContent = ok ? '可用 · 地址解析成功，浏览器已加载音频数据。' : '解析成功，但浏览器未能在 10 秒内加载音频（可能是网络、格式或跨域限制）。';
      } else {
        const results = await probeLines(detected, true);
        if (!active()) return;
        if (!results) { target.textContent = '此音源未提供可切换的已验证 CDN 候选；请使用音源可用性测试。'; return; }
        const good = results.filter(x => x.ok).sort((a, b) => b.kbps - a.kbps);
        target.textContent = good.length ? `检测完成 · ${good.length}/${results.length} 条可用 · 本次最快 ${good[0].host}` : '本次未测得可用线路，可能受网络或浏览器跨域限制影响。';
        $('cdnResults').innerHTML = results.map(r => `<article><strong>${esc(r.host)}</strong><p>${r.ok ? Math.round(r.ms) + ' ms · ' + Math.round(r.kbps) + ' KiB/s' : '不可用或无法跨域测速'}</p><button data-host="${esc(r.host)}" ${r.ok ? '' : 'disabled'}>使用此 CDN</button></article>`).join('');
        results.forEach(r => {
          if (!r.ok || Array.from($('audioCdn').options).some(o => o.value === r.host)) return;
          const option = document.createElement('option'); option.value = r.host; option.textContent = r.host; $('audioCdn').appendChild(option);
        });
        $('cdnResults').querySelectorAll('button').forEach(btn => { btn.onclick = () => { $('audioCdn').value = btn.dataset.host; $('audioCdn').onchange(); }; });
      }
    } catch (e) { if (active()) target.textContent = '检测失败：' + (e.message || '网络异常'); }
    finally { busy = false; if (active()) controls.forEach(id => $(id).disabled = false); }
  }
  $('sourceTest').onclick = () => run('source'); $('cdnTest').onclick = () => run('cdn');
  mirrors();
  
}
