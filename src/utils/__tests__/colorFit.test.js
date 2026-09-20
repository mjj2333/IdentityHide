import { describe, it, expect } from 'vitest';
import { fitColourTransform, applyColourTransform, IDENTITY_TRANSFORM } from '../colorFit';

const W = 64, H = 64;

// A varied, photo-like field of colours (deterministic).
function original() {
  let s = 99;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = 30 + rnd() * 190; px[i * 4 + 1] = 30 + rnd() * 190; px[i * 4 + 2] = 30 + rnd() * 190; px[i * 4 + 3] = 255;
  }
  return px;
}

// What a lossy round trip does: pull colours toward grey and darken slightly.
function degrade(px, saturation = 0.95, offset = -2) {
  const out = new Uint8ClampedArray(px.length);
  for (let p = 0; p < px.length; p += 4) {
    const grey = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
    for (let c = 0; c < 3; c++) out[p + c] = Math.round(grey + (px[p + c] - grey) * saturation + offset);
    out[p + 3] = 255;
  }
  return out;
}

const meanAbsError = (a, b, skip = () => false) => {
  let sum = 0, n = 0;
  for (let i = 0; i < W * H; i++) { if (skip(i)) continue; for (let c = 0; c < 3; c++) { sum += Math.abs(a[i * 4 + c] - b[i * 4 + c]); n++; } }
  return sum / n;
};
const noMask = new Uint8Array(W * H);

describe('fitColourTransform', () => {
  it('recovers the colour a lossy round trip took away', () => {
    const orig = original(), result = degrade(orig);
    expect(meanAbsError(result, orig)).toBeGreaterThan(2);           // visibly off before
    const t = fitColourTransform(result, orig, W, H, noMask, { stride: 1 });
    applyColourTransform(result, t);
    expect(meanAbsError(result, orig)).toBeLessThan(0.6);             // within rounding after
  });

  it('learns only from pixels OUTSIDE the mask — the repainted area legitimately differs', () => {
    const orig = original(), result = degrade(orig);
    const mask = new Uint8Array(W * H);
    for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) { const i = y * W + x; mask[i] = 255; result[i * 4] = 20; result[i * 4 + 1] = 230; result[i * 4 + 2] = 20; } // "new skin" nothing like the original
    const t = fitColourTransform(result, orig, W, H, mask, { stride: 1 });
    applyColourTransform(result, t);
    expect(meanAbsError(result, orig, (i) => mask[i] > 0)).toBeLessThan(0.6);
  });

  it('ignores blown-out and crushed pixels, which carry no usable colour information', () => {
    const orig = original(), result = degrade(orig);
    for (let i = 0; i < W * H; i += 3) { for (let c = 0; c < 3; c++) { orig[i * 4 + c] = 255; result[i * 4 + c] = 255; } } // a third of the image is clipped white
    const t = fitColourTransform(result, orig, W, H, noMask, { stride: 1 });
    const clean = degrade(original()); applyColourTransform(clean, t);
    expect(meanAbsError(clean, original())).toBeLessThan(0.8);
  });

  it('returns the identity when there is too little to learn from', () => {
    const orig = original(), result = degrade(orig);
    const everything = new Uint8Array(W * H).fill(255);
    expect(fitColourTransform(result, orig, W, H, everything, { stride: 1 })).toEqual(IDENTITY_TRANSFORM);
  });

  it('returns the identity rather than apply an implausible correction', () => {
    const orig = original();
    const unrelated = original().reverse();                           // nothing to do with the original
    unrelated.forEach((_, i) => { if (i % 4 === 3) unrelated[i] = 255; });
    expect(fitColourTransform(unrelated, orig, W, H, noMask, { stride: 1 })).toEqual(IDENTITY_TRANSFORM);
  });

  it('is (near) the identity when nothing was lost', () => {
    const orig = original();
    const t = fitColourTransform(Uint8ClampedArray.from(orig), orig, W, H, noMask, { stride: 1 });
    const copy = Uint8ClampedArray.from(orig); applyColourTransform(copy, t);
    expect(meanAbsError(copy, orig)).toBeLessThan(0.05);
  });
});

describe('applyColourTransform', () => {
  it('leaves pixels untouched under the identity', () => {
    const px = original(), before = Array.from(px);
    applyColourTransform(px, IDENTITY_TRANSFORM);
    expect(Array.from(px)).toEqual(before);
  });

  it('never touches alpha and clamps to the valid range', () => {
    const px = new Uint8ClampedArray([250, 250, 250, 77, 3, 3, 3, 200]);
    applyColourTransform(px, [1.2, 0, 0, 10, 0, 1.2, 0, 10, 0, 0, 1.2, -20]);
    expect(px[3]).toBe(77); expect(px[7]).toBe(200);
    expect(px[0]).toBe(255); expect(px[6]).toBe(0);
  });
});
