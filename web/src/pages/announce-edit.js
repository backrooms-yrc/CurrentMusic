// 公告编辑页（v1.28.45：从管理员面板的弹窗改为独立页面）。
// 路由：#/announce/new（发布）与 #/announce/<id>（编辑）。
import { api, auth } from '../api.js';
import { esc, toast } from '../ui.js';

function isAdmin() {
  const u = auth.user || {};
  return !!(u.isAdmin || u.isSuper || u.isOwner);
}

export async function render(el, params) {
  if (!isAdmin()) {
    el.innerHTML = `<div class="cm-page cm-peditor-page">
      <div class="cm-empty" style="padding:48px 0">需要管理员权限才能发布公告</div></div>`;
    return;
  }
  const id = params && params[0] ? parseInt(params[0], 10) : 0;
  let d = { title: '', body: '', link: '', pinned: false };
  if (id) {
    try {
      const data = await api.adminAnnouncements();
      const found = (data.items || []).find(a => a.id === id);
      if (!found) { toast('公告不存在或已移除'); location.hash = '#/admin'; return; }
      if (!found.canEdit) { toast('只能编辑自己发布的公告'); location.hash = '#/admin'; return; }
      d = found;
    } catch (e) {
      toast('加载公告失败：' + e.message);
      location.hash = '#/admin';
      return;
    }
  }

  el.innerHTML = `
    <div class="cm-page cm-peditor-page">
      <div class="cm-sec-head"><h2>${id ? '编辑公告' : '发布公告'}</h2><span class="cm-sec-more" id="annCancel">取消</span></div>
      <div class="cm-form" style="display:flex;flex-direction:column;gap:12px">
        <mdui-text-field id="annTitle" label="标题" variant="outlined" maxlength="60"
          value="${esc(d.title || '')}" style="width:100%"></mdui-text-field>
        <mdui-text-field id="annBody" label="正文（支持 Markdown）" variant="outlined" type="textarea" rows="8"
          value="${esc(d.body || '')}" style="width:100%"></mdui-text-field>
        <mdui-text-field id="annLink" label="详情链接（可选，http/https）" variant="outlined"
          value="${esc(d.link || '')}" style="width:100%"></mdui-text-field>
        <div class="cm-setting" style="padding:0">
          <span class="material-icons-outlined">push_pin</span>置顶
          <mdui-switch id="annPinned" ${d.pinned ? 'checked' : ''} style="margin-left:auto"></mdui-switch>
        </div>
        <div class="cm-more-s" style="opacity:.7">
          客户端每次打开网页 / App 都会弹窗展示生效中的公告，置顶排最前。
        </div>
      </div>
      <div class="cm-peditor-actions">
        <mdui-button variant="filled" id="annSave" full-width>${id ? '保存' : '发布'}</mdui-button>
      </div>
    </div>`;

  el.querySelector('#annCancel').onclick = () => { location.hash = '#/admin'; };
  const saveBtn = el.querySelector('#annSave');
  saveBtn.onclick = async () => {
    const payload = {
      title: (el.querySelector('#annTitle').value || '').trim(),
      body: (el.querySelector('#annBody').value || '').trim(),
      link: (el.querySelector('#annLink').value || '').trim(),
      pinned: !!el.querySelector('#annPinned').checked,
    };
    if (!payload.title) return toast('请填写标题');
    saveBtn.setAttribute('loading', '');
    try {
      if (id) await api.updateAnnouncement(id, payload);
      else await api.createAnnouncement(payload);
      toast(id ? '已保存' : '已发布，客户端下次打开即可看到');
      location.hash = '#/admin';
    } catch (e) {
      toast(e.message);
    } finally { saveBtn.removeAttribute('loading'); }
  };
}
