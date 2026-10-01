// 网易云服务工具箱（阶段五新增）
// 助眠解压：/sati/tag/list、/sati/resource/list、/sati/resource/list/more、
//          /sati/resource/sub（T2）、/sati/resource/sub/list、/sati/timescene/resources/get
// 话题热榜：/hot/topic
// 服务与账号信息：/inner/version（上游版本）、/creator/authinfo/get（创作者认证）、
//          /threshold/detail/get（权益门槛）、/starpick/comments/summary（评论摘要位）、
//          /lbs/city/code（行政区划）、/batch（批量请求，键名必须是 /api/... 形式）
//
// 为什么这些放在「工具箱」而不是各做页面：它们要么是**元信息**（版本/门槛/行政区划），
// 要么是**聚合位**（评论摘要位、话题热榜），单独开页面没有使用场景；
// 计划 §5.6 也明确说"无界面场景的接口保留在分母内，用工具箱承接"，这里就是那个工具箱。
import { api, auth } from '../api.js';
import { esc, toast, fmtCount, skelList, confirmDialog } from '../ui.js';

const KEY = 'cm.svcTab';

function needBind(el, text = '助眠内容与账号权益跟你的网易云账号绑定，请先绑定') {
  el.innerHTML = `<div class="cm-login-tip page">
    <span class="material-icons-outlined" style="font-size:calc(44px * var(--cm-fs, 1))">spa</span>
    <div>${esc(text)}</div>
    <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button></div>`;
}

