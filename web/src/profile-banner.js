import { mdui } from './md.js';
import { api, auth, settings } from './api.js';
import { confirmDialog, esc, toast } from './ui.js';

const MAX_BYTES = 1024 * 1024;

export function profileBannerHTML(path, editable = false) {
  const url = api.profileBannerUrl(path);
  return `<div class="cm-profile-banner">
    ${url ? `<img src="${esc(url)}" alt="" onerror="this.remove()">` : ''}
    ${editable ? `<div class="cm-banner-actions">
      <button type="button" data-banner="select">
        <span class="material-icons-outlined" aria-hidden="true">image</span>${url ? '更换横幅' : '上传横幅'}
      </button>
      ${url ? '<button type="button" data-banner="remove" aria-label="移除横幅" title="移除横幅"><span class="material-icons-outlined" aria-hidden="true">delete_outline</span></button>' : ''}
    </div><input type="file" accept="image/jpeg,image/png,image/webp" hidden>` : ''}
  </div>`;
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

export function bindProfileBanner(container) {
  const banner = container.querySelector('.cm-profile-banner');
  const input = banner.querySelector('input');
  const select = banner.querySelector('[data-banner="select"]');
  const remove = banner.querySelector('[data-banner="remove"]');
  const token = auth.token;
  const base = settings.base;
  const isCurrent = () => banner.isConnected && token === auth.token && base === settings.base;
  let busy = false;

  function setBusy(value) {
    busy = select.disabled = value;
    if (remove) remove.disabled = value;
  }

  function update(path) {
    if (!isCurrent()) return;
    banner.outerHTML = profileBannerHTML(path, true);
    bindProfileBanner(container);
  }

  select.onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (!file || busy || !isCurrent()) return;
    if (file.size > MAX_BYTES) return toast('横幅图片需 ≤1 MiB');
    if (file.type && !/^image\/(jpeg|png|webp)$/.test(file.type)) return toast('请选择 JPEG、PNG 或 WebP 图片');
    setBusy(true);
    let dataUrl;
    try { dataUrl = await readImage(file); }
    catch (e) { toast(e.message); }
    finally { setBusy(false); }
    if (!dataUrl || !isCurrent()) return;

    const dialog = mdui.dialog({
      headline: '预览主页横幅',
      body: `<div class="cm-banner-preview">
        <div class="cm-profile-banner"><img alt=""></div>
        <p>横幅会公开展示。图片将居中裁剪为 4∶1。</p>
        <div class="cm-banner-preview-actions">
          <mdui-button variant="text" data-cancel>取消</mdui-button>
          <mdui-button variant="filled" data-save disabled>保存横幅</mdui-button>
        </div>
      </div>`,
    });
    const save = dialog.querySelector('[data-save]');
    const image = dialog.querySelector('img');
    image.onload = () => { save.disabled = false; };
    image.onerror = () => toast('无法预览这张图片');
    image.src = dataUrl;
    dialog.querySelector('[data-cancel]').onclick = () => { dialog.open = false; };
    save.onclick = async () => {
      if (busy || save.disabled || !isCurrent()) return;
      setBusy(true);
      save.loading = true;
      try {
        const result = await api.uploadProfileBanner(dataUrl.split(',')[1]);
        dialog.open = false;
        update(result.bannerUrl);
        toast('横幅已更新');
      } catch (e) { toast('上传失败：' + e.message); }
      finally { save.loading = false; setBusy(false); }
    };
  };

  if (remove) remove.onclick = () => confirmDialog({
    title: '移除主页横幅',
    body: '移除后，主页会显示默认横幅。',
    onOk: async () => {
      if (busy || !isCurrent()) return;
      setBusy(true);
      try {
        const result = await api.removeProfileBanner();
        update(result.bannerUrl);
        toast('横幅已移除');
      } catch (e) { toast('移除失败：' + e.message); }
      finally { setBusy(false); }
    },
  });
}
