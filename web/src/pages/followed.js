// 关注的歌手（独立页）：来自用户自己的网易云账号，可点击进入歌手主页
import { api, auth } from '../api.js';
import { esc, toast } from '../ui.js';

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-login-tip page">
      <span class="material-icons-outlined" style="font-size:44px">favorite</span>
      <div>登录后可查看你在网易云关注的歌手</div>
      <mdui-button variant="filled" href="#/user">去登录</mdui-button>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
  let d;
  try {
    d = await api.followedArtists(true);      // 进页面取最新（绕过缓存）
  } catch (e) {
    el.innerHTML = e.status === 400
      ? `<div class="cm-login-tip page">
           <span class="material-icons-outlined" style="font-size:44px">cloud_off</span>
           <div>关注歌手与你的网易云账号同步，需先绑定</div>
           <mdui-button variant="filled" href="#/user">去绑定网易云</mdui-button>
         </div>`
      : `<div class="cm-empty">${esc(e.message)}</div>`;
    return;
  }
  const list = d.artists || [];
  el.innerHTML = `
    <div class="cm-sec-head"><h2>关注的歌手</h2>
      <span class="cm-sec-sub">${d.count ?? list.length} 位 · 来自网易云</span></div>
    ${list.length ? `<div class="cm-artist-grid" id="faGrid">${list.map(a => `
      <div class="cm-artist-card" data-aid="${a.artist_id}">
        <div class="cm-artist-ava">${a.pic ? `<img src="${esc(a.pic)}?param=160y160" loading="lazy">` : '<span class="material-icons-outlined">person</span>'}</div>
        <div class="cm-artist-name">${esc(a.name || '歌手')}</div>
        ${a.alias ? `<div class="cm-artist-sub">${esc(a.alias)}</div>` : ''}
      </div>`).join('')}</div>`
      : `<div class="cm-empty">还没有关注的歌手<br><span class="cm-empty-sub">在歌手主页点「关注歌手」即可（与网易云同步）</span></div>`}
    ${d.hasMore ? `<div class="cm-sq-stats" style="margin-top:12px"><span class="material-icons-outlined">info</span>仅显示前 100 位（网易云接口限制）</div>` : ''}`;

  el.querySelectorAll('#faGrid .cm-artist-card').forEach(c => {
    c.onclick = () => { location.hash = `#/artist/${c.dataset.aid}`; };
  });
}