export async function render(el, params = {}) {
  const tab = params.tab || sessionStorage.getItem(KEY) || 'sati';
  const TABS = [
    { k: 'sati', l: '助眠解压' },
    { k: 'topic', l: '话题热榜' },
    { k: 'info', l: '服务信息' },
  ];
  el.innerHTML = `
    <div class="cm-sqtabs" id="svcTabs">
      ${TABS.map(t => `<button class="cm-sqtab${t.k === tab ? ' on' : ''}" data-k="${t.k}">${t.l}</button>`).join('')}
    </div>
    <div id="svcBody">${skelList(5)}</div>`;
  el.querySelectorAll('#svcTabs .cm-sqtab').forEach(b => {
    b.onclick = () => {
      sessionStorage.setItem(KEY, b.dataset.k);
      render(el, { tab: b.dataset.k });
    };
  });
  const body = el.querySelector('#svcBody');

  if (tab === 'topic') {
    body.innerHTML = skelList(5);
    let offset = 0;
    const load = async append => {
      let d;
      try { d = await api.ncm('/hot/topic', { limit: 20, offset }); } catch (e) {
        body.innerHTML = `<div class="cm-empty">加载失败：${esc(e.message)}</div>`;
        return;
      }
      const list = d.hot || [];
      if (!append) body.innerHTML = '';
      if (!list.length && !append) { body.innerHTML = '<div class="cm-empty small">暂无热榜话题</div>'; return; }
      body.insertAdjacentHTML('beforeend', list.map(t => `
        <div class="cm-ev-card" data-act="${t.actId || ''}">
          <div class="cm-ev-text" style="font-weight:650">${esc(t.title || '')}</div>
          ${(t.text || []).slice(0, 2).map(x => `<div class="cm-detail-sub">${esc(x)}</div>`).join('')}
          <div class="cm-ev-foot">
            <span>${t.participateCount ? `${fmtCount(t.participateCount)} 人参与` : ''}</span>
            <span>${t.readCount ? `${fmtCount(t.readCount)} 阅读` : ''}</span>
          </div>
        </div>`).join(''));
      offset += list.length;
      body.querySelector('#svcMore')?.remove();
      if (list.length >= 20) {
        body.insertAdjacentHTML('beforeend',
          '<div class="cm-sq-more" id="svcMore"><mdui-button variant="tonal">加载更多</mdui-button></div>');
        body.querySelector('#svcMore mdui-button').onclick = async ev => {
          const btn = ev.currentTarget;
          btn.loading = true;
          try { await load(true); } catch (e) { toast(e.message); } finally { btn.loading = false; }
        };
      }
    };
    await load(false);
    return;
  }

  if (tab === 'info') {
    body.innerHTML = skelList(4);
    const [verR, creatorR, thrR, starR, lbsR] = await Promise.allSettled([
      api.ncm('/inner/version'),
      api.ncm('/creator/authinfo/get'),
      api.ncm('/threshold/detail/get'),
      api.ncm('/starpick/comments/summary'),
      api.ncm('/lbs/city/code', { bizCode: '' }),
    ]);
    const of = r => (r.status === 'fulfilled' ? (r.value.data || r.value) : null);
    const ver = of(verR) || {};
    const creator = of(creatorR) || {};
    const thr = of(thrR) || [];
    const star = of(starR) || {};
    const lbs = of(lbsR) || {};
    body.innerHTML = `
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>上游服务</h2><span class="cm-sec-sub">/inner/version</span></div>
        <div class="cm-si-row"><b>api-enhanced 版本</b><span>${esc(ver.version || '未知')}</span></div>
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>创作者认证</h2><span class="cm-sec-sub">/creator/authinfo/get</span></div>
        ${Object.keys(creator).length ? Object.entries(creator)
          .filter(([, v]) => typeof v !== 'object')
          .map(([k, v]) => `<div class="cm-si-row"><b>${esc(k)}</b><span>${v ? '是' : '否'}</span></div>`).join('')
          : '<div class="cm-empty small">上游未返回认证信息</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>权益门槛</h2><span class="cm-sec-sub">/threshold/detail/get</span></div>
        ${Array.isArray(thr) && thr.length ? thr.map(t => `
          <div class="cm-kv-sub"><b>Lv.${t.level || '-'} ${t.status ? '（已达成）' : ''}</b>
          ${(t.items || []).slice(0, 6).map(i => `<div class="cm-si-row"><b>${esc(i.itemName || i.itemId || '')}</b>
            <span>${esc(String(i.value ?? i.itemValue ?? ''))}${i.complete ? ' ✓' : ''}</span></div>`).join('')}</div>`).join('')
          : '<div class="cm-empty small">上游未返回门槛数据（该接口面向创作者权益）</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>评论摘要位</h2><span class="cm-sec-sub">/starpick/comments/summary</span></div>
        ${(star.blocks || []).length ? (star.blocks || []).map(b => `
          <div class="cm-si-row"><b>${esc(b.blockCode || '')}</b><span>${esc(b.showType || '')}</span></div>`).join('')
          : '<div class="cm-empty small">上游未返回摘要位</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>行政区划</h2><span class="cm-sec-sub">/lbs/city/code</span></div>
        ${(lbs.provinces || []).length ? `<div class="cm-chips">${(lbs.provinces || []).slice(0, 12).map(p =>
          `<span class="cm-hot">${esc(p.name || '')}（${(p.cities || []).length}）</span>`).join('')}</div>`
          : '<div class="cm-empty small">上游未返回行政区划</div>'}
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>安全验证二维码</h2><span class="cm-sec-sub">/verify/getQr · /verify/qrcodestatus</span></div>
        <div class="cm-pe-hint">上游的 getQr 需要风控下发的 evid/sign/token（在触发风控的响应里给），
          这里只做手动带入与状态轮询，不伪造参数。</div>
        <div class="cm-pe-field"><label>evid</label><input id="svcEvid" placeholder="风控返回的 evid"></div>
        <div class="cm-pe-field"><label>sign</label><input id="svcSign" placeholder="风控返回的 sign"></div>
        <div class="cm-pe-field"><label>token</label><input id="svcToken" placeholder="风控返回的 token"></div>
        <div class="cm-pe-acts">
          <mdui-button variant="tonal" id="svcGetQr">获取验证二维码</mdui-button>
          <mdui-button variant="text" id="svcQrStatus">查询扫码状态</mdui-button>
        </div>
        <div class="cm-pe-hint" id="svcQrHint"></div>
      </section>
      <section class="cm-sec">
        <div class="cm-sec-head"><h2>批量请求</h2><span class="cm-sec-sub">/batch</span></div>
        <div class="cm-pe-field"><label>键必须是 /api/... 形式，值是 JSON（上游要求）</label>
          <textarea id="svcBatch" rows="3" placeholder='/api/song/detail={"ids":[347230]}'></textarea></div>
        <div class="cm-pe-acts"><mdui-button variant="tonal" id="svcBatchGo">发送</mdui-button></div>
        <div class="cm-pe-hint" id="svcBatchHint"></div>
      </section>`;
    body.querySelector('#svcGetQr').onclick = async () => {
      const hint = body.querySelector('#svcQrHint');
      hint.textContent = '请求中…';
      try {
        const d = await api.ncm('/verify/getQr', {
          evid: body.querySelector('#svcEvid').value.trim(),
          sign: body.querySelector('#svcSign').value.trim(),
          token: body.querySelector('#svcToken').value.trim(),
          type: 1, vid: '',
        });
        hint.textContent = `返回：${JSON.stringify(d).slice(0, 180)}`;
        const qr = d.qr || (d.data && d.data.qr);
        if (qr) body.dataset.qr = qr;
      } catch (e) { hint.textContent = `失败：${e.message}`; }
    };
    body.querySelector('#svcQrStatus').onclick = async () => {
      const hint = body.querySelector('#svcQrHint');
      const qr = body.dataset.qr || '';
      if (!qr) { hint.textContent = '先获取二维码（或直接填 qr）'; return; }
      try {
        const d = await api.ncm('/verify/qrcodestatus', { qr });
        hint.textContent = `状态：${JSON.stringify(d).slice(0, 180)}`;
      } catch (e) { hint.textContent = `失败：${e.message}`; }
    };
    body.querySelector('#svcBatchGo').onclick = async () => {
      const raw = body.querySelector('#svcBatch').value.trim();
      const hint = body.querySelector('#svcBatchHint');
      if (!raw) return toast('先填一行');
      const eq = raw.indexOf('=');
      if (eq < 0) return toast('格式：/api/xxx={json}');
      const key = raw.slice(0, eq).trim();
      const val = raw.slice(eq + 1).trim();
      if (!key.startsWith('/api/')) return toast('键必须以 /api/ 开头（上游只认这种键）');
      try { JSON.parse(val); } catch { return toast('值不是合法 JSON'); }
      hint.textContent = '发送中…';
      try {
        const d = await api.ncm('/batch', { [key]: val });
        hint.textContent = `返回：${JSON.stringify(d).slice(0, 200)}`;
      } catch (e) { hint.textContent = `失败：${e.message}`; }
    };
    return;
  }

  // 助眠解压
  if (!auth.token) { needBind(el, '助眠内容需要登录后使用'); return; }
  body.innerHTML = skelList(4);
  const [tagR, sceneR, subR] = await Promise.allSettled([
    api.ncm('/sati/tag/list'),
    api.ncm('/sati/timescene/resources/get'),
    api.ncm('/sati/resource/sub/list'),
  ]);
  const tags = tagR.status === 'fulfilled' ? (tagR.value.data || []) : [];
  const scene = sceneR.status === 'fulfilled' ? ((sceneR.value.data || {}).sceneVO || {}) : {};
  const subs = subR.status === 'fulfilled' ? (subR.value.data || []) : [];
  let curTag = (tags[0] || {}).tag || 'RCMD';
  body.innerHTML = `
    ${scene.text || scene.sceneId ? `<section class="cm-sec">
      <div class="cm-sec-head"><h2>此刻场景</h2><span class="cm-sec-sub">/sati/timescene/resources/get</span></div>
      <div class="cm-detail-sub">${esc(scene.text || '')}${scene.startTime ? ` · ${esc(scene.startTime)}~${esc(scene.endTime || '')}` : ''}</div>
      <div id="svcScene"></div>
    </section>` : ''}
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>助眠解压</h2><span class="cm-sec-sub">/sati/tag/list · /sati/resource/list</span></div>
      <div class="cm-chips" id="svcTags">${tags.map(t =>
        `<span class="cm-hot${t.tag === curTag ? ' on' : ''}" data-tag="${esc(t.tag)}">${esc(t.tagDesc || t.text || t.tag)}</span>`).join('')}</div>
      <div id="svcRes"></div>
    </section>
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>我收藏的助眠内容</h2><span class="cm-sec-sub">/sati/resource/sub/list</span></div>
      ${subs.length ? `<div class="cm-stat-list">${subs.slice(0, 20).map(x => `
        <div class="cm-lm-item"><div class="cm-lm-lyric">${esc(x.name || x.title || '')}</div>
        <div class="cm-lm-meta"><span>${esc(x.tagDesc || '')}</span>
        <span><i class="cm-si-act" data-unsub="${x.id || ''}">取消收藏</i></span></div></div>`).join('')}</div>`
      : '<div class="cm-empty small">还没有收藏助眠内容</div>'}
    </section>`;

  const drawRes = list => {
    const box = body.querySelector('#svcRes');
    box.innerHTML = list.length ? `<div class="cm-plgrid">${list.map(r => `
      <div class="cm-plcard" data-rid="${r.id || ''}">
        <div class="cm-plcover">${r.picUrl || r.coverUrl ? `<img src="${esc(r.picUrl || r.coverUrl)}?param=300y300" loading="lazy" onerror="this.remove()">` : ''}<span class="material-icons-outlined">spa</span></div>
        <div class="cm-plname">${esc(r.name || r.title || '')}</div>
        <div class="cm-plsub">${esc(r.tagDesc || '')}
          <i class="cm-si-act" data-sub="${r.id || ''}" data-on="${r.subed ? 1 : 0}">${r.subed ? '取消收藏' : '收藏'}</i>
          <i class="cm-si-act" data-more="${r.id || ''}">更多</i></div>
      </div>`).join('')}</div>` : '<div class="cm-empty small">该分类下暂无内容</div>';
    box.querySelectorAll('[data-sub]').forEach(x => {
      x.onclick = () => {
        const on = x.dataset.on === '1';
        confirmDialog({
          title: on ? '取消收藏？' : '收藏这条助眠内容？', body: '',
          onOk: () => api.ncm('/sati/resource/sub', { id: x.dataset.sub, cancel: on, confirm: 1 })
            .then(() => { toast(on ? '已取消' : '已收藏'); render(el, { tab: 'sati' }); })
            .catch(e => toast(/绑定|401/.test(e.message) ? '需先绑定网易云账号' : e.message)),
        });
      };
    });
    box.querySelectorAll('[data-more]').forEach(x => {
      x.onclick = async ev => {
        ev.stopPropagation();
        try {
          const d = await api.ncm('/sati/resource/list/more', { id: x.dataset.more });
          const list2 = ((d.data || {}).resourceList) || [];
          toast(list2.length ? `更多内容 ${list2.length} 条：${list2.slice(0, 2).map(y => y.name || '').join(' / ')}`
            : '上游没有更多内容');
        } catch (e) { toast(e.message); }
      };
    });
  };
  const loadTag = async tag => {
    const box = body.querySelector('#svcRes');
    box.innerHTML = '<div class="cm-loading" style="padding:14px 0"><mdui-circular-progress></mdui-circular-progress></div>';
    try {
      const d = await api.ncm('/sati/resource/list', { tag });
      drawRes(d.data || []);
    } catch (e) {
      box.innerHTML = `<div class="cm-empty small">加载失败：${esc(e.message)}</div>`;
    }
  };
  body.querySelectorAll('[data-tag]').forEach(c => {
    c.onclick = () => {
      curTag = c.dataset.tag;
      body.querySelectorAll('[data-tag]').forEach(x => x.classList.toggle('on', x === c));
      loadTag(curTag);
    };
  });
  body.querySelectorAll('[data-unsub]').forEach(x => {
    x.onclick = () => confirmDialog({
      title: '取消收藏？', body: '',
      onOk: () => api.ncm('/sati/resource/sub', { id: x.dataset.unsub, cancel: true, confirm: 1 })
        .then(() => { toast('已取消'); render(el, { tab: 'sati' }); })
        .catch(e => toast(e.message)),
    });
  });
  await loadTag(curTag);
}
