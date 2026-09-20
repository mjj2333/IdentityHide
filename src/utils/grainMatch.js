/**
 * Grain matching for a composited inpaint patch — the pure maths.
 *
 * A generated fill has the right tone and shading but almost none of the fine
 * sensor/film grain of the photo around it (and at Original tier it is
 * upscaled from ≤ 2 MP), so next to untouched full-resolution skin it can read
 * as a smooth, airbrushed spot. Grain matching measures the grain in the
 * ORIGINAL just outside the patch, measures what the fill already has, and
 * adds only the difference — brightness-only, slightly correlated like real
 * photo grain, faded through the same feathered mask. If the fill already has
 * about as much texture as its surroundings, it adds nothing.
 *
 * Everything here works on typed arrays so it is testable without a canvas;
 * inpaintComposite.js does the canvas I/O.
 */

// Fill counts as "already matching" at this fraction of the surrounding grain.
const SATISFIED_RATIO = 0.85;
// Hard ceiling on added grain (8-bit levels of high-pass residual). Real photo
// grain is ~1–2 at low ISO, ~5–8 at high ISO; anything above this is a bad
// measurement (hair, fabric, an edge), not grain.
const MAX_ADDED_SIGMA = 8;

/** Standard deviation estimated from the median absolute deviation — ignores outliers. */
function robustSigma(values, count) {
  if (count === 0) return 0;
  const abs = new Float32Array(count);
  for (let i = 0; i < count; i++) abs[i] = Math.abs(values[i]);
  abs.sort();
  const mid = count >> 1;
  const median = count % 2 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
  return median * 1.4826;
}

/**
 * How grainy a brightness tile is: robust σ of the high-pass residual (each
 * pixel minus the mean of its 4 neighbours). Smooth shading cancels out; an
 * edge or hair through the tile is an outlier the median ignores.
 */
export function estimateGrainSigma(luma, width, height) {
  const residuals = new Float32Array(Math.max(0, (width - 2) * (height - 2)));
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      residuals[n++] = luma[i] - (luma[i - 1] + luma[i + 1] + luma[i - width] + luma[i + width]) / 4;
    }
  }
  return robustSigma(residuals, n);
}

/**
 * A size×size tile of zero-mean grain. White gaussian noise passed through a
 * wrap-around [1 2 1]/4 blur in both directions: that gives it the slight
 * spatial correlation of real (demosaiced, JPEG-ed) photo grain rather than
 * harsh per-pixel static, and the wrap-around makes the tile repeat seamlessly.
 * Seeded, so a re-render never shimmers.
 */
export function synthGrain(size, seed) {
  let state = (seed >>> 0) || 1;
  const rnd = () => { // mulberry32
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const white = new Float32Array(size * size);
  for (let i = 0; i < white.length; i++) {
    let u = 0; while (!u) u = rnd();
    white[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  }
  const wrap = (v) => (v + size) % size;
  const horizontal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    horizontal[y * size + x] = (white[y * size + wrap(x - 1)] + 2 * white[y * size + x] + white[y * size + wrap(x + 1)]) / 4;
  }
  const out = new Float32Array(size * size);
  let mean = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const v = (horizontal[wrap(y - 1) * size + x] + 2 * horizontal[y * size + x] + horizontal[wrap(y + 1) * size + x]) / 4;
    out[y * size + x] = v; mean += v;
  }
  mean /= out.length;
  for (let i = 0; i < out.length; i++) out[i] -= mean;
  return out;
}

/**
 * Multiplier for the grain tile so that fill + added grain matches the target.
 * `target`/`fill` are estimateGrainSigma of the surroundings / the fill;
 * `unit` is estimateGrainSigma of the grain tile itself (self-calibrating, so
 * the tile's correlation doesn't need modelling). Independent noise adds in
 * quadrature: σ_target² = σ_fill² + (gain·σ_unit)².
 */
export function grainGain({ target, fill, unit, maxAdded = MAX_ADDED_SIGMA }) {
  if (!(target > 0) || !(unit > 0) || !(fill >= 0)) return 0;
  if (fill >= target * SATISFIED_RATIO) return 0;
  const missing = Math.sqrt(target * target - fill * fill);
  return Math.min(missing, maxAdded) / unit;
}

/**
 * How much added grain a pixel gets for a given mask alpha (0–255). Across the
 * feather the original's own grain fades out as (1−a); weighting the added
 * grain by √(1−(1−a)²) keeps the TOTAL grain constant, so there is no band of
 * reduced grain around the patch.
 */
export function grainWeight(alpha) {
  const a = alpha / 255;
  return Math.sqrt(1 - (1 - a) * (1 - a));
}

/**
 * Add grain to a block of RGBA pixels in place. Brightness only (same delta on
 * R, G, B — coloured speckle looks like a cheap filter), weighted by the mask,
 * untouched where the mask is 0. `originX/originY` are the block's position in
 * the image, so the pattern is continuous however the image is split into
 * strips.
 */
export function addGrain(rgba, alpha, width, height, { grain, tile, originX = 0, originY = 0, gain }) {
  if (!(gain > 0)) return;
  for (let y = 0; y < height; y++) {
    const gy = ((originY + y) % tile) * tile;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = alpha[i];
      if (a === 0) continue;
      const delta = Math.round(grain[gy + ((originX + x) % tile)] * gain * grainWeight(a));
      if (delta === 0) continue;
      const p = i * 4;
      rgba[p] += delta; rgba[p + 1] += delta; rgba[p + 2] += delta; // Uint8ClampedArray clamps
    }
  }
}

/**
 * Choose where to measure grain. Returns tile origins in WORKING-resolution
 * pixels: `ring` tiles lie wholly outside the soft mask but near the patch
 * (untouched original — what we match TO), `core` tiles lie wholly inside the
 * fully-replaced area (the fill — what we match). `alpha` (the soft mask) and
 * `near` (everything within sampling reach of the patch) are at the inpaint
 * resolution. Scanning on a `step` finer than the tile finds far more tiles
 * that fit the ring band, so the median across tiles stays robust when some
 * land on hair, fabric or an edge.
 */
export function findSampleTiles({ alpha, near, maskWidth, maskHeight, width, height, tile, step }) {
  const sx = width / maskWidth, sy = height / maskHeight;
  let x0 = maskWidth, y0 = maskHeight, x1 = -1, y1 = -1;
  for (let y = 0; y < maskHeight; y++) {
    for (let x = 0; x < maskWidth; x++) {
      if (!near[y * maskWidth + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const ring = [], core = [];
  if (x1 < 0) return { ring, core };

  const at = (x, y) => Math.min(maskHeight - 1, Math.floor(y / sy)) * maskWidth + Math.min(maskWidth - 1, Math.floor(x / sx));
  const every = (x, y, test) => {
    const e = tile - 1, h = tile >> 1;
    return test(at(x, y)) && test(at(x + e, y)) && test(at(x, y + e)) && test(at(x + e, y + e)) && test(at(x + h, y + h));
  };
  const isRing = (i) => alpha[i] === 0 && near[i] === 255;
  const isCore = (i) => alpha[i] === 255;

  const left = Math.max(0, Math.floor(x0 * sx)), top = Math.max(0, Math.floor(y0 * sy));
  const right = Math.min(width, Math.ceil((x1 + 1) * sx)), bottom = Math.min(height, Math.ceil((y1 + 1) * sy));
  for (let y = top; y + tile <= bottom; y += step) {
    for (let x = left; x + tile <= right; x += step) {
      if (every(x, y, isRing)) ring.push([x, y]);
      else if (every(x, y, isCore)) core.push([x, y]);
    }
  }
  return { ring, core };
}
