import { esc } from './ui.js';

const CATEGORIES = [
  { id: 'appearance', title: '外观与个性化', icon: 'palette', description: '主题、配色与专属的播放界面', groups: [
    { id: 'display', title: '主题与显示', description: '选择舒服的配色、风格和文字大小', items: ['theme', 'scheme', 'uiPreset', 'fontScale'] },
    { id: 'background', title: '背景与材质', description: '背景图片与玻璃效果', items: ['bgImage', 'glassFx'] },
    { id: 'player', title: '播放页外观', description: '封面形状、波形与频谱', items: ['coverShape', 'waveStyle', 'waveTilt'] },
  ] },
  { id: 'playback', title: '播放与下载', icon: 'headphones', description: '音质、音效、歌词与收藏习惯', groups: [
    { id: 'audio', title: '音质与音效', description: '找到适合耳朵的声音', items: ['quality', 'soundFx'] },
    { id: 'downloads', title: '下载设置', description: '管理音乐文件的保存位置', items: ['dlDir'] },
    { id: 'lyrics', title: '桌面歌词', description: '在其他应用上方显示歌词', items: ['desktopLyrics'] },
    { id: 'library', title: '收藏偏好', description: '选择喜欢的歌曲保存到哪里', items: ['likeMode'] },
  ] },
  { id: 'account', title: '账号与隐私', icon: 'manage_accounts', description: '安全验证、登录设备与应用授权', groups: [
    { id: 'security', title: '账号与安全', description: '管理账号、邮箱和登录保护', items: ['passkeys', 'accountInfo', 'bindEmail', 'twoFactor', 'securityQuestion', 'devices', 'adminEntry'] },
    { id: 'passport', title: '通行证与授权', description: '统一身份、应用授权与开发者入口', items: ['ppId', 'ppGrants', 'ppDev', 'ppDocs'] },
    { id: 'privacy', title: '隐私与公开范围', description: '决定是否出现在发现页', items: ['sqPublic'] },
  ] },
  { id: 'connection', title: '网络与连接', icon: 'public', description: '服务器地址与安全连接', groups: [
    { id: 'server', title: '服务器与连接', description: '配置 API 地址和 HTTPS 连接', items: ['network', 'server', 'secure'] },
  ] },
  { id: 'about', title: '关于与帮助', icon: 'info', description: '版本更新、使用引导与服务协议', groups: [
    { id: 'app', title: '版本与应用', description: '检查更新、下载应用和查看运行环境', items: ['checkUpd', 'dlApk', 'engine'] },
    { id: 'help', title: '引导与协议', description: '重新了解 CurrentMusic 与服务规则', items: ['replayWelcome', 'privacyPolicy', 'userTerms'] },
  ] },
];
const ALIASES = {
  theme: '夜间 白天 深色 浅色 系统 dark light', scheme: '颜色 动态取色 color', uiPreset: '皮肤 Material MD3 CMX CurrentMusicX 翱翔鸟 Music Apple',
  fontScale: '字号 大字 文字 font', bgImage: '壁纸 图片 wallpaper', glassFx: '模糊 透明 毛玻璃 blur',
  coverShape: '圆形 方形 专辑', waveStyle: '可视化 频谱 波形', waveTilt: '高频 补偿 频谱',
  network: 'CDN 音源 自动 测速 可用性 测试 镜像 LeiZ 网易云 线路',
  quality: '音质 无损 HiRes SQ FLAC 高清', soundFx: '均衡器 EQ 杜比 Dolby 环绕 声音',
  dlDir: '保存 路径 文件 download', desktopLyrics: '悬浮窗 字幕 歌词 lyric', likeMode: '红心 点赞 我喜欢 网易云 收藏',
  securityQuestion: '密保 问题 答案 登录 保护 安全 security question answer',
  passkeys: '通行密钥 passkey WebAuthn 指纹 人脸 FIDO 安全密钥',
  accountInfo: '用户 昵称 登录', bindEmail: '邮件 邮箱 email 换绑', twoFactor: '二步 两步 2FA TOTP Authenticator 验证器 安全',
  devices: '在线 登录 会话 下线 退出 设备 session', ppId: '身份 ID 通行证', ppGrants: '撤销 第三方 应用 授权',
  ppDev: '开发者 应用 登记 API', ppDocs: '文档 开发 接口 API OAuth PKCE', adminEntry: '管理员 后台',
  sqPublic: '隐私 发现 广场 公开 隐藏', server: '服务器 线路 API 域名 URL 地址', secure: 'HTTPS HTTP 安全 连接',
  checkUpd: '升级 版本 更新 update', dlApk: '安卓 Android APK 安装', engine: '浏览器 内核 Chromium WebView 兼容',
  replayWelcome: '重新观看引导 新手 教程 欢迎 入门 onboarding', privacyPolicy: '隐私 政策 数据 个人信息', userTerms: '协议 条款 服务',
};

