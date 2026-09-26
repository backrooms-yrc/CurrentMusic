// DLNA 投屏：搜索局域网渲染器并把音频交给设备播放。
// 原生侧（MainActivity.Bridge → Dlna.java）负责 SSDP 组播与 AVTransport SOAP，
// 页面侧只做 UI 与「投屏时把控制指令转发给设备」。
// 非 App 环境（浏览器）没有 NativeApi，入口会提示改用 App。
import { settings } from './api.js';
import { esc, toast } from './ui.js';
import { mdui } from './md.js';
import { player } from './player.js';

const S = { casting: false, name: '', key: '', busy: false };
let patched = false;

/** 原生桥是否可用（浏览器里没有）。 */
export const castSupported = () => typeof window.NativeApi !== 'undefined'
  && typeof window.NativeApi.dlnaDiscover === 'function';

export const isCasting = () => S.casting;

/** 投屏时交给渲染器拉流的地址：走后端 /cast/<id> 中转（原 CDN 是 https+签名短链，设备多半放不了）。 */
function castUrlFor(meta, level) {
  const sep = settings.base.indexOf('?') >= 0 ? '&' : '?';
  return `${settings.base}/cast/${meta.ncm_id}${sep}level=${encodeURIComponent(level || 'auto')}`;
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 原生直推当前（或指定）曲目（不入队、不取本机播放地址，省一次请求）。 */
function castTrack(meta) {
  if (!S.casting || !meta || !window.NativeApi.dlnaPlay) return;
  const d = deviceMeta(meta);
  window.NativeApi.dlnaPlay(S.key, castUrlFor(meta, settings.quality || 'auto'),
    d.title, d.artist, d.album, d.duration);
}

function deviceMeta(meta) {
  return {
    title: (meta && meta.name) || '', artist: (meta && meta.artists) || '',
    album: (meta && meta.album) || '', duration: (meta && meta.duration) || 0,
  };
}

/** 包装 player 的传输方法：投屏期间指令转发给设备，本机不再出声。 */
function patchPlayer() {
  if (patched) return;
  patched = true;
  const wrap = (name, action, extra) => {
    const orig = player[name];
    if (typeof orig !== 'function') return;
    player[name] = function (...args) {
      if (!S.casting) return orig.apply(this, args);
      // 投屏中：本机保持静默，只把动作转给设备
      try { player.audio.pause(); player.wantPlaying = false; } catch (e) { /* 忽略 */ }
      if (window.NativeApi[action]) window.NativeApi[action](...extra(args));
      return undefined;
    };
  };
  wrap('toggle', 'dlnaCmd', () => ['Pause', '']);
  wrap('play', 'dlnaCmd', () => ['Play', '']);
  wrap('pause', 'dlnaCmd', () => ['Pause', '']);
  wrap('seek', 'dlnaCmd', s => ['Seek', `<Unit>REL_TIME</Unit><Target>${hms(s[0])}</Target>`]);
  // 换歌：本机仍走 playAt（保持队列/进度/UI 一致），但立刻暂停，声音只从设备出
  const wrapNav = name => {
    const orig = player[name];
    if (typeof orig !== 'function') return;
    player[name] = function (...args) {
      const r = orig.apply(this, args);
      if (S.casting) {
        setTimeout(() => {
          try { player.audio.pause(); player.wantPlaying = false; } catch (e) { /* 忽略 */ }
          castTrack(player.meta);
        }, 60);
      }
      return r;
    };
  };
  wrapNav('next');
  wrapNav('prev');

}

/** 打开设备选择器（未投屏）或投屏控制面板（已投屏）。 */
export function openCastDialog() {
  if (!castSupported()) {
    toast('DLNA 投屏需使用安卓 App（浏览器无法访问局域网设备）');
    return;
  }
  if (S.casting) return castControlDialog();
  const diag = mdui.dialog({
    headline: '投屏到设备',
    body: `<div class="cm-cast">
             <div class="cm-cast-hint" id="castHint">正在搜索局域网内的 DLNA 设备…</div>
             <div class="cm-cast-list" id="castList"></div>
             <div class="cm-cast-actions">
               <mdui-button variant="tonal" id="castRescan" loading>重新搜索</mdui-button>
             </div>
             <div class="cm-cast-tip">设备需与本机在同一 Wi-Fi；支持电视、音箱、投影等 DLNA/UPnP 渲染器</div>
           </div>`,
    actions: [{ text: '关闭' }],
  });

  const list = () => diag.querySelector('#castList');
  const hint = t => {
    const h = diag.querySelector('#castHint');
    if (h) h.textContent = t;
  };
  const btn = () => diag.querySelector('#castRescan');

  const render = devices => {
    const box = list();
    if (!box) return;
    if (!devices.length) {
      box.innerHTML = '';
      hint('未发现设备。请确认设备已开机、与手机在同一 Wi-Fi，然后重新搜索。');
      return;
    }
    hint(`发现 ${devices.length} 台设备，点击投屏：`);
    box.innerHTML = devices.map(d => `
      <div class="cm-cast-item" data-key="${esc(d.key)}" data-name="${esc(d.name)}">
        <span class="material-icons-outlined">tv</span>
        <div class="cm-cast-item-t">
          <div>${esc(d.name)}</div>
          <div class="sub">${esc(d.model || 'DLNA 渲染器')}${d.hasVolume ? ' · 支持音量' : ''}</div>
        </div>
        <span class="material-icons-outlined cm-cast-go">chevron_right</span>
      </div>`).join('');
    box.querySelectorAll('.cm-cast-item').forEach(it => {
      it.onclick = () => connect(it.dataset.key, it.dataset.name, diag);
    });
  };

  const scan = () => {
    const b = btn();
    if (b) b.loading = true;
    hint('正在搜索局域网内的 DLNA 设备…');
    const box = list();
    if (box) box.innerHTML = '';
    window.__cmDlnaFound = (devices, error) => {
      const bb = btn();
      if (bb) bb.loading = false;
      if (error) return hint('搜索出错：' + error);
      render(devices || []);
    };
    window.NativeApi.dlnaDiscover(3000);
  };

  const b0 = btn();
  if (b0) b0.onclick = scan;
  scan();
}

function connect(key, name, diag) {
  if (!player.meta) return toast('当前没有播放中的歌曲');
  S.casting = true;
  S.key = key;
  S.name = name;
  const pos = (player.audio && player.audio.currentTime) || 0;
  toast(`正在投屏到「${name}」…`);
  window.__cmDlnaResult = (ok, err, devName) => {
    if (ok) {
      S.name = devName || name;
      toast(`已投屏到「${S.name}」`);
      paintIcon();
      try { player.audio.pause(); } catch (e) { /* 忽略 */ }
    } else {
      S.casting = false;
      S.key = '';
      toast('投屏失败：' + (err || '未知错误'));
      paintIcon();
    }
  };
  const meta = player.meta;
  const level = settings.quality || 'auto';
  window.NativeApi.dlnaPlay(key, castUrlFor(meta, level), meta.name || '', meta.artists || '',
    meta.album || '', meta.duration || 0);
  try { player.audio.pause(); } catch (e) { /* 忽略 */ }
  setTimeout(() => {
    if (S.casting && pos > 1 && window.NativeApi.dlnaCmd) {
      window.NativeApi.dlnaCmd('Seek', `<Unit>REL_TIME</Unit><Target>${hms(pos)}</Target>`);
    }
  }, 1600);
  if (diag) diag.open = false;
}

function castControlDialog() {
  const diag = mdui.dialog({
    headline: '投屏中',
    body: `<div class="cm-cast">
             <div class="cm-cast-now">
               <span class="material-icons-outlined">cast_connected</span>
               <div class="cm-cast-now-t"><div>${esc(S.name || 'DLNA 设备')}</div>
               <div class="sub">声音由该设备输出，手机端保持静默</div></div>
             </div>
             <div class="cm-cast-vol">
               <span class="material-icons-outlined">volume_down</span>
               <input type="range" id="castVol" min="0" max="100" value="${localStorage.getItem('cm.castVol') || 50}">
             </div>
             <div class="cm-cast-tip">换歌、暂停、拖动进度都会同步到该设备</div>
           </div>`,
    actions: [{ text: '关闭' }, { text: '停止投屏', onClick: () => { stopCast(); return true; } }],
  });
  setTimeout(() => {
    const v = diag.querySelector('#castVol');
    if (v) {
      v.oninput = () => {
        localStorage.setItem('cm.castVol', v.value);
        if (window.NativeApi.dlnaVolume) window.NativeApi.dlnaVolume(+v.value);
      };
    }
  }, 0);
}

/** 停止投屏：让设备停止并恢复本机播放能力。 */
export function stopCast() {
  if (!S.casting) return;
  S.casting = false;
  const name = S.name;
  S.key = '';
  S.name = '';
  if (window.NativeApi.dlnaStop) window.NativeApi.dlnaStop();
  paintIcon();
  toast(`已停止投屏${name ? '（' + name + '）' : ''}`);
}

/** 播放页右上角图标（置于「更多」左侧）。 */
export function castIconHTML() {
  if (!castSupported()) return '';
  return `<span class="pl-btn${S.casting ? ' on casting' : ''}" id="plCast" title="DLNA 投屏（电视/音箱）">
            <span class="material-icons-outlined">${S.casting ? 'cast_connected' : 'cast'}</span></span>`;
}

export function paintIcon() {
  const el = document.getElementById('plCast');
  if (!el) return;
  el.classList.toggle('on', S.casting);
  el.classList.toggle('casting', S.casting);
  el.innerHTML = `<span class="material-icons-outlined">${S.casting ? 'cast_connected' : 'cast'}</span>`;
  el.title = S.casting ? `投屏中：${S.name}` : 'DLNA 投屏（电视/音箱）';
}

export function initCast() {
  patchPlayer();
  // 页面重建后恢复投屏状态（Activity 重建/切后台回来）
  try {
    if (castSupported() && window.NativeApi.dlnaState) {
      const st = JSON.parse(window.NativeApi.dlnaState() || '{}');
      if (st && st.casting) { S.casting = true; S.name = st.name || ''; S.key = st.key || ''; }
    }
  } catch (e) { /* 忽略 */ }
  // 整页重新渲染后图标会丢，这里补画
  document.addEventListener('cm-player-open', paintIcon);
}
