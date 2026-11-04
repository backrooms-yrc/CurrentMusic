import { api, auth, settings } from './api.js';

const LEGACY_KEY = 'cm.searchHistory';
const MIGRATED_KEY = 'cm.searchHistory.migrated';
const LIMIT = 10;
const listeners = new Map();
let current = null;
const clean = values => Array.isArray(values) ? [...new Set(values.filter(k => typeof k === 'string')
  .map(k => k.trim()).filter(k => k && k.length <= 200))].slice(0, LIMIT) : [];
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ } }
function persist(state) {
  if (state.account) write(state.key, { history: state.history, pending: state.pending });
  else write(LEGACY_KEY, state.history);
}
function state() {
  const account = auth.token && auth.user?.username ? settings.base + '|' + auth.user.username : '';
  const token = account ? auth.token : '';
  if (current && current.account === account && current.token === token) return current;
  const key = 'cm.searchHistory.account.' + encodeURIComponent(account);
  const stored = account ? read(key, {}) : {};
  current = { account, token, key, history: account ? clean(stored.history) : clean(read(LEGACY_KEY, [])),
    pending: account && Array.isArray(stored.pending) ? stored.pending.filter(op =>
      op && (op.kind === 'clear' || op.kind === 'import' && Array.isArray(op.keywords)
        || ['add', 'remove'].includes(op.kind) && clean([op.keyword]).length)).slice(-100) : [], syncing: null };
  // The old global list has no owner. Claim it once for the first signed-in
  // account; subsequent guest searches stay local and never cross accounts.
  if (account && !read(MIGRATED_KEY, false)) {
    const legacy = clean(read(LEGACY_KEY, []));
    if (legacy.length) current.pending.unshift({ kind: 'import', keywords: legacy });
    persist(current);
    write(MIGRATED_KEY, true);
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* Ignore disabled storage. */ }
  }
  return current;
}
function apply(history, op) {
  if (op.kind === 'clear') return [];
  if (op.kind === 'import') return clean([...history, ...op.keywords]);
  const remaining = history.filter(k => k !== op.keyword);
  return op.kind === 'add' ? [op.keyword, ...remaining].slice(0, LIMIT) : remaining;
}
export function searchHistory() {
  const s = state();
  return s.pending.reduce(apply, s.history);
}
function notify() {
  for (const [root, callback] of listeners) {
    if (!root.isConnected) listeners.delete(root);
    else callback();
  }
}
export function watchSearchHistory(root, callback) { listeners.set(root, callback); }
function edit(op) {
  const s = state();
  if (!s.account) s.history = apply(s.history, op);
  else {
    // Incremental edits preserve other devices' changes. A clear supersedes all
    // queued local edits; an old cached cloud snapshot is never uploaded.
    if (op.kind === 'clear') s.pending = [];
    else s.pending = s.pending.filter(p => p.keyword !== op.keyword);
    s.pending.push(op);
  }
  persist(s); notify();
  void syncSearchHistory();
}
export function recordSearch(keyword) { const k = clean([keyword])[0]; if (k) edit({ kind: 'add', keyword: k }); }
export function removeSearch(keyword) { const k = clean([keyword])[0]; if (k) edit({ kind: 'remove', keyword: k }); }
export function clearSearchHistory() { edit({ kind: 'clear' }); }

export function syncSearchHistory() {
  const s = state();
  if (!s.account) return Promise.resolve();
  if (s.syncing) return s.syncing;
  const active = () => state() === s && auth.token === s.token;
  const accept = response => {
    if (!response || !Array.isArray(response.history)) throw Error('搜索历史响应无效');
    s.history = clean(response.history);
  };
  s.syncing = (async () => {
    try {
      do {
        while (s.pending.length && active()) {
          const op = s.pending[0];
          const response = await (op.kind === 'add' ? api.addSearchHistory(op.keyword)
            : op.kind === 'import' ? api.importSearchHistory(op.keywords)
              : api.deleteSearchHistory(op.kind === 'clear' ? undefined : op.keyword));
          if (!active()) return;
          accept(response);
          // New edits may have superseded this operation while it was in flight.
          if (s.pending[0] === op) s.pending.shift();
          persist(s); notify();
        }
        if (!active()) return;
        const response = await api.searchHistory();
        if (!active()) return;
        accept(response); persist(s); notify();
      } while (s.pending.length);
    } catch { /* Keep explicit edits for retry; cached history remains usable offline. */ }
    finally { s.syncing = null; }
  })();
  return s.syncing;
}

window.addEventListener('cm-authchange', () => {
  const previous = current;
  if (state() !== previous) { notify(); void syncSearchHistory(); }
});
window.addEventListener('storage', event => {
  const s = state();
  if (![s.key, LEGACY_KEY, 'cm.token', 'cm.user', 'cm.base'].includes(event.key)) return;
  // An in-flight tab owns its queue. Read again when it finishes rather than
  // dropping a newly queued local edit due to another tab's cache write.
  if (!s.syncing) { current = null; state(); notify(); }
  void syncSearchHistory();
});
window.addEventListener('online', () => { void syncSearchHistory(); });
window.addEventListener('focus', () => { void syncSearchHistory(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncSearchHistory(); });
setInterval(() => {
  for (const root of listeners.keys()) if (!root.isConnected) listeners.delete(root);
  if (listeners.size && !document.hidden) void syncSearchHistory();
}, 15000);
