import { api, auth, settings } from '../api.js';

const REPO = 'https://github.com/bileizhen/CurrentMusicX';
const STATUS = {
  processing: '正在处理反馈，可以离开页面，稍后回来查看。',
  publishing: '正在发布到 GitHub…',
  published: '反馈已发布。',
  rejected: '未能整理出可公开的问题或建议，请补充具体信息后再提交。',
  failed: '反馈未能发布，请稍后再试。',
  unconfirmed: '暂时无法确认是否发布成功，请先到 GitHub 查看，避免重复提交。',
};

export function render(el) {
  if (!auth.token) {
    el.innerHTML = `<section class="cm-feedback"><h2>意见反馈</h2><p>登录后可以提交问题和建议。</p>
      <a href="#/user">登录或注册</a></section>`;
    return;
  }

  const token = auth.token;
  const base = settings.base;
  const storageKey = `cm.feedback:${base}:${auth.user?.username || ''}`;
  let requestId = sessionStorage.getItem(storageKey);
  let timer;

  el.innerHTML = `<section class="cm-feedback">
    <h2>意见反馈</h2>
    <p>反馈交由 CurrentMusicAI 整理，并在 <a href="${REPO}/issues" target="_blank" rel="noopener">CurrentMusicX Issues</a>
      公开发布。主模型和备用模型都失败时会发布原文，请勿填写密码、令牌或个人信息。</p>
    <form>
      <label for="feedbackContent">问题或建议</label>
      <textarea id="feedbackContent" rows="6" maxlength="4000" required
        placeholder="遇到了什么问题？如果是故障，可以附上版本、复现步骤和预期结果。"></textarea>
      <label class="cm-feedback-consent"><input type="checkbox" required>我同意将这条反馈发布为公开 Issue</label>
      <mdui-button variant="filled" type="submit">提交反馈</mdui-button>
    </form>
    <p id="feedbackStatus" role="status"></p>
    <a id="feedbackIssue" target="_blank" rel="noopener" hidden></a>
    <button type="button" id="feedbackCheck" hidden>查询进度</button>
  </section>`;
  const form = el.querySelector('form');
  const input = el.querySelector('textarea');
  const consent = el.querySelector('input');
  const submit = el.querySelector('mdui-button');
  const message = el.querySelector('#feedbackStatus');
  const issue = el.querySelector('#feedbackIssue');
  const check = el.querySelector('#feedbackCheck');

  const current = () => el.isConnected && auth.token === token && settings.base === base;
  const locked = value => { submit.disabled = value; input.readOnly = value; };
  const forget = () => { sessionStorage.removeItem(storageKey); requestId = null; };

  function show(receipt) {
    const pending = receipt.status === 'processing' || receipt.status === 'publishing';
    locked(pending);
    message.textContent = STATUS[receipt.status] || '反馈状态未知';
    issue.hidden = true;
    if (receipt.status === 'published' && Number.isSafeInteger(receipt.issueNumber)) {
      input.value = '';
      consent.checked = false;
      issue.href = REPO + '/issues/' + receipt.issueNumber;
      issue.textContent = '查看 Issue #' + receipt.issueNumber;
      issue.hidden = false;
    } else if (receipt.status === 'unconfirmed') {
      issue.href = REPO + '/issues';
      issue.textContent = '查看 CurrentMusicX Issues';
      issue.hidden = false;
    }
    if (pending) timer = setTimeout(lookup, 3000);
  }

  async function lookup() {
    clearTimeout(timer);
    if (!current() || !requestId) return;
    locked(true);
    check.hidden = true;
    try {
      const receipt = await api.feedbackStatus(requestId);
      if (current()) show(receipt);
    } catch (e) {
      if (!current()) return;
      if (e.status === 404) {
        forget();
        locked(false);
        message.textContent = input.value ? '未找到本次提交，可以重新发送。' : '';
      } else {
        message.textContent = '暂时无法查询进度，请重试。';
        check.hidden = false;
      }
    }
  }

  check.onclick = lookup;
  form.onsubmit = async event => {
    event.preventDefault();
    if (submit.disabled || !current()) return;
    const content = input.value.trim();
    const length = Array.from(content).length;
    if (length < 8 || length > 2000) {
      message.textContent = '请填写 8 至 2000 个字。';
      input.focus();
      return;
    }
    requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      byte => byte.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(storageKey, requestId);
    locked(true);
    issue.hidden = true;
    message.textContent = '正在提交反馈…';
    try {
      const receipt = await api.submitFeedback(requestId, content);
      if (current()) show(receipt);
    } catch (e) {
      if (!current()) return;
      if (e.status === 400 || e.status === 429 || e.status === 503) {
        forget();
        locked(false);
        message.textContent = e.message;
      } else {
        await lookup();
      }
    }
  };
  if (requestId) lookup();
}