/** Move existing controls without cloning, so handlers and async status updates stay intact. */
export function mountSettingsNavigation(el) {
  const rows = new Map();
  el.querySelectorAll('.cm-setting').forEach(row => {
    rows.set(row.id, row);
    const label = document.createElement('span');
    label.className = 'cm-setting-label';
    Array.from(row.childNodes).filter(node => node.nodeType === 3).forEach(node => label.appendChild(node));
    label.textContent = label.textContent.trim();
    row.insertBefore(label, row.querySelector('i'));
    row.dataset.label = label.textContent;
    const control = row.querySelector('mdui-switch');
    if (control) {
      control.setAttribute('aria-label', label.textContent);
      row.setAttribute('role', 'group');
    } else if (row.id !== 'accountInfo') {
      if (row.tagName !== 'BUTTON') {
        row.setAttribute('role', 'button'); row.tabIndex = 0;
        row.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); row.click(); }
        });
      }
      row.insertAdjacentHTML('beforeend', '<span class="material-icons-outlined cm-setting-chevron" aria-hidden="true">chevron_right</span>');
    }
  });
  const categories = CATEGORIES.map(category => ({ ...category, groups: category.groups.map(group => ({ ...group, items: group.items.filter(id => rows.has(id)) })).filter(group => group.items.length) }));
  const parts = location.hash.split('?')[0].split('/').slice(2);
  const category = categories.find(item => item.id === parts[0]);
  const group = category && category.groups.find(item => item.id === parts[1]);
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  let search = query.get('q') || '';
  const href = (cat, section) => '#/settings' + (cat ? '/' + cat.id : '') + (section ? '/' + section.id : '');
  const icon = name => `<span class="material-icons-outlined" aria-hidden="true">${name}</span>`;
  el.innerHTML = `<section class="cm-settings-hub">
    <header class="cm-settings-header"><div><span class="cm-settings-eyebrow">MAKE IT YOURS</span><h1>设置</h1><p>把音乐空间，调成你喜欢的样子。</p></div><div class="cm-settings-emblem" aria-hidden="true">${icon('tune')}</div></header>
    <div class="cm-settings-search"><label for="settingsSearch">${icon('search')}<span class="cm-sr-only">搜索全部设置</span></label><input id="settingsSearch" type="search" autocomplete="off" placeholder="搜索设置，例如：音质、主题、两步验证" value="${esc(search)}"><button type="button" id="clearSettingsSearch" aria-label="清除搜索">${icon('close')}</button></div>
    <div class="cm-settings-layout"><nav class="cm-settings-sidebar" aria-label="设置分类"><a href="#/settings" ${!category ? 'aria-current="page"' : ''}>${icon('dashboard')}<span>全部设置</span></a>${categories.map(cat => `<a href="${href(cat)}" ${cat === category ? 'aria-current="page"' : ''}>${icon(cat.icon)}<span>${cat.title}</span></a>`).join('')}</nav>
    <div class="cm-settings-main"><nav class="cm-settings-crumbs" aria-label="当前位置"><a href="#/settings">设置</a>${category ? `${icon('chevron_right')}<a href="${href(category)}" ${!group ? 'aria-current="page"' : ''}>${category.title}</a>` : ''}${group ? `${icon('chevron_right')}<span aria-current="page">${group.title}</span>` : ''}</nav>
    <div id="settingsContent"></div></div></div><div id="settingsStore" hidden></div></section>`;
  const store = el.querySelector('#settingsStore');
  rows.forEach(row => store.appendChild(row));
  const content = el.querySelector('#settingsContent');
  const input = el.querySelector('#settingsSearch');
  const clear = el.querySelector('#clearSettingsSearch');
  const addRows = (cat, section, ids, withPath) => {
    const panel = document.createElement('section'); panel.className = 'cm-settings-section';
    panel.innerHTML = `<header>${withPath ? `<a class="cm-settings-result-path" href="${href(cat, section)}">${cat.title} / ${section.title}${icon('arrow_outward')}</a>` : `<h2>${section.title}</h2><p>${section.description}</p>`}</header><div class="cm-setting-list"></div>`;
    ids.forEach(id => panel.querySelector('.cm-setting-list').appendChild(rows.get(id)));
    content.appendChild(panel);
  };
  function paint() {
    rows.forEach(row => store.appendChild(row)); content.replaceChildren();
    if (document.documentElement.getAttribute('data-ui-preset') === 'aimo') {
      try {
        content.animate([
          { opacity: 0, transform: 'translateY(10px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ], {
          duration: 220,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
        });
      } catch {}
    }
    const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    clear.hidden = !search;
    if (words.length) {
      let count = 0;
      const summary = document.createElement('p'); summary.className = 'cm-settings-summary'; summary.setAttribute('role', 'status'); content.appendChild(summary);
      categories.forEach(cat => cat.groups.forEach(section => {
        const ids = section.items.filter(id => {
          const row = rows.get(id);
          const haystack = [row.dataset.label, row.querySelector('i')?.textContent || '', ALIASES[id] || '', cat.title, section.title, section.description].join(' ').toLocaleLowerCase();
          return words.every(word => haystack.includes(word));
        });
        if (ids.length) { count += ids.length; addRows(cat, section, ids, true); }
      }));
      summary.textContent = `找到 ${count} 项相关设置`;
      if (!count) content.insertAdjacentHTML('beforeend', `<div class="cm-settings-empty">${icon('search_off')}<h2>没有找到相关设置</h2><p>试试更简短的词，例如“主题”“下载”或“2FA”。</p><button type="button" id="resetSettingsSearch">清除搜索</button></div>`);
      const reset = content.querySelector('#resetSettingsSearch'); if (reset) reset.onclick = () => { input.value = ''; updateSearch(); input.focus(); };
    } else if (category && group) {
      addRows(category, group, group.items, false);
    } else {
      const list = category ? category.groups : categories;
      const cards = document.createElement('div'); cards.className = category ? 'cm-settings-submenus' : 'cm-settings-categories';
      if (category) content.innerHTML = `<div class="cm-settings-category-heading"><h2>${category.title}</h2><p>${category.description}</p></div>`;
      list.forEach(item => {
        const a = document.createElement('a'); a.className = 'cm-settings-card'; a.href = category ? href(category, item) : href(item);
        const count = category ? item.items.length : item.groups.reduce((sum, entry) => sum + entry.items.length, 0);
        a.innerHTML = `${icon(item.icon || category.icon)}<div><h2>${item.title}</h2><p>${item.description}</p><span>${count} 项设置${!category ? ' · ' + item.groups.map(section => section.title).join(' / ') : ''}</span></div>${icon('chevron_right')}`;
        cards.appendChild(a);
      });
      content.appendChild(cards);
      if (!category) content.insertAdjacentHTML('beforeend', '<p class="cm-settings-footnote">找不到想改的选项？试试上方搜索，支持设置名称和常用关键词。</p>');
    }
  }
  function updateSearch() {
    search = input.value;
    const base = location.hash.split('?')[0];
    history.replaceState(history.state, '', base + (search ? '?q=' + encodeURIComponent(search) : ''));
    paint();
  }
  input.addEventListener('input', updateSearch);
  input.addEventListener('keydown', event => { if (event.key === 'Escape') { input.value = ''; updateSearch(); } });
  clear.onclick = () => { input.value = ''; updateSearch(); input.focus(); };
  paint();
}
