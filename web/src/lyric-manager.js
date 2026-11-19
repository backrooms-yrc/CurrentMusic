import { api, auth, settings } from './api.js';
import { mdui } from './md.js';
import { esc } from './ui.js';
import { exportLyric, importLyricFile, lyricOffset } from './local-lyrics.js';

export function lyricOwner() { return auth.scope || settings.base; }

function lyricsKey(id, owner = lyricOwner()) {
  return 'cm.lyrics.v1:' + JSON.stringify([owner, id]);
}

export function lyricPreference(id) {
  try { return JSON.parse(localStorage.getItem(lyricsKey(id))) || {}; } catch { return {}; }
}

export function openLyricManager(song, { current, data, changed }) {
  const owner = lyricOwner(), id = song.ncm_id;
  const preference = lyricPreference(id);
  let preview = null, sequence = 0;
  const dialog = mdui.dialog({
    headline: '歌词管理',
    body: `<div class="cm-form cm-lyric-manager">
      <label>导入歌词 <input id="lyricFile" type="file" accept=".lrc,.fia,.ttml,.vtt,.yrc,.qrc,.krc"></label>
      <form id="lyricLookup"><label>查找曲目歌词 <input id="lyricKeyword" type="search" maxlength="60" value="${esc(String(song.name || '').slice(0, 60))}"></label>
        <button type="submit">查找</button>
      </form>
      <div id="lyricCandidates"></div>
      <pre id="lyricPreview" hidden></pre>
      <mdui-button id="lyricUse" variant="filled" disabled>使用预览歌词</mdui-button>
      <mdui-button id="lyricRemove" variant="text" ${preference.data ? '' : 'hidden'}>恢复自动歌词</mdui-button>
      <label>歌词偏移（毫秒） <input id="lyricOffset" type="number" step="1" min="-60000" max="60000" value="${lyricOffset(preference.offsetMs)}"></label>
      <div><mdui-button id="lyricApplyOffset" variant="tonal">应用偏移</mdui-button>
        <mdui-button id="lyricResetOffset" variant="text">归零</mdui-button></div>
      <div><mdui-button variant="text" data-export="fia">导出 FIA</mdui-button>
        <mdui-button variant="text" data-export="lrc">导出 LRC</mdui-button></div>
      <p id="lyricManageStatus" role="status" aria-live="polite"></p>
    </div>`,
    actions: [{ text: '关闭' }],
  });
  const $ = selector => dialog.querySelector(selector);
  const status = $('#lyricManageStatus');
  const offset = $('#lyricOffset');
  const available = () => dialog.open && current() && lyricOwner() === owner;

  function save(update, reload) {
    if (!available()) { status.textContent = '当前曲目或账号已改变，请重新打开歌词管理。'; return false; }
    const next = { ...lyricPreference(id), ...update };
    try { localStorage.setItem(lyricsKey(id, owner), JSON.stringify(next)); }
    catch { status.textContent = '无法保存歌词，请检查浏览器存储空间。'; return false; }
    changed(reload);
    return true;
  }

  function setPreview(result) {
    preview = result;
    const pre = $('#lyricPreview');
    pre.hidden = !preview;
    pre.textContent = preview?.data.lines.slice(0, 8).map(row => row.txt).join('\n') || '';
    $('#lyricUse').disabled = !preview;
  }

  $('#lyricFile').onchange = async event => {
    const file = event.target.files[0], request = ++sequence;
    event.target.value = '';
    setPreview(null);
    $('#lyricCandidates').textContent = '';
    if (!file) return;
    status.textContent = '正在读取歌词…';
    try {
      const result = await importLyricFile(file);
      if (request !== sequence || !available()) return;
      setPreview(result);
      status.textContent = '预览已就绪。';
    } catch (error) {
      if (request === sequence && available()) status.textContent = error.message || '无法读取歌词';
    }
  };

  $('#lyricLookup').onsubmit = async event => {
    event.preventDefault();
    const query = $('#lyricKeyword').value.trim();
    if (!query || !available()) return;
    const request = ++sequence;
    setPreview(null);
    $('#lyricCandidates').textContent = '';
    status.textContent = '正在查找同名和相关曲目…';
    try {
      const response = await api.search(query, 0, 10, 'song');
      if (request !== sequence || !available()) return;
      const candidates = (response.songs || []).filter(track => track.ncm_id);
      status.textContent = candidates.length ? '选择曲目以预览歌词。' : '没有找到曲目。';
      for (const track of candidates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = [track.name, track.artists].filter(Boolean).join(' · ');
        button.onclick = async () => {
          const selected = ++sequence;
          setPreview(null);
          status.textContent = '正在读取所选曲目的歌词…';
          try {
            const lyric = await api.lyric(track.ncm_id, true);
            if (selected !== sequence || !available()) return;
            if (!lyric?.lines?.length) { status.textContent = '这首曲目没有同步歌词。'; return; }
            setPreview({ data: { ...lyric, source: 'local:manual' }, offsetMs: 0 });
            status.textContent = '预览已就绪。';
          } catch (error) {
            if (selected === sequence && available()) status.textContent = error.message;
          }
        };
        $('#lyricCandidates').appendChild(button);
      }
    } catch (error) {
      if (request === sequence && available()) status.textContent = error.message;
    }
  };

  $('#lyricUse').onclick = () => {
    if (!preview || !save(preview, true)) return;
    offset.value = preview.offsetMs;
    $('#lyricRemove').hidden = false;
    status.textContent = '此曲的歌词已保存到当前浏览器。';
  };
  $('#lyricRemove').onclick = () => {
    if (!save({ data: null }, true)) return;
    $('#lyricRemove').hidden = true;
    status.textContent = '已恢复自动歌词。';
  };
  function changeOffset(value) {
    if (!save({ offsetMs: value }, false)) return;
    offset.value = value;
    status.textContent = value === 0 ? '偏移已归零。' : `已应用 ${value} 毫秒偏移。`;
  }
  $('#lyricApplyOffset').onclick = () => {
    if (offset.reportValidity()) changeOffset(lyricOffset(offset.valueAsNumber));
  };
  $('#lyricResetOffset').onclick = () => changeOffset(0);
  dialog.querySelectorAll('[data-export]').forEach(button => button.onclick = () => {
    if (!available()) return;
    try {
      const type = button.dataset.export;
      const output = exportLyric(type, data()?.lines || [], song, lyricPreference(id).offsetMs);
      const url = URL.createObjectURL(new Blob([output], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = String(song.name || 'lyrics').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') + '.' + type;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { status.textContent = error.message || '无法导出歌词'; }
  });
}
