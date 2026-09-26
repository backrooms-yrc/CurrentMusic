// DLNA 投屏：搜索局域网渲染器并把音频交给设备播放。
//
// 原生侧（MainActivity.Bridge → Dlna.java）负责 SSDP 组播与 AVTransport SOAP，
// 并每秒轮询一次设备状态（GetTransportInfo/GetPositionInfo）推给页面；
// 页面侧维护「投屏会话」：本地插值时钟驱动进度条与歌词、把控制指令转给设备、掉线自动重连。
//
// 为什么需要会话状态：投屏时本机音频是暂停的，audio.currentTime 不前进。
// 若不做接管，进度条与歌词会永远停在原处、播放键也分不清设备当前是播是停。
import { settings, call } from './api.js';
import { esc, toast } from './ui.js';
import { mdui } from './md.js';
import { player, setClockSource, tick, notifyState } from './player.js';

const S = {
  casting: false,
  name: '',
  key: '',
  playing: false,      // 设备当前是否在播（来自轮询）
  posMs: 0,            // 设备上报的播放位置
  durMs: 0,            // 设备上报的曲目总长
  syncedAt: 0,         // posMs 对应的本地时间戳（用于两次轮询之间插值）
  intended: true,      // 我们期望的播放状态（用于区分「设备自己停了」）
  lastOkAt: 0,         // 最近一次成功查询的时间
  maxPosMs: 0,         // 本次投屏期间见到过的最大播放位置（判断是否已播完）
  recoverCount: 0,
  recoverTimer: null,
};

let patched = false;
let ticker = null;

/** 原生桥是否可用（浏览器里没有）。 */
export const castSupported = () => typeof window.NativeApi !== 'undefined'
  && typeof window.NativeApi.dlnaDiscover === 'function';

export const isCasting = () => S.casting;

/** 投屏专用音质：默认 exhigh（320k MP3）。
 *  不能沿用本机音质——本机可能选了超清母带，单曲 160MB+ 的 FLAC 电视既不解码也扛不住。 */
function castLevel() {
  return localStorage.getItem('cm.castLevel') || 'exhigh';
}

