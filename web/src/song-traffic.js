// Third-party media bodies are opaque on many CDNs. Estimate their size from the
// union of buffered audio ranges, without issuing any additional media requests.
export function createSongTraffic(send) {
  const media = new WeakMap();
  const sources = new WeakMap();
  const pending = new Set();
  let timer = 0;
  const maxBytes = 1024 ** 3;

  function schedule() {
    if (!timer && pending.size) timer = setTimeout(flush, 12000);
  }

  function flush(unloading = false) {
    clearTimeout(timer);
    timer = 0;
    for (const track of pending) {
      if (track.sending && !unloading) continue;
      const bytes = track.bytes;
      track.sending = true;
      send({ session: track.id, bytes }, unloading).then(() => {
        if (track.bytes === bytes) pending.delete(track);
      }).catch(() => {}).then(() => {
        track.sending = false;
        if (!unloading) schedule();
      });
    }
  }

  function sample(audio) {
    const track = media.get(audio);
    if (!track || audio.currentSrc !== track.url) return;
    const duration = audio.duration;
    const size = Number(track.info.size);
    const br = Number(track.info.br);
    const rate = size > 0 && Number.isFinite(duration) && duration > 0
      ? size / duration : br >= 8000 && br <= 24000000 ? br / 8 : 320000 / 8;
    const buffered = audio.buffered;
    if (!buffered?.length) return;
    const ranges = track.ranges.slice();
    for (let i = 0; i < buffered.length; i++) ranges.push([buffered.start(i), buffered.end(i)]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [start, end] of ranges) {
      const tail = merged[merged.length - 1];
      if (tail && start <= tail[1]) tail[1] = Math.max(tail[1], end);
      else merged.push([start, end]);
    }
    track.ranges = merged;
    const seconds = merged.reduce((total, [start, end]) => total + end - start, 0);
    const bytes = Math.min(maxBytes, size > 0 ? size : maxBytes, Math.round(seconds * rate));
    if (Number.isSafeInteger(bytes) && bytes > track.bytes) {
      track.bytes = bytes;
      if (pending.size >= 24 && !pending.has(track)) pending.delete(pending.values().next().value);
      pending.add(track);
      schedule();
    }
  }

  function detach(audio) {
    if (!media.has(audio)) return;
    sample(audio);
    audio.removeEventListener('progress', onProgress);
    audio.removeEventListener('loadedmetadata', onProgress);
    audio.removeEventListener('suspend', onProgress);
    media.delete(audio);
  }

  function onProgress(event) { sample(event.currentTarget); }

  function attach(audio, info, url) {
    detach(audio);
    if (!info || !url) return;
    let address;
    try { address = new URL(url, location.href); } catch { return; }
    if (!/^https?:$/.test(address.protocol) || /\/cm\/cast\/\d+\/?$/.test(address.pathname)) return;
    let track = sources.get(info);
    if (!track || track.url !== address.href) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
        value => ('0' + value.toString(16)).slice(-2)).join('');
      track = { id, info, url: address.href, ranges: [], bytes: 0, sending: false };
      sources.set(info, track);
    }
    media.set(audio, track);
    audio.addEventListener('progress', onProgress);
    audio.addEventListener('loadedmetadata', onProgress);
    audio.addEventListener('suspend', onProgress);
  }

  return { attach, detach, sample, flush };
}
