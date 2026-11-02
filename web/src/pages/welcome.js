import { auth } from '../api.js';
import { esc } from '../ui.js';
import { authFrame, completeWelcome, needsWelcome, isWelcomeReplay } from '../auth-flow.js';

const slides = [
  { art: 'music', kicker: '很高兴与你相遇', title: '你的音乐旅程，从这里开始', text: '发现新歌，也重逢那些舍不得跳过的旋律。让 CurrentMusic 陪你度过每一个想听歌的时刻。', icon: 'headphones', note: '搜索喜欢的歌曲、歌手与专辑，找到今天的心动。' },
  { art: 'library', kicker: '让喜欢，有处收藏', title: '把每一份喜欢，收进音乐库', text: '遇到喜欢的歌，就点亮爱心。创建属于自己的歌单，把通勤、专注和夜晚的旋律好好整理。', icon: 'library_music', note: '也可以稍后在「我的 → 网易云账号」绑定账号，同步你的音乐收藏。' },
  { art: 'style', kicker: '舒服的样子，你来决定', title: '让音乐，也有你的风格', text: '明亮或深邃，简洁或通透。选择喜欢的主题、背景与播放样式，让每一次打开都合心意。', icon: 'palette', note: '前往「设置 → 外观」探索更多可能，随时都能调整。' },
  { art: 'security', kicker: '最后一步 · 账号安全', title: '要为账号开启两步验证吗？', text: '登录时，在密码或邮箱验证码之外，再用验证器确认一次。多一道简单的验证，多一份安心。', icon: 'verified_user', note: '支持主流 Authenticator 验证器，并提供恢复码。你也可以稍后在设置中开启。' },
];
export function render(el) {
  if (!auth.token) { location.hash = '#/user'; return; }
  if (!needsWelcome()) { location.hash = '#/home'; return; }
  const replay = isWelcomeReplay();
  let step = 0;
  try { step = Math.max(0, Math.min(slides.length - 1, Number(sessionStorage.getItem('cm.welcome.step')) || 0)); } catch { /* 默认第一页 */ }
  function draw() {
    const slide = slides[step], last = step === slides.length - 1;
    const captions = ['新的旋律，新的日常。', '每一首喜欢，都值得好好收藏。', '你的音乐空间，自然该像你。', '简单几步，守护每一次登录。'];
    try { sessionStorage.setItem('cm.welcome.step', String(step)); } catch { /* 隐私模式 */ }
    el.innerHTML = authFrame({ eyebrow: 'WELCOME TO CURRENTMUSIC', art: slide.art, title: slide.title, description: captions[step], body: `
      <div class="cm-welcome-top"><span>为你准备的开始</span><span aria-label="第 ${step + 1} 页，共 ${slides.length} 页">0${step + 1} / 0${slides.length}</span></div>
      <div class="cm-welcome-progress" aria-label="引导进度">${slides.map((_, i) => `<span class="${i <= step ? 'active' : ''}" ${i === step ? 'aria-current="step"' : ''}></span>`).join('')}</div>
      <div class="cm-welcome-content" aria-live="polite"><span class="cm-auth-kicker">${slide.kicker}</span>
      <h2>${step === 0 ? `欢迎你，${esc((auth.user || {}).nickname || '新朋友')}` : last ? '让账号更安全' : step === 1 ? '收藏、歌单，都在这里' : '从喜欢的样子开始'}</h2>
      <p class="cm-auth-description">${step === 0 ? '账号已准备就绪。花一点时间，认识你的新音乐空间。' : slide.text}</p>
      <div class="cm-welcome-note"><span class="material-icons-outlined">${slide.icon}</span><p>${slide.note}</p></div>
      ${last ? '<div class="cm-welcome-benefits"><span><span class="material-icons-outlined">qr_code_2</span>扫码即可绑定</span><span><span class="material-icons-outlined">key</span>恢复码备用</span></div>' : ''}</div>
      <div class="cm-auth-fields"><mdui-button id="welcomeNext" variant="filled">${last ? (replay ? '查看两步验证设置' : '开启两步验证') : step === 0 ? '开始了解' : '继续'}</mdui-button>
      ${last ? '<mdui-button id="welcomeQuestion" variant="tonal">改用登录密保问题</mdui-button>' : ''}
      ${last ? `<mdui-button id="welcomeLater" variant="text">${replay ? '完成引导，返回设置' : '暂不开启，开始听歌'}</mdui-button>` : ''}
      ${step > 0 ? '<mdui-button id="welcomeBack" variant="text">上一步</mdui-button>' : ''}</div>
      <p class="cm-auth-footnote">${last ? '安全选项由你决定，之后仍可随时修改。' : '你的喜好由你定义，一切都可以慢慢探索。'}</p>` });
    document.getElementById('out').scrollTop = 0;
    el.querySelector('#welcomeNext').onclick = () => { if (last) location.hash = '#/two-factor'; else { step++; draw(); } };
    const question = el.querySelector('#welcomeQuestion'); if (question) question.onclick = () => { location.hash = '#/security-question'; };
    const back = el.querySelector('#welcomeBack'); if (back) back.onclick = () => { step--; draw(); };
    const later = el.querySelector('#welcomeLater'); if (later) later.onclick = completeWelcome;
  }
  draw();
}
