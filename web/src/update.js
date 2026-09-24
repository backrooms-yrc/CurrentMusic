// 在线更新：启动自动检测 + MD3 更新弹窗（双源测速选优 + 下载进度 + 自动拉起安装器）
import { mdui } from './md.js';
import { call, settings } from './api.js';
import { esc, toast } from './ui.js';
import { currentVersion, isNewer } from './version.js';

const SKIP_KEY = 'cm.updateSkip';         // 本会话跳过的版本（避免反复打扰）
const SPEED_BYTES = 262144;               // 测速样本 256KB
const GH_REPO = 'backrooms-yrc/CurrentMusic';

const fmtSpeed = bps => (bps >= 1048576 ? (bps / 1048576).toFixed(1) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s');
const fmtSize = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

/** 拉取最新版本信息：服务器优先，不可达时回退 GitHub Releases API。 */
export async function fetchLatest() {
  try {
    const d = await call('GET', '/version/latest');
    d.sources = (d.sources || []).map(s => ({ ...s, url: s.path ? `${settings.base}/${s.path}` : s.url }));
    return d;
  } catch (e) {
    return await fetchFromGithub();
  }
}

async function fetchFromGithub() {
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
  if (!r.ok) throw new Error('无法获取版本信息');
  const d = await r.json();
  const version = String(d.tag_name || '').replace(/^v/, '');
  const asset = (d.assets || []).find(a => a.name && a.name.endsWith('.apk'));
  return {
    version,
    versionCode: 0,
    changelog: d.body || '',
    publishedAt: d.published_at ? Math.floor(new Date(d.published_at).getTime() / 1000) : 0,
    sources: asset ? [{ key: 'github', label: 'GitHub Releases', url: asset.browser_download_url }] : [],
  };
}

/** 单源测速：App 内走原生桥（Range 拉 256KB），浏览器调试用 fetch。 */
function speedTest(source) {
  return new Promise(resolve => {
    if (window.NativeApi && window.NativeApi.testSpeed) {
      const timer = setTimeout(() => resolve(null), 9000);
      window.__cmSpeedResult = (key, bytes, bps, ms) => {
        if (key !== source.key) return;
        clearTimeout(timer);
        resolve(bytes > 0 ? { bps, ms } : null);
      };
      try {
        window.NativeApi.testSpeed(source.key, source.url, SPEED_BYTES);
      } catch {
        clearTimeout(timer);
        resolve(null);
      }
      return;
    }
    const t0 = performance.now();
    fetch(source.url, { headers: { Range: `bytes=0-${SPEED_BYTES - 1}` } })
      .then(async r => {
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        const buf = await r.arrayBuffer();
        const ms = Math.max(1, performance.now() - t0);
        resolve({ bps: buf.byteLength * 1000 / ms, ms });
      })
      .catch(() => resolve(null));
  });
}

/** 启动时自动检测（silent=不弹"已是最新"提示）。 */
export async function checkUpdate({ silent = true } = {}) {
  const cur = currentVersion();
  let latest;
  try {
    latest = await fetchLatest();
  } catch (e) {
    if (!silent) toast('检查更新失败：' + e.message);
    return;
  }
  if (!latest || !latest.version || (latest.sources || []).length === 0) {
    if (!silent) toast('暂无可用更新包');
    return;
  }
  if (!isNewer(latest, cur)) {
    if (!silent) toast(`已是最新版本 v${cur.name}`);
    return;
  }
  if (silent && sessionStorage.getItem(SKIP_KEY) === String(latest.versionCode || latest.version)) return;
  showUpdateDialog(latest, cur);
}

function showUpdateDialog(latest, cur) {
  const speed = {};      // key -> {bps, ms, failed}
  let picked = null;
  let downloading = false;

  const running = (cur.code && cur.code < 21);   // 极老版本提示
  const diag = mdui.dialog({
    headline: `发现新版本 v${latest.version}`,
    body: `<div class="upd">
      <div class="upd-ver">
        <span>当前 <b>v${esc(cur.name)}</b></span>
        <span class="material-icons-outlined">arrow_forward</span>
        <span>最新 <b class="upd-new">v${esc(latest.version)}</b></span>
        ${latest.size ? `<span class="upd-size">${fmtSize(latest.size)}</span>` : ''}
      </div>
      ${latest.changelog ? `<div class="upd-log">${esc(latest.changelog).slice(0, 1200)}</div>` : ''}
      <div class="upd-sec">下载源<span class="upd-tip" id="updSpeedTip">测速中…</span></div>
      <div class="upd-srcs" id="updSrcs">
        ${latest.sources.map(s => `
          <div class="upd-src" data-key="${s.key}">
            <span class="material-icons-outlined upd-radio">radio_button_unchecked</span>
            <div class="upd-src-main"><div>${esc(s.label)}</div><div class="upd-src-url">${esc(s.url.replace(/^https?:\/\//, '').slice(0, 46))}</div></div>
            <span class="upd-spd" data-spd="${s.key}">测速中</span>
          </div>`).join('')}
      </div>
      <div class="upd-prog" id="updProg" hidden>
        <mdui-linear-progress id="updBar"></mdui-linear-progress>
        <div class="upd-prog-txt" id="updProgTxt">准备下载…</div>
      </div>
    </div>`,
    actions: [{ text: '稍后再说' }, { text: '立即更新', onClick: () => startDownload() }],
  });

  const setPicked = key => {
    picked = key;
    diag.querySelectorAll('.upd-src').forEach(el => {
      const on = el.dataset.key === key;
      el.classList.toggle('on', on);
      el.querySelector('.upd-radio').textContent = on ? 'radio_button_checked' : 'radio_button_unchecked';
    });
  };

  let userPicked = false;
  const renderSpeed = () => {
    let best = null, done = 0;
    for (const s of latest.sources) {
      const el = diag.querySelector(`.upd-spd[data-spd="${s.key}"]`);
      const r = speed[s.key];
      if (r === undefined) { if (el) el.textContent = '测速中'; continue; }
      done++;
      if (r === null) { if (el) { el.textContent = '不可达'; el.classList.add('bad'); } continue; }
      if (el) el.textContent = fmtSpeed(r.bps);
      if (!best || r.bps > speed[best].bps) best = s.key;
    }
    if (best && !userPicked) setPicked(best);          // 自动选择最快源（不覆盖用户手选）
    const tip = diag.querySelector('#updSpeedTip');
    if (tip) {
      if (done === latest.sources.length) tip.textContent = best ? '已自动选择最快源' : '测速失败，请手动选择';
      else tip.textContent = '测速中…';
    }
  };

  diag.querySelectorAll('.upd-src').forEach(el => {
    el.onclick = () => { userPicked = true; setPicked(el.dataset.key); };
  });

  if (latest.sources.length) setPicked(latest.sources[0].key);   // 兜底先选第一个
  latest.sources.forEach(async s => {                             // 各源并发测速
    speed[s.key] = await speedTest(s);
    renderSpeed();
  });

  // 原生回调
  window.__cmUpdateProgress = (pct, done, total) => {
    const box = diag.querySelector('#updProg');
    const bar = diag.querySelector('#updBar');
    const txt = diag.querySelector('#updProgTxt');
    if (!box) return;
    box.hidden = false;
    if (bar) bar.value = pct / 100;
    if (txt) txt.textContent = total > 0 ? `下载中 ${pct}%（${fmtSize(done)} / ${fmtSize(total)}）` : `下载中 ${pct}%`;
  };
  window.__cmUpdateInstall = () => {
    const txt = diag.querySelector('#updProgTxt');
    if (txt) txt.textContent = '下载完成，正在拉起安装器…';
    toast('下载完成，请在系统安装界面完成安装');
    setTimeout(() => { diag.open = false; cleanHandlers(); }, 1200);
  };
  window.__cmUpdateFailed = msg => {
    downloading = false;
    const btn = [...diag.querySelectorAll('mdui-button')].find(b => b.textContent.includes('立即更新'));
    if (btn) btn.loading = false;
    const txt = diag.querySelector('#updProgTxt');
    if (txt) txt.textContent = String(msg);
    toast(String(msg));
  };

  function cleanHandlers() {
    delete window.__cmUpdateProgress;
    delete window.__cmUpdateInstall;
    delete window.__cmUpdateFailed;
    delete window.__cmSpeedResult;
  }

  function startDownload() {
    if (downloading) return false;
    const src = latest.sources.find(s => s.key === picked) || latest.sources[0];
    if (!src) { toast('没有可用的下载源'); return false; }
    const fileName = latest.fileName || `CurrentMusic-v${latest.version}.apk`;
    downloading = true;
    const box = diag.querySelector('#updProg');
    if (box) box.hidden = false;
    if (window.NativeApi && window.NativeApi.downloadApk) {
      window.NativeApi.downloadApk(src.url, fileName);
      toast('已开始下载更新…');
      return false;   // 保持弹窗展示进度
    }
    // 浏览器模式：直接跳转下载
    window.open(src.url, '_blank');
    toast('已在新窗口打开下载');
    return true;
  }

  diag.addEventListener('closed', () => {
    if (!downloading) {
      sessionStorage.setItem(SKIP_KEY, String(latest.versionCode || latest.version));
    }
    cleanHandlers();
  }, { once: true });
}
