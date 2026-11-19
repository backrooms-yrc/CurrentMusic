'use strict';

const $ = id => document.getElementById(id);
const DAY = 86400;
const CN_OFFSET = 8 * 3600;
const labels = { up: '正常', warn: '有失败探测', down: '全部探测失败', unknown: '暂无记录' };
const clock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric',
  day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayKey = epoch => new Date((epoch + CN_OFFSET) * 1000).toISOString().slice(0, 10);
const dayStart = key => Date.parse(key + 'T00:00:00+08:00') / 1000;
const dateLabel = key => key.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1 年 $2 月 $3 日');

const themePreference = matchMedia('(prefers-color-scheme: dark)');
let theme;
try { theme = localStorage.getItem('cm.status.theme'); } catch {}
function applyTheme() {
  const dark = theme ? theme === 'dark' : themePreference.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme').setAttribute('aria-pressed', String(dark));
}
$('theme').onclick = () => {
  theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('cm.status.theme', theme); } catch {}
  applyTheme();
};
themePreference.addEventListener?.('change', applyTheme);
applyTheme();

let data, picked, month, showHistory = false, timer;
const newEl = (tag, className, value) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (value != null) el.textContent = value;
  return el;
};
const stateFor = ([count, ok] = []) => !count ? 'unknown' : ok === count ? 'up' : ok ? 'warn' : 'down';

function currentState(service) {
  if (!service.checkedAt || Date.now() / 1000 - service.checkedAt > 4500) return 'unknown';
  return service.up ? 'up' : 'down';
}

function renderSummary(problem = false) {
  const probes = data?.services || [];
  const states = probes.map(currentState);
  const failed = states.filter(state => state === 'down').length;
  const unknown = states.filter(state => state === 'unknown').length;
  const lastProbe = Math.max(0, ...probes.map(service => service.checkedAt || 0));
  const stale = problem || Date.now() / 1000 - lastProbe > 180;
  const state = stale || !states.length || unknown === states.length ? 'unknown'
    : failed === states.length ? 'down' : failed || unknown ? 'warn' : 'up';
  const title = { up: '所有服务运行正常', warn: '部分服务出现异常', down: '服务暂不可用', unknown: '暂无法确认实时状态' };
  $('summary').dataset.state = state;
  $('summary').querySelector('.summary-mark').textContent = { up: '✓', warn: '!', down: '!', unknown: '···' }[state];
  $('summary-title').textContent = title[state];
  $('summary-detail').textContent = state === 'unknown' ? '监控数据暂不可用或已过期'
    : failed || unknown ? `${failed} 项异常 · ${unknown} 项等待探测 · 共 ${states.length} 项`
      : `${states.length} 项监控通过最近一次探测`;
  if (data?.updatedAt) {
    $('last-updated').dateTime = new Date(data.updatedAt * 1000).toISOString();
    $('last-updated').textContent = '更新于 ' + clock.format(data.updatedAt * 1000);
  }
}

function renderServices() {
  const groups = new Map(), fragment = document.createDocumentFragment();
  const order = ['公网入口', 'CDN 镜像', '后端进程', '内部依赖', '外部依赖', '证书与域名'];
  const rank = group => order.includes(group) ? order.indexOf(group) : order.length;
  const services = [...data.services].sort((a, b) => rank(a.group) - rank(b.group));
  for (const service of services) {
    if (!groups.has(service.group)) {
      const section = newEl('div', 'group');
      groups.set(service.group, section);
      section.append(newEl('h3', '', service.group));
      fragment.append(section);
    }
    const row = newEl('div', 'service'), head = newEl('div', 'service-head');
    const state = currentState(service);
    const badge = newEl('span', 'badge');
    badge.append(newEl('i', 'dot ' + state), document.createTextNode(state === 'down' ? '探测失败' : labels[state]));
    head.append(newEl('strong', '', service.name), badge);
    const timeline = newEl('div', 'timeline');
    timeline.setAttribute('aria-label', service.name + ' 每日可用率');
    let checks = 0, successes = 0;
    for (let time = dayStart(data.from); time <= dayStart(data.to); time += DAY) {
      const key = dayKey(time), results = service.days[key];
      const bar = newEl('button', stateFor(results));
      bar.type = 'button';
      bar.tabIndex = -1;
      bar.title = `${key} · ${results?.[0] ? (100 * results[1] / results[0]).toFixed(2) + '%' : '暂无记录'}`;
      bar.setAttribute('aria-label', bar.title);
      bar.onclick = () => pick(key, true);
      timeline.append(bar);
      if (results) { checks += results[0]; successes += results[1]; }
    }
    const details = newEl('div', 'timeline-labels');
    details.append(newEl('span', '', data.from.slice(5)), newEl('span', '', checks
      ? `${(100 * successes / checks).toFixed(2)}% 可用 · ${checks.toLocaleString('zh-CN')} 次探测` : '暂无探测'),
    newEl('span', '', data.to.slice(5)));
    row.append(head, timeline, details);
    groups.get(service.group).append(row);
  }
  if (!groups.size) fragment.append(newEl('p', '', '暂无服务探测记录'));
  $('services').replaceChildren(fragment);
  $('services').setAttribute('aria-busy', 'false');
}

