import { api, auth } from '../api.js';
import { esc, levelLabel } from '../ui.js';

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
    auth.token ? api.me().catch(() => null) : null,
  ]);
  const { levels, dailyPoints, trial } = rules;
  el.innerHTML = `<section class="cm-sec cm-level-page">
    <h2>积分与升级规则</h2>
    ${me?.level ? `<p>当前等级 <b>${levelLabel(me.level)}</b> · 累计 <b>${esc(me.points)}</b> 积分</p>` : ''}
    <p>每天首次使用有效登录会话访问 CurrentMusic 时获得 ${esc(dailyPoints)} 积分。同一账号每天最多领取一次，按北京时间零点换日。</p>
    <table class="cm-level-table">
      <thead><tr><th scope="col">等级</th><th scope="col">升级所需累计积分</th></tr></thead>
      <tbody>${levels.map(({ level, points }) => `<tr><th scope="row">${levelLabel(level)}</th><td>${esc(points)}</td></tr>`).join('')}</tbody>
    </table>
    <h3>Lv.6 Plus 试炼</h3>
    <p>达到 Lv.6 后开放试炼。共 ${esc(trial.questionCount)} 道单选题，满分 ${esc(trial.maxScore)} 分，达到 ${esc(trial.passScore)} 分即可升级。未通过可以重新作答。</p>
    ${me?.level === trial.level ? '<mdui-button href="#/levels/trial" variant="filled">参加试炼</mdui-button>' : ''}
  </section>`;
}

async function renderTrial(el) {
  if (!auth.token) {
    el.innerHTML = '<div class="cm-empty">登录后可参加试炼。</div><mdui-button href="#/user">前往登录</mdui-button>';
    return;
  }
  let rules, questions;
  try {
    [rules, { questions }] = await Promise.all([api.levelRules(), api.levelTrial()]);
  } catch (e) {
    if (e.status !== 403 && e.status !== 409) throw e;
    el.innerHTML = `<div class="cm-empty">${esc(e.message)}</div><mdui-button href="#/levels">积分与升级规则</mdui-button>`;
    return;
  }
  const { trial } = rules;
  el.innerHTML = `<section class="cm-sec cm-level-page">
    <h2>通过试炼</h2>
    <p>共 ${esc(trial.questionCount)} 道单选题，满分 ${esc(trial.maxScore)} 分，${esc(trial.passScore)} 分及格。</p>
    <form class="cm-level-quiz">
      ${questions.map(({ prompt, options }, i) => `<fieldset>
        <legend>${i + 1}. ${esc(prompt)}</legend>
        ${options.map((option, j) => `<label><input type="radio" name="answer${i}" value="${j}" required>${esc(option)}</label>`).join('')}
      </fieldset>`).join('')}
      <p id="trialResult" role="status" tabindex="-1"></p>
      <button class="cm-level-submit" type="submit">提交试炼</button>
      <mdui-button href="#/levels" variant="text">积分与升级规则</mdui-button>
    </form>
  </section>`;
  const form = el.querySelector('form');
  const button = form.querySelector('button');
  const result = form.querySelector('#trialResult');
  form.onsubmit = async event => {
    event.preventDefault();
    if (button.disabled) return;
    const fields = new FormData(form);
    const answers = questions.map((_, i) => Number(fields.get(`answer${i}`)));
    button.disabled = true;
    let finished = false;
    try {
      const grade = await api.submitLevelTrial(answers);
      finished = grade.level === trial.plusLevel;
      result.textContent = finished
        ? `得分 ${grade.score}/${trial.maxScore}。当前等级 Lv.6 Plus。`
        : `得分 ${grade.score}/${trial.maxScore}，未通过试炼。可以修改答案后再次提交。`;
      if (finished) {
        form.querySelectorAll('fieldset').forEach(group => { group.disabled = true; });
        button.hidden = true;
        api.me().catch(() => {});
      }
    } catch (e) {
      result.textContent = e.message;
    } finally {
      button.disabled = finished;
      result.focus();
    }
  };
}
