// 网易云歌单编辑器（阶段三新增）
// 覆盖 T2 写接口：/playlist/update、/playlist/name/update、/playlist/desc/update、
//   /playlist/tags/update、/playlist/privacy、/playlist/delete、/playlist/subscribe、
//   /playlist/track/add、/playlist/track/delete、/playlist/order/update、/playlist/tracks、
//   /playlist/import/name/task/create、/playlist/update/playcount
// 以及只读接口 /playlist/detail/dynamic、/playlist/detail/rcmd/get、/playlist/subscribers、
//   /playlist/import/task/status。
// 写操作一律 confirm=1（后端 T2 门禁会拒掉漏传 confirm 的请求）。
//
// 未接入：/playlist/cover/update —— 上游要求 multipart 的 imgFile，而 cm-server 的泛化
// 转发只吃 query/JSON 体（见 docs/api-5-phase-plan.md 的「封面更新」缺口说明）。
import { api } from './api.js';
import { esc, toast, confirmDialog, promptDialog, fmtCount } from './ui.js';

const W = (path, params) => api.ncm(path, { ...params, confirm: 1 });

/** 把一串「ID 或 ID,ID」解析成数字数组。 */
const parseIds = s => String(s || '').split(/[\s,，]+/).map(x => x.trim()).filter(Boolean);

/**
 * 打开歌单编辑器。
 * @param {{id: string|number, name?: string, onChanged?: Function, canEdit?: boolean}} opts
 */
