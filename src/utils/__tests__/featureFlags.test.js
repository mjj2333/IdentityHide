// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveFlag, initFeatureFlags, isInpaintCompositeEnabled, isGrainMatchEnabled, isColourFitEnabled, COMPOSITE_FLAG_KEY, GRAIN_FLAG_KEY, COLORFIT_FLAG_KEY } from '../featureFlags';

beforeEach(() => {
  localStorage.clear();
  initFeatureFlags('');
});

describe('resolveFlag', () => {
  it('is off by default', () => {
    expect(resolveFlag('composite', 'k', '', localStorage)).toBe(false);
  });

  it('turns on and persists for ?composite=1', () => {
    expect(resolveFlag('composite', 'k', '?composite=1', localStorage)).toBe(true);
    expect(localStorage.getItem('k')).toBe('1');
  });

  it('stays on from storage once the query string is gone', () => {
    localStorage.setItem('k', '1');
    expect(resolveFlag('composite', 'k', '', localStorage)).toBe(true);
  });

  it('turns off and forgets for ?composite=0', () => {
    localStorage.setItem('k', '1');
    expect(resolveFlag('composite', 'k', '?composite=0', localStorage)).toBe(false);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('ignores other parameters', () => {
    expect(resolveFlag('composite', 'k', '?diag=1&other=1', localStorage)).toBe(false);
  });

  it('is off (and does not throw) when storage is unavailable', () => {
    const broken = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    expect(resolveFlag('composite', 'k', '?composite=1', broken)).toBe(false);
  });
});

describe('inpaint composite flag', () => {
  it('is off until initialised with ?composite=1', () => {
    expect(isInpaintCompositeEnabled()).toBe(false);
    initFeatureFlags('?composite=1');
    expect(isInpaintCompositeEnabled()).toBe(true);
    expect(localStorage.getItem(COMPOSITE_FLAG_KEY)).toBe('1');
  });

  it('survives a reload without the query string, and ?composite=0 turns it back off', () => {
    initFeatureFlags('?composite=1');
    initFeatureFlags('');
    expect(isInpaintCompositeEnabled()).toBe(true);
    initFeatureFlags('?composite=0');
    expect(isInpaintCompositeEnabled()).toBe(false);
  });
});

describe('grain match flag', () => {
  it('is off by default', () => {
    expect(isGrainMatchEnabled()).toBe(false);
  });

  it('turns on with ?composite=1&grain=1 and persists', () => {
    initFeatureFlags('?composite=1&grain=1');
    expect(isGrainMatchEnabled()).toBe(true);
    expect(localStorage.getItem(GRAIN_FLAG_KEY)).toBe('1');
    initFeatureFlags('');
    expect(isGrainMatchEnabled()).toBe(true);
  });

  it('has no effect unless compositing is on too (grain is applied to the composited patch)', () => {
    initFeatureFlags('?grain=1');
    expect(isGrainMatchEnabled()).toBe(false);
    initFeatureFlags('?composite=1');
    expect(isGrainMatchEnabled()).toBe(true);
  });

  it('can be turned off on its own, leaving compositing on', () => {
    initFeatureFlags('?composite=1&grain=1');
    initFeatureFlags('?grain=0');
    expect(isGrainMatchEnabled()).toBe(false);
    expect(isInpaintCompositeEnabled()).toBe(true);
  });
});

describe('colour fit flag', () => {
  it('is off by default', () => {
    expect(isColourFitEnabled()).toBe(false);
  });

  it('turns on with ?colorfit=1, persists, and turns off with ?colorfit=0', () => {
    initFeatureFlags('?colorfit=1');
    expect(isColourFitEnabled()).toBe(true);
    expect(localStorage.getItem(COLORFIT_FLAG_KEY)).toBe('1');
    initFeatureFlags('');
    expect(isColourFitEnabled()).toBe(true);
    initFeatureFlags('?colorfit=0');
    expect(isColourFitEnabled()).toBe(false);
  });

  it('is independent of compositing (it is the no-compositing alternative, but can also be combined)', () => {
    initFeatureFlags('?colorfit=1');
    expect(isInpaintCompositeEnabled()).toBe(false);
    initFeatureFlags('?composite=1');
    expect(isColourFitEnabled()).toBe(true);
    expect(isInpaintCompositeEnabled()).toBe(true);
  });
});
