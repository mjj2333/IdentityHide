import { describe, it, expect } from 'vitest';
import { synthGrain, estimateGrainSigma, grainGain, grainWeight, addGrain, findSampleTiles, fillWasUpscaled } from '../grainMatch';
import { buildSoftMask } from '../softMask';

// Deterministic gaussian noise for building test images.
function noiseField(w, h, sigma, seed = 7) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    let u = 0; while (!u) u = rnd();
    out[i] = 128 + Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()) * sigma;
  }
  return out;
}

describe('estimateGrainSigma', () => {
  it('is 0 for a perfectly flat area', () => {
    expect(estimateGrainSigma(new Float32Array(64 * 64).fill(140), 64, 64)).toBe(0);
  });

  it('grows in proportion to the noise in the image', () => {
    const weak = estimateGrainSigma(noiseField(96, 96, 3), 96, 96);
    const strong = estimateGrainSigma(noiseField(96, 96, 9), 96, 96);
    expect(strong / weak).toBeGreaterThan(2.6);
    expect(strong / weak).toBeLessThan(3.4);
  });

  it('ignores a smooth brightness gradient (shading is not grain)', () => {
    const w = 96, h = 96, img = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img[y * w + x] = 60 + x * 1.2 + y * 0.6;
    expect(estimateGrainSigma(img, w, h)).toBeLessThan(0.05);
  });

  it('is robust to a hard edge in the sample (hair, fabric, a tattoo line)', () => {
    const w = 96, h = 96;
    const clean = noiseField(w, h, 4);
    const withEdge = Float32Array.from(clean);
    for (let y = 0; y < h; y++) for (let x = 48; x < 52; x++) withEdge[y * w + x] -= 90; // dark line through the tile
    const a = estimateGrainSigma(clean, w, h), b = estimateGrainSigma(withEdge, w, h);
    expect(Math.abs(b - a) / a).toBeLessThan(0.15);
  });
});

describe('synthGrain', () => {
  it('is deterministic for a seed and different across seeds', () => {
    expect(Array.from(synthGrain(32, 1))).toEqual(Array.from(synthGrain(32, 1)));
    expect(Array.from(synthGrain(32, 1))).not.toEqual(Array.from(synthGrain(32, 2)));
  });

  it('is a zero-mean square tile', () => {
    const g = synthGrain(64, 5);
    expect(g).toHaveLength(64 * 64);
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
  });

  it('has a little spatial correlation, like real photo grain (not per-pixel static)', () => {
    const size = 128, g = synthGrain(size, 9);
    let num = 0, den = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size - 1; x++) { num += g[y * size + x] * g[y * size + x + 1]; den += g[y * size + x] ** 2; }
    const neighbourCorrelation = num / den;
    expect(neighbourCorrelation).toBeGreaterThan(0.2);
    expect(neighbourCorrelation).toBeLessThan(0.8);
  });

  it('tiles seamlessly (left/right and top/bottom edges are as correlated as the interior)', () => {
    const size = 128, g = synthGrain(size, 3);
    let num = 0, den = 0;
    for (let y = 0; y < size; y++) { num += g[y * size + size - 1] * g[y * size]; den += g[y * size] ** 2; }
    expect(num / den).toBeGreaterThan(0.2);
  });
});

describe('grainGain', () => {
  it('adds nothing when the fill already has about as much grain as its surroundings', () => {
    expect(grainGain({ target: 3.3, fill: 3.4, unit: 1 })).toBe(0);
    expect(grainGain({ target: 3.3, fill: 2.9, unit: 1 })).toBe(0); // within 15%
  });

  it('adds the missing amount in quadrature (variances add, not amplitudes)', () => {
    expect(grainGain({ target: 5, fill: 3, unit: 1 })).toBeCloseTo(4, 5);      // sqrt(25 - 9)
    expect(grainGain({ target: 5, fill: 3, unit: 2 })).toBeCloseTo(2, 5);      // grain tile twice as strong => half the gain
  });

  it('caps how much it will ever add, so a bad measurement cannot make sandpaper', () => {
    expect(grainGain({ target: 40, fill: 0, unit: 1, maxAdded: 8 })).toBe(8);
  });

  it('adds nothing when there is nothing to match or the inputs are unusable', () => {
    expect(grainGain({ target: 0, fill: 0, unit: 1 })).toBe(0);
    expect(grainGain({ target: 5, fill: 1, unit: 0 })).toBe(0);
    expect(grainGain({ target: NaN, fill: 1, unit: 1 })).toBe(0);
  });
});

describe('grainWeight', () => {
  it('is 0 outside the mask and 1 fully inside', () => {
    expect(grainWeight(0)).toBe(0);
    expect(grainWeight(255)).toBe(1);
  });

  it('keeps total grain constant across the feather (original fades out as added fades in)', () => {
    // variance from the original's grain is (1-a)^2, from the added grain is w^2 — they should sum to 1
    for (const alpha of [32, 96, 128, 200]) {
      const a = alpha / 255;
      expect((1 - a) ** 2 + grainWeight(alpha) ** 2).toBeCloseTo(1, 5);
    }
  });
});

