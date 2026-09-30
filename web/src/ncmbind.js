// 网易云账号绑定：扫码 / 手机验证码 两种方式；绑定后自动同步歌单
import { mdui } from './md.js';
import { api, auth } from './api.js';
import { esc, toast, confirmDialog } from './ui.js';

export function bindDialog(onBound) {
  if (!auth.token) return toast('请先登录 CurrentMusic 账号');
  let closed = false;
  let mode = 'phone';       // 默认手机验证码（qr | phone）
  let qrKey = '';
  let qrGen = 0;            // 二维码加载世代：旧请求的回调一律丢弃
  let qrTimer = null;
  let smsTimer = null;

  const diag = mdui.dialog({
    headline: '绑定网易云音乐',
    body: `
      <div class="cm-bindtabs">
        <mdui-segmented-button-group value="phone" selects="single" id="bindMode">
          <mdui-segmented-button value="phone">手机验证码</mdui-segmented-button>
          <mdui-segmented-button value="qr">扫码登录</mdui-segmented-button>
        </mdui-segmented-button-group>
      </div>
      <div id="paneQr" class="cm-qrbind" hidden>
        <div class="cm-qrbox loading" id="qrBox"><img id="qrImg" alt=""></div>
        <div class="cm-qrstatus" id="qrStatus"><mdui-linear-progress></mdui-linear-progress></div>
        <div class="cm-qrhint">打开网易云音乐 APP → 左上角「扫一扫」扫描二维码授权登录</div>
      </div>
      <div id="panePhone" class="cm-phonebind">
        <div class="cm-phone-row">
          <mdui-text-field id="phCc" label="区号" variant="outlined" value="86" style="width:88px"></mdui-text-field>
          <mdui-text-field id="phPhone" label="手机号" variant="outlined" type="tel" style="flex:1"></mdui-text-field>
        </div>
        <div class="cm-phone-row">
          <mdui-text-field id="phCode" label="短信验证码" variant="outlined" style="flex:1"></mdui-text-field>
          <mdui-button variant="tonal" id="phSend">获取验证码</mdui-button>
        </div>
        <mdui-button variant="filled" id="phLogin" style="width:100%;margin-top:10px">绑定</mdui-button>
        <div class="cm-qrstatus" id="phStatus" hidden></div>
        <div class="cm-qrhint">将向该手机号发送网易云登录验证码；此方式会真实发送短信，请确认号码无误</div>
      </div>`,
    actions: [{ text: '取消' }],
    onClose: () => { closed = true; clearTimeout(qrTimer); clearInterval(smsTimer); },
  });

  const setStatus = (html, sel = '#qrStatus') => {
    const el = diag.querySelector(sel);
    if (el) el.innerHTML = html;
  };

  // ---------- 扫码 ----------
  const qrBox = diag.querySelector('#qrBox');
  const qrImg = diag.querySelector('#qrImg');

  function qrLoading(on, failed) {
    qrBox.classList.toggle('loading', !!on);
    qrBox.classList.toggle('failed', !!failed);
    qrBox.classList.remove('ok');
  }

  async function startQr() {
    const gen = ++qrGen;
    clearTimeout(qrTimer);
    qrLoading(true);
    setStatus('正在生成二维码…');
    qrImg.onload = () => {
      if (closed || gen !== qrGen) return;
      qrLoading(false);     // 移除 loading 即触发二维码弹入动画
    };
    qrImg.onerror = () => {
      if (closed || gen !== qrGen) return;
      qrLoading(false, true);
      setStatus('<span class="err">二维码加载失败，<a id="qrRefresh">点击重试</a></span>');
      diag.querySelector('#qrRefresh').onclick = startQr;
    };
    try {
      qrKey = (await api.qrKey()).key;
      const img = (await api.qrImg(qrKey)).qrimg;
      if (closed || gen !== qrGen) return;
      qrImg.src = img;
      setStatus('等待扫码…');
      pollQr(gen);
    } catch (e) {
      if (closed || gen !== qrGen) return;
      qrLoading(false, true);
      setStatus(`<span class="err">${esc(e.message)}，<a id="qrRefresh">点击重试</a></span>`);
      diag.querySelector('#qrRefresh').onclick = startQr;
    }
  }

  async function pollQr(gen) {
    if (closed || mode !== 'qr' || gen !== qrGen) return;
    try {
      const r = await api.qrCheck(qrKey);
      if (closed || gen !== qrGen) return;
      if (r.code === 803) {
        setStatus(`<span class="ok"><span class="mi">check_circle</span> 绑定成功：${esc((r.profile && r.profile.nickname) || '')}，正在同步歌单…</span>`);
        qrBox.classList.add('ok');
        await runSync(diag, () => { diag.open = false; onBound && onBound(); });
        return;
      }
      if (r.code === 800) {
        setStatus('二维码已过期，<a id="qrRefresh">点击刷新</a>');
        diag.querySelector('#qrRefresh').onclick = startQr;
        return;
      }
      setStatus(r.code === 802 ? '已扫码，请在手机上确认授权…' : '等待扫码…');
      qrTimer = setTimeout(() => pollQr(gen), 2000);
    } catch (e) {
      if (closed || gen !== qrGen) return;
      setStatus(`<span class="err">${esc(e.message)}</span>`);
      qrTimer = setTimeout(() => pollQr(gen), 3000);
    }
  }

  // ---------- 手机验证码 ----------
  const phPhone = diag.querySelector('#phPhone');
  const phCc = diag.querySelector('#phCc');
  const phCode = diag.querySelector('#phCode');
  const phSend = diag.querySelector('#phSend');
  const phStatus = diag.querySelector('#phStatus');

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
      phStatus.hidden = false;
      phStatus.innerHTML = `<span class="ok"><span class="mi">check_circle</span> 绑定成功：${esc((r.profile && r.profile.nickname) || '')}，正在同步歌单…</span>`;
      await runSync(diag, () => { diag.open = false; onBound && onBound(); }, '#phStatus');
    } catch (e) {
      phStatus.hidden = false;
      phStatus.innerHTML = `<span class="err">${esc(e.message)}</span>`;
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
    qrGen++;                       // 使在途的二维码回调失效
    if (isQr) startQr();
  });
  if (mode === 'qr') startQr();    // 默认手机验证码：进弹窗不预取二维码，切换时才生成
}

