// 管理员面板：概览 / 用户 / 公告 / 设备 / 系统（仅管理员可用）
//
// 这页的数据量小但区块多，旧实现每次搜索/分页/操作都 render(el) 整页重画：
// 输入框失焦、TAB 位置丢失、图表闪一下白屏。现在页面只渲染一次外壳，
// 各 TAB 各自懒加载、各自局部刷新；用户搜索回车触发，只更新列表与分页。
import { mdui } from '../md.js';
import { api, auth, settings } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import { esc, toast, confirmDialog, promptDialog, userTags, fmtCount, avatarHTML } from '../ui.js';
import { drawLineChart, drawBarChart, drawComboChart, drawDonutChart } from '../admin-charts.js';

const PAGE = 20;
let query = '', offset = 0, userSort = 'reg';   // 跨页面停留保留搜索/排序；搜索/翻页只改列表
const ADMIN_USER_SORTS = [
  { k: 'reg', label: '注册最新' },
  { k: 'reg_asc', label: '注册最早' },
  { k: 'name', label: '昵称' },
  { k: 'active', label: '最近活跃' },
  { k: 'sessions', label: '在线设备' },
  { k: 'likes', label: '点赞数' },
  { k: 'plays', label: '播放数' },
  { k: 'role', label: '角色' },
];

const TABS = [
  { k: 'overview', label: '概览', icon: 'dashboard' },
  { k: 'users', label: '用户', icon: 'people' },
  { k: 'announcements', label: '公告', icon: 'campaign' },
  { k: 'devices', label: '设备', icon: 'devices' },
  { k: 'clients', label: '客户端', icon: 'phone_android' },
  { k: 'system', label: '系统', icon: 'settings' },
];
const TAB_DESC = {
  overview: '站点运营总览、流量与趋势',
  users: '搜索、分页与账号操作',
  announcements: '发布与维护客户端弹窗公告',
  devices: '全部在线设备与强制下线',
  clients: 'CurrentMusic 与 CurrentMusicX 版本与更新说明',
  system: '数据量、角色与缓存维护',
};
const ROLE_COLORS = ['#6750a4', '#0088cc', '#ff8d28', '#8e8e93'];

