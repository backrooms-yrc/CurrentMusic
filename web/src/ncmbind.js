// 网易云账号绑定：扫码 / 手机验证码 两种方式；绑定后自动同步歌单
import { mdui } from './md.js';
import { api, auth } from './api.js';
import { esc, toast, confirmDialog } from './ui.js';

export function bindDialog(onBound) {
  if (!auth.token) return toast('请先登录 CurrentMusic 账号');
  let closed = false;
  let mode = 'qr';          // qr | phone
  let qrKey = '';
  let qrTimer = null;
  let smsTimer = null;

  const diag = mdui.dialog({
    headline: '绑定网易云音乐',
    body: `
      <div class="cm-bindtabs">
        <mdui-segmented-button-group value="qr" selects="single" id="bindMode">
          <mdui-segmented-button value="qr">扫码登录</mdui-segmented-button>
          <mdui-segmented-button value="phone">手机验证码</mdui-segmented-button>
        </mdui-segmented-button-group>
      </div>
      <div id="paneQr" class="cm-qrbind">
        <div class="cm-qrbox"><img id="qrImg" alt="二维码加载中…"></div>
        <div class="cm-qrstatus" id="qrStatus"><mdui-linear-progress></mdui-linear-progress></div>
        <div class="cm-qrhint">打开网易云音乐 APP → 左上角「扫一扫」扫描二维码授权登录</div>
      </div>
      <div id="panePhone" class="cm-phonebind" hidden>
        <div class="cm-phone-row">
          <mdui-text-field id="phCc" label="区号" variant="outlined" value="86" style="width:88px"></mdui-text-field>
          <mdui-text-field id="phPhone" label="手机号" variant="outlined" type="tel" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-phone-row">
          <mdui-text-field id="phCode" label="短信验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="phSend">获取验证码</mdui-button>
        </div>
        <mdui-button variant="filled" id="phLogin" style="width:100%;margin-top:10px">绑定</mdui-button>
        <div class="cm-qrhint">将向该手机号发送网易云登录验证码；此方式会真实发送短信，请确认号码无误</div>
      </div>`,
    actions: [{ text: '取消' }],
    onClose: () => { closed = true; clearTimeout(qrTimer); clearInterval(smsTimer); },
  });

  const setStatus = (html) => {
    const el = diag.querySelector('#qrStatus');
    if (el) el.innerHTML = html;
  };

  // ---------- 扫码 ----------
  async function startQr() {
    setStatus('<mdui-linear-progress></mdui-linear-progress>');
    try {
      qrKey = (await api.qrKey()).key;
      const img = (await api.qrImg(qrKey)).qrimg;
      if (closed) return;
      diag.querySelector('#qrImg').src = img;
      setStatus('等待扫码…');
      pollQr();
    } catch (e) {
      if (!closed) setStatus(`<span class="err">${esc(e.message)}</span>`);
    }
  }

  async function pollQr() {
    if (closed || mode !== 'qr') return;
    try {
      const r = await api.qrCheck(qrKey);
      if (r.code === 803) {
        setStatus(`<span class="ok"><span class="mi">check_circle</span> 绑定成功：${esc((r.profile && r.profile.nickname) || '')}，正在同步歌单…</span>`);
        diag.querySelector('.cm-qrbox').classList.add('ok');
        await runSync(diag, () => { diag.open = false; onBound && onBound(); });
        return;
      }
      if (r.code === 800) {
        setStatus('二维码已过期，<a id="qrRefresh">点击刷新</a>');
        diag.querySelector('#qrRefresh').onclick = startQr;
        return;
      }
      setStatus(r.code === 802 ? '已扫码，请在手机上确认授权…' : '等待扫码…');
      qrTimer = setTimeout(pollQr, 2000);
    } catch (e) {
      if (closed) return;
      setStatus(`<span class="err">${esc(e.message)}</span>`);
      qrTimer = setTimeout(pollQr, 3000);
    }
  }

  // ---------- 手机验证码 ----------
  const phPhone = diag.querySelector('#phPhone');
  const phCc = diag.querySelector('#phCc');
  const phCode = diag.querySelector('#phCode');
  const phSend = diag.querySelector('#phSend');

  phSend.onclick = async () => {
    const phone = (phPhone.value || '').replace(/\D/g, '');
    const cc = (phCc.value || '86').replace(/\D/g, '') || '86';
    if (!/^\d{5,15}$/.test(phone)) return toast('请输入正确的手机号');
    try {
      phSend.loading = true;
      await api.ncmPhoneCode(phone, cc);
      toast('验证码已发送，请查看短信');
      let left = 60;
      phSend.disabled = true;
      const tick = () => {
        phSend.textContent = `${left}s 后重发`;
        if (left-- <= 0) { clearInterval(smsTimer); phSend.disabled = false; phSend.textContent = '获取验证码'; }
      };
      tick();
      smsTimer = setInterval(tick, 1000);
    } catch (e) {
      toast(e.message);
    } finally {
      phSend.loading = false;
    }
  };

  diag.querySelector('#phLogin').onclick = async () => {
    const phone = (phPhone.value || '').replace(/\D/g, '');
    const cc = (phCc.value || '86').replace(/\D/g, '') || '86';
    const captcha = (phCode.value || '').trim();
    if (!phone) return toast('请输入手机号');
    if (!captcha) return toast('请输入短信验证码');
    const btn = diag.querySelector('#phLogin');
    try {
      btn.loading = true;
      const r = await api.ncmPhoneLogin(phone, captcha, cc);
      toast(`绑定成功：${(r.profile && r.profile.nickname) || ''}`);
      await runSync(diag, () => { diag.open = false; onBound && onBound(); });
    } catch (e) {
      toast(e.message);
    } finally {
      btn.loading = false;
    }
  };

  // ---------- 模式切换 ----------
  const modeGroup = diag.querySelector('#bindMode');
  modeGroup.addEventListener('change', () => {
    mode = modeGroup.value;
    const isQr = mode === 'qr';
    diag.querySelector('#paneQr').hidden = !isQr;
    diag.querySelector('#panePhone').hidden = isQr;
    clearTimeout(qrTimer);
    if (isQr) startQr();
  });
  startQr();
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
