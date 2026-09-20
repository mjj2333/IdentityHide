// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveFlag, initFeatureFlags, isColourFitEnabled, isCleanFillEnabled, isMaskGrowEnabled, COLORFIT_FLAG_KEY, CLEANFILL_FLAG_KEY, MASKGROW_FLAG_KEY } from '../featureFlags';

const BROKEN_STORAGE = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };

beforeEach(() => {
  localStorage.clear();
  initFeatureFlags('');
});

describe('resolveFlag (opt-in flag)', () => {
  it('is off by default', () => {
    expect(resolveFlag('maskgrow', 'k', '', localStorage)).toBe(false);
  });

  it('turns on and persists for ?maskgrow=1', () => {
    expect(resolveFlag('maskgrow', 'k', '?maskgrow=1', localStorage)).toBe(true);
    expect(localStorage.getItem('k')).toBe('1');
  });

  it('stays on from storage once the query string is gone', () => {
    localStorage.setItem('k', '1');
    expect(resolveFlag('maskgrow', 'k', '', localStorage)).toBe(true);
  });

  it('turns off and forgets for ?maskgrow=0', () => {
    localStorage.setItem('k', '1');
    expect(resolveFlag('maskgrow', 'k', '?maskgrow=0', localStorage)).toBe(false);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('ignores other parameters', () => {
    expect(resolveFlag('maskgrow', 'k', '?diag=1&other=1', localStorage)).toBe(false);
  });

  it('is off (and does not throw) when storage is unavailable', () => {
    expect(resolveFlag('maskgrow', 'k', '?maskgrow=1', BROKEN_STORAGE)).toBe(false);
  });
});

describe('resolveFlag (default-on flag)', () => {
  it('is on by default', () => {
    expect(resolveFlag('colorfit', 'k', '', localStorage, true)).toBe(true);
  });

  it('turns off and REMEMBERS the opt-out for ?colorfit=0', () => {
    expect(resolveFlag('colorfit', 'k', '?colorfit=0', localStorage, true)).toBe(false);
    expect(localStorage.getItem('k')).toBe('0');
    expect(resolveFlag('colorfit', 'k', '', localStorage, true)).toBe(false);   // query string gone, still off
  });

  it('turns back on and forgets the opt-out for ?colorfit=1', () => {
    localStorage.setItem('k', '0');
    expect(resolveFlag('colorfit', 'k', '?colorfit=1', localStorage, true)).toBe(true);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('still reads as on for a browser that opted in back when it was opt-in', () => {
    localStorage.setItem('k', '1');
    expect(resolveFlag('colorfit', 'k', '', localStorage, true)).toBe(true);
  });

  it('is on when storage is unavailable — but ?colorfit=0 is still honoured for that page load', () => {
    expect(resolveFlag('colorfit', 'k', '', BROKEN_STORAGE, true)).toBe(true);
    expect(resolveFlag('colorfit', 'k', '', null, true)).toBe(true);
    expect(resolveFlag('colorfit', 'k', '?colorfit=0', BROKEN_STORAGE, true)).toBe(false);
  });
});

describe('colour fit (default on)', () => {
  it('is on with nothing in the URL or storage — what every normal user gets', () => {
    expect(isColourFitEnabled()).toBe(true);
  });

  it('?colorfit=0 switches it off and that survives a reload; ?colorfit=1 switches it back on', () => {
    initFeatureFlags('?colorfit=0');
    expect(isColourFitEnabled()).toBe(false);
    expect(localStorage.getItem(COLORFIT_FLAG_KEY)).toBe('0');
    initFeatureFlags('');
    expect(isColourFitEnabled()).toBe(false);
    initFeatureFlags('?colorfit=1');
    expect(isColourFitEnabled()).toBe(true);
    initFeatureFlags('');
    expect(isColourFitEnabled()).toBe(true);
  });
});

describe('clean fill (default on)', () => {
  it('is on with nothing in the URL or storage — what every normal user gets', () => {
    expect(isCleanFillEnabled()).toBe(true);
  });

  it('?cleanfill=0 switches it off and that survives a reload; ?cleanfill=1 switches it back on', () => {
    initFeatureFlags('?cleanfill=0');
    expect(isCleanFillEnabled()).toBe(false);
    expect(localStorage.getItem(CLEANFILL_FLAG_KEY)).toBe('0');
    initFeatureFlags('');
    expect(isCleanFillEnabled()).toBe(false);
    initFeatureFlags('?cleanfill=1');
    expect(isCleanFillEnabled()).toBe(true);
  });

  it('can be switched off without touching colour fit, and the reverse', () => {
    initFeatureFlags('?cleanfill=0');
    expect(isCleanFillEnabled()).toBe(false);
    expect(isColourFitEnabled()).toBe(true);
    initFeatureFlags('?cleanfill=1&colorfit=0');
    expect(isCleanFillEnabled()).toBe(true);
    expect(isColourFitEnabled()).toBe(false);
  });
});

describe('defaults before initFeatureFlags has run, or with no storage at all', () => {
  it('match what initialising with nothing gives: the pair on, the experiments off', async () => {
    vi.resetModules();
    const fresh = await import('../featureFlags');
    expect(fresh.isCleanFillEnabled()).toBe(true);
    expect(fresh.isColourFitEnabled()).toBe(true);
    expect(fresh.isMaskGrowEnabled()).toBe(false);
  });
});

describe('mask grow flag', () => {
  it('is off by default', () => {
    expect(isMaskGrowEnabled()).toBe(false);
  });

  it('turns on with ?maskgrow=1, persists, and turns off with ?maskgrow=0', () => {
    initFeatureFlags('?maskgrow=1');
    expect(isMaskGrowEnabled()).toBe(true);
    expect(localStorage.getItem(MASKGROW_FLAG_KEY)).toBe('1');
    initFeatureFlags('');
    expect(isMaskGrowEnabled()).toBe(true);
    initFeatureFlags('?maskgrow=0');
    expect(isMaskGrowEnabled()).toBe(false);
  });

  it('is separate from clean fill — the prompt can be tried without growing the mask, and the reverse', () => {
    initFeatureFlags('?cleanfill=1&maskgrow=0');
    expect(isCleanFillEnabled()).toBe(true);
    expect(isMaskGrowEnabled()).toBe(false);
    initFeatureFlags('?cleanfill=0&maskgrow=1');
    expect(isCleanFillEnabled()).toBe(false);
    expect(isMaskGrowEnabled()).toBe(true);
  });
});

describe('retired flags (compositing and grain matching were removed)', () => {
  it('?composite=1&grain=1 switch nothing on and store nothing', () => {
    initFeatureFlags('?composite=1&grain=1');
    expect(localStorage.getItem('ih_flag_composite')).toBeNull();
    expect(localStorage.getItem('ih_flag_grain')).toBeNull();
    expect(isCleanFillEnabled()).toBe(true);
    expect(isColourFitEnabled()).toBe(true);
    expect(isMaskGrowEnabled()).toBe(false);
  });
});
