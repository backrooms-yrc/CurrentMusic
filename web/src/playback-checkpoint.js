const PREFIX = 'cm.playback.v1:';
const LIMIT = 100;
const SONG_FIELDS = ['ncm_id', 'name', 'artists', 'artist_ids', 'album', 'pic', 'duration', 'fee', 'pop', 'mv'];

function serializableSong(song) {
  const record = {};
  for (const key of SONG_FIELDS) if (song[key] != null) record[key] = song[key];
  if (/^#\/(?:pl|ncmpl)\/[\w-]+$|^#\/daily$/.test(song.queuePlaylist)) record.queuePlaylist = song.queuePlaylist;
  return record;
}

export function saveCheckpoint(scope, queue, index, posMs) {
  if (!scope) return;
  try {
    const key = PREFIX + scope;
    if (!queue[index]) {
      localStorage.setItem(key, '{}');
      return;
    }
    // Keep the active song and upcoming tracks even if the active index is above the storage cap.
    const first = Math.min(Math.max(0, index - Math.floor(LIMIT / 2)), Math.max(0, queue.length - LIMIT));
    localStorage.setItem(key, JSON.stringify({
      queue: queue.slice(first, first + LIMIT).map(serializableSong),
      index: index - first,
      posMs: Math.round(posMs),
    }));
  } catch { /* Blocked or full storage must not interrupt playback. */ }
}

export function readCheckpoint(scope, migrateLegacy) {
  if (!scope) return null;
  try {
    const key = PREFIX + scope;
    const saved = localStorage.getItem(key);
    const legacy = saved == null && migrateLegacy ? localStorage.getItem('cm.lastq') : null;
    const data = JSON.parse(saved || legacy || '{}');
    if (!Array.isArray(data.queue) || !Number.isInteger(data.index) ||
        !data.queue[data.index] || !data.queue.every(song => song && song.ncm_id)) return null;
    const posMs = Number.isFinite(data.posMs) && data.posMs > 0 ? data.posMs : 0;
    const queue = data.queue.map(serializableSong);
    if (legacy) {
      saveCheckpoint(scope, queue, data.index, posMs);
      if (localStorage.getItem(key)) localStorage.removeItem('cm.lastq');
    }
    return { queue, index: data.index, posMs };
  } catch { return null; }
}
