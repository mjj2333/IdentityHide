// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DIAG_FLAG_KEY,
  DIAG_LOG_KEY,
  MAX_ENTRIES,
  resolveDiagFlag,
  classifyTick,
  initDiagnostics,
  disableDiagnostics,
  isDiagEnabled,
  diagLog,
  diagSpan,
  getDiagEntries,
  clearDiagLog,
  subscribeDiag,
  formatDiagLog,
  watchWebGLContexts,
} from '../perfDiagnostics';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  disableDiagnostics();
  vi.useRealTimers();
});

describe('resolveDiagFlag', () => {
  it('turns on and persists the flag for ?diag=1', () => {
    expect(resolveDiagFlag('?diag=1', localStorage)).toBe(true);
    expect(localStorage.getItem(DIAG_FLAG_KEY)).toBe('1');
  });

  it('stays on from the persisted flag when the query string is gone', () => {
    localStorage.setItem(DIAG_FLAG_KEY, '1');
    expect(resolveDiagFlag('', localStorage)).toBe(true);
  });

  it('turns off and forgets the flag for ?diag=0', () => {
    localStorage.setItem(DIAG_FLAG_KEY, '1');
    expect(resolveDiagFlag('?diag=0', localStorage)).toBe(false);
    expect(localStorage.getItem(DIAG_FLAG_KEY)).toBeNull();
  });

  it('is off by default', () => {
    expect(resolveDiagFlag('', localStorage)).toBe(false);
  });

  it('is off (and does not throw) when storage is unavailable', () => {
    const broken = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
      removeItem() { throw new Error('denied'); },
    };
    expect(resolveDiagFlag('', broken)).toBe(false);
  });
});

describe('classifyTick', () => {
  const base = { intervalMs: 250, thresholdMs: 400, hidden: false, lastVisibleAt: 0 };

  it('ignores a tick that arrived on time', () => {
    expect(classifyTick({ ...base, prevTick: 1000, now: 1260 })).toBeNull();
  });

  it('reports a foreground stall with how long the main thread was blocked', () => {
    expect(classifyTick({ ...base, prevTick: 1000, now: 5250 })).toEqual({ type: 'stall', ms: 4000 });
  });

  it('ignores late ticks while the page is hidden (browsers throttle timers there)', () => {
    expect(classifyTick({ ...base, hidden: true, prevTick: 1000, now: 9000 })).toBeNull();
  });

  it('does not count time spent in the background as a stall', () => {
    // hidden for a minute, first tick lands right after the visible event
    expect(classifyTick({ ...base, prevTick: 1000, lastVisibleAt: 61000, now: 61100 })).toBeNull();
  });

  it('reports a stall that follows the return to the foreground, measured from the return', () => {
    expect(classifyTick({ ...base, prevTick: 1000, lastVisibleAt: 61000, now: 70250 }))
      .toEqual({ type: 'stall-after-return', ms: 9000 });
  });
});

describe('diagnostics log', () => {
  it('records nothing while diagnostics are off', () => {
    expect(isDiagEnabled()).toBe(false);
    diagLog('save-start', {});
    expect(getDiagEntries()).toEqual([]);
  });

  it('records entries in order with a wall-clock time once enabled', () => {
    expect(initDiagnostics('?diag=1')).toBe(true);
    clearDiagLog();
    diagLog('save-start', { reason: 'edit' });
    diagLog('save-end', { ms: 1200 });
    const entries = getDiagEntries();
    expect(entries.map((e) => e.type)).toEqual(['save-start', 'save-end']);
    expect(entries[0].reason).toBe('edit');
    expect(entries[1].ms).toBe(1200);
    expect(typeof entries[0].t).toBe('number');
  });

  it('keeps only the newest MAX_ENTRIES entries', () => {
    initDiagnostics('?diag=1');
    clearDiagLog();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) diagLog('tick', { i });
    const entries = getDiagEntries();
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries[0].i).toBe(5);
    expect(entries[entries.length - 1].i).toBe(MAX_ENTRIES + 4);
  });

  it('persists the log so it survives the page being killed and reloaded', () => {
    initDiagnostics('?diag=1');
    clearDiagLog();
    diagLog('hidden', {});
    const stored = JSON.parse(localStorage.getItem(DIAG_LOG_KEY));
    expect(stored.map((e) => e.type)).toEqual(['hidden']);
  });

  it('reloads the previous log on init', () => {
    localStorage.setItem(DIAG_LOG_KEY, JSON.stringify([{ t: 1, type: 'from-last-run' }]));
    initDiagnostics('?diag=1');
    expect(getDiagEntries()[0].type).toBe('from-last-run');
  });

  it('notifies subscribers of new entries until they unsubscribe', () => {
    initDiagnostics('?diag=1');
    const seen = [];
    const unsubscribe = subscribeDiag(() => seen.push(getDiagEntries().length));
    clearDiagLog();
    seen.length = 0;
    diagLog('a', {});
    unsubscribe();
    diagLog('b', {});
    expect(seen).toEqual([1]);
  });

  it('clearDiagLog empties memory and storage', () => {
    initDiagnostics('?diag=1');
    diagLog('a', {});
    clearDiagLog();
    expect(getDiagEntries()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(DIAG_LOG_KEY))).toEqual([]);
  });
});

