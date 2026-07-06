// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TIERS,
  DEFAULT_TIER_KEY,
  getAvailableTiers,
  getSavedTierKey,
  saveTierKey,
  getTierMP,
  estimateDimensions,
} from '../resolutionTiers';

beforeEach(() => {
  localStorage.clear();
});

describe('TIERS constants', () => {
  it('exposes exactly the Quick (1 MP) and Original (Infinity) tiers', () => {
    expect(TIERS.map((t) => t.key)).toEqual(['fast', 'native']);
    expect(TIERS.find((t) => t.key === 'fast').mp).toBe(1);
    expect(TIERS.find((t) => t.key === 'native').mp).toBe(Infinity);
  });

  it('DEFAULT_TIER_KEY is fast (the quick/small option)', () => {
    expect(DEFAULT_TIER_KEY).toBe('fast');
  });
});

describe('getAvailableTiers', () => {
  it('marks Quick unavailable for tiny source images below 1 MP', () => {
    const tiers = getAvailableTiers(800, 600); // 0.48 MP
    expect(tiers.find((t) => t.key === 'fast').available).toBe(false);
  });

  it('marks Quick available for large sources (well above 1 MP)', () => {
    const tiers = getAvailableTiers(3000, 2000); // 6 MP
    expect(tiers.find((t) => t.key === 'fast').available).toBe(true);
  });

  it('always marks Original available (even on tiny sources)', () => {
    const small = getAvailableTiers(400, 300); // 0.12 MP
    expect(small.find((t) => t.key === 'native').available).toBe(true);
  });

  it('applies the 0.1-MP tolerance to common sizes like 1920x1080 (2.07 MP)', () => {
    const tiers = getAvailableTiers(1920, 1080); // 2.07 MP
    expect(tiers.find((t) => t.key === 'fast').available).toBe(true);
  });

  it('exposes effectiveMP capped at the source MP', () => {
    const tiers = getAvailableTiers(800, 600); // 0.48 MP
    // Quick is nominally 1 MP but should cap at the 0.48-MP source
    expect(tiers.find((t) => t.key === 'fast').effectiveMP).toBeCloseTo(0.48, 2);
    // Original is Infinity → caps at the source
    expect(tiers.find((t) => t.key === 'native').effectiveMP).toBeCloseTo(0.48, 2);
  });
});

describe('getTierMP', () => {
  it('returns 1 for the fast tier', () => {
    expect(getTierMP('fast')).toBe(1);
  });

  it('returns Infinity for the native tier', () => {
    expect(getTierMP('native')).toBe(Infinity);
  });

  it('falls back to 1 for unknown tier keys', () => {
    expect(getTierMP('unknown')).toBe(1);
  });
});

describe('tier key persistence', () => {
  it('getSavedTierKey returns DEFAULT_TIER_KEY when nothing stored', () => {
    expect(getSavedTierKey()).toBe(DEFAULT_TIER_KEY);
  });

  it('round-trips a saved tier key through localStorage', () => {
    saveTierKey('native');
    expect(getSavedTierKey()).toBe('native');
  });
});

describe('estimateDimensions', () => {
  it('returns the source dimensions when tierMP >= srcMP', () => {
    // 800x600 = 0.48 MP; 1 MP tier exceeds source, so no downscale.
    expect(estimateDimensions(800, 600, 1)).toEqual({ width: 800, height: 600 });
  });

  it('returns source dimensions for Infinity tier (no downscale)', () => {
    expect(estimateDimensions(4000, 3000, Infinity)).toEqual({ width: 4000, height: 3000 });
  });

  it('scales down proportionally to hit the tier MP target', () => {
    // 4000x3000 = 12 MP → 1 MP ≈ sqrt(1/12) ≈ 0.289 scale
    const est = estimateDimensions(4000, 3000, 1);
    expect(est.width).toBeCloseTo(4000 * Math.sqrt(1 / 12), 0);
    expect(est.height).toBeCloseTo(3000 * Math.sqrt(1 / 12), 0);
    // Aspect ratio preserved
    expect(est.width / est.height).toBeCloseTo(4 / 3, 2);
  });

  it('preserves aspect ratio for non-4:3 sources', () => {
    const est = estimateDimensions(1920, 1080, 0.5);
    expect(est.width / est.height).toBeCloseTo(1920 / 1080, 2);
  });
});