function overlapping(key) {
  const start = dayStart(key);
  return data.incidents.filter(item => item.startedAt < start + DAY && (item.endedAt ?? Infinity) >= start);
}
function monthOffset(delta) {
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
function renderCalendar() {
  const start = dayStart(month + '-01');
  const weekday = (new Date((start + CN_OFFSET) * 1000).getUTCDay() + 6) % 7;
  $('calendar-month').textContent = month.replace('-', ' 年 ') + ' 月';
  $('prev').disabled = month <= data.from.slice(0, 7);
  $('next').disabled = month >= data.to.slice(0, 7);
  const cells = document.createDocumentFragment();
  for (let i = 0; i < 42; i++) {
    const key = dayKey(start + (i - weekday) * DAY);
    const marked = key >= data.from && key <= data.to && overlapping(key).length > 0;
    const btn = newEl('button', marked ? 'has-event' : '', String(Number(key.slice(-2))));
    btn.type = 'button';
    btn.disabled = !key.startsWith(month) || key < data.from || key > data.to;
    btn.dataset.day = key;
    btn.setAttribute('aria-label', dateLabel(key) + (marked ? '，有事件' : ''));
    btn.setAttribute('aria-pressed', String(key === picked && !showHistory));
    btn.onclick = () => pick(key, true);
    cells.append(btn);
  }
  $('calendar-days').replaceChildren(cells);
}
function renderEvents() {
  $('event-date').textContent = showHistory ? '近 30 天事件' : dateLabel(picked);
  $('history').textContent = showHistory ? '返回所选日期' : '查看近 30 天事件';
  $('history').setAttribute('aria-pressed', String(showHistory));
  const items = showHistory ? data.incidents : overlapping(picked);
  const names = new Map(data.services.map(service => [service.key, service.name]));
  const list = document.createDocumentFragment();
  for (const item of items) {
    const row = newEl('div', 'event');
    row.append(newEl('b', '', names.get(item.key)),
      newEl('time', '', clock.format(item.startedAt * 1000) + ' – '
        + (item.endedAt ? clock.format(item.endedAt * 1000) + ' 恢复' : '仍在监测')));
    list.append(row);
  }
  if (!items.length) {
    const recorded = showHistory ? data.services.some(service => Object.keys(service.days).length)
      : data.services.some(service => service.days[picked]);
    list.append(newEl('p', '', recorded ? '没有记录到服务事件。' : '这段时间暂无监控记录。'));
  }
  $('events').replaceChildren(list);
}
function pick(key, focus) {
  picked = key;
  month = key.slice(0, 7);
  showHistory = false;
  renderCalendar();
  renderEvents();
  if (focus) $('calendar-days').querySelector(`[data-day="${key}"]`)?.focus();
}
$('prev').onclick = () => { month = monthOffset(-1); renderCalendar(); };
$('next').onclick = () => { month = monthOffset(1); renderCalendar(); };
$('history').onclick = () => {
  if (!data) return;
  showHistory = !showHistory;
  renderCalendar();
  renderEvents();
};

async function refresh() {
  clearTimeout(timer);
  try {
    const response = await fetch('./status.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const next = await response.json();
    const focusDay = document.activeElement?.dataset.day;
    const followToday = !picked || picked === data?.to;
    data = next;
    if (followToday || picked < data.from) {
      if (!month || month === picked?.slice(0, 7)) month = data.to.slice(0, 7);
      picked = data.to;
    }
    renderSummary();
    renderServices();
    renderCalendar();
    renderEvents();
    if (focusDay) $('calendar-days').querySelector(`[data-day="${focusDay}"]`)?.focus({ preventScroll: true });
  } catch {
    renderSummary(true);
    if (!data) {
      $('services').setAttribute('aria-busy', 'false');
      $('services').replaceChildren(newEl('p', '', '暂时无法读取监控记录，即将自动重试。'));
    }
  } finally {
    timer = setTimeout(refresh, 30000);
  }
}
refresh();
