// Independent REST adapters; no provider credentials or third-party source code.
const { MatchError, checkDuration } = require('./ncm-match-core.cjs');

const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
const names = artists => [...new Set((artists || []).map(a => normalize(a.name)).filter(Boolean))].sort();

function durationMs(value) {
  const m = /^(\d+)分(\d+)秒$/.exec(String(value || ''));
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : 0;
}

function selectQQSong(reference, items) {
  const wanted = names(reference.artists);
  if (!wanted.length || !normalize(reference.name)) throw new MatchError('reference_identity_missing');
  const candidates = [];
  for (const item of Array.isArray(items) ? items.slice(0, 20) : []) {
    for (const song of [item, ...(Array.isArray(item?.grp) ? item.grp.slice(0, 10) : [])]) {
      if (!song || !/^[A-Za-z0-9]{10,20}$/.test(song.mid || '')) continue;
      if (normalize(song.song) !== normalize(reference.name)) continue;
      const artists = Array.isArray(song.singer_list) ? song.singer_list : [];
      if (JSON.stringify(names(artists)) !== JSON.stringify(wanted)) continue;
      // A plain title plus a version subtitle must not masquerade as the studio recording.
      if (song.subtitle && /(live|remix|cover|伴奏|翻唱|现场|演唱会|混音|铃声|片段)/i.test(song.subtitle)
          && !normalize(reference.name).includes(normalize(song.subtitle))) continue;
      try { checkDuration(durationMs(song.interval), reference.duration); } catch { continue; }
      candidates.push(song);
    }
  }
  candidates.sort((a, b) =>
    Number(normalize(b.album) === normalize(reference.album?.name)) - Number(normalize(a.album) === normalize(reference.album?.name))
    || Math.abs(durationMs(a.interval) - reference.duration) - Math.abs(durationMs(b.interval) - reference.duration));
  if (!candidates.length) throw new MatchError('identity_mismatch');
  return candidates[0];
}

async function jsonRequest(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(3500),
      headers: { Accept: 'application/json', 'User-Agent': 'CurrentMusic/1.0' } });
    if (!response.ok) throw new MatchError('provider_http_rejected');
    const text = await response.text();
    if (text.length > 262144) throw new MatchError('provider_response_invalid');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof MatchError) throw error;
    throw new MatchError('provider_unavailable');
  }
}

function qqCandidates(reference, { fetchImpl = fetch } = {}) {
  let search;
  const find = () => search ||= (async () => {
    const url = new URL('https://api.vkeys.cn/v2/music/tencent');
    url.searchParams.set('word', [reference.name, ...(reference.artists || []).map(a => a.name)].filter(Boolean).join(' '));
    const result = await jsonRequest(url, fetchImpl);
    if (result?.code !== 200 || !Array.isArray(result.data)) throw new MatchError('provider_response_invalid');
    return selectQQSong(reference, result.data);
  })();
  // The current link API is distinct from v2's URL, which can return only a preview.
  return [2, 1].map(quality => ({ name: 'vkeys:qq:' + quality, timeoutMs: 7500,
    get: async () => {
      const song = await find();
      const url = new URL('https://api.vkeys.cn/music/tencent/song/link');
      url.searchParams.set('mid', song.mid); url.searchParams.set('quality', String(quality));
      const result = await jsonRequest(url, fetchImpl);
      if (result?.code !== 0 || !result.data?.url || result.data.songMID !== song.mid) throw new MatchError('provider_response_invalid');
      return result.data.url;
    },
  }));
}

module.exports = { qqCandidates, selectQQSong };