export function openPlaylistEditor({ id, name = '歌单', onChanged, canEdit = true } = {}) {
  const diag = document.createElement('mdui-dialog');
  diag.headline = `编辑「${name}」`;
  diag.style.setProperty('--mdui-dialog-width', 'min(560px, 92vw)');
  diag.innerHTML = `
    <div class="cm-pe">
      <div class="cm-pe-tabs">
        <div class="cm-pe-tab on" data-tab="info">信息</div>
        <div class="cm-pe-tab" data-tab="tracks">歌曲</div>
        <div class="cm-pe-tab" data-tab="dyn">动态</div>
        <div class="cm-pe-tab" data-tab="import">导入</div>
      </div>
      <div class="cm-pe-panel" data-panel="info"></div>
      <div class="cm-pe-panel" data-panel="tracks" hidden></div>
      <div class="cm-pe-panel" data-panel="dyn" hidden></div>
      <div class="cm-pe-panel" data-panel="import" hidden></div>
    </div>`;
  document.body.appendChild(diag);
  diag.open = true;

  const q = sel => diag.querySelector(sel);
  const panelOf = k => q(`.cm-pe-panel[data-panel="${k}"]`);
  const guard = async (fn, okMsg) => {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      if (onChanged) onChanged();
      return r;
    } catch (e) {
      toast(/绑定|未登录|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
      throw e;
    }
  };

  diag.querySelectorAll('.cm-pe-tabs .cm-pe-tab').forEach(t => {
    t.onclick = () => {
      diag.querySelectorAll('.cm-pe-tab').forEach(x => x.classList.toggle('on', x === t));
      diag.querySelectorAll('.cm-pe-panel').forEach(p => { p.hidden = p.dataset.panel !== t.dataset.tab; });
      const k = t.dataset.tab;
      if (k === 'info') loadDynSummary();
      if (k === 'tracks') loadTracks();
      if (k === 'dyn') loadDyn();
      if (k === 'import') loadImport();
    };
  });

  // ---------------- 信息 ----------------
  const info = panelOf('info');
  info.innerHTML = `
    <div class="cm-pe-field"><label>歌单名</label><input id="peName" value="${esc(name)}"></div>
    <div class="cm-pe-field"><label>简介</label><textarea id="peDesc" rows="3"></textarea></div>
    <div class="cm-pe-field"><label>标签（逗号分隔）</label><input id="peTags"></div>
    <div class="cm-pe-acts">
      <mdui-button variant="filled" id="peSaveAll">保存全部</mdui-button>
      <mdui-button variant="tonal" id="peRename">只改名</mdui-button>
      <mdui-button variant="tonal" id="peDescOnly">只改简介</mdui-button>
      <mdui-button variant="tonal" id="peTagsOnly">只改标签</mdui-button>
    </div>
    <div class="cm-pe-acts">
      <mdui-button variant="tonal" id="peCover">更换封面</mdui-button>
      <input type="file" id="peCoverFile" accept="image/png,image/jpeg,image/webp" hidden>
      <span class="cm-pe-hint" id="peCoverHint">图片先压到最长边 1024 再上传</span>
    </div>
    <div class="cm-pe-acts">
      <mdui-button variant="tonal" id="pePrivacy">切换公开/私密</mdui-button>
      <mdui-button variant="tonal" id="peSubscribe">收藏歌单</mdui-button>
      <mdui-button variant="tonal" id="peUnsubscribe">取消收藏</mdui-button>
      <mdui-button variant="text" id="peSubs">订阅者</mdui-button>
      ${canEdit ? '<mdui-button variant="text" id="peDelete" style="color:#c62828">删除歌单</mdui-button>' : ''}
    </div>
    <div class="cm-pe-hint" id="peInfoHint"></div>`;

  q('#peSaveAll').onclick = () => guard(() => W('/playlist/update', {
    id, name: q('#peName').value.trim(), desc: q('#peDesc').value, tags: q('#peTags').value.trim(),
  }), '已保存到网易云');
  q('#peRename').onclick = () => guard(() => W('/playlist/name/update', { id, name: q('#peName').value.trim() }), '歌单名已更新');
  q('#peDescOnly').onclick = () => guard(() => W('/playlist/desc/update', { id, desc: q('#peDesc').value }), '简介已更新');
  q('#peTagsOnly').onclick = () => guard(() => W('/playlist/tags/update', { id, tags: q('#peTags').value.trim() }), '标签已更新');
  q('#pePrivacy').onclick = () => guard(() => W('/playlist/privacy', { id }), '已切换公开/私密（以网易云返回为准）');

  // 更换封面：唯一的文件上传接口（后端白名单 cm_ncm_gateway.UPLOAD_FIELD 里的
  // /playlist/cover/update，走 multipart；前端先降采样再 base64 提交）。
  q('#peCover').onclick = () => q('#peCoverFile').click();
  q('#peCoverFile').onchange = async ev => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const hint = q('#peCoverHint');
    const btn = q('#peCover');
    btn.loading = true;
    if (hint) hint.textContent = '上传中…';
    try {
      await api.ncmUpload('/playlist/cover/update', { id }, file);
      toast('封面已更新');
      if (hint) hint.textContent = '图片先压到最长边 1024 再上传';
      if (onChanged) onChanged();
    } catch (e) {
      toast(/绑定|未登录|401/.test(e.message) ? '需先绑定网易云账号' : e.message);
      if (hint) hint.textContent = `上传失败：${e.message}`;
    } finally {
      btn.loading = false;
      ev.target.value = '';
    }
  };
  q('#peSubscribe').onclick = () => confirmDialog({
    title: '收藏这个歌单？', body: '会同步到你的网易云账号。',
    onOk: () => guard(() => W('/playlist/subscribe', { id, t: 1 }), '已收藏'),
  });
  q('#peUnsubscribe').onclick = () => confirmDialog({
    title: '取消收藏这个歌单？', body: '',
    onOk: () => guard(() => W('/playlist/subscribe', { id, t: 0 }), '已取消收藏'),
  });
  q('#peSubs').onclick = () => subscribersDialog(id);
  const del = q('#peDelete');
  if (del) del.onclick = () => confirmDialog({
    title: `删除歌单「${name}」？`, body: '删除后不可恢复。',
    onOk: () => guard(() => W('/playlist/delete', { id }), '已删除').then(() => { diag.open = false; location.hash = '#/library'; }),
  });

  /** 信息面板顶部的实时计数（/playlist/detail/dynamic）。 */
  function loadDynSummary() {
    api.ncm('/playlist/detail/dynamic', { id }).then(d => {
      const box = q('#peInfoHint');
      if (!box) return;
      const bits = [];
      if (d.playCount) bits.push(`播放 ${fmtCount(d.playCount)}`);
      if (d.subscribedCount) bits.push(`收藏 ${fmtCount(d.subscribedCount)}`);
      if (d.commentCount) bits.push(`评论 ${fmtCount(d.commentCount)}`);
      if (d.subscribed !== undefined) bits.push(d.subscribed ? '已收藏' : '未收藏');
      box.textContent = bits.join(' · ');
    }).catch(() => {});
  }

  // ---------------- 歌曲 ----------------
  const tracks = panelOf('tracks');
  tracks.innerHTML = `
    <div class="cm-pe-field"><label>按歌名搜索后添加</label>
      <div class="cm-pe-inline"><input id="peSearch" placeholder="歌名 / 歌手"><mdui-button variant="tonal" id="peSearchBtn">搜索</mdui-button></div>
    </div>
    <div id="peSearchRes" class="cm-pe-list"></div>
    <div class="cm-pe-field"><label>按歌曲 ID 删除（可逗号分隔）</label>
      <div class="cm-pe-inline"><input id="peDelIds" placeholder="如 347230,186016"><mdui-button variant="tonal" id="peDelBtn">删除</mdui-button></div>
    </div>
    <div class="cm-pe-field"><label>按歌曲 ID 添加（可逗号分隔）</label>
      <div class="cm-pe-inline"><input id="peAddIds" placeholder="如 347230"><mdui-button variant="tonal" id="peAddBtn">添加</mdui-button></div>
    </div>
    <div class="cm-pe-acts">
      <mdui-button variant="tonal" id="peOrder">把当前页顺序写回云端</mdui-button>
      <mdui-button variant="text" id="peTracksOp">批量提交（/playlist/tracks）</mdui-button>
    </div>
    <div id="peTrackList" class="cm-pe-list"></div>`;

  let currentIds = [];
  function loadTracks() {
    // 读当前顺序用 /playlist/detail（/playlist/tracks 的 op 语义在上游只支持 add/del）
    api.ncm('/playlist/detail', { id }).then(d => {
      const pl = d.playlist || {};
      currentIds = (pl.trackIds || []).map(t => t.id).filter(Boolean);
      const box = q('#peTrackList');
      if (!box) return;
      box.innerHTML = currentIds.length
        ? `<div class="cm-pe-hint">当前 ${currentIds.length} 首（仅列 ID 前 200）</div>
           <div class="cm-pe-ids">${currentIds.slice(0, 200).join(', ')}</div>`
        : '<div class="cm-pe-hint">未能读到曲目列表（上游 /playlist/detail 未返回 trackIds）</div>';
    }).catch(e => {
      const box = q('#peTrackList');
      if (box) box.textContent = `曲目读取失败：${e.message}`;
    });
  }

  q('#peSearchBtn').onclick = async () => {
    const kw = q('#peSearch').value.trim();
    if (!kw) return;
    const box = q('#peSearchRes');
    box.innerHTML = '<div class="cm-pe-hint">搜索中…</div>';
    try {
      const d = await api.search(kw, 0, 10, 'song');
      const songs = d.songs || [];
      box.innerHTML = songs.length ? songs.map((s, i) => `
        <div class="cm-pe-row"><span>${esc(s.name)} <i>${esc(s.artists || '')}</i></span>
        <mdui-button variant="text" data-add="${s.ncm_id || s.id}" data-i="${i}">添加</mdui-button></div>`).join('')
        : '<div class="cm-pe-hint">没有结果</div>';
      box.querySelectorAll('[data-add]').forEach(b => {
        b.onclick = () => guard(() => W('/playlist/track/add', { pid: id, ids: b.dataset.add }), '已添加')
          .then(() => { b.disabled = true; b.textContent = '已添加'; }).catch(() => {});
      });
    } catch (e) { box.innerHTML = `<div class="cm-pe-hint">搜索失败：${esc(e.message)}</div>`; }
  };
  q('#peAddBtn').onclick = () => {
    const ids = parseIds(q('#peAddIds').value);
    if (!ids.length) return toast('请填歌曲 ID');
    guard(() => W('/playlist/track/add', { pid: id, ids: ids.join(',') }), `已添加 ${ids.length} 首`).catch(() => {});
  };
  q('#peDelBtn').onclick = () => {
    const ids = parseIds(q('#peDelIds').value);
    if (!ids.length) return toast('请填歌曲 ID');
    return confirmDialog({
      title: `从歌单移除 ${ids.length} 首？`, body: '',
      onOk: () => guard(() => W('/playlist/track/delete', { id, ids: ids.join(',') }), '已移除'),
    });
  };
  q('#peOrder').onclick = () => {
    if (currentIds.length < 2) return toast('当前顺序不可写（读不到曲目）');
    return confirmDialog({
      title: `把 ${currentIds.length} 首的当前顺序写回云端？`, body: '会覆盖网易云上的现有顺序。',
      onOk: () => guard(() => W('/playlist/order/update', { ids: currentIds.join(',') }), '顺序已保存'),
    });
  };
  q('#peTracksOp').onclick = () => promptDialog({
    title: '批量提交（op=add / del）', label: '格式：add|347230,186016', placeholder: 'add|347230',
    onOk: async v => {
      const [op, list] = String(v).split('|');
      const ids = parseIds(list);
      if (!['add', 'del'].includes(op) || !ids.length) return toast('格式：add|347230');
      await guard(() => W('/playlist/tracks', { op, pid: id, tracks: JSON.stringify(ids.map(x => ({ id: Number(x) }))) }), '已提交');
    },
  });

  // ---------------- 动态 ----------------
  const dyn = panelOf('dyn');
  dyn.innerHTML = '<div class="cm-pe-hint">加载中…</div>';
  function loadDyn() {
    const box = panelOf('dyn');
    Promise.allSettled([api.ncm('/playlist/detail/dynamic', { id }), api.ncm('/playlist/detail/rcmd/get', { id })]).then(([a, b]) => {
      const d = a.status === 'fulfilled' ? a.value : {};
      const rcmd = b.status === 'fulfilled' ? (b.value.data || []) : [];
      box.innerHTML = `
        <div class="cm-pe-kv">
          <div><span>播放量</span><b>${d.playCount ? fmtCount(d.playCount) : '—'}</b></div>
          <div><span>收藏</span><b>${d.subscribedCount ? fmtCount(d.subscribedCount) : '—'}</b></div>
          <div><span>评论</span><b>${d.commentCount ? fmtCount(d.commentCount) : '—'}</b></div>
          <div><span>分享</span><b>${d.shareCount ? fmtCount(d.shareCount) : '—'}</b></div>
        </div>
        <div class="cm-pe-acts"><mdui-button variant="tonal" id="pePlaycount">上报一次播放（/playlist/update/playcount）</mdui-button></div>
        <div class="cm-pe-hint">${(Array.isArray(rcmd) && rcmd.length) ? `推荐曲目 ${rcmd.length} 首` : '上游未返回相似歌单推荐'}</div>`;
      const btn = box.querySelector('#pePlaycount');
      if (btn) btn.onclick = () => guard(() => W('/playlist/update/playcount', { id }), '已上报').catch(() => {});
    });
  }

  // ---------------- 导入 ----------------
  const imp = panelOf('import');
  imp.innerHTML = `
    <div class="cm-pe-field"><label>导入链接（歌单/专辑/歌曲分享链接）</label><input id="peLink" placeholder="https://music.163.com/playlist?id=..."></div>
    <div class="cm-pe-field"><label>或粘贴文本（含链接的整段分享文案）</label><textarea id="peText" rows="3"></textarea></div>
    <div class="cm-pe-field"><label>新歌单名（可选）</label><input id="peImpName" placeholder="不填由上游决定"></div>
    <div class="cm-pe-acts"><mdui-button variant="filled" id="peImport">开始导入</mdui-button></div>
    <div id="peImportStatus" class="cm-pe-hint"></div>`;

  q('#peImport').onclick = () => {
    const link = q('#peLink').value.trim();
    const text = q('#peText').value.trim();
    if (!link && !text) return toast('请填链接或文本');
    const body = { link, text, playlistName: q('#peImpName').value.trim(), local: false, importStarPlaylist: false };
    guard(() => W('/playlist/import/name/task/create', body), '导入任务已创建')
      .then(r => {
        const taskId = r && (r.id || r.taskId || (r.data && (r.data.id || r.data.taskId)));
        if (!taskId) { q('#peImportStatus').textContent = '已提交，但上游未返回任务 ID'; return; }
        pollImport(taskId);
      }).catch(() => {});
  };

  function pollImport(taskId) {
    const box = q('#peImportStatus');
    let tries = 0;
    const tick = async () => {
      tries++;
      try {
        const d = await api.ncm('/playlist/import/task/status', { id: taskId });
        const st = d.status !== undefined ? d.status : (d.data && d.data.status);
        const pid = d.playlistId || d.pid || (d.data && d.data.playlistId);
        box.textContent = `任务 ${taskId}：状态 ${st === undefined ? '未知' : st}${pid ? ` · 新歌单 ${pid}` : ''}（第 ${tries} 次轮询）`;
        if (pid) { if (onChanged) onChanged(); return; }
        if (tries < 20) setTimeout(tick, 3000);
      } catch (e) {
        box.textContent = `轮询失败：${e.message}`;
      }
    };
    tick();
  }

  // ---------------- 订阅者 ----------------
  function subscribersDialog(pid) {
    const d2 = document.createElement('mdui-dialog');
    d2.headline = '订阅者';
    d2.innerHTML = '<div id="peSubsBox" class="cm-pe-list"><div class="cm-pe-hint">加载中…</div></div>';
    document.body.appendChild(d2);
    d2.open = true;
    api.ncm('/playlist/subscribers', { id: pid, limit: 50, offset: 0 }).then(r => {
      const users = r.subscribers || [];
      const box = d2.querySelector('#peSubsBox');
      box.innerHTML = users.length ? users.map(u => `
        <div class="cm-pe-row" ${u.userId ? `data-uid="${u.userId}"` : ''}>
          <span>${esc(u.nickname || '')} <i>${esc(u.signature || '')}</i></span>
        </div>`).join('') : '<div class="cm-pe-hint">暂无订阅者</div>';
      box.querySelectorAll('[data-uid]').forEach(x => {
        x.style.cursor = 'pointer';
        x.onclick = () => { d2.open = false; location.hash = `#/u/${x.dataset.uid}`; };
      });
    }).catch(e => {
      const box = d2.querySelector('#peSubsBox');
      if (box) box.textContent = `加载失败：${e.message}`;
    });
  }

  loadDynSummary();
}
