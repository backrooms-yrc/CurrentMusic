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

const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, '0')).join('');

async function previewMedia(file, isVideo, limits) {
  const url = URL.createObjectURL(file);
  const preview = document.createElement(isVideo ? 'video' : 'img');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('无法预览该文件')), 10000);
      const done = error => {
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      preview.onerror = () => done(new Error('浏览器无法读取该媒体文件'));
      if (isVideo) {
        preview.preload = 'metadata';
        preview.controls = true;
        preview.playsInline = true;
        preview.onloadedmetadata = () => done();
      } else {
        preview.alt = '待上传截图';
        preview.onload = () => done();
      }
      preview.src = url;
    });
    const [short, long] = (isVideo ? [preview.videoWidth, preview.videoHeight]
      : [preview.naturalWidth, preview.naturalHeight]).sort((a, b) => a - b);
    if (!short || long > limits.maxLongEdge || (isVideo ? short > limits.maxShortEdge
      || !Number.isFinite(preview.duration) || preview.duration <= 0 || preview.duration > limits.maxDurationSeconds : short * long > limits.maxPixels)) {
      throw new Error(isVideo ? '录屏尺寸或时长超过限制' : '截图尺寸超过限制');
    }
    return { preview, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

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
  let draftId, timer, mediaLimits, busy = false;
  const files = new Map();

  el.innerHTML = `<section class="cm-feedback">
    <h2>意见反馈</h2>
    <p>反馈交由 CurrentMusicAI 整理，并在 <a href="${REPO}/issues" target="_blank" rel="noopener">CurrentMusicX Issues</a>
      公开发布。主模型和备用模型都失败时会发布原文，请勿填写密码、令牌或个人信息。</p>
    <form>
      <label for="feedbackType">反馈类型</label>
      <select id="feedbackType"><option value="Bug">报告问题</option><option value="Feature">功能建议</option></select>
      <label for="feedbackContent">标题和内容</label>
      <textarea id="feedbackContent" rows="6" maxlength="4000" required
        placeholder="首行填写标题，随后描述问题或建议。报告问题时请附上版本、复现步骤和预期结果。"></textarea>
      <fieldset id="feedbackMedia" hidden>
        <legend>截图与录屏</legend>
        <p id="feedbackMediaLimits"></p>
        <p>上传前请预览并遮挡通知、凭据和私人内容，同时检查录屏声音。</p>
        <label for="feedbackFiles">选择附件</label>
        <input id="feedbackFiles" type="file" multiple accept="image/jpeg,image/png,video/mp4">
        <div class="cm-feedback-files" id="feedbackPreviews"></div>
        <label class="cm-feedback-consent"><input id="feedbackMediaConsent" type="checkbox">我同意将这些截图、录屏画面和声音交给项目管理员查看</label>
      </fieldset>
      <label class="cm-feedback-consent"><input id="feedbackPublicConsent" type="checkbox" required>我同意将文字反馈发布为公开 Issue</label>
      <mdui-button variant="filled" type="submit">提交反馈</mdui-button>
    </form>
    <p id="feedbackStatus" role="status"></p>
    <a id="feedbackIssue" target="_blank" rel="noopener" hidden></a>
    <button type="button" id="feedbackCheck" hidden>查询进度</button>
  </section>`;
  const form = el.querySelector('form');
  const input = el.querySelector('textarea');
  const type = el.querySelector('#feedbackType');
  const consent = el.querySelector('#feedbackPublicConsent');
  const mediaBox = el.querySelector('#feedbackMedia');
  const picker = el.querySelector('#feedbackFiles');
  const previews = el.querySelector('#feedbackPreviews');
  const mediaConsent = el.querySelector('#feedbackMediaConsent');
  const submit = el.querySelector('mdui-button');
  const message = el.querySelector('#feedbackStatus');
  const issue = el.querySelector('#feedbackIssue');
  const check = el.querySelector('#feedbackCheck');

  const current = () => el.isConnected && auth.token === token && settings.base === base;
  const locked = value => {
    busy = value;
    submit.disabled = value;
    input.readOnly = value;
    type.disabled = value;
    mediaBox.disabled = value;
    consent.disabled = value;
  };
  const forget = () => { sessionStorage.removeItem(storageKey); requestId = null; };
  const toggleMedia = () => { mediaBox.hidden = type.value !== 'Bug' || !mediaLimits; };
  const releaseFiles = () => {
    for (const entry of files.values()) URL.revokeObjectURL(entry.url);
    files.clear();
    previews.textContent = '';
    picker.value = '';
    mediaConsent.checked = false;
  };
  if (el.parentNode) {
    const observer = new MutationObserver(() => {
      if (!el.isConnected) { observer.disconnect(); clearTimeout(timer); releaseFiles(); }
    });
    observer.observe(el.parentNode, { childList: true });
  }
  type.onchange = () => {
    if (files.size) {
      type.value = 'Bug';
      message.textContent = '切换反馈类型前请先移除附件。';
    }
    toggleMedia();
  };
  api.feedbackCapabilities().then(({media}) => {
    if (!current() || !media?.enabled) return;
    mediaLimits = media;
    el.querySelector('#feedbackMediaLimits').textContent = `最多 ${media.screenshot.maxCount} 张 JPEG 或 PNG，每张 ${media.screenshot.maxBytes / 1048576} MiB。可附一段 ${media.video.maxDurationSeconds} 秒、${media.video.maxBytes / 1048576} MiB 以内的 H.264 MP4。`;
    toggleMedia();
  }).catch(() => {});

  picker.onchange = async () => {
    if (!mediaLimits || busy) return;
    const selected = Array.from(picker.files);
    picker.value = '';
    const errors = [];
    locked(true);
    try {
      for (const file of selected) {
        if (!current()) return;
        const isVideo = mediaLimits.video.contentTypes.includes(file.type);
        const limits = isVideo ? mediaLimits.video : mediaLimits.screenshot;
        const slots = Array.from({ length: limits.maxCount }, (_, n) => `${isVideo ? 'video' : 'screenshot'}-${n + 1}`);
        const slot = slots.find(key => !files.has(key));
        const total = Array.from(files.values()).reduce((bytes, entry) => bytes + entry.file.size, file.size);
        if (!slot || !limits.contentTypes.includes(file.type) || !file.size || file.size > limits.maxBytes || total > mediaLimits.maxTotalBytes) {
          errors.push(file.name + ' 超出附件数量、类型或大小限制');
          continue;
        }
        try {
          const { preview, url } = await previewMedia(file, isVideo, limits);
          if (!current()) { URL.revokeObjectURL(url); return; }
          const row = document.createElement('div');
          const name = document.createElement('span');
          name.textContent = file.name;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '移除';
          remove.setAttribute('aria-label', '移除 ' + file.name);
          const entry = { file, url, started: false, receipt: null };
          const progress = document.createElement('progress');
          progress.hidden = true;
          progress.max = 100;
          progress.setAttribute('aria-label', file.name + ' 上传进度');
          entry.progress = progress;
          files.set(slot, entry);
          remove.onclick = async () => {
            if (busy) return;
            locked(true);
            try {
              if (entry.started) await api.deleteFeedbackMedia(draftId, slot);
              if (!current()) return;
              URL.revokeObjectURL(url);
              files.delete(slot);
              row.remove();
              if (!files.size) mediaConsent.checked = false;
              message.textContent = '';
            } catch (error) {
              if (current()) message.textContent = `${error.message}，可再次尝试移除。`;
            } finally { if (current()) locked(false); }
          };
          row.append(preview, name, remove, progress);
          previews.appendChild(row);
        } catch (error) { errors.push(`${file.name}：${error.message}`); }
      }
      if (selected.length) mediaConsent.checked = false;
      message.textContent = errors.join('。');
    } finally { if (current()) locked(false); }
  };

  function show(receipt) {
    const pending = receipt.status === 'processing' || receipt.status === 'publishing';
    if (draftId) {
      releaseFiles();
      draftId = null;
    }
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
    const text = input.value.trim().replace(/^\[(?:Bug|Feature)\]\s*/i, '');
    const content = `[${type.value}] ${text}`;
    if (Array.from(text).length < 8 || Array.from(content).length > 2000) {
      message.textContent = '请填写 8 至 2000 个字。';
      input.focus();
      return;
    }
    if (files.size && !mediaConsent.checked) {
      message.textContent = '请确认同意上传截图与录屏。';
      mediaConsent.focus();
      return;
    }
    if (!draftId) draftId = newRequestId();
    locked(true);
    issue.hidden = true;
    const manifest = [];
    let submitting = false;
    try {
      for (const [slot, entry] of files) {
        message.textContent = `正在上传 ${entry.file.name}…`;
        if (!entry.receipt || Date.parse(entry.receipt.expiresAt) <= Date.now()) {
          entry.started = true;
          entry.progress.hidden = false;
          entry.progress.value = 0;
          entry.receipt = await api.uploadFeedbackMedia(draftId, slot, entry.file, (sent, total) => {
            entry.progress.value = Math.floor(100 * sent / total);
          });
        }
        if (!current()) return;
        manifest.push({ slot, sha256: entry.receipt.sha256 });
      }
      message.textContent = '正在提交反馈…';
      requestId = draftId;
      sessionStorage.setItem(storageKey, requestId);
      submitting = true;
      const receipt = await api.submitFeedback(requestId, content, manifest);
      if (current()) show(receipt);
    } catch (e) {
      if (!current()) return;
      if (!submitting) {
        locked(false);
        message.textContent = `${e.message}。可重试提交或移除附件。`;
      } else if ([400, 413, 429, 503].includes(e.status) || e.code === 'media_not_ready') {
        if (e.code === 'media_not_ready') for (const entry of files.values()) entry.receipt = null;
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
