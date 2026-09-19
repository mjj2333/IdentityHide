/**
 * Opt-in performance diagnostics — a small on-device event log for chasing
 * "the app froze" reports that can't be reproduced at a desk (e.g. lag after
 * backgrounding the PWA on a phone).
 *
 * Off by default and zero-cost while off. Turn on with ?diag=1 (persists in
 * localStorage so it survives the router stripping the query string and works
 * across reloads); turn off with ?diag=0 or the panel's "Turn off" button.
 *
 * Deliberately built on APIs every browser has (visibilitychange, timers,
 * performance.now, localStorage). The Long Tasks API and the freeze/resume
 * lifecycle events would be more precise but are Chromium-only, and the
 * reports we're chasing come from iOS Safari.
 *
 * Nothing here touches image content, file names, or the network — entries are
 * event names, durations, and canvas dimensions, kept on the device until the
 * user copies them out.
 */

export const DIAG_FLAG_KEY = 'ih_diag';
export const DIAG_LOG_KEY = 'ih_diag_log';
export const MAX_ENTRIES = 300;

// Stall detector cadence. A tick that lands more than STALL_THRESHOLD_MS late
// means the main thread was blocked for that long.
const TICK_INTERVAL_MS = 250;
const STALL_THRESHOLD_MS = 400;

let enabled = false;
// Replaced (never mutated) on every change so subscribers can use reference
// equality to detect updates.
let entries = [];
const listeners = new Set();
let stopMonitors = null;

const noop = () => {};

function getStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function notify() {
  listeners.forEach((fn) => fn());
}

function persist() {
  try { getStorage()?.setItem(DIAG_LOG_KEY, JSON.stringify(entries)); } catch { /* storage full/blocked — memory log still works */ }
}

function setEntries(next) {
  entries = next;
  persist();
  notify();
}

/**
 * Resolve the on/off flag from the query string + persisted state.
 * ?diag=1 turns it on, ?diag=0 turns it off, otherwise the stored value wins.
 */
export function resolveDiagFlag(search, storage) {
  try {
    const param = new URLSearchParams(search || '').get('diag');
    if (param === '1') storage.setItem(DIAG_FLAG_KEY, '1');
    if (param === '0') storage.removeItem(DIAG_FLAG_KEY);
    return storage.getItem(DIAG_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Decide whether a stall-detector tick represents a main-thread stall.
 *
 * Browsers throttle (or fully suspend) timers while a page is hidden, so a
 * late tick only counts when the page is visible — and when the page came
 * back to the foreground since the previous tick, lateness is measured from
 * the return, not from the last tick, so time spent in the background is
 * never reported as a freeze.
 */
export function classifyTick({ prevTick, now, intervalMs, thresholdMs, hidden, lastVisibleAt }) {
  if (hidden) return null;
  const returned = lastVisibleAt > prevTick;
  const late = now - (returned ? lastVisibleAt : prevTick) - intervalMs;
  if (late <= thresholdMs) return null;
  return { type: returned ? 'stall-after-return' : 'stall', ms: Math.round(late) };
}

/**
 * Log WebGL context loss/restore for every WebGL canvas created through
 * `proto.getContext` (pass HTMLCanvasElement.prototype / OffscreenCanvas
 * .prototype). TF.js owns its canvas privately, so wrapping getContext is the
 * only way to see its context die — which mobile browsers do to backgrounded
 * pages, forcing a full shader recompile on the next face detection.
 * Returns a function that restores the original getContext.
 */
export function watchWebGLContexts(proto) {
  const original = proto.getContext;
  const watched = new WeakSet();
  proto.getContext = function getContext(type, ...rest) {
    const ctx = original.call(this, type, ...rest);
    if (ctx && /webgl/i.test(type) && !watched.has(this)) {
      watched.add(this);
      this.addEventListener('webglcontextlost', () => diagLog('webgl-context-lost'));
      this.addEventListener('webglcontextrestored', () => diagLog('webgl-context-restored'));
    }
    return ctx;
  };
  return () => { proto.getContext = original; };
}

function startMonitors() {
  if (typeof document === 'undefined') return noop;
  const unwatchers = [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]
    .filter(Boolean)
    .map((ctor) => watchWebGLContexts(ctor.prototype));
  let prevTick = performance.now();
  let lastVisibleAt = 0;
  let hiddenAt = 0;

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      diagLog('hidden');
    } else {
      lastVisibleAt = performance.now();
      diagLog('visible', hiddenAt ? { awayMs: Date.now() - hiddenAt } : undefined);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const timer = setInterval(() => {
    const now = performance.now();
    const stall = classifyTick({
      prevTick, now, lastVisibleAt,
      intervalMs: TICK_INTERVAL_MS,
      thresholdMs: STALL_THRESHOLD_MS,
      hidden: document.hidden,
    });
    prevTick = now;
    if (stall) diagLog(stall.type, { ms: stall.ms });
  }, TICK_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    unwatchers.forEach((unwatch) => unwatch());
  };
}

/**
 * Call once at startup, before the router rewrites the URL. Returns whether
 * diagnostics are on.
 */
export function initDiagnostics(search = globalThis.location?.search) {
  const storage = getStorage();
  enabled = !!storage && resolveDiagFlag(search, storage);
  if (!enabled) return false;

  // Pick up the previous run's log — if the OS killed the page while it was
  // in the background, what happened right before is exactly what we want.
  try {
    const stored = JSON.parse(storage.getItem(DIAG_LOG_KEY) || '[]');
    entries = Array.isArray(stored) ? stored.slice(-MAX_ENTRIES) : [];
  } catch {
    entries = [];
  }

  stopMonitors?.();
  stopMonitors = startMonitors();
  diagLog('diag-start', {
    standalone: globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true
      || globalThis.navigator?.standalone === true,
  });
  return true;
}

/** Turn diagnostics off and wipe the flag + log from the device. */
export function disableDiagnostics() {
  enabled = false;
  stopMonitors?.();
  stopMonitors = null;
  entries = [];
  try {
    const storage = getStorage();
    storage?.removeItem(DIAG_FLAG_KEY);
    storage?.removeItem(DIAG_LOG_KEY);
  } catch { /* ignore */ }
  notify();
}

export function isDiagEnabled() {
  return enabled;
}

export function diagLog(type, data) {
  if (!enabled) return;
  setEntries([...entries, { t: Date.now(), type, ...data }].slice(-MAX_ENTRIES));
}

/**
 * Time an operation: call the returned function when it finishes to log one
 * entry carrying the elapsed ms plus any extra details known only at the end.
 */
export function diagSpan(type, data) {
  if (!enabled) return noop;
  const t0 = performance.now();
  return (extra) => diagLog(type, { ...data, ...extra, ms: Math.round(performance.now() - t0) });
}

export function getDiagEntries() {
  return entries;
}

export function clearDiagLog() {
  setEntries([]);
}

export function subscribeDiag(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Plain-text rendering for the panel's Copy button (paste into a message). */
export function formatDiagLog(list) {
  return list.map((entry, i) => {
    const { t, type, ...details } = entry;
    const clock = `${new Date(t).toTimeString().slice(0, 8)}.${String(t % 1000).padStart(3, '0')}`;
    const gap = i === 0 ? '' : `+${t - list[i - 1].t}ms`;
    const rest = Object.entries(details).map(([k, v]) => `${k}=${v}`).join(' ');
    return [clock, gap, type, rest].filter(Boolean).join('  ');
  }).join('\n');
}
