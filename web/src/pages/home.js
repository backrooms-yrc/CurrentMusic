// 首页：每日推荐 + 排行榜 + 猜你喜欢（登录后） + 最近播放（登录后）
import { api, auth } from '../api.js';
import { esc, renderSongList, skelCards, skelList } from '../ui.js';
import { player } from '../player.js';

// 头像挂件更新横幅：仅在「已登录 + 听歌时长达标 + 尚未设置挂件」时出现，设好后自动消失
// （永久占位会打扰已设置的用户；未达标者由「我的」页设置行引导，首页不做催促）
async function decorBannerHTML() {
  if (!auth.token) return '';
  let me = null;
  try { me = await api.me(); } catch (e) { return ''; }        // 未登录/限流/断网都静默不显示
  if (!me || me.avatarDecoration || !me.decorUnlocked) return '';
  return `
    <a class="cm-decor-banner" href="#/user?decor=1">
      <span class="material-icons-outlined">face_retouching_natural</span>
      <span class="cm-decor-banner-t">
        <b>重大更新：听歌时长 2 小时及以上的用户现已支持设置动态头像挂件！</b>
        <span class="cm-decor-banner-sub">挂件会在个人主页、发现页等位置公开展示</span>
      </span>
      <span class="cm-decor-banner-go">点此设置<span class="material-icons-outlined">chevron_right</span></span>
    </a>`;
}

export async function render(el) {
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  el.innerHTML = `
    <div class="cm-greet">
      <div class="cm-greet-date">${esc(today)}</div>
      <div class="cm-greet-title">${auth.user ? `你好，${esc(auth.user.nickname)}` : '今天想听点什么？'}</div>
    </div>
    <div id="decorBanner"></div>
    <section class="cm-sec"><div class="cm-sec-head"><h2>每日推荐</h2></div>${skelCards(8)}</section>
    <section class="cm-sec">${skelList(3)}</section>`;
  // 横幅不阻塞首屏：与每日推荐并行请求；结果先存起来，整页重渲染后再插入
  let bannerHTML = '';
  const bannerJob = decorBannerHTML().then(html => { bannerHTML = html; }).catch(() => {});
  let daily = [], forYou = [], recent = [], artists = [];
  const jobs = [api.daily().then(d => { daily = d.daily || []; forYou = d.forYou || []; artists = d.artists || []; }).catch(() => {})];
  if (auth.token) jobs.push(api.recentPlays(20).then(d => { recent = d.songs || []; }).catch(() => {}));
  await Promise.allSettled(jobs);
  await bannerJob;   // 横幅请求通常更快，这里几乎立即返回

  el.innerHTML = `
    <div class="cm-greet">
      <div class="cm-greet-date">${esc(today)}</div>
      <div class="cm-greet-title">${auth.user ? `你好，${esc(auth.user.nickname)}` : '今天想听点什么？'}</div>
    </div>
    ${bannerHTML}
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
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>排行榜</h2></div>
      <div class="cm-quickrow">
        <a class="cm-quick" href="#/ncmpl/3778678"><span class="material-icons-outlined">local_fire_department</span><b>热歌榜</b></a>
        <a class="cm-quick" href="#/ncmpl/19723756"><span class="material-icons-outlined">trending_up</span><b>飙升榜</b></a>
        <a class="cm-quick" href="#/ncmpl/3779629"><span class="material-icons-outlined">star</span><b>新歌榜</b></a>
      </div>
    </section>
    ${forYou.length ? `
    <section class="cm-sec">
      <div class="cm-sec-head"><h2>一起听</h2><span class="cm-sec-more" id="goRooms"><span class="material-icons-outlined">groups</span> 房间广场</span></div>
      <div class="cm-quickrow">
        <a class="cm-quick" href="#/rooms"><span class="material-icons-outlined">meeting_room</span><b>加入房间</b><i>多人同步播放</i></a>
        <a class="cm-quick" id="quickCreateRoom"><span class="material-icons-outlined">add_circle</span><b>创建房间</b><i>可设密码</i></a>
      </div>
    </section>
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
  el.querySelector('#quickCreateRoom')?.addEventListener('click', () => {
    import('./rooms.js').then(m => m.createRoomDialog());   // 首页直达创建
  });
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