export async function runSync(container, onDone, statusSel) {
  const box = container.querySelector(statusSel || '#qrStatus') || container;
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

/**
 * 网易云账号「高级操作」抽屉。
 *
 * 这一组上游接口在登记表里是 **T3**（登录/验证码/注册/换绑/设置），泛化转发对 T3 一律 403，
 * 所以它们只能走项目**专用入口** `/ncm/<上游路径>`（后端 `_T3_ROUTES`，见 cm_server.py）。
 * 专用入口与 T2 的安全属性一致：项目 Bearer 鉴权 + 用户自己的 cookie + 写操作 confirm=1 + 审计。
 *
 * 为什么仍然做得"门槛高一点"：这些操作会动到用户的网易云账号本身（登录态、绑定手机、注册），
 * 界面上每一类都先给说明再要求确认；注册类额外标注"会创建新的网易云账号"。
 */
export function advancedDialog(onChanged) {
  if (!auth.token) return toast('请先登录 CurrentMusic 账号');
  const diag = mdui.dialog({
    headline: '网易云账号高级操作',
    body: `
      <div class="cm-pe">
        <div class="cm-pe-hint">这些接口属 T3：只走项目专用入口，不经通用转发。写操作都会带 confirm=1 并记审计日志。</div>

        <div class="cm-pe-acts">
          <mdui-button variant="tonal" id="advSetting">消息与隐私设置</mdui-button>
          <mdui-button variant="text" id="advLogout">登出网易云</mdui-button>
        </div>
        <div class="cm-pe-hint" id="advSettingBox"></div>

        <div class="cm-pe-field"><label>手机号（发送验证码 / 换绑用）</label><input id="advPhone" placeholder="如 13800000000"></div>
        <div class="cm-pe-acts">
          <mdui-button variant="tonal" id="advCaptcha">发送验证码 v1</mdui-button>
          <mdui-button variant="tonal" id="advCaptchaSafe">发送安全验证码</mdui-button>
        </div>
        <div class="cm-pe-hint" id="advCaptchaBox"></div>

        <div class="cm-pe-field"><label>邮箱登录（网易云邮箱 + 密码）</label>
          <div class="cm-pe-inline"><input id="advEmail" placeholder="邮箱"><input id="advPass" type="password" placeholder="密码"></div></div>
        <div class="cm-pe-acts">
          <mdui-button variant="filled" id="advLogin">登录并绑定</mdui-button>
        </div>

        <div class="cm-pe-field"><label>换绑手机（原手机 / 新手机 / 验证码 / 密码）</label>
          <div class="cm-pe-inline"><input id="advOldPhone" placeholder="原手机"><input id="advNewPhone" placeholder="新手机"></div>
          <div class="cm-pe-inline" style="margin-top:6px"><input id="advCode" placeholder="验证码"><input id="advPwd" type="password" placeholder="密码"></div></div>
        <div class="cm-pe-acts">
          <mui-button id="advRebind" hidden></mui-button>
          <mdui-button variant="tonal" id="advReplace">换绑手机</mdui-button>
          <mdui-button variant="tonal" id="advBindPhone">绑定新手机</mdui-button>
        </div>
        <div class="cm-pe-hint" id="advBindBox"></div>

        <div class="cm-pe-acts">
          <mdui-button variant="text" id="advRegAnon">匿名注册（会创建新的网易云账号）</mdui-button>
          <mdui-button variant="text" id="advRegPhone">手机号注册（会创建新的网易云账号）</mdui-button>
        </div>
      </div>`,
    actions: [{ text: '关闭' }],
  });
  const q = sel => diag.querySelector(sel);
  const val = sel => (q(sel) ? q(sel).value.trim() : '');
  const act = async (label, fn) => {
    try {
      const r = await fn();
      toast(r && (r.message || r.msg) ? `${label}：${r.message || r.msg}` : `${label}完成`);
      if (onChanged) onChanged();
      return r;
    } catch (e) {
      toast(`${label}失败：${e.message}`);
      return null;
    }
  };

  q('#advSetting').onclick = async () => {
    const box = q('#advSettingBox');
    box.textContent = '读取中…';
    const d = await act('读取设置', () => api.ncm('/setting'));
    box.textContent = d ? `设置：${JSON.stringify(d).slice(0, 220)}` : '读取失败';
  };
  q('#advLogout').onclick = () => confirmDialog({
    title: '登出网易云账号？', body: '会调用上游 /logout，之后需要重新绑定。',
    onOk: () => act('登出', () => api.ncm('/logout', { confirm: 1 })),
  });
  q('#advCaptcha').onclick = () => {
    const phone = val('#advPhone');
    if (!phone) return toast('先填手机号');
    return act('发送验证码', () => api.ncm('/captcha/sent/v1', { phone, ctcode: '86', confirm: 1 }));
  };
  q('#advCaptchaSafe').onclick = () => {
    const phone = val('#advPhone');
    if (!phone) return toast('先填手机号');
    return act('发送安全验证码', () => api.ncm('/captcha/safe/sent', { phone, ctcode: '86', confirm: 1 }));
  };
  q('#advLogin').onclick = () => {
    const email = val('#advEmail');
    const password = val('#advPass');
    if (!email || !password) return toast('邮箱和密码都要填');
    return confirmDialog({
      title: `用 ${email} 登录网易云并绑定？`, body: '成功后会用该账号的 cookie 覆盖当前绑定。',
      onOk: () => act('邮箱登录', () => api.ncm('/login', { email, password, confirm: 1 })),
    });
  };
  q('#advReplace').onclick = () => {
    const phone = val('#advNewPhone') || val('#advPhone');
    const captcha = val('#advCode');
    const oldPhone = val('#advOldPhone');
    if (!phone || !captcha) return toast('新手机号与验证码都要填');
    return confirmDialog({
      title: `把绑定手机换成 ${phone}？`, body: '对应上游 /user/replacephone。',
      onOk: () => act('换绑手机', () => api.ncm('/user/replacephone', {
        phone, captcha, oldphone: oldPhone, confirm: 1,
      })),
    });
  };
  q('#advBindPhone').onclick = () => {
    const phone = val('#advNewPhone') || val('#advPhone');
    const captcha = val('#advCode');
    if (!phone || !captcha) return toast('手机号与验证码都要填');
    return act('绑定手机', () => api.ncm('/user/bindingcellphone', { phone, captcha, confirm: 1 }));
  };
  q('#advRebind').onclick = () => act('换绑', () => api.ncm('/rebind', {
    phone: val('#advNewPhone'), captcha: val('#advCode'), confirm: 1,
  }));
  q('#advRegAnon').onclick = () => confirmDialog({
    title: '匿名注册一个新的网易云账号？', body: '会创建一个你并不拥有的新账号，仅在明确需要时使用。',
    onOk: () => act('匿名注册', () => api.ncm('/register/anonimous', { confirm: 1 })),
  });
  q('#advRegPhone').onclick = () => {
    const phone = val('#advPhone');
    const captcha = val('#advCode');
    const password = val('#advPwd');
    if (!phone || !password) return toast('手机号与密码都要填');
    return confirmDialog({
      title: `用 ${phone} 注册网易云账号？`, body: '会创建新账号（上游该接口同时用于改密）。',
      onOk: () => act('手机号注册', () => api.ncm('/register/cellphone', {
        phone, password, captcha, nickname: `cm${Date.now() % 100000}`, confirm: 1,
      })),
    });
  };
}
