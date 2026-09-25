// 公开用户主页：资料 + 统计（点赞/歌单/听歌天数/累计时长）+ 当前在听 + 最近听过 + TA 的歌单
import { api } from '../api.js';
import { esc, toast, avatarHTML } from '../ui.js';
import { player } from '../player.js';

const fmtListen = ms => {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
};
const fmtTime = ts => new Date(ts * 1000).toLocaleDateString('zh-CN');

export async function render(el, params) {
  const uid = params[0];
  el.innerHTML = `<div class="cm-loading"><mdui-circular-progress></mdui-circular-progress></div>`;
  let d;
  try {
    d = await api.userProfile(uid);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>`;
    return;
  }
  const u = d.user, st = d.stat;
  const songRow = (s, i, list) => `
    <div class="cm-song" data-i="${i}">
      <div class="cm-song-cover">${s.pic ? `<img src="${esc(s.pic)}" loading="lazy">` : '<span class="material-icons-outlined">music_note</span>'}</div>
      <div class="cm-song-main">
        <div class="cm-song-name">${esc(s.name)}</div>
        <div class="cm-song-sub">${esc(s.artists)}</div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="cm-up-head">
      <div class="cm-up-ava">${avatarHTML(u, 76)}</div>
      <div class="cm-up-info">
        <h2>${esc(u.nickname)}${u.isAdmin ? ' <span class="cm-tag admin">管理员</span>' : ''}</h2>
        <div class="cm-up-bio">${esc(u.bio || '这个人很懒，什么都没写')}</div>
        <div class="cm-up-sub">注册于 ${fmtTime(u.created_at)}</div>
      </div>
    </div>
    <div class="cm-up-stats">
      <div><b>${st.likes}</b><span>点赞</span></div>
      <div><b>${st.playlists}</b><span>歌单</span></div>
      <div><b>${st.playDays}</b><span>听歌天数</span></div>
      <div><b>${fmtListen(st.listenMs)}</b><span>累计时长</span></div>
    </div>
    ${d.current ? `
    <div class="cm-sec-head"><h2>当前在听</h2></div>
    <div class="cm-up-now">
      <span class="material-icons-outlined graphic_eq">graphic_eq</span>
      <div class="cm-up-now-main">
        <div class="cm-up-now-name">${esc(d.current.name)}</div>
        <div class="cm-up-now-sub">${esc(d.current.artists)}</div>
      </div>
      <mdui-button variant="tonal" compact id="nowPlay"><span class="material-icons-outlined">play_arrow</span>一起听</mdui-button>
    </div>` : ''}
    ${d.recent.length ? `
    <div class="cm-sec-head"><h2>最近听过</h2></div>
    <div id="upRecent">${d.recent.map((s, i) => songRow(s, i)).join('')}</div>` : ''}
    ${d.playlists.length ? `
    <div class="cm-sec-head"><h2>TA 的歌单</h2></div>
    <div class="cm-plgrid">
      ${d.playlists.map(p => `
        <div class="cm-plcard" data-id="${p.id}">
          <div class="cm-plcover">${p.cover ? `<img src="${esc(p.cover)}" loading="lazy">` : ''}<span class="material-icons-outlined">queue_music</span>${p.source === 'ncm' ? '<span class="cm-ncmbadge">网易云</span>' : ''}</div>
          <div class="cm-plname">${esc(p.name)}</div>
          <div class="cm-plsub">${p.track_count} 首</div>
        </div>`).join('')}
    </div>` : ''}
  `;

  if (d.current) {
    el.querySelector('#nowPlay').onclick = () => player.playList([d.current], 0);
  }
  el.querySelectorAll('#upRecent .cm-song').forEach(r => {
    r.onclick = () => player.playList(d.recent, +r.dataset.i);
  });
  el.querySelectorAll('.cm-plcard').forEach(c => {
    c.onclick = () => { location.hash = `#/pl/${c.dataset.id}`; };
  });
}
