// 网易云账号绑定：扫码弹窗（轮询）+ 同步 + 解绑。
import { mdui } from './md.js';
import { api, auth } from './api.js';
import { esc, toast, confirmDialog } from './ui.js';

export function bindDialog(onBound) {
  if (!auth.token) return toast('请先登录 CurrentMusic 账号');
  let closed = false;
  let key = '';
  let timer = null;

  const diag = mdui.dialog({
    headline: '绑定网易云音乐',
    body: `
      <div class="cm-qrbind">
        <div class="cm-qrbox"><img id="qrImg" alt="二维码加载中…"></div>
        <div class="cm-qrstatus" id="qrStatus"><mdui-linear-progress></mdui-linear-progress></div>
        <div class="cm-qrhint">打开网易云音乐 APP → 扫一扫（右上角 ⋯ 里）扫描二维码授权登录</div>
      </div>`,
    actions: [{ text: '取消' }],
    onClose: () => { closed = true; clearTimeout(timer); },
  });

  const setStatus = (html) => {
    const el = diag.querySelector('#qrStatus');
    if (el) el.innerHTML = html;
  };

  async function start() {
    setStatus('<mdui-linear-progress></mdui-linear-progress>');
    try {
      key = (await api.qrKey()).key;
      const img = (await api.qrImg(key)).qrimg;
      if (closed) return;
      diag.querySelector('#qrImg').src = img;
      setStatus('等待扫码…');
      poll();
    } catch (e) {
      if (!closed) setStatus(`<span class="err">${esc(e.message)}</span>`);
    }
  }

  async function poll() {
    if (closed) return;
    try {
      const r = await api.qrCheck(key);
      if (r.code === 803) {
        setStatus(`<span class="ok"><span class="mi">check_circle</span> 绑定成功：${esc((r.profile && r.profile.nickname) || '')}，正在同步歌单…</span>`);
        diag.querySelector('.cm-qrbox').classList.add('ok');
        await runSync(diag, () => { diag.open = false; onBound && onBound(); });
        return;
      }
      if (r.code === 800) {
        setStatus('二维码已过期，<a id="qrRefresh">点击刷新</a>');
        diag.querySelector('#qrRefresh').onclick = start;
        return;
      }
      setStatus(r.code === 802 ? '已扫码，请在手机上确认授权…' : '等待扫码…');
      timer = setTimeout(poll, 2000);
    } catch (e) {
      if (closed) return;
      setStatus(`<span class="err">${esc(e.message)}</span>`);
      timer = setTimeout(poll, 3000);
    }
  }

  start();
}

export async function runSync(container, onDone) {
  const box = container.querySelector('#qrStatus') || container;
  const old = box.innerHTML;
  box.innerHTML = '<mdui-linear-progress></mdui-linear-progress> 正在同步网易云歌单（冷查询较慢，请稍候）…';
  try {
    const r = await api.syncNcm();
    const msg = `已同步 ${r.imported} 个歌单 / ${r.tracks} 首歌` +
      (r.pending ? `（${r.pending} 个未完成，可再次同步续传）` : '') +
      (r.failed ? `，${r.failed} 个失败` : '');
    toast(msg);
    if (onDone) onDone();
    else location.reload();
  } catch (e) {
    toast(`同步失败：${e.message}`);
    box.innerHTML = old;
  }
}

export function unbindFlow(onDone) {
  confirmDialog({
    title: '解绑网易云音乐？',
    body: '已导入的歌单会保留为本地快照（不再随网易云更新），也不会从网易云删除任何数据。',
    onOk: async () => {
      try { await api.unbindNcm(); toast('已解绑'); onDone && onDone(); }
      catch (e) { toast(e.message); }
    },
  });
}
