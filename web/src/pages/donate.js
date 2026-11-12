// 官方捐赠：确认账号基本信息（可选备注）→ 捐赠码 → 填写交易单号提交
// 金额由用户自报，记录仅用于站长核对与感谢，不构成任何付费服务
import { mdui } from '../md.js';
import { api, auth, settings } from '../api.js';
import { esc, toast } from '../ui.js';

const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtYuan = cents => (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function render(el) {
  if (!auth.token) { location.hash = '#/user'; return; }
  const owner = auth.token;

  el.innerHTML = `
    <div class="cm-donate">
      <div class="cm-sec-head"><h2>捐赠支持 CurrentMusic</h2><span class="cm-usub">自愿参与 · 不影响任何功能</span></div>
      <div class="cm-donate-loading"><mdui-circular-progress></mdui-circular-progress><p>正在加载捐赠信息…</p></div>
    </div>`;
  document.getElementById('out').scrollTop = 0;

  let info;
  try {
    info = await api.donationInfo();
  } catch (e) {
    el.innerHTML = `<div class="cm-donate"><div class="cm-empty">捐赠信息加载失败：${esc(e.message)}</div></div>`;
    return;
  }
  if (!el.isConnected || auth.token !== owner) return;
  const p = info.profile || {};

  const mineHTML = mine => !mine || !mine.count ? '' : `
    <div class="cm-sec-head"><h2>我的捐赠记录</h2>
      <span class="cm-usub">共 ${mine.count} 次 · 累计 ¥${fmtYuan(mine.totalCents || 0)}，感谢你的支持！</span></div>
    <div class="cm-setting-list">
      ${(mine.items || []).map(d => `
        <div class="cm-setting"><span class="material-icons-outlined">volunteer_activism</span>
          ¥${fmtYuan(d.amount_cents)}<i>${esc(d.note || '无备注')} · ${fmtTime(d.created_at)}</i></div>`).join('')}
    </div>`;

  const renderStep1 = () => {
    el.innerHTML = `
      <div class="cm-donate">
        <div class="cm-sec-head"><h2>确认账号信息</h2><span class="cm-usub">捐赠记录将关联以下账号，请先核对</span></div>
        <div class="cm-setting-list">
          <div class="cm-setting"><span class="material-icons-outlined">person</span>用户名<i>${esc(p.username || '—')}</i></div>
          <div class="cm-setting"><span class="material-icons-outlined">badge</span>昵称<i>${esc(p.nickname || '—')}</i></div>
          <div class="cm-setting"><span class="material-icons-outlined">mail</span>邮箱<i>${esc(p.email || '未绑定')}</i></div>
          <div class="cm-setting"><span class="material-icons-outlined">smartphone</span>手机号<i>${esc(p.phone || '未绑定')}</i></div>
          <div class="cm-setting"><span class="material-icons-outlined">schedule</span>注册时间<i>${fmtTime(p.created_at)}</i></div>
          <div class="cm-setting cm-donate-note"><span class="material-icons-outlined">edit_note</span>
            <mdui-text-field id="donateNote" label="备注（可选，${info.noteMax || 120} 字内）" variant="outlined"
              maxlength="${info.noteMax || 120}" style="width:100%"></mdui-text-field></div>
        </div>
        <mdui-button variant="filled" id="donateNext" class="cm-donate-next">
          <span class="material-icons-outlined">qr_code_2</span>下一步：查看捐赠码</mdui-button>
        ${mineHTML(info.mine)}
      </div>`;
    el.querySelector('#donateNext').onclick = () => {
      renderStep2((el.querySelector('#donateNote').value || '').trim());
    };
    document.getElementById('out').scrollTop = 0;
  };

  const renderStep2 = note => {
    el.innerHTML = `
      <div class="cm-donate">
        <div class="cm-sec-head"><h2>扫码捐赠</h2><span class="cm-usub">使用支付宝 / 微信扫码，金额随意</span></div>
        <div class="cm-donate-qrbox">
          <img src="${settings.base}${info.qrPath || '/donation/qr'}" alt="官方捐赠二维码" loading="lazy">
          <div class="cm-donate-tip">长按或截图保存二维码，在支付应用中扫码完成捐赠。</div>
        </div>
        <div class="cm-sec-head"><h2>填写交易单号</h2><span class="cm-usub">支付完成后，把交易单号填到这里，便于核对与感谢</span></div>
        <div class="cm-donate-form">
          <mdui-text-field id="donateAmount" label="捐赠金额（元，自报）" variant="outlined" type="number"
            min="0.01" max="100000" step="0.01"></mdui-text-field>
          <mdui-text-field id="donateTxn" label="交易单号（${info.txnMax || 64} 位内数字/字母）" variant="outlined"
            maxlength="${info.txnMax || 64}"></mdui-text-field>
          <div class="cm-donate-hint">单号在支付应用的账单详情里可以找到；每个单号只能提交一次。${note ? `<br>备注：${esc(note)}` : ''}</div>
          <div class="cm-donate-actions">
            <mdui-button variant="text" id="donateBack"><span class="material-icons-outlined">arrow_back</span>上一步</mdui-button>
            <mdui-button variant="filled" id="donateSubmit"><span class="material-icons-outlined">volunteer_activism</span>提交捐赠记录</mdui-button>
          </div>
        </div>
      </div>`;
    document.getElementById('out').scrollTop = 0;
    el.querySelector('#donateBack').onclick = renderStep1;
    const submit = el.querySelector('#donateSubmit');
    const doSubmit = async () => {
      if (submit.loading) return;
      const amount = parseFloat(el.querySelector('#donateAmount').value);
      const txn = (el.querySelector('#donateTxn').value || '').trim();
      if (!isFinite(amount) || amount < 0.01) { toast('请填写 0.01 元以上的捐赠金额'); return; }
      if (!/^[0-9A-Za-z._-]{6,}$/.test(txn)) { toast('交易单号需为 6 位以上数字/字母'); return; }
      submit.loading = true;
      try {
        const r = await api.donationSubmit(Math.round(amount * 100) / 100, txn, note);
        toast('捐赠记录已提交，感谢你的支持！');
        renderDone(r.mine);
      } catch (e) { toast(e.message); } finally { submit.loading = false; }
    };
    submit.onclick = doSubmit;
    el.querySelectorAll('mdui-text-field').forEach(input =>
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSubmit(); } }));
  };

  const renderDone = mine => {
    el.innerHTML = `
      <div class="cm-donate">
        <div class="cm-donate-done">
          <span class="material-icons-outlined">favorite</span>
          <h2>捐赠记录已提交</h2>
          <p>感谢你对 CurrentMusic 的支持！站长核对后会记录在你的账号下。</p>
          <mdui-button variant="tonal" id="donateAgain"><span class="material-icons-outlined">add</span>再次捐赠</mdui-button>
        </div>
        ${mineHTML(mine)}
      </div>`;
    el.querySelector('#donateAgain').onclick = renderStep1;
    document.getElementById('out').scrollTop = 0;
  };

  renderStep1();
}
