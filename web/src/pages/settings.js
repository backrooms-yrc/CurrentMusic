// 设置页：配色/音质/主题/下载目录/服务器/关于（与「我的」分离，顶栏齿轮直达）
import { mdui } from '../md.js';
import { api, settings, auth } from '../api.js';
import { esc, toast, promptDialog, COLOR_SCHEMES, getColorSchemeKey, setColorSchemeKey, QUALITY_TIERS, tierLabel } from '../ui.js';
import { checkUpdate } from '../update.js';
import { currentVersion, engineChrome, engineOutdated, ENGINE_MIN_RECOMMENDED } from '../version.js';

export function applyTheme() {
  const root = document.documentElement;
  root.classList.remove('mdui-theme-light', 'mdui-theme-dark', 'mdui-theme-auto');
  if (settings.theme === 'light') root.classList.add('mdui-theme-light');
  else if (settings.theme === 'dark') root.classList.add('mdui-theme-dark');
  else {
    // auto：Android 壳里跟随系统（桥查询），浏览器里用 media query
    const sysDark = typeof window.NativeApi !== 'undefined' && window.NativeApi.isDarkMode
      ? window.NativeApi.isDarkMode()
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.add(sysDark ? 'mdui-theme-dark' : 'mdui-theme-light');
  }
}

export function themeName() {
  return { auto: '跟随系统', light: '浅色', dark: '深色' }[settings.theme] || settings.theme;
}

