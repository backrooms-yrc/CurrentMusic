// CurrentMusic's independent validation layer; upstream provider implementations stay external.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

class MatchError extends Error {
  constructor(code, attempts = []) { super(code); this.code = code; this.attempts = attempts; }
}

function mediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new MatchError('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new MatchError('invalid_url');
  // The Web player uses HTTPS. Keep loopback HTTP available for local regression fixtures.
  if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) url.protocol = 'https:';
  return url.href;
}

function audioHeader(buffer) {
  return ['ID3', 'fLaC', 'OggS'].some(prefix => buffer.subarray(0, prefix.length).toString() === prefix)
    || (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE')
    || buffer.subarray(4, 8).toString() === 'ftyp'
    || (buffer[0] === 255 && (buffer[1] & 224) === 224);
}

function checkDuration(actualMs, expectedMs) {
  if (!Number.isFinite(expectedMs) || expectedMs <= 0) throw new MatchError('reference_duration_missing');
  if (!Number.isFinite(actualMs) || actualMs <= 0) throw new MatchError('audio_duration_missing');
  const tolerance = Math.max(2000, Math.min(10000, expectedMs * .03));
  if (Math.abs(actualMs - expectedMs) > tolerance) {
    const error = new MatchError('duration_mismatch');
    error.durationMs = actualMs; error.expectedDurationMs = expectedMs;
    throw error;
  }
}

async function inspectAudio(candidate, reference, { fetchImpl = fetch, executeImpl = execute } = {}) {
  const url = mediaUrl(candidate);
  let response, head = Buffer.alloc(0), size = 0;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(3000),
      headers: { Range: 'bytes=0-4095', 'Accept-Encoding': 'identity', 'User-Agent': 'CurrentMusic/1.0' } });
    if (!response.ok) throw new MatchError('http_rejected');
    mediaUrl(response.url || url);
    const total = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
    size = Number(total?.[1] || (response.status === 200 ? response.headers.get('content-length') : 0)) || 0;
    const reader = response.body.getReader();
    try {
      while (head.length < 4096) {
        const chunk = await reader.read();
        if (chunk.done) break;
        head = Buffer.concat([head, Buffer.from(chunk.value).subarray(0, 4096 - head.length)]);
      }
    } finally { await reader.cancel().catch(() => {}); }
  } catch (error) {
    if (error instanceof MatchError) throw error;
    throw new MatchError('audio_fetch_failed');
  }
  if (!audioHeader(head)) throw new MatchError('not_audio');
  let data;
  try {
    const result = await executeImpl(process.env.CM_FFPROBE || 'ffprobe', [
      '-v', 'error', '-rw_timeout', '3000000', '-protocol_whitelist', 'http,https,tcp,tls,crypto',
      '-analyzeduration', '1000000', '-probesize', '131072',
      '-show_entries', 'format=duration,size,bit_rate:stream=codec_type,codec_name,duration,bit_rate,sample_rate,bits_per_raw_sample,channels:stream_disposition=attached_pic',
      '-of', 'json', '-i', url,
    ], { timeout: 5000, maxBuffer: 131072 });
    data = JSON.parse(result.stdout);
  } catch { throw new MatchError('audio_probe_failed'); }
  const streams = data.streams || [];
  const audio = streams.find(stream => stream.codec_type === 'audio');
  if (!audio || streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)) throw new MatchError('not_audio');
  const durationMs = Math.round(Number(data.format?.duration || audio.duration) * 1000);
  checkDuration(durationMs, reference.duration);
  const streamBr = Number(audio.bit_rate) || 0;
  if (size > 0 && streamBr > 0 && size * 8 < durationMs / 1000 * streamBr * .65) throw new MatchError('truncated_audio');
  const codec = audio.codec_name || '';
  const type = codec.startsWith('pcm_') ? 'wav' : ({ aac: 'm4a', vorbis: 'ogg' }[codec] || codec);
  if (!['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus'].includes(type)) throw new MatchError('unsupported_audio');
  return { url, type, durationMs, expectedDurationMs: reference.duration, validated: true, validationVersion: 1,
    br: Number(data.format?.bit_rate) || 0, size: size || Number(data.format?.size) || 0,
    sr: Number(audio.sample_rate) || 0, bits: Number(audio.bits_per_raw_sample) || 0, ch: Number(audio.channels) || 0 };
}

async function matchCandidates(reference, candidates, inspect = inspectAudio) {
  if (!Number.isSafeInteger(reference.id) || reference.id <= 0 || !(reference.duration > 0)) throw new MatchError('reference_duration_missing');
  const attempts = [], checks = new Map();
  let cursor = 0, winner;
  async function work() {
    while (!winner) {
      const candidate = candidates[cursor++];
      if (!candidate) return;
      try {
        const value = await candidate.get(reference);
        const url = mediaUrl(typeof value === 'string' ? value : value?.url);
        if (!checks.has(url)) checks.set(url, inspect(url, reference));
        const verified = await checks.get(url);
        if (!winner) winner = { ...verified, source: candidate.name };
      } catch (error) {
        // Provider exceptions can contain credentials or signed URLs; retain only our reason codes.
        attempts.push({ source: candidate.name, reason: error instanceof MatchError ? error.code : 'provider_failed',
          ...(Number.isFinite(error?.durationMs) ? { durationMs: error.durationMs, expectedDurationMs: error.expectedDurationMs } : {}) });
      }
    }
  }
  // Resolve at the first valid candidate; the enclosing worker process cancels the remaining work.
  const workers = [work(), work()];
  await Promise.race([Promise.all(workers), new Promise(resolve => {
    for (const worker of workers) worker.then(() => { if (winner) resolve(); });
  })]);
  if (!winner) throw new MatchError('no_verified_source', attempts);
  return { ...winner, attempts };
}

module.exports = { MatchError, mediaUrl, audioHeader, checkDuration, inspectAudio, matchCandidates };
