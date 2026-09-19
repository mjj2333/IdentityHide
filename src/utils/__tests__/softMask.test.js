import { describe, it, expect } from 'vitest';
import { buildSoftMask } from '../softMask';

// Helpers: a w×h field with chosen pixels painted (1) and the rest empty (0).
const field = (w, h, painted) => {
  const m = new Uint8Array(w * h);
  for (const [x, y] of painted) m[y * w + x] = 1;
  return m;
};
const at = (mask, w, x, y) => mask[y * w + x];

describe('buildSoftMask', () => {
  const W = 101, H = 101, C = 50; // single painted pixel in the centre

  it('returns one alpha byte per pixel', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 10, 8);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(out).toHaveLength(W * H);
  });

  it('is fully opaque on the painted pixels and everywhere within the grow distance', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 10, 8);
    expect(at(out, W, C, C)).toBe(255);
    expect(at(out, W, C + 9, C)).toBe(255);
    expect(at(out, W, C, C - 9)).toBe(255);
  });

  it('is fully transparent beyond grow + feather', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 10, 8);
    expect(at(out, W, C + 20, C)).toBe(0);
    expect(at(out, W, C, C + 20)).toBe(0);
    expect(at(out, W, 0, 0)).toBe(0);
  });

  it('fades smoothly and never increases with distance across the feather', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 10, 8);
    const ramp = [];
    for (let d = 8; d <= 20; d++) ramp.push(at(out, W, C + d, C));
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1]);
    const partial = ramp.filter((a) => a > 0 && a < 255);
    expect(partial.length).toBeGreaterThanOrEqual(4); // a real gradient, not a hard step
  });

  it('grows roughly equally in every direction (diagonal reach within 10% of horizontal)', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 20, 0);
    let horiz = 0; while (at(out, W, C + horiz + 1, C) === 255) horiz++;
    let diag = 0; while (at(out, W, C + diag + 1, C + diag + 1) === 255) diag++;
    const diagDistance = diag * Math.SQRT2;
    expect(Math.abs(diagDistance - horiz) / horiz).toBeLessThan(0.1);
  });

  it('gives a hard edge when feather is 0', () => {
    const out = buildSoftMask(field(W, H, [[C, C]]), W, H, 10, 0);
    const values = new Set(out);
    expect([...values].sort()).toEqual([0, 255]);
  });

  it('does not wrap around the image edges', () => {
    // painted pixel on the LEFT edge must not bleed onto the right edge of the row above/below
    const out = buildSoftMask(field(W, H, [[0, C]]), W, H, 6, 4);
    expect(at(out, W, W - 1, C - 1)).toBe(0);
    expect(at(out, W, W - 1, C)).toBe(0);
    expect(at(out, W, W - 1, C + 1)).toBe(0);
    expect(at(out, W, 3, C)).toBe(255);
  });

  it('is empty for an empty mask and full for a fully painted one', () => {
    expect(buildSoftMask(new Uint8Array(W * H), W, H, 10, 8).every((a) => a === 0)).toBe(true);
    expect(buildSoftMask(new Uint8Array(W * H).fill(1), W, H, 10, 8).every((a) => a === 255)).toBe(true);
  });

  it('treats a painted region as a whole (distance is to the NEAREST painted pixel)', () => {
    const painted = [];
    for (let y = 40; y <= 60; y++) for (let x = 40; x <= 60; x++) painted.push([x, y]);
    const out = buildSoftMask(field(W, H, painted), W, H, 5, 5);
    expect(at(out, W, 50, 50)).toBe(255);   // inside
    expect(at(out, W, 64, 50)).toBe(255);   // 4px outside the square: within grow
    expect(at(out, W, 75, 50)).toBe(0);     // 15px outside: beyond grow + feather
  });
});
