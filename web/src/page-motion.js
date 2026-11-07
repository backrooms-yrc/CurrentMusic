import { createLoadingIndicator, loadingCycle, enhanceLoading } from './loading.js';
// A single route owner: interrupted navigations cancel their animation and never reset the new page's scroll.
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export function createPageMotion(container, footer) {
  let generation = 0, exit = null, observer = null, indicator = null, cycle = null;
  const animations = new Set();
  function animate(node, frames, duration, easing = 'cubic-bezier(.2,0,0,1)') {
    if (reduced() || !node.animate) return null;
    const raw = node.animate(frames, { duration, easing });
    let settle;
    const done = new Promise(resolve => { settle = resolve; });
    const animation = { done, cancel() { raw.cancel(); finish(); } };
    function finish() { animations.delete(animation); settle(); }
    // Animation.finished is absent in older WebViews; our own cancellation always settles.
    raw.onfinish = finish; raw.oncancel = finish;
    animations.add(animation);
    return animation;
  }
  return async function show(render, back = false, { refresh = false } = {}) {
    const own = ++generation;
    if (cycle) { cycle.cancel(); cycle = null; }
    if (indicator) { indicator.remove(); indicator = null; }
    container.classList.remove('cm-route-loading-active');
    if (observer) observer.disconnect();
    animations.forEach(a => a.cancel()); animations.clear();
    if (exit) { exit.cancel(); exit = null; }
    const old = container.firstElementChild;
    const isAimoNow = document.documentElement.getAttribute('data-ui-preset') === 'aimo';
    if (old) {
      old.style.pointerEvents = 'none';
      if (isAimoNow) {
        exit = animate(old, [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: `translateY(${back ? 4 : -4}px)` }
        ], 90, 'cubic-bezier(.22, 1, .36, 1)');
      } else {
        exit = animate(old, [{ opacity: 1, transform: 'none' },
          { opacity: 0, transform: `translateX(${back ? 8 : -8}px)` }], 100);
      }
      if (exit) await exit.done;
      if (own !== generation) return;
      exit = null;
    }
    const wrap = document.createElement('div');
    wrap.className = 'cm-page cm-route-page' + (back ? ' cm-page-back' : '');
    container.replaceChildren(wrap);
    if (footer) container.appendChild(footer);
    container.scrollTop = 0;
    const isAimo = document.documentElement.getAttribute('data-ui-preset') === 'aimo';
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
        animate(node, [{ opacity: .35 }, { opacity: 1 }], 220, isAimo ? 'cubic-bezier(.22, 1, .36, 1)' : 'cubic-bezier(.2,0,0,1)');
      });
    });
    observer.observe(wrap, { childList: true, subtree: true });
    let result;
    try { result = render(wrap); }
    catch (error) { result = Promise.reject(error); }
    enhanceLoading(wrap);
    const hasSkeleton = !!wrap.querySelector('.sk, .cm-skeleton, .cm-search-result-skeleton');
    let ownIndicator = null, ownCycle = null;
    if (isAimo) {
      if (!hasSkeleton && !wrap.firstElementChild) {
        wrap.innerHTML = `<div class="cm-skeleton" role="status" aria-label="正在加载">
          <div class="sk sk-l1" style="height:28px;width:34%;margin:12px 0 24px;border-radius:6px"></div>
          <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:24px">
            <div class="sk" style="height:100px;border-radius:14px"></div>
            <div class="sk" style="height:100px;border-radius:14px"></div>
            <div class="sk" style="height:100px;border-radius:14px"></div>
          </div>
          <div class="cm-skel-list">${Array.from({ length: 4 }, () =>
            `<div class="cm-skel-song"><div class="sk sk-pic"></div><div class="cm-skel-main"><div class="sk sk-l1"></div><div class="sk sk-l2"></div></div></div>`).join('')}</div>
        </div>`;
      }
    } else if (!hasSkeleton && !refresh) {
      if (document.getElementById('boot')) {
        // Boot already guarantees a full cycle; keep a visible fallback if the request outlives it.
        if (!wrap.firstElementChild) wrap.appendChild(createLoadingIndicator('cm-route-loading-placeholder'));
      } else {
        ownIndicator = createLoadingIndicator('cm-route-loading');
        ownCycle = loadingCycle(ownIndicator); indicator = ownIndicator; cycle = ownCycle;
        container.appendChild(ownIndicator); container.classList.add('cm-route-loading-active');
        wrap.setAttribute('inert', ''); wrap.setAttribute('aria-hidden', 'true');
      }
    }
    if (isAimo) {
      animate(wrap, [
        { opacity: 0, transform: `translateY(${back ? -8 : 8}px)` },
        { opacity: 1, transform: 'none' }
      ], 220, 'cubic-bezier(.22, 1, .36, 1)');
    } else {
      animate(wrap, [{ opacity: 0, transform: back ? 'translateX(-14px)' : 'translateY(12px)' },
        { opacity: 1, transform: 'none' }], back ? 240 : 280);
    }
    try { await result; }
    catch (error) {
      if (own !== generation || !wrap.isConnected) return;
      const empty = document.createElement('div'); empty.className = 'cm-empty';
      empty.textContent = '页面加载失败：' + (error.message || '请稍后重试');
      wrap.replaceChildren(empty);
    }
    if (ownCycle) {
      await ownCycle.finish();
      if (own !== generation) return;
      ownIndicator.remove(); indicator = null; cycle = null;
      wrap.removeAttribute('inert'); wrap.removeAttribute('aria-hidden');
      container.classList.remove('cm-route-loading-active');
      animate(wrap, [{ opacity: .35 }, { opacity: 1 }], 220);
    }
  };
}

export async function dismissBoot() {
  const boot = document.getElementById('boot');
  if (!boot) return;
  if (document.documentElement.getAttribute('data-ui-preset') === 'aimo') { boot.remove(); return; }
  await loadingCycle(boot).finish();
  if (!boot.isConnected) return;
  if (reduced() || !boot.animate) { boot.remove(); return; }
  boot.setAttribute('aria-hidden', 'true'); boot.style.pointerEvents = 'none';
  await new Promise(resolve => {
    const animation = boot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
    const finish = () => { boot.remove(); resolve(); };
    animation.onfinish = finish;
    animation.oncancel = finish;
  });
}
