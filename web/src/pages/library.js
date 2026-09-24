// 歌单库页：网易云同步歌单 + 我的歌单 + 我喜欢的/收藏（排行榜已移至首页）
import { mdui } from '../md.js';
import { api, auth } from '../api.js';
import { esc, toast, confirmDialog, promptDialog, skelGrid } from '../ui.js';

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:44px">library_music</span>
      <div>登录后即可创建歌单、收藏歌曲、同步网易云歌单</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button>
    </div>`;
    return;
  }

  el.innerHTML = skelGrid(6);
  let me = null, pls = [], bind = { bound: false };
  const jobs = [
    api.me().then(d => { me = d; }).catch(() => {}),
    api.myPlaylists().then(d => { pls = d.playlists || []; }).catch(() => {}),
    api.bindStatus().then(d => { bind = d; }).catch(() => {}),
  ];
  await Promise.allSettled(jobs);

  const ncmPls = pls.filter(p => p.source === 'ncm');
  const localPls = pls.filter(p => p.source !== 'ncm');
  const coverHTML = p => p.cover
    ? `<img src="${esc(p.cover)}" loading="lazy" onerror="this.remove()"><span class="material-icons-outlined">queue_music</span>`
    : `<span class="material-icons-outlined">queue_music</span>`;

  el.innerHTML = `
    <div class="cm-quickrow">
      <a class="cm-quick" href="#/pl/likes"><span class="material-icons-outlined">favorite</span><b>CurrentMusic·我喜欢</b><i>${me ? me.stat.likes : 0} 首</i></a>
      ${bind.bound && bind.ncmLikedPlId
        ? `<a class="cm-quick" href="#/pl/${bind.ncmLikedPlId}"><span class="material-icons-outlined">cloud_done</span><b>网易云·我喜欢</b><i>红心歌单</i></a>`
        : ''}
    </div>

    ${ncmPls.length || bind.bound ? `
    <div class="cm-sec-head"><h2>网易云同步</h2>
      <span class="cm-sec-more" id="syncNcm"><span class="material-icons-outlined">sync</span> ${bind.lastSync ? '重新同步' : '立即同步'}</span></div>
    <div class="cm-plgrid" id="ncmGrid">
      ${ncmPls.map(p => `
        <div class="cm-plcard" data-id="${p.id}">
          <div class="cm-plcover">${coverHTML(p)}<span class="cm-ncmbadge">网易云</span></div>
          <div class="cm-plname">${esc(p.name)}</div>
          <div class="cm-plsub">${p.track_count} 首</div>
        </div>`).join('') || `<div class="cm-empty small">${bind.stale ? '绑定已失效，请到「我的」页重新扫码绑定' : '还没有同步到歌单，点右上角立即同步'}</div>`}
    </div>` : `
    <div class="cm-bindbanner" id="bindBanner">
      <span class="material-icons-outlined">cloud_sync</span>
      <div class="cm-bindbanner-t"><b>绑定网易云音乐，自动同步全部歌单</b><span>扫码授权即可，随时可解绑</span></div>
      <mdui-button variant="tonal" compact id="goBind">去绑定</mdui-button>
    </div>`}

    <div class="cm-sec-head"><h2>我的歌单</h2>
      <span class="cm-sec-more" id="newPl"><span class="material-icons-outlined">add</span> 新建</span></div>
    <div class="cm-plgrid" id="plGrid">
      ${localPls.map(p => `
        <div class="cm-plcard" data-id="${p.id}">
          <div class="cm-plcover">${coverHTML(p)}</div>
          <div class="cm-plname">${esc(p.name)}</div>
          <div class="cm-plsub">${p.track_count} 首</div>
          <div class="cm-plmenu" data-id="${p.id}"><span class="material-icons-outlined">more_vert</span></div>
        </div>`).join('') || `<div class="cm-empty small">还没有歌单，点右上角新建</div>`}
    </div>

`;

  el.querySelector('#syncNcm')?.addEventListener('click', () => {
    if (!bind.bound) { toast('请先到「我的」页扫码绑定网易云账号'); return; }
    el.querySelector('#syncNcm').innerHTML = '<mdui-linear-progress style="width:90px"></mdui-linear-progress> 同步中…';
    import('../ncmbind.js').then(m => m.runSync(el, () => render(el)));
  });
  el.querySelector('#goBind')?.addEventListener('click', () => {
    import('../ncmbind.js').then(m => m.bindDialog(() => render(el)));
  });

  el.querySelector('#newPl').onclick = () => {
    promptDialog({
      title: '新建歌单', label: '歌单名称', placeholder: '给歌单起个名字',
      onOk: async name => { await api.createPlaylist(name, ''); toast('歌单已创建'); render(el); },
    });
  };
  el.querySelectorAll('.cm-plcard').forEach(c => {
    c.onclick = e => { if (!e.target.closest('.cm-plmenu')) location.hash = `#/pl/${c.dataset.id}`; };
  });
  el.querySelectorAll('.cm-plmenu').forEach(m => {
    m.onclick = e => {
      e.stopPropagation();
      const pid = +m.dataset.id;
      const pl = localPls.find(p => p.id === pid);
      if (!pl) return;
      mdui.dialog({
        headline: pl.name,
        body: `<div class="cm-qm">
          <div class="cm-qm-item" id="mRename"><span class="material-icons-outlined">edit</span> 重命名</div>
          <div class="cm-qm-item" id="mDel"><span class="material-icons-outlined">delete</span> 删除歌单</div>
        </div>`,
        actions: [{ text: '取消' }],
      });
      setTimeout(() => {
        document.getElementById('mRename').onclick = () => {
          document.querySelectorAll('mdui-dialog').forEach(d => d.open = false);
          promptDialog({
            title: '重命名歌单', label: '新名称', value: pl.name,
            onOk: async name => { await api.updatePlaylist(pid, { name }); toast('已重命名'); render(el); },
          });
        };
        document.getElementById('mDel').onclick = () => {
          document.querySelectorAll('mdui-dialog').forEach(d => d.open = false);
          confirmDialog({
            title: `删除歌单「${pl.name}」？`, body: '删除后不可恢复。',
            onOk: async () => { await api.deletePlaylist(pid); toast('已删除'); render(el); },
          });
        };
      }, 0);
    };
  });
}
