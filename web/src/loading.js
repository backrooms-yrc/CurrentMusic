import indicatorSVG from '../assets/loading-indicator.svg';
import './loading-indicator.css';

export const LOADING_CYCLE_MS = 2275;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The same locally bundled SVG is used by boot, routes, panels and pull-to-refresh. */
export function loadingMarkup() { return indicatorSVG; }

/** Wait for a full seven-shape boundary after content is ready, including instant responses.
 * A CSS iteration event is authoritative; the timer also supports reduced motion and old WebViews.
 * The owner cancels the gate when its route/refresh is superseded.
 */
export function loadingCycle(node) {
  let started = node.hasAttribute('data-loading-start');
  let began = Number(node.getAttribute('data-loading-start')) || performance.now();
  let frame = null;
  let timer = null, ready = false, settled = false, resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  function cleanup() {
    clearTimeout(timer); cancelAnimationFrame(frame);
    node.removeEventListener('animationstart', start);
    node.removeEventListener('animationiteration', iteration);
  }
  function settle() { if (settled) return; settled = true; cleanup(); resolveDone(); }
  function schedule() {
    clearTimeout(timer);
    const elapsed = Math.max(0, performance.now() - began);
    const end = Math.max(1, Math.ceil(elapsed / LOADING_CYCLE_MS)) * LOADING_CYCLE_MS;
    timer = setTimeout(settle, Math.max(0, end - elapsed) + (reduced() ? 0 : 80));
  }
  function start(event) {
    if (event.animationName !== 'cmIndicatorMorph') return;
    started = true; began = performance.now();
    node.setAttribute('data-loading-start', String(began));
    if (ready) schedule();
  }
  function iteration(event) {
    if (event.animationName === 'cmIndicatorMorph' && ready && performance.now() - began >= LOADING_CYCLE_MS - 40) settle();
  }
  node.addEventListener('animationstart', start);
  node.addEventListener('animationiteration', iteration);
  if (!started) frame = requestAnimationFrame(() => {
    if (!started) { started = true; began = performance.now(); }
    if (ready && !settled) schedule();
  });
  return {
    done,
    finish() { if (!ready && !settled) { ready = true; if (started) schedule(); } return done; },
    cancel: settle,
  };
}

export function createLoadingIndicator(className = '', label = '正在加载') {
  const node = document.createElement('div');
  node.className = 'cm-expressive-loading ' + className;
  node.setAttribute('role', 'status'); node.setAttribute('aria-label', label);
  node.innerHTML = loadingMarkup();
  return node;
}

/** Upgrade indeterminate placeholders only; actual progress values retain their native component. */
export function enhanceLoading(root) {
  root.querySelectorAll('mdui-circular-progress:not([value]), mdui-linear-progress:not([value])').forEach(old => {
    if (old.value !== undefined && old.value !== null) return;
    const node = createLoadingIndicator('cm-loading-inline');
    if (old.closest('button, mdui-button') || /18px|20px|24px/.test(old.getAttribute('style') || '')) node.classList.add('cm-loading-small');
    old.replaceWith(node);
  });
}

/** A page may insert a spinner later (filters/tabs), including inside a dialog. */
export function initExpressiveLoading() {
  enhanceLoading(document.body);
  const observer = new MutationObserver(records => {
    if (records.some(record => Array.from(record.addedNodes).some(n => n.nodeType === 1 &&
        (n.matches('mdui-circular-progress, mdui-linear-progress') || n.querySelector('mdui-circular-progress, mdui-linear-progress'))))) enhanceLoading(document.body);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
