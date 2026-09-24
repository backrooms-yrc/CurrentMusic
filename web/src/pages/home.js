// 首页：每日推荐 + 猜你喜欢（登录后） + 最近播放（登录后）
import { api, auth } from '../api.js';
import { esc, renderSongList, skelCards, skelList } from '../ui.js';
import { player } from '../player.js';

export async function render(el) {
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  el.innerHTML = `
    <div class="cm-greet">
      <div class="cm-greet-date">${esc(today)}</div>
      <div class="cm-greet-title">${auth.user ? `你好，${esc(auth.user.nickname)}` : '今天想听点什么？'}</div>
    </div>
    <section class="cm-sec"><div class="cm-sec-head"><h2>每日推荐</h2></div>${skelCards(8)}</section>
    <section class="cm-sec">${skelList(3)}</section>`;
  let daily = [], forYou = [], recent = [], artists = [];
  const jobs = [api.daily().then(d => { daily = d.daily || []; forYou = d.forYou || []; artists = d.artists || []; }).catch(() => {})];
  if (auth.token) jobs.push(api.recentPlays(20).then(d => { recent = d.songs || []; }).catch(() => {}));
  await Promise.allSettled(jobs);

  el.innerHTML = `
    <div class="cm-greet">
      <div class="cm-greet-date">${esc(today)}</div>
      <div class="cm-greet-title">${auth.user ? `你好，${esc(auth.user.nickname)}` : '今天想听点什么？'}</div>
    </div>
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>每日推荐</h2><span class="cm-sec-more" id="playDaily"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
      ${daily.length ? `<div class="cm-hscroll" id="dailyRow">${
        daily.slice(0, 12).map((s, i) => `
          <div class="cm-card" data-i="${i}">
            <img src="${esc(s.pic)}" loading="lazy" onerror="this.classList.add('none')">
            <div class="cm-card-name">${esc(s.name)}</div>
            <div class="cm-card-sub">${esc(s.artists)}</div>
          </div>`).join('')
      }</div>` : `<div class="cm-empty small">今日推荐暂不可用</div>`}
    </section>
    ${forYou.length ? `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>猜你喜欢</h2><span class="cm-sec-sub">基于你点赞的歌手：${esc(artists.join('、'))}</span></div>
      <div id="forYouList"></div>
    </section>` : ''}
    ${recent.length ? `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>最近播放</h2><span class="cm-sec-more" id="playRecent"><span class="material-icons-outlined">play_circle</span> 播放全部</span></div>
      <div id="recentList"></div>
    </section>` : ''}
    ${!auth.token ? `
    <section class="cm-sec">
      <div class="cm-login-tip">
        <div>登录 CurrentMusic 账号，同步点赞、收藏与歌单</div>
        <mdui-button variant="filled" href="#/user">去登录</mdui-button>
      </div>
    </section>` : ''}
  `;

  const dailyRow = el.querySelector('#dailyRow');
  if (dailyRow) dailyRow.querySelectorAll('.cm-card').forEach(c => {
    c.onclick = () => player.playList(daily, +c.dataset.i);
  });
  el.querySelector('#playDaily')?.addEventListener('click', () => player.playList(daily, 0));
  el.querySelector('#playRecent')?.addEventListener('click', () => player.playList(recent, 0));

  if (forYou.length) {
    const box = el.querySelector('#forYouList');
    await renderSongList(box, forYou, { onPlay: i => player.playList(forYou, i) });
  }
  if (recent.length) {
    const box = el.querySelector('#recentList');
    await renderSongList(box, recent, { onPlay: i => player.playList(recent, i) });
  }
}
