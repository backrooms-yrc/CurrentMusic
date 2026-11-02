// A single route owner: interrupted navigations cancel their animation and never reset the new page's scroll.
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export function createPageMotion(container) {
  let generation = 0, exit = null, observer = null;
  const animations = new Set();
  function animate(node, frames, duration) {
    if (reduced() || !node.animate) return null;
    const raw = node.animate(frames, { duration, easing: 'cubic-bezier(.2,0,0,1)' });
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const animation = { done, cancel() { raw.cancel(); finish(); } };
    function finish() { animations.delete(animation); settle(); }
    // Animation.finished is absent in older WebViews; our own cancellation always settles.
    raw.onfinish = finish; raw.oncancel = finish;
    animations.add(animation);
    return animation;
  }
  return async function show(render, back = false) {
    const own = ++generation;
    if (observer) observer.disconnect();
    animations.forEach(a => a.cancel()); animations.clear();
    if (exit) { exit.cancel(); exit = null; }
    const old = container.firstElementChild;
    if (old) {
      old.style.pointerEvents = 'none';
      exit = animate(old, [{ opacity: 1, transform: 'none' },
        { opacity: 0, transform: `translateX(${back ? 8 : -8}px)` }], 100);
      if (exit) await exit.done;
      if (own !== generation) return;
      exit = null;
    }
    const wrap = document.createElement('div');
    wrap.className = 'cm-page cm-route-page' + (back ? ' cm-page-back' : '');
    container.replaceChildren(wrap);
    container.scrollTop = 0;
    // Fade in asynchronously inserted content, including in-page tab/filter changes.
    observer = new MutationObserver(records => {
      if (own !== generation || !wrap.isConnected) return;
      const targets = new Set();
      for (const record of records) {
        const hadSkeleton = Array.from(record.removedNodes).some(n => n.nodeType === 1 &&
          (n.matches('.cm-skeleton, .sk, .cm-loading') || n.querySelector('.sk, .cm-loading')));
        if (hadSkeleton && record.target.isConnected && !record.target.querySelector('.sk')) targets.add(record.target);
      }
      targets.forEach(node => {
        // Opacity only: nested panels can contain fixed dialogs and sticky controls.
        animate(node, [{ opacity: .35 }, { opacity: 1 }], 220);
      });
    });
    observer.observe(wrap, { childList: true, subtree: true });
    let result;
    try { result = render(wrap); }
    catch (error) { result = Promise.reject(error); }
    animate(wrap, [{ opacity: 0, transform: back ? 'translateX(-14px)' : 'translateY(12px)' },
      { opacity: 1, transform: 'none' }], back ? 240 : 280);
    try { await result; }
    catch (error) {
      if (own !== generation || !wrap.isConnected) return;
      const empty = document.createElement('div'); empty.className = 'cm-empty';
      empty.textContent = '页面加载失败：' + (error.message || '请稍后重试');
      wrap.replaceChildren(empty);
    }
  };
}

export function dismissBoot() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  if (reduced() || !boot.animate) { boot.remove(); return; }
  boot.setAttribute('aria-hidden', 'true'); boot.style.pointerEvents = 'none';
  const animation = boot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
  animation.onfinish = () => boot.remove();
  animation.oncancel = () => boot.remove();
}
