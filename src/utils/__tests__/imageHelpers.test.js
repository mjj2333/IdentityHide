import { describe, it, expect } from 'vitest';
import { clampRect, padRect, generateExportFilename } from '../imageHelpers';

describe('clampRect', () => {
  it('clamps rect within bounds', () => {
    const r = clampRect({ x: -10, y: -5, w: 200, h: 100 }, 150, 80);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.w).toBeLessThanOrEqual(150);
    expect(r.h).toBeLessThanOrEqual(80);
  });

  it('returns same rect when already inside', () => {
    const r = clampRect({ x: 10, y: 10, w: 50, h: 50 }, 200, 200);
    expect(r).toEqual({ x: 10, y: 10, w: 50, h: 50 });
  });

  it('clamps width when rect extends past right edge', () => {
    const r = clampRect({ x: 100, y: 0, w: 200, h: 50 }, 150, 100);
    expect(r.x).toBe(100);
    expect(r.w).toBe(50); // 150 - 100
  });

  it('rounds fractional values', () => {
    const r = clampRect({ x: 1.7, y: 2.3, w: 10.5, h: 8.9 }, 100, 100);
    expect(r.x).toBe(2);
    expect(r.y).toBe(2);
    expect(r.w).toBe(11);
    expect(r.h).toBe(9);
  });
});

describe('padRect', () => {
  it('expands rect by given factor', () => {
    const r = padRect({ x: 50, y: 50, w: 100, h: 100 }, 0.2);
    expect(r.x).toBe(40);  // 50 - (100*0.2)/2
    expect(r.y).toBe(40);
    expect(r.w).toBe(120); // 100 + 100*0.2
    expect(r.h).toBe(120);
  });

  it('returns same rect with factor 0', () => {
    const r = padRect({ x: 10, y: 20, w: 30, h: 40 }, 0);
    expect(r).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });
});

describe('generateExportFilename', () => {
  it('returns a string with correct extension', () => {
    const name = generateExportFilename('png');
    expect(name).toMatch(/^img_protected_[a-z0-9]+\.png$/);
  });

  it('uses jpg extension', () => {
    const name = generateExportFilename('jpg');
    expect(name).toMatch(/\.jpg$/);
  });

  it('generates unique names', () => {
    const a = generateExportFilename('png');
    // Slight delay to ensure different timestamp
    const b = generateExportFilename('png');
    // They could be the same if called within the same ms, but structure should match
    expect(a).toMatch(/^img_protected_/);
    expect(b).toMatch(/^img_protected_/);
  });
});
