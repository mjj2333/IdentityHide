import { describe, it, expect } from 'vitest';
import { maskGrowPx, blobGrowPx, growPaintedBlobs } from '../inpaintMaskGrow';

describe('maskGrowPx (the most any blob is grown)', () => {
  it('is 32 px at the 1 MP inpaint resolution the experiments were run at', () => {
    expect(maskGrowPx(1000, 1000)).toBe(32);
    expect(maskGrowPx(816, 1232)).toBe(32);           // the real test photo (1.005 MP)
  });

  it('covers the same physical distance at other resolutions (scales with the linear size)', () => {
    expect(maskGrowPx(1632, 1216)).toBe(45);          // ~2 MP inpaint cap → 32 × √2
    expect(maskGrowPx(500, 500)).toBe(16);            // 0.25 MP → half
  });

  it('never grows by less than a few pixels, and copes with nonsense input', () => {
    expect(maskGrowPx(64, 64)).toBeGreaterThanOrEqual(4);
    expect(maskGrowPx(0, 0)).toBe(0);
    expect(maskGrowPx(NaN, 100)).toBe(0);
  });
});

describe('blobGrowPx (how far ONE painted blob is grown)', () => {
  it('gives a broadly painted blob the full grow', () => {
    expect(blobGrowPx(46, 32)).toBe(32);              // back-of-hand piece in the hand photo
  });

  it('gives a small blob a proportionally smaller grow', () => {
    expect(blobGrowPx(14.3, 32)).toBe(20);            // a finger letter: +32 swallowed the finger and warped a ring
    expect(blobGrowPx(12, 32)).toBe(17);
  });

  it('never drops below a quarter of the full grow, however small the dab', () => {
    expect(blobGrowPx(1, 32)).toBe(8);
    expect(blobGrowPx(0, 45)).toBe(11);
  });

  it('never exceeds the full grow, even when that is tiny', () => {
    expect(blobGrowPx(500, 32)).toBe(32);
    expect(blobGrowPx(500, 4)).toBe(4);
    expect(blobGrowPx(1, 4)).toBe(4);
  });
});

describe('growPaintedBlobs', () => {
  const W = 400, H = 200, CY = 100;
  const blank = () => new Uint8Array(W * H);
  const square = (m, cx, cy, half) => {
    for (let y = cy - half; y <= cy + half; y++) for (let x = cx - half; x <= cx + half; x++) m[y * W + x] = 1;
    return m;
  };
  const at = (m, x, y) => m[y * W + x];

  it('grows a broadly painted blob by the full distance', () => {
    const out = growPaintedBlobs(square(blank(), 100, CY, 30), W, H, 32);   // painted x 70…130
    expect(at(out, 130 + 32, CY)).toBe(1);
    expect(at(out, 130 + 34, CY)).toBe(0);
    expect(at(out, 70 - 32, CY)).toBe(1);
    expect(at(out, 100, CY - 30 - 32)).toBe(1);
    expect(at(out, 100, CY + 30 + 34)).toBe(0);
  });

  it('grows a small blob by less — its own size decides, not the full distance', () => {
    const out = growPaintedBlobs(square(blank(), 300, CY, 10), W, H, 32);   // painted x 290…310, inner radius 11 → +15
    expect(at(out, 310 + 15, CY)).toBe(1);
    expect(at(out, 310 + 17, CY)).toBe(0);
    expect(at(out, 290 - 15, CY)).toBe(1);
    expect(at(out, 290 - 17, CY)).toBe(0);
  });

  it('sizes each blob separately when several are painted in one mask', () => {
    const out = growPaintedBlobs(square(square(blank(), 100, CY, 30), 300, CY, 10), W, H, 32);
    expect(at(out, 130 + 32, CY)).toBe(1);            // the big one still gets the full grow
    expect(at(out, 310 + 17, CY)).toBe(0);            // the small one still does not
    expect(at(out, 290 - 17, CY)).toBe(0);
  });

  it('treats strokes that touch — even only diagonally — as one blob', () => {
    const m = square(blank(), 100, CY, 30);
    // A thin tail hanging off the big square's corner, connected only through a diagonal step.
    for (let i = 1; i <= 12; i++) m[(CY + 30 + i) * W + (130 + i)] = 1;
    const out = growPaintedBlobs(m, W, H, 32);
    expect(at(out, 142 + 30, CY + 42)).toBe(1);       // tail end grown by the BIG blob's distance, not a dab's 8 px
  });

  it('does not mistake a blob cut off by the photo edge for a thin one', () => {
    const m = blank();
    for (let y = 40; y < 160; y++) for (let x = 0; x < 20; x++) m[y * W + x] = 1;   // 20 px strip flush with the left edge
    const out = growPaintedBlobs(m, W, H, 32);
    expect(at(out, 19 + 26, CY)).toBe(1);             // inner radius 20 (not 10) → +28
    expect(at(out, 19 + 30, CY)).toBe(0);
  });

  it('returns a hard 0 / 1 mask that always keeps what was painted', () => {
    const m = square(square(blank(), 100, CY, 30), 300, CY, 10);
    const out = growPaintedBlobs(m, W, H, 32);
    expect(new Set(out).size).toBe(2);
    for (let i = 0; i < m.length; i++) if (m[i]) expect(out[i]).toBe(1);
  });

  it('returns the mask unchanged when the grow distance is 0', () => {
    const m = square(blank(), 300, CY, 10);
    expect(Array.from(growPaintedBlobs(m, W, H, 0))).toEqual(Array.from(m));
  });

  it('keeps an empty mask empty (no tattoo painted → nothing gets regenerated)', () => {
    expect(growPaintedBlobs(blank(), W, H, 32).every((v) => v === 0)).toBe(true);
  });
});