describe('diagSpan', () => {
  it('logs one entry with the elapsed time and merged details when ended', () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    initDiagnostics('?diag=1');
    clearDiagLog();
    const end = diagSpan('encode', { name: 'original', w: 4032, h: 3024 });
    vi.advanceTimersByTime(2300);
    end({ kb: 21650 });
    const entries = getDiagEntries().filter((e) => e.type === 'encode');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: 'original', w: 4032, h: 3024, kb: 21650, ms: 2300 });
  });

  it('is a harmless no-op while diagnostics are off', () => {
    const end = diagSpan('encode', { name: 'original' });
    expect(() => end({ kb: 1 })).not.toThrow();
    expect(getDiagEntries()).toEqual([]);
  });
});

describe('watchWebGLContexts', () => {
  // Stand-in for HTMLCanvasElement / OffscreenCanvas (jsdom implements neither
  // WebGL nor OffscreenCanvas). Both real classes are EventTargets whose
  // getContext returns the context object.
  class FakeCanvas extends EventTarget {
    getContext(type) { return { type }; }
  }
  const originalGetContext = FakeCanvas.prototype.getContext;
  const loggedTypes = () => getDiagEntries().map((e) => e.type);

  afterEach(() => { FakeCanvas.prototype.getContext = originalGetContext; });

  it('logs when a WebGL canvas loses and regains its context', () => {
    initDiagnostics('?diag=1');
    watchWebGLContexts(FakeCanvas.prototype);
    clearDiagLog();
    const canvas = new FakeCanvas();
    canvas.getContext('webgl2');
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(loggedTypes()).toEqual(['webgl-context-lost', 'webgl-context-restored']);
  });

  it('hands back the real context unchanged', () => {
    initDiagnostics('?diag=1');
    watchWebGLContexts(FakeCanvas.prototype);
    expect(new FakeCanvas().getContext('webgl')).toEqual({ type: 'webgl' });
  });

  it('ignores 2D canvases', () => {
    initDiagnostics('?diag=1');
    watchWebGLContexts(FakeCanvas.prototype);
    clearDiagLog();
    const canvas = new FakeCanvas();
    canvas.getContext('2d');
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(loggedTypes()).toEqual([]);
  });

  it('logs a loss once even when getContext is called repeatedly on one canvas', () => {
    initDiagnostics('?diag=1');
    watchWebGLContexts(FakeCanvas.prototype);
    clearDiagLog();
    const canvas = new FakeCanvas();
    canvas.getContext('webgl2');
    canvas.getContext('webgl2');
    canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(loggedTypes()).toEqual(['webgl-context-lost']);
  });

  it('puts the original getContext back when unwatched', () => {
    const unwatch = watchWebGLContexts(FakeCanvas.prototype);
    expect(FakeCanvas.prototype.getContext).not.toBe(originalGetContext);
    unwatch();
    expect(FakeCanvas.prototype.getContext).toBe(originalGetContext);
  });
});

describe('formatDiagLog', () => {
  it('renders one line per entry with the gap since the previous entry and its details', () => {
    const text = formatDiagLog([
      { t: 1_700_000_000_000, type: 'hidden' },
      { t: 1_700_000_001_500, type: 'stall-after-return', ms: 9000 },
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('hidden');
    expect(lines[1]).toContain('+1500ms');
    expect(lines[1]).toContain('stall-after-return');
    expect(lines[1]).toContain('ms=9000');
  });
});