describe('addGrain', () => {
  const W = 8, H = 4;
  const grey = () => { const p = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < p.length; i += 4) { p[i] = 120; p[i + 1] = 100; p[i + 2] = 90; p[i + 3] = 255; } return p; };
  const grain = { grain: synthGrain(16, 4), tile: 16, originX: 0, originY: 0 };

  it('leaves pixels outside the mask bit-exact', () => {
    const px = grey(), before = Array.from(px);
    addGrain(px, new Uint8Array(W * H), W, H, { ...grain, gain: 10 });
    expect(Array.from(px)).toEqual(before);
  });

  it('changes brightness only — the same amount on R, G and B — inside the mask', () => {
    const px = grey();
    addGrain(px, new Uint8Array(W * H).fill(255), W, H, { ...grain, gain: 10 });
    let changed = 0;
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - 120, dg = px[i + 1] - 100, db = px[i + 2] - 90;
      expect(dr).toBe(dg); expect(dg).toBe(db); expect(px[i + 3]).toBe(255);
      if (dr !== 0) changed++;
    }
    expect(changed).toBeGreaterThan((W * H) / 2);
  });

  it('does nothing when the gain is 0', () => {
    const px = grey(), before = Array.from(px);
    addGrain(px, new Uint8Array(W * H).fill(255), W, H, { ...grain, gain: 0 });
    expect(Array.from(px)).toEqual(before);
  });

  it('is continuous across strips: the pattern depends on image position, not on where the strip starts', () => {
    const whole = new Uint8ClampedArray(W * (H * 2) * 4).fill(128);
    addGrain(whole, new Uint8Array(W * H * 2).fill(255), W, H * 2, { ...grain, gain: 12 });
    const lower = new Uint8ClampedArray(W * H * 4).fill(128);
    addGrain(lower, new Uint8Array(W * H).fill(255), W, H, { ...grain, originY: H, gain: 12 });
    expect(Array.from(lower)).toEqual(Array.from(whole.subarray(W * H * 4)));
  });
});

describe('findSampleTiles', () => {
  // inpaint-resolution masks for a 200x120 painted box, mapped onto a 1.5x larger working image
  const MW = 600, MH = 400, W = 900, H = 600, TILE = 48;
  const binary = new Uint8Array(MW * MH);
  for (let y = 140; y < 260; y++) for (let x = 200; x < 400; x++) binary[y * MW + x] = 1;
  const alpha = buildSoftMask(binary, MW, MH, 24, 16);
  const near = buildSoftMask(binary, MW, MH, 24 + 16 + 96, 0);
  const args = { alpha, near, maskWidth: MW, maskHeight: MH, width: W, height: H, tile: TILE, step: TILE / 2 };
  const maskAt = (arr, x, y) => arr[Math.min(MH - 1, Math.floor(y / (H / MH))) * MW + Math.min(MW - 1, Math.floor(x / (W / MW)))];
  const corners = ([x, y]) => [[x, y], [x + TILE - 1, y], [x, y + TILE - 1], [x + TILE - 1, y + TILE - 1], [x + TILE / 2, y + TILE / 2]];

  it('finds plenty of surrounding tiles, so a few landing on hair or fabric cannot skew the median', () => {
    expect(findSampleTiles(args).ring.length).toBeGreaterThanOrEqual(12);
  });

  it('finds tiles inside the patch too', () => {
    expect(findSampleTiles(args).core.length).toBeGreaterThanOrEqual(4);
  });

  it('surrounding tiles lie wholly OUTSIDE the soft mask (they must sample untouched original only)', () => {
    for (const t of findSampleTiles(args).ring) for (const [x, y] of corners(t)) expect(maskAt(alpha, x, y)).toBe(0);
  });

  it('patch tiles lie wholly inside the fully-replaced area', () => {
    for (const t of findSampleTiles(args).core) for (const [x, y] of corners(t)) expect(maskAt(alpha, x, y)).toBe(255);
  });

  it('keeps every tile inside the image', () => {
    const { ring, core } = findSampleTiles(args);
    for (const [x, y] of [...ring, ...core]) {
      expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
      expect(x + TILE).toBeLessThanOrEqual(W); expect(y + TILE).toBeLessThanOrEqual(H);
    }
  });

  it('returns nothing for an empty mask', () => {
    const empty = new Uint8ClampedArray(MW * MH);
    expect(findSampleTiles({ ...args, alpha: empty, near: empty })).toEqual({ ring: [], core: [] });
  });
});

describe('fillWasUpscaled', () => {
  it('is false when the fill was generated at the working resolution (Quick / 1 MP tier)', () => {
    expect(fillWasUpscaled({ workingWidth: 1152, generatedWidth: 1152 })).toBe(false);
  });

  it('ignores the few-pixel size differences the VAE rounding produces', () => {
    expect(fillWasUpscaled({ workingWidth: 1008, generatedWidth: 992 })).toBe(false);
  });

  it('is true when a 2 MP fill is stretched onto a larger photo (Original tier)', () => {
    expect(fillWasUpscaled({ workingWidth: 2400, generatedWidth: 1632 })).toBe(true);   // ~1.47x
    expect(fillWasUpscaled({ workingWidth: 4032, generatedWidth: 1632 })).toBe(true);   // ~2.47x
  });

  it('is false for unusable input', () => {
    expect(fillWasUpscaled({ workingWidth: 0, generatedWidth: 0 })).toBe(false);
    expect(fillWasUpscaled({ workingWidth: 1000, generatedWidth: undefined })).toBe(false);
  });
});
