/**
 * Colour fit for an inpainted frame — the pure maths.
 *
 * The tattoo-removal result is the model's whole re-decoded frame, and the
 * Flux VAE round trip pulls every colour slightly toward grey and darkens it
 * (measured: −3.4% chroma per pass, hue-dependent — blues/greens lose the
 * most — compounding to −11% over three Touch Ups). But for every pixel
 * OUTSIDE the repainted area we hold an exact before/after pair, so the loss
 * can be measured and undone: fit the 3×4 colour transform that best maps the
 * returned frame back onto the image we sent (least squares), then apply it to
 * the whole frame — including the fill, which was generated against the
 * already-dulled surroundings. Measured result: colour error below visibility
 * (worst patch ΔE 0.74, vs 3.47 uncorrected), and it no longer compounds.
 *
 * A single global gain is NOT enough (it fixes the average but leaves blues
 * under and skin over); a 2nd-order polynomial was no better than this affine
 * fit.
 *
 * Deliberately conservative: learns only from unmasked, unclipped pixels, and
 * hands back the identity rather than apply a correction it can't trust.
 */

// Row-major 3×4: [r' g' b'] = M · [r g b 1]
export const IDENTITY_TRANSFORM = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

// Pixels this close to black/white in either image are clipped — they don't
// say what the colour "should" have been, and would bias the fit.
const CLIP_LOW = 5;
const CLIP_HIGH = 250;
// Too few samples to trust (e.g. the mask covers almost the whole image).
const MIN_SAMPLES = 500;
// A real round-trip loss is a few percent. Anything outside these bounds is a
// degenerate fit (wrong image, misalignment…), not a colour loss to undo.
const GAIN_MIN = 0.85, GAIN_MAX = 1.2;
const CROSS_MAX = 0.12;
const OFFSET_MAX = 16;

/** Solve the n×n system A·x = b for each column of B (Gauss–Jordan, partial pivoting). Returns null if singular. */
function solve(A, B, n, cols) {
  const M = A.map((row, i) => [...row, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-9) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const d = M[c][c];
    for (let k = c; k < n + cols; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = c; k < n + cols; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

function plausible(t) {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const v = t[row * 4 + col];
      if (row === col ? (v < GAIN_MIN || v > GAIN_MAX) : Math.abs(v) > CROSS_MAX) return false;
    }
    if (Math.abs(t[row * 4 + 3]) > OFFSET_MAX) return false;
  }
  return t.every(Number.isFinite);
}

/**
 * Least-squares 3×4 transform taking `result` colours to `original` colours.
 * Both are RGBA arrays of the same width×height; `mask` is one byte per pixel,
 * non-zero = repainted (or near it) → excluded from the fit.
 */
export function fitColourTransform(result, original, width, height, mask, { stride = 3 } = {}) {
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let samples = 0;
  const usable = (v) => v > CLIP_LOW && v < CLIP_HIGH;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x;
      if (mask[i]) continue;
      const p = i * 4;
      const r = result[p], g = result[p + 1], b = result[p + 2];
      const or = original[p], og = original[p + 1], ob = original[p + 2];
      if (!(usable(r) && usable(g) && usable(b) && usable(or) && usable(og) && usable(ob))) continue;
      const v = [r, g, b, 1];
      for (let a = 0; a < 4; a++) {
        for (let c = 0; c < 4; c++) A[a][c] += v[a] * v[c];
        B[a][0] += v[a] * or; B[a][1] += v[a] * og; B[a][2] += v[a] * ob;
      }
      samples++;
    }
  }
  if (samples < MIN_SAMPLES) return IDENTITY_TRANSFORM;
  const X = solve(A, B, 4, 3);         // X[basis][channel]
  if (!X) return IDENTITY_TRANSFORM;
  const t = [];
  for (let ch = 0; ch < 3; ch++) for (let basis = 0; basis < 4; basis++) t.push(X[basis][ch]);
  return plausible(t) ? t : IDENTITY_TRANSFORM;
}

/** Apply a 3×4 transform to RGBA pixels in place. Alpha is never touched. */
export function applyColourTransform(rgba, t) {
  if (t === IDENTITY_TRANSFORM) return;
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    rgba[p] = Math.round(t[0] * r + t[1] * g + t[2] * b + t[3]);       // Uint8ClampedArray clamps
    rgba[p + 1] = Math.round(t[4] * r + t[5] * g + t[6] * b + t[7]);
    rgba[p + 2] = Math.round(t[8] * r + t[9] * g + t[10] * b + t[11]);
  }
}
