export function createSleepTimer({ isPlaying, pause }) {
  let timer = 0;
  let end = 0;
  let finishTrack = false;
  let waiting = false;

  function cancel() {
    clearTimeout(timer);
    timer = end = 0;
    finishTrack = waiting = false;
  }

  function stop() {
    cancel();
    pause();
  }

  function check(trackEnded = false) {
    if (!end || Date.now() < end) return false;
    if (finishTrack && !trackEnded && isPlaying()) {
      waiting = true;
      return false;
    }
    stop();
    return true;
  }

  return {
    start(minutes, afterTrack) {
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1439) return false;
      clearTimeout(timer);
      end = Date.now() + minutes * 60000;
      finishTrack = !!afterTrack;
      waiting = false;
      timer = setTimeout(check, minutes * 60000);
      return true;
    },
    get state() { return { end, waiting }; },
    check,
    cancel,
  };
}