export async function render(el) {
  const u = auth.user || {};
  el.innerHTML = `
    <div class="cm-sec-head"><h2>外观</h2></div>
    <div class="cm-setting-list">
      <div class="cm-setting" id="scheme"><span class="material-icons-outlined">palette</span>配色方案<i>${esc((COLOR_SCHEMES.find(s => s.key === getColorSchemeKey()) || {}).label || '动态取色')}</i></div>
      <div class="cm-setting" id="theme"><span class="material-icons-outlined">dark_mode</span>外观主题<i>${themeName()}</i></div>
    </div>
    <div class="cm-sec-head"><h2>播放与下载</h2></div>
    <div class="cm-setting-list">
      <div class="cm-setting" id="quality"><span class="material-icons-outlined">high_quality</span>默认音质<i>${tierLabel(settings.quality)}</i></div>
      <div class="cm-setting" id="dlDir"><span class="material-icons-outlined">download</span>下载目录<i>Music/${esc(localStorage.getItem('cm.downloadDir') || 'CurrentMusic')}</i></div>
    </div>
    <div class="cm-sec-head"><h2>服务器</h2></div>
    <div class="cm-setting-list">
      <div class="cm-setting" id="secure"><span class="material-icons-outlined">lock</span>安全连接<i>${settings.secureMode ? 'HTTPS 已启用' : '已关闭'}</i></div>
      <div class="cm-setting" id="server"><span class="material-icons-outlined">dns</span>服务器地址<i>${esc(settings.base)}</i></div>
    </div>
    <div class="cm-sec-head"><h2>关于</h2></div>
    <div class="cm-setting-list">
      <div class="cm-setting" id="checkUpd"><span class="material-icons-outlined">system_update</span>检查更新<i>v${esc(currentVersion().name)}<span class="material-icons-outlined" style="font-size:15px;vertical-align:-3px;margin-left:4px">chevron_right</span></i></div>
      <div class="cm-setting"><span class="material-icons-outlined">person</span>当前账号<i>${esc(u.nickname || u.username || '未登录')}</i></div>
      ${(auth.user && auth.user.isAdmin) ? `<div class="cm-setting" id="adminEntry"><span class="material-icons-outlined">admin_panel_settings</span>管理员面板<i>用户/设备/系统</i></div>` : ''}
      ${auth.token ? `<div class="cm-setting" id="devices"><span class="material-icons-outlined">devices</span>登录设备<i id="devCount">—</i></div>` : ''}
      <div class="cm-setting" id="engine"><span class="material-icons-outlined">public</span>系统 WebView<i>${engineChrome() ? 'Chromium ' + engineChrome() : '未知'}${engineOutdated() ? ' · 建议更新' : ''}</i></div>
    </div>`;

  el.querySelector('#scheme').onclick = () => {
    const cur = getColorSchemeKey();
    const diag = mdui.dialog({
      headline: '配色方案',
      body: `<div class="cm-more">
        <div class="cm-more-chips">${COLOR_SCHEMES.map(s =>
          `<mdui-chip ${s.key === cur ? 'selected' : ''} data-k="${s.key}"><i class="cm-swatch ${s.key === 'dynamic' ? 'dyn' : ''}" style="background:${s.color || 'linear-gradient(135deg,#6750a4,#e65100)'}"></i>${s.label}</mdui-chip>`).join('')}</div>
        <div class="cm-more-s" style="margin-top:10px">动态取色：主色随正在播放的封面自动变化</div>
      </div>`,
      actions: [{ text: '关闭' }],
    });
    setTimeout(() => {
      diag.querySelectorAll('mdui-chip').forEach(ch => {
        ch.onclick = () => {
          setColorSchemeKey(ch.dataset.k);
          toast(`配色：${ch.textContent.trim()}`);
          diag.open = false;
          render(el);
        };
      });
    }, 0);
  };
  el.querySelector('#theme').onclick = () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(settings.theme) + 1) % 3];
    settings.theme = next;
    applyTheme();
    toast(`主题：${themeName()}`);
    render(el);
  };
  el.querySelector('#quality').onclick = () => {
    const diag = mdui.dialog({
      headline: '默认音质',
      body: `<div class="cm-qm">${QUALITY_TIERS.map(t =>
        `<div class="cm-qm-item" data-v="${t.key}">${t.label}${t.key === settings.quality ? '<span class="material-icons-outlined">check</span>' : ''}</div>`).join('')}</div>`,
      actions: [{ text: '关闭' }],
    });
    setTimeout(() => {
      diag.querySelectorAll('.cm-qm-item').forEach(it => {
        it.onclick = () => {
          settings.quality = it.dataset.v;
          toast(`默认音质：${it.textContent.trim()}`);
          diag.close();
          render(el);
        };
      });
    }, 0);
  };
  el.querySelector('#dlDir').onclick = () => promptDialog({
    title: '下载目录', label: 'Music/ 下的子目录名', value: localStorage.getItem('cm.downloadDir') || 'CurrentMusic',
    onOk: v => { localStorage.setItem('cm.downloadDir', v.trim() || 'CurrentMusic'); toast('已保存'); render(el); },
  });
  el.querySelector('#engine').onclick = () => {
    const v = engineChrome();
    if (!engineOutdated()) return toast(`当前 WebView：Chromium ${v || '未知'}，无需更新`);
    mdui.dialog({
      headline: '建议更新系统 WebView',
      body: `<div style="font-size:13.5px;line-height:1.8">
        当前内核为 <b>Chromium ${v}</b>，低于建议版本 ${ENGINE_MIN_RECOMMENDED}，
        部分界面效果或播放体验可能受影响。<br>
        在应用商店更新「Android System WebView」（或 Chrome）后重启 App 即可恢复最佳效果。
      </div>`,
      actions: [
        { text: '稍后' },
        { text: '去更新', onClick: () => {
            if (window.NativeApi && window.NativeApi.openWebViewUpdate) window.NativeApi.openWebViewUpdate();
            else toast('请到应用商店搜索「Android System WebView」');
          } },
      ],
    });
  };
  el.querySelector('#adminEntry')?.addEventListener('click', () => { location.hash = '#/admin'; });

  const devRow = el.querySelector('#devices');
  if (devRow) {
    const fmtTime = ts => {
      if (!ts) return '—';
      const d = new Date(ts * 1000), now = new Date();
      const diff = (now - d) / 1000;
      if (diff < 120) return '刚刚活跃';
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
      if (d.toDateString() === now.toDateString()) return '今天 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    let sessions = [];
    const refresh = async () => {
      try {
        const d = await api.sessions();
        sessions = d.sessions || [];
        const c = el.querySelector('#devCount');
        if (c) c.textContent = `${sessions.length}/${d.max} 台`;
        return d.max;
      } catch (e) {
        const c = el.querySelector('#devCount');
        if (c) c.textContent = '查看';
        return 5;
      }
    };
    refresh();
    devRow.onclick = async () => {
      const max = await refresh();
      const diag = mdui.dialog({
        headline: `登录设备（最多 ${max} 台）`,
        body: `<div class="cm-devs">
          ${sessions.map(s => `
            <div class="cm-dev">
              <span class="material-icons-outlined">${s.platform === 'web' ? 'language' : 'smartphone'}</span>
              <div class="cm-dev-main">
                <div>${esc(s.device)}${s.current ? '<span class="cm-dev-cur">本机</span>' : ''}</div>
                <div class="cm-dev-sub">登录于 ${fmtTime(s.createdAt)} · ${fmtTime(s.lastSeen)}</div>
              </div>
              ${s.current ? '' : `<span class="cm-dev-kick" data-id="${s.id}">退出</span>`}
            </div>`).join('') || '<div class="cm-empty small">暂无设备</div>'}
        </div>`,
        actions: [
          { text: '关闭' },
          { text: '退出其他设备', onClick: () => {
              api.revokeOtherSessions().then(r => {
                toast(`已退出 ${r.removed} 台设备`);
                diag.open = false;
                render(el);
              }).catch(e => toast(e.message));
              return false;
            } },
        ],
      });
      setTimeout(() => {
        diag.querySelectorAll('.cm-dev-kick').forEach(k => {
          k.onclick = async () => {
            try {
              await api.revokeSession(k.dataset.id);
              toast('该设备已下线');
              k.closest('.cm-dev').remove();
              refresh();
            } catch (e) { toast(e.message); }
          };
        });
      }, 0);
    };
  }

  el.querySelector('#checkUpd').onclick = async () => {
    toast('正在检查更新…');
    await checkUpdate({ silent: false });
  };
  el.querySelector('#secure').onclick = () => {
    const next = !settings.secureMode;
    settings.secureMode = next;
    toast(next ? '安全连接已启用（HTTPS）' : '安全连接已关闭（允许 HTTP）');
    render(el);
  };
  el.querySelector('#server').onclick = () => promptDialog({
    title: '服务器地址', label: 'API 基址', value: settings.base,
    onOk: v => { settings.base = v.replace(/\/+$/, ''); toast('已保存'); render(el); },
  });
}