/** 投屏地址强制明文 http：渲染器普遍不支持 https（证书/SNI 不认），实测 https 会直接不出声。 */
function castBase() {
  const scheme = localStorage.getItem('cm.castHttp') === '0' ? 'https' : 'http';
  return settings.base.replace(/^https?:\/\//, scheme + '://');
}

/** 投屏时交给渲染器拉流的地址：走后端 /cast/<id> 中转（原 CDN 是 https+签名短链，设备放不了）。 */
function castUrlFor(meta, level) {
  const sep = castBase().indexOf('?') >= 0 ? '&' : '?';
  return `${castBase()}/cast/${meta.ncm_id}${sep}level=${encodeURIComponent(level || castLevel())}`;
}

function hms(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 播放时钟：轮询间隔 1s 太久（歌词会一跳一跳），故用「上报值 + 本地经过时间」插值，
 * 每 250ms 重算一次位置，歌词与进度条因此能平滑推进。
 */
function castClock() {
  if (!S.casting) return null;
  let pos = S.posMs;
  if (S.playing && S.syncedAt) pos += Date.now() - S.syncedAt;
  if (S.durMs > 0 && pos > S.durMs) pos = S.durMs;
  return { posMs: Math.max(0, pos), durMs: S.durMs, playing: S.playing };
}

/** 原生每秒推来的设备状态。 */
function onCastState(st) {
  if (!S.casting || !st) return;
  if (st.error) {
    // 查询失败：多数是设备离线/休眠。连续失败才判定为掉线，避免偶发抖动误报。
    if (S.lastOkAt && Date.now() - S.lastOkAt > 6000) scheduleRecover('设备无响应');
    return;
  }
  S.lastOkAt = Date.now();
  const wasPlaying = S.playing;
  const prevDur = S.durMs;
  S.playing = st.state === 'PLAYING' || st.state === 'TRANSITIONING' || st.state === 'RECORDING';
  if (st.posMs > 0) { S.posMs = st.posMs; S.syncedAt = Date.now(); }
  if (st.posMs > S.maxPosMs) S.maxPosMs = st.posMs;
  if (st.durMs > 0) S.durMs = st.durMs;
  if (S.playing) S.recoverCount = 0;                 // 恢复正常，重置重连计数
  if (wasPlaying !== S.playing || prevDur !== S.durMs) notifyState();   // 刷新播放键/时长
  // 设备端停了（我们期望在播）要分两种情况：
  //  a) 已经播到接近结尾 → 正常放完，应切下一首（否则会永远重播同一首）
  //  b) 中途停住 → 异常，从当前位置续播
  if (!S.playing && S.intended && st.state === 'STOPPED') {
    const atEnd = S.durMs > 0 && S.maxPosMs >= S.durMs - 6000;
    if (atEnd) {
      S.intended = false;              // 交给下一首的 castTrack 重新置 true
      player.next(true);               // 走 player 的自动前进（尊重单曲循环/顺序/随机）
    } else {
      scheduleRecover('播放已停止');
    }
  }
}

/** 掉线/被停止后的自动恢复：从上次位置重新投一次（最多 3 次）。 */
function scheduleRecover(reason) {
  if (!S.casting || S.recoverTimer) return;
  if (S.recoverCount >= 3) {
    toast('投屏已断开，请重新连接设备');
    stopCast();
    return;
  }
  S.recoverTimer = setTimeout(() => {
    S.recoverTimer = null;
    if (!S.casting || !player.meta) return;
    S.recoverCount++;
    toast(`投屏中断（${reason}），正在重连 ${S.recoverCount}/3…`);
    castTrack(player.meta, S.posMs / 1000);
  }, 1200);
}

/** 把指定曲目推给设备；startSec>0 时在其后定位到该位置（用于续播/恢复）。 */
function castTrack(meta, startSec) {
  if (!S.casting || !meta || !window.NativeApi.dlnaPlay) return;
  S.intended = true;
  S.posMs = Math.max(0, (startSec || 0) * 1000);
  S.syncedAt = Date.now();
  S.playing = true;                       // 乐观：设备通常很快就播；轮询会纠正
  S.durMs = meta.duration || S.durMs;
  S.maxPosMs = S.posMs;                 // 新曲目重新计
  notifyState();
  window.NativeApi.dlnaPlay(S.key, castUrlFor(meta, castLevel()),
    meta.name || '', meta.artists || '', meta.album || '', meta.duration || 0);
  if (startSec > 0) {
    setTimeout(() => {
      if (S.casting && window.NativeApi.dlnaCmd) {
        window.NativeApi.dlnaCmd('Seek', `<Unit>REL_TIME</Unit><Target>${hms(startSec)}</Target>`);
      }
    }, 1600);
  }
}

/** 包装 player 的传输方法：投屏期间指令转给设备，本机不出声；任何来源的切歌都会跟随。 */
function patchPlayer() {
  if (patched) return;
  patched = true;

  // 播放/暂停：必须以「设备当前是否在播」为依据。
  // 原先一律发 Pause，导致投屏后再也点不回播放。
  const origToggle = player.toggle;
  player.toggle = function (...a) {
    if (!S.casting) return origToggle.apply(this, a);
    try { player.audio.pause(); player.wantPlaying = false; } catch (e) { /* 忽略 */ }
    S.intended = !S.playing;
    S.playing = !S.playing;               // 乐观切换，轮询会纠正
    S.syncedAt = Date.now();
    notifyState();
    window.NativeApi.dlnaCmd(S.intended ? 'Play' : 'Pause', '');
  };

  const origPlay = player.play;
  player.play = function (...a) {
    if (!S.casting) return origPlay.apply(this, a);
    S.intended = true; S.playing = true; S.syncedAt = Date.now(); notifyState();
    window.NativeApi.dlnaCmd('Play', '');
  };

  const origPause = player.pause;
  player.pause = function (...a) {
    if (!S.casting) return origPause.apply(this, a);
    S.intended = false; S.playing = false; notifyState();
    window.NativeApi.dlnaCmd('Pause', '');
  };

  // 拖动进度：投屏时本机没有时长/位置，必须把目标时间转成设备的 Seek
  const origSeek = player.seek;
  player.seek = function (sec) {
    if (!S.casting) return origSeek.apply(this, arguments);
    if (!isFinite(sec)) return;
    S.posMs = Math.max(0, sec * 1000);
    S.syncedAt = Date.now();
    tick();
    window.NativeApi.dlnaCmd('Seek', `<Unit>REL_TIME</Unit><Target>${hms(sec)}</Target>`);
  };

  // 切歌跟随：playAt 是所有换歌的唯一入口（点列表、下一首、播放全部、房间同步都走它），
  // 在这里挂钩即可覆盖全部来源——此前只包了 next/prev，点列表换歌就不同步。
  const origPlayAt = player.playAt;
  player.playAt = function (...a) {
    const r = origPlayAt.apply(this, a);
    if (S.casting && player.meta) {
      S.recoverCount = 0;
      castTrack(player.meta, 0);
    }
    return r;
  };
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => { if (S.casting) tick(); else { clearInterval(ticker); ticker = null; } }, 250);
}

function endSession() {
  S.casting = false;
  S.maxPosMs = 0;
  S.playing = false;
  S.intended = true;
  S.posMs = 0;
  S.durMs = 0;
  S.syncedAt = 0;
  S.lastOkAt = 0;
  S.recoverCount = 0;
  if (S.recoverTimer) { clearTimeout(S.recoverTimer); S.recoverTimer = null; }
  if (ticker) { clearInterval(ticker); ticker = null; }
  setClockSource(null);
  paintIcon();
  notifyState();
}

/** 开始投屏会话。 */
function beginSession(key, name) {
  S.casting = true;
  S.key = key;
  S.name = name;
  S.playing = true;
  S.intended = true;
  S.posMs = 0;
  S.durMs = 0;
  S.syncedAt = Date.now();
  S.lastOkAt = Date.now();
  S.recoverCount = 0;
  setClockSource(castClock);      // 让进度条/歌词改读设备时钟
  startTicker();
  window.__cmCastState = onCastState;
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
             <div class="cm-cast-qrow">
               <span class="cm-cast-qlabel">投屏音质</span>
               <div class="cm-cast-qbox" id="castQ"></div>
             </div>
             <div class="cm-cast-tip">设备需与本机在同一 Wi-Fi；音质过高时部分电视无法解码（默认「极高」兼容性最好）</div>
           </div>`,
    actions: [{ text: '关闭' }],
  });

  // 投屏音质：默认极高(320k MP3)——电视基本都支持；无损/母带体积巨大且常不被支持
  const LEVELS = [
    { k: 'standard', label: '标准' },
    { k: 'exhigh', label: '极高' },
    { k: 'lossless', label: '无损' },
  ];
  const renderQuality = () => {
    const box = diag.querySelector('#castQ');
    if (!box) return;
    const cur = castLevel();
    box.innerHTML = LEVELS.map(l =>
      `<span class="cm-cast-q${l.k === cur ? ' on' : ''}" data-k="${l.k}">${l.label}</span>`).join('');
    box.querySelectorAll('.cm-cast-q').forEach(el => {
      el.onclick = () => {
        localStorage.setItem('cm.castLevel', el.dataset.k);
        renderQuality();
        toast(`投屏音质：${el.textContent}（下次投屏生效）`);
      };
    });
  };

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

  // 预热当前歌曲的音源地址：等用户点设备时首字节几乎立即到达
  if (player.meta) {
    call('GET', `/cast/${player.meta.ncm_id}?warm=1&level=${encodeURIComponent(castLevel())}`)
      .catch(() => { /* 预热失败不影响正常投屏 */ });
  }

  const b0 = btn();
  if (b0) b0.onclick = scan;
  renderQuality();
  scan();
}

function connect(key, name, diag) {
  if (!player.meta) return toast('当前没有播放中的歌曲');
  const meta = player.meta;
  const pos = (player.audio && player.audio.currentTime) || 0;
  toast(`正在投屏到「${name}」…`);

  window.__cmDlnaResult = (ok, err, devName) => {
    if (ok) {
      beginSession(key, devName || name);
      S.durMs = meta.duration || 0;
      S.posMs = pos * 1000;
      S.syncedAt = Date.now();
      try { player.audio.pause(); player.wantPlaying = false; } catch (e) { /* 忽略 */ }
      toast(`已投屏到「${S.name}」`);
      paintIcon();
      notifyState();
    } else {
      endSession();
      S.key = '';
      S.name = '';
      toast('投屏失败：' + (err || '未知错误'));
    }
  };
  // 先接管时钟再发指令：避免 playAt 在投屏判定前触发本机播放
  beginSession(key, name);
  castTrack(meta, pos);
  try { player.audio.pause(); player.wantPlaying = false; } catch (e) { /* 忽略 */ }
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
             <div class="cm-cast-tip">换歌、暂停、拖动进度都会同步到该设备；断开会自动重连</div>
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

/** 停止投屏：让设备停止并交还本机播放能力。 */
export function stopCast() {
  if (!S.casting) return;
  const name = S.name;
  if (window.NativeApi.dlnaStop) window.NativeApi.dlnaStop();
  endSession();
  S.key = '';
  S.name = '';
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
  window.__cmCastState = onCastState;
  // 页面重建后恢复投屏会话（Activity 重建/切后台回来）
  try {
    if (castSupported() && window.NativeApi.dlnaState) {
      const st = JSON.parse(window.NativeApi.dlnaState() || '{}');
      if (st && st.casting) {
        beginSession(st.key || '', st.name || '');
      }
    }
  } catch (e) { /* 忽略 */ }
  document.addEventListener('cm-player-open', paintIcon);
}