const fmtTime = ts => {
  if (!ts) return '—';
  const d = new Date(ts * 1000), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 120) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (d.toDateString() === now.toDateString()) return '今天 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtDay = value => {
  // 服务端日序列带 day='YYYY-MM-DD'（服务器本地时区）；直接用日期串，
  // 避免管理员在别的时区打开时把「10/31」渲染成 10/30。
  if (typeof value === 'string') {
    const [, m, d] = value.split('-');
    return `${Number(m)}/${Number(d)}`;
  }
  const d = new Date(value * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtHour = ts => {
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
};
const fmtStamp = ts => {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtIso = iso => {
  const t = Date.parse(iso || '');
  return t ? fmtTime(Math.floor(t / 1000)) : (iso || '—');
};
const fmtBytes = n => {
  if (!isFinite(n)) return '—';
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return Math.round(n) + ' B';
};
const fmtAxisBytes = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'G'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + 'M'
  : n >= 1024 ? Math.round(n / 1024) + 'K' : String(Math.round(n));
const fmtRate = bps => bps >= 1048576 ? (bps / 1048576).toFixed(2) + ' MB/s'
  : bps >= 1024 ? (bps / 1024).toFixed(1) + ' KB/s' : Math.round(bps) + ' B/s';

const card = (label, value, sub = '') => `
  <div class="cm-acard"><div class="cm-acard-v">${value}</div><div class="cm-acard-l">${label}</div>${sub ? `<div class="cm-acard-s">${sub}</div>` : ''}</div>`;

const sk = (style = '') => `<div class="sk" style="${style}"></div>`;
const cardSkeleton = () => Array.from({ length: 8 }, () => `
  <div class="cm-acard cm-askel-card">${sk('height:26px;width:52%')}${sk('height:11px;width:70%;margin-top:10px')}${sk('height:10px;width:45%;margin-top:7px')}</div>`).join('');
const trafficCardsSkeleton = () => Array.from({ length: 4 }, () => `
  <div class="cm-acard cm-askel-card">${sk('height:24px;width:58%')}${sk('height:11px;width:66%;margin-top:10px')}</div>`).join('');
const userSkeleton = (n = 6) => `<div class="cm-ulist">${Array.from({ length: n }, () => `
  <div class="cm-urow">${sk('width:40px;height:40px;border-radius:50%;flex:none')}
    <div class="cm-umain">${sk('height:14px;width:36%')}${sk('height:11px;width:65%;margin-top:8px')}${sk('height:10px;width:52%;margin-top:6px')}</div>
  </div>`).join('')}</div>`;
const rowSkeleton = (n = 4) => `<div class="cm-ulist">${Array.from({ length: n }, () => `
  <div class="cm-urow">${sk('width:34px;height:34px;border-radius:50%;flex:none')}
    <div class="cm-umain">${sk('height:13px;width:42%')}${sk('height:10px;width:58%;margin-top:8px')}</div>
  </div>`).join('')}</div>`;

const clientsSkeleton = () => `
  <div class="cm-client-grid">
    ${Array.from({ length: 2 }, () => `<div class="cm-acard cm-client-card">
      ${sk('height:18px;width:38%')}${sk('height:13px;width:62%;margin-top:12px')}
      <div class="cm-client-kv">${Array.from({ length: 4 }, () => sk('height:36px;width:100%')).join('')}</div>
    </div>`).join('')}
  </div>
  <div class="cm-acard cm-achart" style="margin-top:12px">${sk('height:17px;width:34%')}<div class="sk cm-chart-skel"></div></div>`;

const overviewSkeleton = () => `
  <div class="cm-agrid">${cardSkeleton()}</div>
  <div class="cm-achart-grid">
    <div class="cm-acard cm-achart cm-awide">
      ${sk('height:18px;width:32%')}
      <div class="cm-agrid" style="margin-top:12px">${trafficCardsSkeleton()}</div>
      <div class="sk cm-chart-skel"></div>
    </div>
    ${Array.from({ length: 4 }, () => `<div class="cm-acard cm-achart">${sk('height:17px;width:42%')}<div class="sk cm-chart-skel"></div></div>`).join('')}
  </div>`;

const topSkeleton = () => `<div class="cm-hbars">${Array.from({ length: 4 }, () => `
  <div class="cm-hbar">${sk('height:12px;width:58%')}${sk('height:6px;width:100%;margin-top:7px')}</div>`).join('')}</div>`;

const hBars = (items, { value, label, format } = {}) => {
  const vals = items.map(x => Number(value(x)) || 0);
  const max = Math.max(1, ...vals);
  return `<div class="cm-hbars">${items.map(it => {
    const v = Number(value(it)) || 0;
    return `<div class="cm-hbar">
      <div class="cm-hbar-top"><span class="cm-hbar-label" title="${esc(label(it))}">${esc(label(it))}</span><b>${esc(format(v))}</b></div>
      <div class="cm-hbar-track"><i style="width:${Math.max(v ? 2 : 0, v / max * 100).toFixed(1)}%"></i></div>
    </div>`;
  }).join('')}</div>`;
};

export async function render(el) {
  if (!auth.token) {
    el.innerHTML = `<div class="cm-empty">请先登录</div>`;
    return;
  }

  const S = {
    tab: 'overview',
    ov: null, users: null, sessions: null, ann: null, traffic: null, clients: null,
    trafficRange: 'day', trafficAt: 0, trafficLoading: false,
    usersSeq: 0, annSeq: 0, devSeq: 0, clientsSeq: 0, ovLoading: false,
  };

  el.innerHTML = `
    <div class="cm-admin">
      <div class="cm-admin-head">
        <div>
          <div class="cm-admin-title">管理员面板</div>
          <div class="cm-admin-sub" id="adminSub">${TAB_DESC.overview}</div>
        </div>
        <mdui-button variant="tonal" id="adminRefresh"><span class="material-icons-outlined">refresh</span>刷新</mdui-button>
      </div>
      <div class="cm-atabs" id="adminTabs" role="tablist">
        ${TABS.map(t => `<button class="cm-atab${t.k === 'overview' ? ' on' : ''}" data-tab="${t.k}" role="tab"
          aria-selected="${t.k === 'overview' ? 'true' : 'false'}">
          <span class="material-icons-outlined">${t.icon}</span><span>${t.label}</span>
          <span class="cm-atab-b" id="badge-${t.k}" hidden></span>
        </button>`).join('')}
      </div>

      <section class="cm-apane" data-pane="overview" id="pane-overview">
        <div id="ovBody">${overviewSkeleton()}</div>
      </section>

      <section class="cm-apane" data-pane="users" id="pane-users" hidden>
        <div class="cm-sec-head"><h2>用户管理</h2><span class="cm-usub" id="userTotal"></span></div>
        <div class="cm-adminbar cm-ausearch">
          <mdui-text-field id="uq" label="搜索 用户名 / 昵称 / 邮箱 / 手机号" variant="outlined" clearable
            enterkeyhint="search" value="${esc(query)}" style="flex:1"></mdui-text-field>
          <mdui-button variant="filled" id="usearch"><span class="material-icons-outlined">search</span>搜索</mdui-button>
        </div>
        <div class="cm-usearch-hint">按回车或点「搜索」；只更新下方列表，不会刷新整个页面。</div>
        <div class="cm-plsort cm-asort" id="userSort">
          <span class="cm-plsort-l"><span class="material-icons-outlined">sort</span>排序</span>
          ${ADMIN_USER_SORTS.map(x => `<mdui-chip ${x.k === userSort ? 'selected' : ''} data-k="${x.k}">${x.label}</mdui-chip>`).join('')}
        </div>
        <div id="userList">${userSkeleton()}</div>
        <div class="cm-pager" id="userPager"></div>
      </section>

      <section class="cm-apane" data-pane="announcements" id="pane-announcements" hidden>
        <div class="cm-sec-head"><h2>弹窗公告</h2><span class="cm-usub" id="annCount"></span>
          <span class="cm-sec-more" id="annNew"><span class="material-icons-outlined">campaign</span>发布公告</span></div>
        <div class="cm-annrow-wrap" id="annList">${rowSkeleton(4)}</div>
      </section>

      <section class="cm-apane" data-pane="devices" id="pane-devices" hidden>
        <div class="cm-sec-head"><h2>在线设备（全部）</h2><span class="cm-usub" id="devCount"></span></div>
        <div class="cm-devlist" id="devAll">${rowSkeleton(5)}</div>
      </section>

      <section class="cm-apane" data-pane="clients" id="pane-clients" hidden>
        <div id="clientsBody">${clientsSkeleton()}</div>
      </section>

      <section class="cm-apane" data-pane="system" id="pane-system" hidden>
        <div id="systemBody"></div>
      </section>
    </div>`;

  // ---------- 通用 ----------
  const setBadge = (k, v) => {
    const b = el.querySelector('#badge-' + k);
    if (!b) return;
    const text = v == null || v === '' ? '' : String(v);
    b.textContent = text;
    b.hidden = !text;
  };
  // 滑动选中胶囊：按钮宽度随徽标变化，几何每次重新量，不做固定下标动画
  const tabsEl = el.querySelector('#adminTabs');
  const tabInd = document.createElement('span');
  tabInd.className = 'cm-atab-ind';
  tabInd.setAttribute('aria-hidden', 'true');
  tabsEl.appendChild(tabInd);
  tabsEl.classList.add('has-indicator');
  const moveTabIndicator = (animate = true) => {
    const on = tabsEl.querySelector('.cm-atab.on');
    if (!on) return;
    const r = on.getBoundingClientRect();
    const tr = tabsEl.getBoundingClientRect();
    tabInd.style.width = r.width + 'px';
    tabInd.style.height = r.height + 'px';
    tabInd.style.top = (r.top - tr.top + tabsEl.scrollTop) + 'px';
    tabInd.style.transform = `translateX(${r.left - tr.left + tabsEl.scrollLeft}px)`;
    if (!animate) {
      tabsEl.classList.remove('ready');
      requestAnimationFrame(() => tabsEl.classList.add('ready'));
    }
  };
  moveTabIndicator(false);

  const setTab = k => {
    const prev = S.tab;
    if (k === prev) return;
    const from = TABS.findIndex(t => t.k === prev);
    const to = TABS.findIndex(t => t.k === k);
    S.tab = k;
    el.querySelectorAll('.cm-atab').forEach(b => {
      const on = b.dataset.tab === k;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    el.querySelectorAll('.cm-apane').forEach(p => { p.hidden = p.dataset.pane !== k; });
    const sub = el.querySelector('#adminSub');
    if (sub) sub.textContent = TAB_DESC[k] || '';
    moveTabIndicator();
    // TAB 内容过渡：方向跟随页签索引，进入时淡入 + 轻微横移；旧动画类在
    // 下一次切换前清掉，避免连续快速点击被上一轮 timer 拆掉。
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scroller = document.getElementById('out');
    if (scroller && scroller.scrollTop > 0) {
      scroller.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    }
    const pane = el.querySelector(`.cm-apane[data-pane="${k}"]`);
    if (pane && !reduceMotion) {
      clearTimeout(pane._cmAnimTimer);
      pane.classList.remove('cm-tabpane', 'in-right', 'in-left');
      void pane.offsetWidth;
      pane.classList.add('cm-tabpane', to >= from ? 'in-right' : 'in-left');
      pane._cmAnimTimer = setTimeout(() => {
        pane.classList.remove('cm-tabpane', 'in-right', 'in-left');
      }, 300);
    }
    if (k === 'overview') {
      const draw = () => {
        if (!el.isConnected) return;
        requestAnimationFrame(drawOverviewCharts);
        if (S.traffic) requestAnimationFrame(drawTrafficChart);
        else loadTraffic();
      };
      if (!S.ov) loadOverview().then(ok => { if (ok) draw(); });
      else draw();
    } else if (k === 'users' && !S.users) loadUsers();
    else if (k === 'announcements' && !S.ann) loadAnn();
    else if (k === 'devices' && !S.sessions) loadDevices();
    else if (k === 'clients') {
      if (!S.clients) loadClients();
      else requestAnimationFrame(drawClientsChart);
    }
    else if (k === 'system') renderSystem();
  };
  el.querySelectorAll('.cm-atab').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });

  // ---------- 概览 ----------
  async function loadOverview() {
    if (S.ovLoading) return false;
    S.ovLoading = true;
    try {
      const ov = await api.adminOverview();
      if (!el.isConnected) return false;
      S.ov = ov;
      renderOverview();
      updateBadges();
      if (S.tab === 'system') renderSystem();
      return true;
    } catch (e) {
      if (!el.isConnected) return false;
      if (!S.ov) {
        const box = el.querySelector('#ovBody');
        if (e.status === 403) {
          el.innerHTML = `<div class="cm-empty">${esc(e.message)}（当前账号不是管理员）</div>`;
        } else if (box) {
          box.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>`;
        }
      } else if (!/请求过于频繁/.test(e.message || '')) {
        toast('概览刷新失败：' + e.message);
      }
      return false;
    } finally {
      S.ovLoading = false;
    }
  }

  function renderOverview() {
    const ov = S.ov;
    const box = el.querySelector('#ovBody');
    if (!ov || !box) return;
    const role = ov.roleCounts || {};
    const growthTotal = (ov.userDaily || []).reduce((s, x) => s + (x.count || 0), 0);
    const playTotal = (ov.playDaily || []).reduce((s, x) => s + (x.plays || 0), 0);
    const playHours = ((ov.playDaily || []).reduce((s, x) => s + (x.ms || 0), 0) / 3600000).toFixed(1);
    const content = [
      { label: '站内点赞', value: ov.likes || 0 },
      { label: '网易云红心', value: ov.ncmLikes || 0 },
      { label: '自建歌单', value: ov.playlists || 0 },
      { label: '歌单曲目', value: ov.tracks || 0 },
      { label: '播放记录', value: ov.plays || 0 },
      { label: '网易云绑定', value: ov.bindings || 0 },
      { label: '歌曲缓存', value: ov.songs || 0 },
      { label: '缓存条目', value: ov.cache || 0 },
    ];
    box.innerHTML = `
      <div class="cm-agrid">
        ${card('注册用户', fmtCount(ov.users), `今日 +${ov.usersToday} · 7日 +${ov.usersWeek}`)}
        ${card('在线设备', fmtCount(ov.sessions), `1 小时内活跃 ${ov.onlineUsers} 人`)}
        ${card('总点赞数', fmtCount((ov.likes || 0) + (ov.ncmLikes || 0)),
          `站内 ${fmtCount(ov.likes || 0)} · 网易云 ${fmtCount(ov.ncmLikes || 0)}`)}
        ${card('播放记录', fmtCount(ov.plays), `歌单 ${fmtCount(ov.playlists)} · 曲目 ${fmtCount(ov.tracks)}`)}
        ${card('禁用账号', fmtCount(ov.disabled), `站长 ${role.owner || 0} · 超管 ${role.super || 0} · 管理员 ${role.admin || 0}`)}
        ${card('网易云绑定', fmtCount(ov.bindings), `歌曲缓存 ${fmtCount(ov.songs)} 首`)}
        ${card('缓存条目', fmtCount(ov.cache), '歌词 / 评论 / 详情等')}
        ${card('当前版本', ov.release ? 'v' + esc(ov.release.version) : '—',
          ov.release ? '发布于 ' + fmtTime(ov.release.publishedAt) : '暂无发布记录')}
      </div>

      <div class="cm-achart-grid">
        <div class="cm-acard cm-achart cm-awide" id="trafficPanel">
          <div class="cm-achart-head">
            <div>
              <div class="cm-achart-title">站点出站流量</div>
              <div class="cm-achart-sub" id="trafficLive">加载中…</div>
            </div>
            <div class="cm-aseg" id="trafficRange" role="group" aria-label="流量时间范围">
              <button type="button" data-range="hour">近48小时</button>
              <button type="button" data-range="day" class="on">近30天</button>
            </div>
          </div>
          <div class="cm-agrid" id="trafficCards">${trafficCardsSkeleton()}</div>
          <div class="cm-chart-wrap">
            <div class="sk cm-chart-skel" id="trafficSkel"></div>
            <canvas id="trafficChart" class="cm-chart-canvas" hidden aria-label="站点出站流量趋势图"></canvas>
          </div>
          <div class="cm-achart-head cm-achart-head-sub">
            <div class="cm-achart-title">今日消耗 Top 路径</div>
            <div class="cm-achart-sub" id="trafficTopNote"></div>
          </div>
          <div id="trafficTop">${topSkeleton()}</div>
        </div>

        <div class="cm-acard cm-achart">
          <div class="cm-achart-head">
            <div><div class="cm-achart-title">用户增长</div><div class="cm-achart-sub">近 30 天新增 · 合计 ${growthTotal} 人</div></div>
          </div>
          <div class="cm-chart-wrap"><canvas id="growthChart" class="cm-chart-canvas" aria-label="近30天用户增长柱状图"></canvas></div>
        </div>

        <div class="cm-acard cm-achart">
          <div class="cm-achart-head">
            <div><div class="cm-achart-title">播放活跃</div><div class="cm-achart-sub">近 14 天 · ${fmtCount(playTotal)} 次 · 收听 ${playHours} 小时</div></div>
            <div class="cm-legend">
              <span class="cm-legend-item"><i class="cm-legend-dot" style="background:var(--cm-primary)"></i>播放次数</span>
              <span class="cm-legend-item"><i class="cm-legend-dot" style="background:#ff8d28"></i>活跃用户</span>
            </div>
          </div>
          <div class="cm-chart-wrap"><canvas id="playChart" class="cm-chart-canvas" aria-label="近14天播放与活跃用户组合图"></canvas></div>
        </div>

        <div class="cm-acard cm-achart">
          <div class="cm-achart-head"><div><div class="cm-achart-title">角色构成</div><div class="cm-achart-sub">站长 > 超管 > 管理员 > 普通用户</div></div></div>
          <div class="cm-role-wrap">
            <div class="cm-chart-wrap cm-donut-wrap"><canvas id="roleChart" class="cm-chart-canvas cm-donut-canvas" aria-label="账号角色构成环图"></canvas></div>
            <div class="cm-legend cm-legend-col" id="roleLegend">
              ${[['站长', role.owner || 0], ['超级管理员', role.super || 0], ['管理员', role.admin || 0], ['普通用户', role.user || 0]]
                .map(([n, v], i) => `<span class="cm-legend-item"><i class="cm-legend-dot" style="background:${ROLE_COLORS[i]}"></i>${n}<b>${fmtCount(v)}</b></span>`).join('')}
            </div>
          </div>
        </div>

        <div class="cm-acard cm-achart">
          <div class="cm-achart-head"><div><div class="cm-achart-title">内容与互动</div><div class="cm-achart-sub">站内数据量对比</div></div></div>
          ${hBars(content, { value: x => x.value, label: x => x.label, format: fmtCount })}
        </div>
      </div>`;

    bindTrafficControls();
    if (S.traffic) renderTrafficPanel();
    if (S.tab === 'overview') requestAnimationFrame(drawOverviewCharts);
  }

  function drawOverviewCharts() {
    if (S.tab !== 'overview' || !S.ov) return;
    const growth = el.querySelector('#growthChart');
    if (growth && growth.clientWidth) {
      drawBarChart(growth, S.ov.userDaily || [], {
        value: p => p.count,
        label: p => fmtDay(p.day),
        format: n => `${n} 人`,
        axisFormat: n => String(Math.round(n)),
      });
    }
    const play = el.querySelector('#playChart');
    if (play && play.clientWidth) {
      drawComboChart(play, S.ov.playDaily || [], {
        barValue: p => p.plays,
        lineValue: p => p.users,
        label: p => fmtDay(p.day),
        barFormat: n => `${fmtCount(n)} 次`,
        lineFormat: n => `${fmtCount(Math.round(n))} 人`,
        axisFormat: n => fmtCount(Math.round(n)),
      });
    }
    const role = el.querySelector('#roleChart');
    if (role && role.clientWidth) {
      const r = S.ov.roleCounts || {};
      drawDonutChart(role, [
        { label: '站长', value: r.owner || 0, color: ROLE_COLORS[0] },
        { label: '超级管理员', value: r.super || 0, color: ROLE_COLORS[1] },
        { label: '管理员', value: r.admin || 0, color: ROLE_COLORS[2] },
        { label: '普通用户', value: r.user || 0, color: ROLE_COLORS[3] },
      ], { centerLabel: '个账号' });
    }
  }

  // ---------- 流量 ----------
  function paintTrafficRange() {
    el.querySelectorAll('#trafficRange button').forEach(b => {
      b.classList.toggle('on', b.dataset.range === S.trafficRange);
    });
  }
  function bindTrafficControls() {
    paintTrafficRange();
    el.querySelectorAll('#trafficRange button').forEach(b => {
      b.onclick = () => {
        S.trafficRange = b.dataset.range;
        paintTrafficRange();
        drawTrafficChart();
      };
    });
  }
  function drawTrafficChart() {
    const canvas = el.querySelector('#trafficChart');
    if (!canvas || !S.traffic || !S.traffic.available || !canvas.clientWidth) return;
    const range = S.trafficRange;
    const points = (range === 'hour' ? S.traffic.hourly : S.traffic.daily) || [];
    drawLineChart(canvas, points, {
      value: p => p.bytes,
      label: p => range === 'hour' ? fmtHour(p.t) : fmtDay(p.t),
      format: fmtBytes,
      axisFormat: fmtAxisBytes,
      tipTitle: p => `${range === 'hour' ? '小时' : '日期'} ${range === 'hour' ? fmtHour(p.t) : fmtDay(p.t)}`,
    });
  }
  async function loadTraffic({ silent = false } = {}) {
    if (S.trafficLoading) return;
    S.trafficLoading = true;
    const live = el.querySelector('#trafficLive');
    if (!silent && S.traffic && live) live.textContent = '刷新中…';
    try {
      const d = await api.adminTraffic();
      if (!el.isConnected) return;
      S.traffic = d;
      S.trafficAt = Date.now();
      renderTrafficPanel();
    } catch (e) {
      if (!el.isConnected) return;
      if (!S.traffic) {
        S.traffic = { available: false, error: e.message };
        renderTrafficPanel();
      } else {
        renderTrafficPanel();          // 恢复旧数据的「更新于 …」文案
        if (!silent) toast('流量刷新失败：' + e.message);
      }
    } finally {
      S.trafficLoading = false;
    }
  }
  function renderTrafficPanel() {
    const panel = el.querySelector('#trafficPanel');
    if (!panel || !S.traffic) return;
    const d = S.traffic;
    const cards = panel.querySelector('#trafficCards');
    const canvas = panel.querySelector('#trafficChart');
    const skel = panel.querySelector('#trafficSkel');
    const top = panel.querySelector('#trafficTop');
    const live = panel.querySelector('#trafficLive');
    const note = panel.querySelector('#trafficTopNote');
    if (!d.available) {
      if (cards) cards.innerHTML = `<div class="cm-acard cm-awide"><div class="cm-acard-l">流量统计不可用</div>
        <div class="cm-acard-s">${esc(d.error || '需在部署环境变量 CM_TRAFFIC_LOG 指向 nginx 访问日志后重启后端')}</div></div>`;
      if (skel) skel.hidden = true;
      if (canvas) canvas.hidden = true;
      if (top) top.innerHTML = '';
      if (live) live.textContent = '未配置访问日志';
      if (note) note.textContent = '';
      return;
    }
    const topItem = (d.top || [])[0];
    if (cards) cards.innerHTML = `
      ${card('今日出站', fmtBytes(d.today || 0), '今日 00:00 起')}
      ${card('本月出站', fmtBytes(d.month || 0), '本月累计')}
      ${card('实时速率', fmtRate(d.rate5m || 0), '近 5 分钟均值')}
      ${card('今日最大路径', topItem ? fmtBytes(topItem.bytes) : '—', topItem ? esc(topItem.path) : '暂无记录')}`;
    if (skel) skel.hidden = true;
    if (canvas) canvas.hidden = false;
    if (live) live.textContent = `实时 ${fmtRate(d.rate5m || 0)} · 更新于 ${fmtTime(d.generatedAt)}`;
    if (top) {
      top.innerHTML = (d.top || []).length
        ? hBars(d.top, { value: x => x.bytes, label: x => x.path, format: fmtBytes })
        : '<div class="cm-empty small">今日暂无出站记录</div>';
    }
    if (note) note.textContent = (d.top || []).length ? `按出站字节排序 · Top ${(d.top || []).length}` : '';
    paintTrafficRange();
    drawTrafficChart();
  }

  function updateBadges() {
    setBadge('users', S.ov ? S.ov.users : (S.users ? S.users.total : null));
    setBadge('devices', S.ov ? S.ov.sessions : (S.sessions ? S.sessions.length : null));
    if (S.ann) setBadge('announcements', (S.ann.items || []).filter(a => !a.removed).length);
    moveTabIndicator(false);
  }

  // ---------- 用户 ----------
  async function loadUsers({ silent = false } = {}) {
    const box = el.querySelector('#userList');
    if (!box) return;
    if (!silent) {
      box.innerHTML = userSkeleton();
      const pager = el.querySelector('#userPager');
      if (pager) pager.innerHTML = '';
    }
    const seq = ++S.usersSeq;
    try {
      const d = await api.adminUsers(query, offset, PAGE, userSort);
      if (seq !== S.usersSeq || !el.isConnected) return;
      if (offset > 0 && !(d.users || []).length && d.total > 0) {
        offset = Math.max(0, Math.floor((d.total - 1) / PAGE) * PAGE);
        return loadUsers({ silent });
      }
      S.users = d;
      renderUsers();
      updateBadges();
    } catch (e) {
      if (seq !== S.usersSeq || !el.isConnected) return;
      box.innerHTML = `<div class="cm-empty small">用户加载失败：${esc(e.message)}</div>`;
      const pager = el.querySelector('#userPager');
      if (pager) pager.innerHTML = '';
    }
  }
  function renderUsers() {
    const d = S.users;
    if (!d) return;
    const total = d.total || 0;
    const totalEl = el.querySelector('#userTotal');
    if (totalEl) totalEl.textContent = total ? `共 ${fmtCount(total)} 位` : '无匹配用户';
    const list = el.querySelector('#userList');
    if (!list) return;
    list.innerHTML = (d.users || []).length ? (d.users || []).map(u => `
      <div class="cm-urow" data-id="${u.id}">
        <div class="cm-uava">${avatarHTML(u, 40)}</div>
        <div class="cm-umain">
          <div class="cm-uname">${esc(u.nickname || u.username)}${userTags(u)}
            ${u.disabled ? '<span class="cm-tag banned">已禁用</span>' : ''}
            ${u.username === '__internal__' ? '<span class="cm-tag">内部账户</span>' : ''}
          </div>
          <div class="cm-usub">@${esc(u.username)}${u.email ? ' · ' + esc(u.email) : ''}${u.phone ? ' · ' + esc(u.phone) : ''} · 注册于 ${fmtTime(u.created_at)}</div>
          <div class="cm-usub">赞 ${u.likes} · 歌单 ${u.playlists} · 播放 ${u.plays} · 在线设备 ${u.sessions}${u.bound ? ' · 已绑网易云' : ''}${u.last_seen ? ' · 最近活跃 ' + fmtTime(u.last_seen) : ''}</div>
        </div>
        <span class="cm-uact" data-act="menu" data-id="${u.id}" title="用户操作"><span class="material-icons-outlined">more_vert</span></span>
      </div>`).join('') : '<div class="cm-empty small">无匹配用户</div>';
    const pager = el.querySelector('#userPager');
    if (pager) {
      pager.innerHTML = total ? `
        <mdui-button variant="text" id="prev" ${offset === 0 ? 'disabled' : ''}>上一页</mdui-button>
        <span class="cm-pager-info">${offset + 1}–${Math.min(offset + PAGE, total)} / ${total}</span>
        <mdui-button variant="text" id="next" ${offset + PAGE >= total ? 'disabled' : ''}>下一页</mdui-button>` : '';
      const prev = pager.querySelector('#prev'), next = pager.querySelector('#next');
      if (prev) prev.onclick = () => { offset = Math.max(0, offset - PAGE); loadUsers(); };
      if (next) next.onclick = () => { offset += PAGE; loadUsers(); };
    }
    list.querySelectorAll('[data-act="menu"]').forEach(m => { m.onclick = () => openUserMenu(+m.dataset.id); });
  }

  function openUserMenu(id) {
    const u = ((S.users && S.users.users) || []).find(x => x.id === id);
    if (!u) return;
    const meOwner = !!(auth.user && auth.user.isOwner);
    const meSuper = meOwner || !!(auth.user && auth.user.isSuper);
    const self = !!(auth.user && auth.user.id === id);
    let roleActs;
    if (u.is_owner) {
      roleActs = (meOwner && !self)
        ? [{ k: 'unowner', label: '取消站长', icon: 'emoji_events' }]
        : [{ k: 'noowner', label: `站长（${self ? '不能对自己操作' : '仅站长可变更'}）`, icon: 'emoji_events' }];
    } else if (u.is_super) {
      roleActs = [
        ...(meSuper && !self
          ? [{ k: 'unsuper', label: '取消超级管理员', icon: 'workspace_premium' }]
          : [{ k: 'nosuper', label: `超级管理员（${self ? '不能对自己操作' : '仅超管可变更'}）`, icon: 'workspace_premium' }]),
        ...(meOwner ? [{ k: 'owner', label: '设为站长', icon: 'emoji_events' }] : []),
      ];
    } else {
      roleActs = [
        { k: u.is_admin ? 'unadmin' : 'admin', label: u.is_admin ? '取消管理员' : '设为管理员', icon: 'verified_user' },
        ...(meSuper ? [{ k: 'super', label: '设为超级管理员', icon: 'workspace_premium' }] : []),
        ...(meOwner ? [{ k: 'owner', label: '设为站长', icon: 'emoji_events' }] : []),
      ];
    }
    const acts = [
      { k: 'kick', label: u.sessions ? `踢下线（${u.sessions} 台设备）` : '踢下线（无在线设备）', icon: 'logout' },
      { k: 'pw', label: '重置密码', icon: 'password' },
      { k: u.disabled ? 'enable' : 'disable', label: u.disabled ? '解除禁用' : '禁用账号', icon: u.disabled ? 'lock_open' : 'block' },
      { k: 'title', label: u.title ? `修改头衔（当前：${u.title}）` : '设置头衔', icon: 'military_tech' },
      ...roleActs,
    ];
    const diag = mdui.dialog({
      headline: `${u.nickname || u.username}`,
      body: `<div class="cm-qm">${acts.map(a =>
        `<div class="cm-qm-item" data-k="${a.k}"><span class="material-icons-outlined">${a.icon}</span>${esc(a.label)}</div>`).join('')}</div>`,
      actions: [{ text: '关闭' }],
    });
    setTimeout(() => {
      diag.querySelectorAll('.cm-qm-item').forEach(it => {
        it.onclick = async () => {
          const k = it.dataset.k;
          diag.open = false;
          try {
            if (k === 'kick') { const r = await api.adminKick(id); toast(`已踢下线（${r.kicked} 个会话）`); await afterUserChange(); }
            else if (k === 'disable') { await api.adminDisable(id, true); toast('已禁用，其所有会话已作废'); await afterUserChange(); }
            else if (k === 'enable') { await api.adminDisable(id, false); toast('已解除禁用'); await afterUserChange(); }
            else if (k === 'admin') { await api.adminSetAdmin(id, true); toast('已设为管理员'); await afterUserChange(); }
            else if (k === 'nosuper') { toast('超级管理员只能由超管/站长变更，且不能对自己操作'); }
            else if (k === 'super') { await api.adminSetSuper(id, true); toast('已设为超级管理员'); await afterUserChange(); }
            else if (k === 'unsuper') { await api.adminSetSuper(id, false); toast('已取消超级管理员'); await afterUserChange(); }
            else if (k === 'noowner') { toast('站长只能由站长变更，且不能对自己操作'); }
            else if (k === 'owner') { await api.adminSetOwner(id, true); toast('已设为站长'); await afterUserChange(); }
            else if (k === 'unowner') { await api.adminSetOwner(id, false); toast('已取消站长，回落为超级管理员'); await afterUserChange(); }
            else if (k === 'unadmin') { await api.adminSetAdmin(id, false); toast('已取消管理员'); await afterUserChange(); }
            else if (k === 'title') {
              const max = (S.ov && S.ov.titleMax) || 16;
              promptDialog({
                title: `设置「${u.nickname || u.username}」的头衔`,
                label: `头衔（最多 ${max} 字，留空 = 取消）`, value: u.title || '',
                allowEmpty: true, maxlength: max,
                onOk: async t => { const r = await api.adminSetTitle(id, t); toast(r.title ? `头衔已设为「${r.title}」` : '已取消头衔'); await afterUserChange(); },
              });
            } else if (k === 'pw') {
              promptDialog({
                title: `重置「${u.username}」的密码`, label: '新密码（6~64 位）', type: 'password',
                onOk: async pw => { await api.adminResetPassword(id, pw); toast('密码已重置，该用户需重新登录'); await afterUserChange(); },
              });
            }
          } catch (e) { toast(e.message); }
        };
      });
    }, 0);
  }
  async function afterUserChange() {
    await Promise.allSettled([loadUsers({ silent: true }), loadOverview()]);
  }

  // 搜索：只在回车/点按钮时触发；不调用 render(el)
  const uq = el.querySelector('#uq');
  const doSearch = async () => {
    query = (uq.value || '').trim();
    offset = 0;
    const btn = el.querySelector('#usearch');
    if (btn) btn.loading = true;
    try { await loadUsers(); } finally { if (btn) btn.loading = false; }
  };
  uq.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doSearch(); }
  });
  el.querySelector('#usearch').onclick = doSearch;
  el.querySelectorAll('#userSort mdui-chip').forEach(ch => {
    ch.onclick = () => {
      if (userSort === ch.dataset.k) return;
      userSort = ch.dataset.k;
      offset = 0;
      el.querySelectorAll('#userSort mdui-chip').forEach(x => {
        if (x === ch) x.setAttribute('selected', '');
        else x.removeAttribute('selected');
      });
      loadUsers();
    };
  });

  // ---------- 公告 ----------
  async function loadAnn() {
    const box = el.querySelector('#annList');
    const seq = ++S.annSeq;
    if (box && !S.ann) box.innerHTML = rowSkeleton(4);
    try {
      const d = await api.adminAnnouncements();
      if (seq !== S.annSeq || !el.isConnected) return;
      S.ann = d;
      renderAnn();
    } catch (e) {
      if (seq !== S.annSeq || !el.isConnected) return;
      if (box) box.innerHTML = `<div class="cm-empty small">公告加载失败：${esc(e.message)}</div>`;
    }
  }
  function renderAnn() {
    const d = S.ann;
    const box = el.querySelector('#annList');
    if (!d || !box) return;
    const items = d.items || [];
    const live = items.filter(a => !a.removed).length;
    const c = el.querySelector('#annCount');
    if (c) c.textContent = `${live} 条生效${items.length > live ? ` · ${items.length - live} 条已移除` : ''}${d.isOwner ? ' · 站长可编辑全部' : d.isSuper ? ' · 超管可编辑全部' : ''}`;
    setBadge('announcements', live);
    box.innerHTML = items.length ? items.map(a => `
      <div class="cm-annrow${a.removed ? ' gone' : ''}" data-id="${a.id}">
        <div class="cm-annrow-main">
          <div class="cm-annrow-title">
            ${a.pinned && !a.removed ? '<span class="cm-tag admin">置顶</span>' : ''}
            ${a.removed ? '<span class="cm-tag banned">已移除</span>' : ''}
            ${esc(a.title)}
          </div>
          <div class="cm-annrow-sub">${esc(a.author || '—')} · 发布于 ${fmtTime(a.createdAt)}${a.updatedAt > a.createdAt ? ` · 修改于 ${fmtTime(a.updatedAt)}` : ''}${a.link ? ' · <span class="material-icons-outlined">link</span>带链接' : ''}</div>
          <div class="cm-annrow-body">${esc((a.body || '').replace(/\s+/g, ' ').slice(0, 160))}</div>
        </div>
        <div class="cm-annacts">
          ${a.canEdit ? `
            ${a.removed
              ? '<span class="material-icons-outlined" data-act="restore" title="恢复">restore_from_trash</span>'
              : `<span class="material-icons-outlined${a.pinned ? ' on' : ''}" data-act="pin" title="${a.pinned ? '取消置顶' : '置顶'}">push_pin</span>`}
            <span class="material-icons-outlined" data-act="edit" title="编辑">edit</span>
            ${a.removed ? '' : '<span class="material-icons-outlined" data-act="remove" title="移除">delete</span>'}
          ` : '<span class="cm-tag">他人发布</span>'}
        </div>
      </div>`).join('') : '<div class="cm-empty small">还没有公告。发布一条，客户端下次打开就会弹窗。</div>';

    box.querySelectorAll('.cm-annrow').forEach(row => {
      const a = items.find(x => String(x.id) === row.dataset.id);
      row.querySelectorAll('[data-act]').forEach(btn => {
        btn.onclick = async () => {
          const act = btn.dataset.act;
          try {
            if (act === 'pin') { await api.pinAnnouncement(a.id, !a.pinned); toast(a.pinned ? '已取消置顶' : '已置顶'); await loadAnn(); }
            else if (act === 'restore') { await api.restoreAnnouncement(a.id); toast('已恢复，客户端将重新看到'); await loadAnn(); }
            else if (act === 'remove') { await api.removeAnnouncement(a.id); toast('已移除'); await loadAnn(); }
            else if (act === 'edit') { location.hash = `#/announce/${a.id}`; }
          } catch (e) { toast(e.message); }
        };
      });
    });
  }
  el.querySelector('#annNew').onclick = () => { location.hash = '#/announce/new'; };

  // ---------- 设备 ----------
  async function loadDevices() {
    const box = el.querySelector('#devAll');
    const seq = ++S.devSeq;
    if (box && !S.sessions) box.innerHTML = rowSkeleton(5);
    try {
      const d = await api.adminSessions();
      if (seq !== S.devSeq || !el.isConnected) return;
      S.sessions = d.sessions || [];
      renderDevices();
    } catch (e) {
      if (seq !== S.devSeq || !el.isConnected) return;
      if (box) box.innerHTML = `<div class="cm-empty small">设备列表加载失败：${esc(e.message)}</div>`;
    }
  }
  function renderDevices() {
    const box = el.querySelector('#devAll');
    if (!box) return;
    const list = S.sessions || [];
    const c = el.querySelector('#devCount');
    if (c) c.textContent = `${list.length} 台${list.length >= 100 ? '（最多展示 100 台）' : ''}`;
    box.innerHTML = list.length ? list.map(s => `
      <div class="cm-dev">
        <span class="material-icons-outlined">${s.platform === 'web' ? 'language' : 'smartphone'}</span>
        <div class="cm-dev-main">
          <div>${esc(s.nickname || s.username)} <span class="cm-usub">@${esc(s.username)}</span></div>
          <div class="cm-dev-sub">${esc(s.device)} · 登录于 ${fmtTime(s.created_at)} · ${fmtTime(s.last_seen)}</div>
        </div>
        <span class="cm-dev-kick" data-sid="${s.id}" data-uid="${s.user_id}">踢出</span>
      </div>`).join('') : '<div class="cm-empty small">无在线设备</div>';
    box.querySelectorAll('.cm-dev-kick').forEach(k => {
      k.onclick = async () => {
        try {
          await api.adminKick(+k.dataset.uid);
          toast('该用户所有设备已下线');
          await Promise.allSettled([loadDevices(), loadOverview()]);
        } catch (e) { toast(e.message); }
      };
    });
  }

  // ---------- 客户端版本 ----------
  async function loadClients({ silent = false } = {}) {
    const box = el.querySelector('#clientsBody');
    if (!box) return;
    if (!S.clients && !silent) box.innerHTML = clientsSkeleton();
    const seq = ++S.clientsSeq;
    try {
      const d = await api.adminClients();
      if (seq !== S.clientsSeq || !el.isConnected) return;
      S.clients = d;
      renderClients();
    } catch (e) {
      if (seq !== S.clientsSeq || !el.isConnected) return;
      if (box) box.innerHTML = `<div class="cm-empty small">客户端版本加载失败：${esc(e.message)}</div>`;
    }
  }

  function renderClients() {
    const d = S.clients;
    const box = el.querySelector('#clientsBody');
    if (!d || !box) return;
    const cur = d.current || {};
    const cmx = d.cmx || {};
    const apk = cmx.apk || {};
    const hist = cmx.history || [];
    const totalDownloads = hist.reduce((s, h) => s + (Number(h.apkDownloads) || 0), 0);
    const mirrorTag = (on, labels = ['已镜像', '未镜像']) =>
      `<span class="cm-tag ${on ? '' : 'banned'}">${on ? labels[0] : labels[1]}</span>`;
    const currentCard = `
      <div class="cm-acard cm-client-card">
        <div class="cm-client-head">
          <div class="cm-client-badge cm-client-badge-cm">CM</div>
          <div class="cm-client-id">
            <div class="cm-client-name">CurrentMusic</div>
            <div class="cm-client-sub">网页端与 App 同一份前端产物</div>
          </div>
          ${mirrorTag(!!cur.mirrored, ['已发布', '无安装包'])}
        </div>
        <div class="cm-client-kv">
          <div><span>版本</span><b>${cur.version ? 'v' + esc(cur.version) : '—'}</b></div>
          <div><span>versionCode</span><b>${esc(String(cur.versionCode || '—'))}</b></div>
          <div><span>安装包</span><b>${cur.size ? fmtBytes(cur.size) : '—'}</b></div>
          <div><span>发布时间</span><b>${fmtStamp(cur.publishedAt)}</b></div>
        </div>
        <div class="cm-client-actions">
          <a class="cm-client-link" href="${settings.base}/download/latest" target="_blank" rel="noopener">下载最新版<span class="material-icons-outlined">download</span></a>
        </div>
        ${cur.changelog ? `<details class="cm-client-details"><summary>本版更新说明</summary><div class="cm-client-plain">${esc(cur.changelog)}</div></details>` : ''}
      </div>`;

    const cmxCard = `
      <div class="cm-acard cm-client-card">
        <div class="cm-client-head">
          <div class="cm-client-badge cm-client-badge-cmx">X</div>
          <div class="cm-client-id">
            <div class="cm-client-name">CurrentMusicX</div>
            <div class="cm-client-sub">第三方原生 Android 客户端</div>
          </div>
          ${mirrorTag(!!apk.mirrored)}
        </div>
        <div class="cm-client-kv">
          <div><span>版本</span><b>${cmx.version ? 'v' + esc(cmx.version) : '—'}</b></div>
          <div><span>versionCode</span><b>${esc(String(apk.versionCode || '—'))}</b></div>
          <div><span>安装包</span><b>${apk.size ? fmtBytes(apk.size) : '—'}</b></div>
          <div><span>发布时间</span><b>${cmx.publishedAt ? fmtStamp(cmx.publishedAt) : fmtIso(cmx.publishedAtIso)}</b></div>
          ${(apk.minSdk || apk.targetSdk) ? `<div><span>系统要求</span><b>Android ${esc(String(apk.minSdk || '—'))}+ · target ${esc(String(apk.targetSdk || '—'))}</b></div>` : ''}
          <div><span>下载</span><b>${fmtCount(apk.downloads || 0)} 次</b></div>
        </div>
        <div class="cm-client-actions">
          <a class="cm-client-link" href="${settings.base}${esc(cmx.downloadPath || '/x/download/latest')}" target="_blank" rel="noopener">${apk.mirrored ? '下载 APK（本机镜像）' : '从 GitHub 下载'}<span class="material-icons-outlined">download</span></a>
          ${cmx.htmlUrl ? `<a class="cm-client-link ghost" href="${esc(cmx.htmlUrl)}" target="_blank" rel="noopener">Release 页面<span class="material-icons-outlined">open_in_new</span></a>` : ''}
        </div>
        ${apk.fileName ? `<div class="cm-client-file" title="${esc(apk.sha256 || '')}">${esc(apk.fileName)} · sha256 ${esc(String(apk.sha256 || '').slice(0, 12))}…</div>` : ''}
      </div>`;

    box.innerHTML = `
      <div class="cm-sec-head"><h2>客户端</h2>
        <span class="cm-usub">CurrentMusic 与 CurrentMusicX 最新发布</span></div>
      <div class="cm-client-grid">${currentCard}${cmxCard}</div>

      <div class="cm-acard cm-achart" style="margin-top:12px">
        <div class="cm-achart-head">
          <div>
            <div class="cm-achart-title">CurrentMusicX 更新说明</div>
            <div class="cm-achart-sub">${cmx.name ? esc(cmx.name) : '尚未同步'}${cmx.publishedAt ? ' · ' + fmtTime(cmx.publishedAt) : ''}</div>
          </div>
          <div class="cm-legend">
            <a class="cm-client-link small" href="${esc(cmx.releasesUrl || cmx.htmlUrl || 'https://github.com/bileizhen/CurrentMusicX/releases')}" target="_blank" rel="noopener">Releases<span class="material-icons-outlined">open_in_new</span></a>
          </div>
        </div>
        <details class="cm-client-details" open>
          <summary>${cmx.version ? 'v' + esc(cmx.version) + ' 更新内容' : '暂无更新说明'}</summary>
          <div class="cm-client-md">${cmx.body ? renderMarkdown(cmx.body) : '<p>镜像尚未同步更新说明。</p>'}</div>
        </details>
        <div class="cm-client-sync">同步于 ${fmtTime(cmx.syncedAt)}${cmx.repo ? ' · ' + esc(cmx.repo) : ''}${cmx.apk && cmx.apk.mirrored ? ' · 本机已有安装包' : ''}</div>
      </div>

      <div class="cm-achart-grid">
        <div class="cm-acard cm-achart">
          <div class="cm-achart-head"><div><div class="cm-achart-title">各版本下载量</div>
            <div class="cm-achart-sub">GitHub 累计 · 历史合计 ${fmtCount(totalDownloads)} 次</div></div></div>
          <div class="cm-chart-wrap"><canvas id="cmxDownloadsChart" class="cm-chart-canvas" aria-label="CurrentMusicX 各版本下载量"></canvas></div>
        </div>
        <div class="cm-acard cm-achart">
          <div class="cm-achart-head"><div><div class="cm-achart-title">历史版本</div>
            <div class="cm-achart-sub">最近 ${hist.length} 个发布</div></div></div>
          <div class="cm-client-history">${hist.length ? hist.map(h => `
            <a class="cm-client-hrow" href="${esc(h.htmlUrl || cmx.releasesUrl || '#')}" target="_blank" rel="noopener">
              <div class="cm-client-hmain"><b>v${esc(h.version || '—')}</b>
                <span>${fmtIso(h.publishedAt)} · ${h.apkSize ? fmtBytes(h.apkSize) : '—'}</span></div>
              <div class="cm-client-hside"><span>${fmtCount(h.apkDownloads || 0)} 次</span>${mirrorTag(!!h.mirrored)}</div>
            </a>`).join('') : '<div class="cm-empty small">暂无历史版本</div>'}</div>
        </div>
      </div>`;
    if (S.tab === 'clients') requestAnimationFrame(drawClientsChart);
  }

  function drawClientsChart() {
    const canvas = el.querySelector('#cmxDownloadsChart');
    if (!canvas || !S.clients || !canvas.clientWidth) return;
    const hist = ((S.clients.cmx || {}).history || []).slice().reverse();
    drawBarChart(canvas, hist, {
      value: h => h.apkDownloads || 0,
      label: h => 'v' + (h.version || ''),
      format: n => `${fmtCount(n)} 次`,
      axisFormat: n => fmtCount(Math.round(n)),
    });
  }

  // ---------- 系统 ----------
  function renderSystem() {
    const box = el.querySelector('#systemBody');
    if (!box) return;
    const ov = S.ov;
    if (!ov) {
      box.innerHTML = `<div class="cm-agrid">${cardSkeleton()}</div>`;
      return;
    }
    const role = ov.roleCounts || {};
    box.innerHTML = `
      <div class="cm-sec-head"><h2>系统与数据</h2><span class="cm-usub">当前只读统计与低频维护</span></div>
      <div class="cm-agrid">
        ${card('自建歌单', fmtCount(ov.playlists), `曲目 ${fmtCount(ov.tracks)} 首`)}
        ${card('网易云绑定', fmtCount(ov.bindings), '已绑定网易云账号')}
        ${card('数据库缓存', fmtCount(ov.cache), '歌词 / 评论 / 详情等')}
        ${card('歌曲元数据', fmtCount(ov.songs), '站内缓存歌曲')}
      </div>
      <div class="cm-agrid" style="margin-top:12px">
        <div class="cm-acard cm-awide">
          <div class="cm-achart-head"><div><div class="cm-achart-title">角色摘要</div>
            <div class="cm-achart-sub">合计 ${fmtCount(ov.users)} 个账号</div></div></div>
          <div class="cm-role-chips">
            <span class="cm-role-chip"><i style="background:${ROLE_COLORS[0]}"></i>站长 <b>${role.owner || 0}</b></span>
            <span class="cm-role-chip"><i style="background:${ROLE_COLORS[1]}"></i>超级管理员 <b>${role.super || 0}</b></span>
            <span class="cm-role-chip"><i style="background:${ROLE_COLORS[2]}"></i>管理员 <b>${role.admin || 0}</b></span>
            <span class="cm-role-chip"><i style="background:${ROLE_COLORS[3]}"></i>普通用户 <b>${role.user || 0}</b></span>
          </div>
        </div>
        <div class="cm-acard cm-awide">
          <div class="cm-achart-head"><div><div class="cm-achart-title">缓存维护</div>
            <div class="cm-achart-sub">清理歌词、评论、详情等辅助缓存，不影响音质档位探测缓存。</div></div>
            <mdui-button variant="tonal" id="cacheClear"><span class="material-icons-outlined">cleaning_services</span>清理缓存</mdui-button></div>
          <div class="cm-system-note">当前缓存 <b>${fmtCount(ov.cache)}</b> 条。清理后首次访问对应内容会稍慢。</div>
        </div>
      </div>`;
    const btn = box.querySelector('#cacheClear');
    if (btn) btn.onclick = () => confirmDialog({
      title: '清理缓存？',
      body: '将清除歌词、评论、详情等缓存（不影响音质档位探测缓存）。',
      onOk: async () => {
        const r = await api.adminClearCache('aux');
        toast(`已清理 ${r.cleared} 条缓存`);
        await loadOverview();
        renderSystem();
      },
    });
  }

  // ---------- 刷新 / 轮询 / 尺寸 ----------
  async function refreshCurrent() {
    const btn = el.querySelector('#adminRefresh');
    if (btn) btn.loading = true;
    try {
      if (S.tab === 'overview') {
        await loadOverview();
        await loadTraffic();
      } else if (S.tab === 'users') {
        await loadUsers();
      } else if (S.tab === 'announcements') {
        await loadAnn();
      } else if (S.tab === 'devices') {
        await loadDevices();
      } else if (S.tab === 'clients') {
        await loadClients();
      } else if (S.tab === 'system') {
        await loadOverview();
        renderSystem();
      }
    } finally {
      if (btn) btn.loading = false;
    }
  }
  el.querySelector('#adminRefresh').onclick = refreshCurrent;

  let trafficTimer = null;
  const startTrafficPolling = () => {
    clearInterval(trafficTimer);
    trafficTimer = setInterval(() => {
      if (!el.isConnected) { clearInterval(trafficTimer); trafficTimer = null; return; }
      if (S.tab !== 'overview' || document.visibilityState !== 'visible') return;
      if (Date.now() - S.trafficAt < 25000) return;
      loadTraffic({ silent: true });
    }, 30000);
  };

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!el.isConnected) { window.removeEventListener('resize', onResize); return; }
      moveTabIndicator(false);
      if (S.tab === 'overview') { drawOverviewCharts(); drawTrafficChart(); }
      else if (S.tab === 'clients') drawClientsChart();
    }, 160);
  };
  window.addEventListener('resize', onResize);

  // 角色可能刚被更高角色改过：进面板时顺手刷新本地缓存的当前用户（决定菜单里的角色操作）
  api.me().then(me => { if (me && me.username) auth.saveLogin(auth.token, me); }).catch(() => {});

  const ok = await loadOverview();
  if (!ok || !el.isConnected) return;
  loadTraffic();
  startTrafficPolling();
}
