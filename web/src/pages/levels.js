import { api, auth } from '../api.js';
import { esc } from '../ui.js';
import { levelBadge } from '../level-badges.js';

const number = new Intl.NumberFormat('zh-CN');
const icon = name => `<span class="material-icons-outlined" aria-hidden="true">${name}</span>`;
const SOURCE_COPY = {
  visit: ['today', '每日登录访问', () => '每天首次使用有效会话访问'],
  listen: ['headphones', '有效收听', seconds => `当日开始播放的不同歌曲，单次收听满 ${seconds} 秒`],
  post: ['edit_note', '发布动态', () => '当天首次成功发布帖子'],
  comment: ['forum', '参与讨论', () => '评论他人帖子，同一帖子每天计一次'],
};

export async function render(el, [page] = []) {
  el.innerHTML = '<div class="cm-empty">加载中…</div>';
  try {
    if (page === 'trial') await renderTrial(el);
    else await renderRules(el);
  } catch (e) {
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}</div>
      <mdui-button variant="text" id="levelRetry">重试</mdui-button>`;
    el.querySelector('#levelRetry').onclick = () => render(el, [page]);
  }
}

async function renderRules(el) {
  const [rules, me] = await Promise.all([
    api.levelRules(),
    auth.token ? api.levelProgress().catch(() => null) : null,
  ]);
  const { levels, pointSources = [{ id: 'visit', points: rules.dailyPoints, dailyLimit: 1 }], listenSeconds, trial } = rules;
  const today = pointSources.reduce((total, source) => total + (me?.today[source.id] || 0) * source.points, 0);
  const dailyMax = pointSources.reduce((total, source) => total + source.dailyLimit * source.points, 0);
  const next = me && levels.find(item => item.level > me.level && item.points > me.points);
  const previous = next && levels.find(item => item.level === next.level - 1);
  const progress = next && Math.max(0, me.points - previous.points);
  el.innerHTML = `<section class="cm-level-page">
    <header class="cm-level-hero">
      <div>
        <span class="cm-level-eyebrow">CURRENTMUSIC · 成长中心</span>
        <h2>积分与升级规则</h2>
        <p>听歌、分享、参与讨论，每天都能积累积分。</p>
        ${me ? `<dl class="cm-level-stats">
          <div><dt>累计积分</dt><dd>${number.format(me.points)}</dd></div>
          <div><dt>今日已获</dt><dd>+${number.format(today)} <small>/ ${number.format(dailyMax)}</small></dd></div>
        </dl>` : !auth.token ? '<mdui-button href="#/user" variant="tonal">登录查看进度</mdui-button>' : '<p>暂时无法读取个人进度。</p>'}
      </div>
      <div class="cm-level-hero-badge">${levelBadge(me?.level || 1)}</div>
      ${next ? `<div class="cm-level-next">
        <progress max="${next.points - previous.points}" value="${progress}" aria-label="升级进度"></progress>
        <span>距下一积分门槛还差 ${number.format(next.points - me.points)} 分</span>
      </div>` : ''}
    </header>

    <section class="cm-level-section">
      <div class="cm-level-heading"><h3>积分获取途径</h3><span>北京时间 00:00 刷新额度</span></div>
      <div class="cm-point-sources">${pointSources.map(source => sourceCard(source, me, listenSeconds)).join('')}</div>
    </section>

    <section class="cm-level-section">
      <div class="cm-level-heading"><h3>升级路线</h3><span>累计积分达到门槛即升级</span></div>
      <ol class="cm-level-route">
        ${levels.map(({ level, points }) => `<li ${me?.level === level ? 'aria-current="step"' : ''}>
          ${levelBadge(level)}<b>${number.format(points)}</b><small>${me?.level === level ? '当前' : '积分'}</small>
        </li>`).join('')}
        <li ${me?.level === trial.plusLevel ? 'aria-current="step"' : ''}>
          ${levelBadge(trial.plusLevel)}<b>试炼</b><small>${me?.level === trial.plusLevel ? '当前' : '解锁'}</small>
        </li>
      </ol>
    </section>

    <section class="cm-level-trial-callout">
      ${levelBadge(trial.plusLevel)}
      <div><h3>终阶试炼</h3><p>拿到金色音符盾章后即可参加。共 ${esc(trial.questionCount)} 道单选题，满分 ${esc(trial.maxScore)}，${esc(trial.passScore)} 分及格。</p></div>
      ${me?.level === trial.level ? '<mdui-button href="#/levels/trial" variant="filled">参加试炼</mdui-button>' : ''}
    </section>
  </section>`;
}

function sourceCard(source, me, listenSeconds) {
  const copy = SOURCE_COPY[source.id];
  const done = me?.today[source.id] ?? 0;
  return `<article class="cm-point-source">
    <div class="cm-point-icon">${icon(copy?.[0] || 'stars')}</div>
    <div><h4>${copy?.[1] || esc(source.id)}</h4><p>${copy?.[2](listenSeconds) || ''}</p></div>
    <b class="cm-point-award">+${number.format(source.points)} 分</b>
    <div class="cm-point-foot">
      <span>${me ? `今日 ${done} / ${source.dailyLimit} 次` : `每日最多 ${source.dailyLimit} 次`}</span>
      ${me ? `<progress max="${source.dailyLimit}" value="${done}" aria-label="${copy?.[1] || esc(source.id)}计分进度"></progress>` : ''}
    </div>
  </article>`;
}

function trialNotice(el, title, detail, { login = false, badge = 6, score = '', celebrate = false } = {}) {
  el.innerHTML = `<section class="cm-level-page">
    <div class="cm-trial-result${celebrate ? ' is-celebrating' : ''}" tabindex="-1" role="status">
      <div class="cm-trial-emblem">${levelBadge(badge)}</div>
      <h2>${esc(title)}</h2>
      ${score ? `<strong class="cm-trial-score">${esc(score)}</strong>` : ''}
      <p>${esc(detail)}</p>
      <mdui-button href="${login ? '#/user' : '#/levels'}" variant="filled">${login ? '前往登录' : '返回积分与升级规则'}</mdui-button>
    </div>
  </section>`;
  el.querySelector('.cm-trial-result').focus();
  if (celebrate) fallConfetti();
}

async function renderTrial(el) {
  if (!auth.token) {
    trialNotice(el, '登录后参加试炼', '使用你的 CurrentMusic 账号登录后继续。', { login: true });
    return;
  }
  let rules, questions;
  try {
    [rules, { questions }] = await Promise.all([api.levelRules(), api.levelTrial()]);
  } catch (e) {
    if (e.status === 403) {
      trialNotice(el, '试炼尚未解锁', '拿到金色音符盾章后，即可回来参加试炼。');
      return;
    }
    if (e.status === 409) {
      trialNotice(el, '已解锁终阶徽章', '可在成长中心查看累计积分与今日进度。', { badge: 7 });
      return;
    }
    throw e;
  }
  const { trial } = rules;
  const answers = Array(questions.length).fill(null);
  let current = 0;
  el.innerHTML = `<section class="cm-level-page cm-trial-page">
    <header class="cm-level-hero">
      <div>
        <span class="cm-level-eyebrow">CURRENTMUSIC · 终阶挑战</span>
        <h2>通过试炼</h2>
        <p class="cm-trial-meta"><span>${esc(trial.questionCount)} 道单选题</span>
          <span>满分 ${esc(trial.maxScore)}</span><span>${esc(trial.passScore)} 分及格</span></p>
      </div>
      <div class="cm-level-hero-badge">${levelBadge(trial.plusLevel)}</div>
    </header>
    <form class="cm-level-quiz">
      <div class="cm-trial-progress">
        <div><b>作答进度</b><span id="trialCount" aria-live="polite"></span></div>
        <progress max="${questions.length}" value="0" aria-label="作答进度"></progress>
        <nav class="cm-trial-steps" aria-label="跳转到题目">
          ${questions.map((_, i) => `<button type="button" data-question="${i}">${i + 1}</button>`).join('')}
        </nav>
      </div>
      <fieldset class="cm-trial-question"></fieldset>
      <p id="trialFeedback" class="cm-trial-feedback" role="status" tabindex="-1"></p>
      <div class="cm-trial-actions">
        <button id="trialPrev" class="cm-level-button" type="button">上一题</button>
        <button id="trialNext" class="cm-level-button is-primary" type="button">下一题</button>
        <button id="trialSubmit" class="cm-level-button is-primary" type="submit" hidden>提交试炼</button>
      </div>
    </form>
  </section>`;
  const form = el.querySelector('form');
  const field = form.querySelector('fieldset');
  const steps = Array.from(form.querySelectorAll('[data-question]'));
  const prev = form.querySelector('#trialPrev');
  const next = form.querySelector('#trialNext');
  const submit = form.querySelector('#trialSubmit');
  const feedback = form.querySelector('#trialFeedback');
  const bar = form.querySelector('progress');
  const count = form.querySelector('#trialCount');

  function updateProgress() {
    const answered = answers.filter(answer => answer !== null).length;
    count.textContent = `已答 ${answered} / ${questions.length}`;
    bar.value = answered;
    steps.forEach((step, i) => {
      const done = answers[i] !== null;
      step.setAttribute('aria-label', `第 ${i + 1} 题，${done ? '已答' : '未答'}`);
      step.classList.toggle('is-answered', done);
      if (i === current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  function showQuestion(index, focus = true) {
    if (submit.disabled) return;
    current = index;
    const { prompt, options } = questions[index];
    field.innerHTML = `<legend tabindex="-1"><span>第 ${index + 1} 题</span>${esc(prompt)}</legend>
      ${options.map((option, i) => `<label class="cm-trial-option">
        <input type="radio" name="answer" value="${i}" ${answers[index] === i ? 'checked' : ''}>
        <span class="cm-trial-option-letter" aria-hidden="true">${String.fromCharCode(65 + i)}</span>
        <span>${esc(option)}</span>
      </label>`).join('')}`;
    prev.disabled = index === 0;
    next.hidden = index === questions.length - 1;
    submit.hidden = !next.hidden;
    updateProgress();
    if (focus) field.querySelector('legend').focus();
  }

  prev.onclick = () => showQuestion(current - 1);
  next.onclick = () => showQuestion(current + 1);
  steps.forEach((step, i) => { step.onclick = () => showQuestion(i); });
  field.onchange = event => {
    answers[current] = Number(event.target.value);
    feedback.textContent = '';
    updateProgress();
  };
  showQuestion(0, false);

  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || submit.hidden) return;
    const missing = answers.indexOf(null);
    if (missing !== -1) {
      showQuestion(missing);
      feedback.textContent = '请答完全部题目后再提交。';
      return;
    }
    submit.disabled = true;
    field.disabled = true;
    feedback.textContent = '正在判分…';
    try {
      const grade = await api.submitLevelTrial(answers);
      if (!form.isConnected || location.hash.split('?')[0] !== '#/levels/trial') return;
      if (grade.level === trial.plusLevel) {
        trialNotice(el, grade.passed ? '恭喜通过试炼！' : '已解锁终阶徽章',
          '终阶星章已点亮。', { badge: grade.level, score: `${grade.score} / ${trial.maxScore}`, celebrate: grade.passed });
        api.me().catch(() => {});
        return;
      }
      feedback.textContent = `本次得分 ${grade.score} / ${trial.maxScore}。可以返回修改答案，再次提交。`;
    } catch (e) {
      feedback.textContent = e.message;
    } finally {
      submit.disabled = false;
      field.disabled = false;
      if (feedback.isConnected) feedback.focus();
    }
  };
}

function fallConfetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'cm-trial-confetti';
  layer.setAttribute('aria-hidden', 'true');
  const colors = ['#ffcf57', '#fb7fa4', '#68c9ff', '#79dfae', '#af93fc', '#ff9e6d'];
  for (let i = 0; i < 72; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `left:${(i + Math.random()) / 72 * 100}%;
      --paper:${colors[i % colors.length]}; --drift:${Math.round((Math.random() - .5) * 26)}vw;
      --spin:${Math.round((Math.random() - .5) * 1300)}deg;
      animation-delay:${Math.random() * 1.35}s; animation-duration:${2.6 + Math.random() * 1.1}s`;
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  const remove = () => {
    clearTimeout(timer);
    window.removeEventListener('hashchange', remove);
    layer.remove();
  };
  const timer = setTimeout(remove, 5300);
  window.addEventListener('hashchange', remove);
}
