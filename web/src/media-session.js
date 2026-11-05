const bindings = new WeakMap();

function duration(player) {
  const value = player.durMs() / 1000;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 系统通知/锁屏只控制现有播放器，不另建音源或改变音量、音质。 */
export function updateBrowserMediaSession(player) {
  const session = navigator.mediaSession;
  if (!session) return;
  let state = bindings.get(session);
  if (!state || state.player !== player) {
    state = { player, metadata: '' };
    bindings.set(session, state);
    const seek = seconds => {
      const dur = duration(player);
      if (!dur || !Number.isFinite(seconds)) return;
      player.seek(Math.max(0, Math.min(dur, seconds)));
      updateBrowserMediaState(player);
    };
    const offset = (details = {}) => Number.isFinite(details.seekOffset) && details.seekOffset > 0 ? details.seekOffset : 10;
    const actions = {
      play: () => player.play(),
      pause: () => player.pause(),
      previoustrack: () => player.prev(),
      nexttrack: () => player.next(),
      seekto: (details = {}) => seek(details.seekTime),
      seekbackward: details => seek(player.posMs() / 1000 - offset(details)),
      seekforward: details => seek(player.posMs() / 1000 + offset(details)),
      stop: () => { player.pause(); updateBrowserMediaState(player, 'none'); },
    };
    // 某一动作不受支持，不能让其它通知按钮一并失效。
    for (const [action, handler] of Object.entries(actions)) {
      try { session.setActionHandler(action, handler); } catch { /* 旧内核按动作降级 */ }
    }
  }
  if (player.meta && typeof MediaMetadata !== 'undefined') {
    const meta = player.meta;
    const info = { title: meta.name || '', artist: meta.artists || '', album: meta.album || '' };
    if (meta.pic) {
      try { info.artwork = [{ src: new URL(meta.pic, location.href).href }]; } catch { /* 仍显示曲名 */ }
    }
    const key = JSON.stringify(info);
    if (key !== state.metadata) {
      try { session.metadata = new MediaMetadata(info); state.metadata = key; }
      catch {
        delete info.artwork;
        try { session.metadata = new MediaMetadata(info); } catch { /* 通知控制仍可用 */ }
      }
    }
  }
  updateBrowserMediaState(player);
}

export function updateBrowserMediaState(player, state) {
  const session = navigator.mediaSession;
  if (!session) return;
  const playing = player.isPlaying(), binding = bindings.get(session);
  if (binding && playing) binding.stopped = false;
  if (binding && state === 'none') binding.stopped = true;
  const stopped = state === 'none' || (binding && binding.stopped);
  try { session.playbackState = stopped ? 'none' : state || (playing ? 'playing' : 'paused'); } catch { /* 旧内核 */ }
  if (typeof session.setPositionState !== 'function') return;
  const dur = duration(player), rate = player.audio.playbackRate;
  try {
    session.setPositionState(dur && !stopped ? {
      duration: dur,
      position: Math.max(0, Math.min(dur, player.posMs() / 1000 || 0)),
      playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    } : {});
  } catch { /* 不影响实际播放 */ }
}
