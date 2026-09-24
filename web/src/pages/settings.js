// 设置页：配色/音质/主题/下载目录/服务器/关于（与「我的」分离，顶栏齿轮直达）
import { mdui } from '../md.js';
import { settings, auth } from '../api.js';
import { esc, toast, promptDialog, COLOR_SCHEMES, getColorSchemeKey, setColorSchemeKey, QUALITY_TIERS, tierLabel } from '../ui.js';
import { checkUpdate } from '../update.js';
import { currentVersion } from '../version.js';

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
      <div class="cm-setting" id="server"><span class="material-icons-outlined">dns</span>服务器地址<i>${esc(settings.base)}</i></div>
    </div>
    <div class="cm-sec-head"><h2>关于</h2></div>
    <div class="cm-setting-list">
      <div class="cm-setting" id="checkUpd"><span class="material-icons-outlined">system_update</span>检查更新<i>v${esc(currentVersion().name)}<span class="material-icons-outlined" style="font-size:15px;vertical-align:-3px;margin-left:4px">chevron_right</span></i></div>
      <div class="cm-setting"><span class="material-icons-outlined">person</span>当前账号<i>${esc(u.nickname || u.username || '未登录')}</i></div>
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
  el.querySelector('#checkUpd').onclick = async () => {
    toast('正在检查更新…');
    await checkUpdate({ silent: false });
  };
  el.querySelector('#server').onclick = () => promptDialog({
    title: '服务器地址', label: 'API 基址', value: settings.base,
    onOk: v => { settings.base = v.replace(/\/+$/, ''); toast('已保存'); render(el); },
  });
}
