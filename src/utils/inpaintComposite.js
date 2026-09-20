import { buildSoftMask } from './softMask';
import { synthGrain, estimateGrainSigma, grainGain, addGrain, findSampleTiles } from './grainMatch';
import { diagSpan } from './perfDiagnostics';

/**
 * Composite an inpainted result back onto the original image.
 *
 * The tattoo-removal workflow returns the model's whole re-decoded frame, and
 * every pixel of that frame — not just the repainted area — has been through
 * the Flux VAE, which is lossy: measured ~3.4% chroma loss and ~13% fine
 * texture loss per pass over pixels the user never touched, compounding with
 * each Touch Up; at Original tier it also drops the entire photo to the 2 MP
 * inpaint resolution. Compositing keeps the ORIGINAL pixels everywhere except
 * a grown, feathered copy of the painted mask, so untouched areas stay
 * bit-exact at full resolution and only the repaired patch comes from the
 * model.
 *
 * Grow/feather are in INPAINT-resolution pixels: the model's reach beyond the
 * painted strokes comes from its latent grid, which is fixed relative to the
 * image it was given, not to the (possibly larger) working canvas. Measured
 * reach ≈ 16–24 px, back to the noise floor by ~32 px.
 */
export const COMPOSITE_GROW_PX = 24;
export const COMPOSITE_FEATHER_PX = 16;

// Same cut-off uploadMask() uses, so "painted" means the same thing here as
// it did for the model.
const MASK_ALPHA_THRESHOLD = 128;

function makeCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function free(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * @param {HTMLCanvasElement} original     image at the working resolution (never modified)
 * @param {HTMLCanvasElement} generated    the model's result, any resolution
 * @param {HTMLCanvasElement} inpaintMask  the painted mask AT THE INPAINT RESOLUTION (alpha = painted)
 * @returns {HTMLCanvasElement} new canvas at `original`'s dimensions
 */
export function compositeInpaint({
  original, generated, inpaintMask,
  growPx = COMPOSITE_GROW_PX, featherPx = COMPOSITE_FEATHER_PX,
  grainMatch = false,
}) {
  const endSpan = diagSpan('inpaint-composite', {
    out: `${original.width}x${original.height}`,
    gen: `${generated.width}x${generated.height}`,
  });
  const { width: mw, height: mh } = inpaintMask;
  const { width: W, height: H } = original;

  // Soft mask at the inpaint resolution — small (≤ 2 MP), so pixel maths is cheap.
  const painted = inpaintMask.getContext('2d').getImageData(0, 0, mw, mh).data;
  const binary = new Uint8Array(mw * mh);
  for (let i = 0; i < binary.length; i++) binary[i] = painted[i * 4 + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
  const alpha = buildSoftMask(binary, mw, mh, growPx, featherPx);

  const soft = makeCanvas(mw, mh);
  const softCtx = soft.getContext('2d');
  const softData = softCtx.createImageData(mw, mh);
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4;
    softData.data[p] = 255; softData.data[p + 1] = 255; softData.data[p + 2] = 255;
    softData.data[p + 3] = alpha[i];
  }
  softCtx.putImageData(softData, 0, 0);

  // Everything at full size happens with canvas compositing (GPU), never a
  // full-resolution getImageData: generated ∩ soft mask, laid over the original.
  const layer = makeCanvas(W, H);
  const layerCtx = layer.getContext('2d');
  layerCtx.imageSmoothingEnabled = true;
  layerCtx.imageSmoothingQuality = 'high';
  layerCtx.drawImage(generated, 0, 0, W, H);
  layerCtx.globalCompositeOperation = 'destination-in';
  layerCtx.drawImage(soft, 0, 0, W, H);

  const out = makeCanvas(W, H);
  const outCtx = out.getContext('2d');
  outCtx.drawImage(original, 0, 0);
  outCtx.drawImage(layer, 0, 0);

  // Opt-in (?grain=1): give the patch the same fine grain as the photo around it.
  if (grainMatch) {
    applyGrainMatch({ out, original, soft, alpha, binary, mw, mh, growPx, featherPx });
  }

  free(soft);
  free(layer);
  endSpan();
  return out;
}

// ── Grain matching (canvas I/O around grainMatch.js) ──────────────────────────

const GRAIN_TILE = 256;          // grain pattern repeats every 256 px — invisible for noise
const SAMPLE_TILE = 48;          // working-resolution px per measurement tile
const MAX_SAMPLE_TILES = 24;     // per class; bounds the cost whatever the photo size
const RING_PX = 96;              // how far past the feather (inpaint px) the surroundings are sampled
const STRIP_PIXELS = 1_000_000;  // grain is added in strips this big, so memory stays bounded at 12 MP+

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function tileLuma(ctx, x, y, size) {
  const d = ctx.getImageData(x, y, size, size).data;
  const luma = new Float32Array(size * size);
  for (let i = 0; i < luma.length; i++) luma[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return luma;
}

/** Up to `max` items, evenly spread through the list. */
function spread(list, max) {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, i) => list[Math.floor((i * list.length) / max)]);
}

function applyGrainMatch({ out, original, soft, alpha, binary, mw, mh, growPx, featherPx }) {
  const { width: W, height: H } = out;
  const sx = W / mw, sy = H / mh;
  const endSpan = diagSpan('grain-match');

  // Bounding box of the soft mask (inpaint px) — where grain will be added.
  let ax0 = mw, ay0 = mh, ax1 = -1, ay1 = -1;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (!alpha[y * mw + x]) continue;
      if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
    }
  }
  if (ax1 < 0) { endSpan({ skipped: 'empty-mask' }); return; }

  // `near` = everything within sampling reach of the patch; ring = near but outside the soft mask.
  const near = buildSoftMask(binary, mw, mh, growPx + featherPx + RING_PX, 0);
  const { ring, core } = findSampleTiles({
    alpha, near, maskWidth: mw, maskHeight: mh, width: W, height: H,
    tile: SAMPLE_TILE, step: SAMPLE_TILE >> 1,
  });
  if (ring.length === 0 || core.length === 0) { endSpan({ skipped: 'no-samples', ring: ring.length, core: core.length }); return; }

  // Median ACROSS tiles: a few tiles landing on hair, fabric or an edge don't move it.
  const originalCtx = original.getContext('2d');
  const outCtx = out.getContext('2d');
  const sigmaOf = (ctx) => ([x, y]) => estimateGrainSigma(tileLuma(ctx, x, y, SAMPLE_TILE), SAMPLE_TILE, SAMPLE_TILE);
  const target = median(spread(ring, MAX_SAMPLE_TILES).map(sigmaOf(originalCtx)));
  const fill = median(spread(core, MAX_SAMPLE_TILES).map(sigmaOf(outCtx)));

  const grain = synthGrain(GRAIN_TILE, (W * 73856093) ^ (H * 19349663) ^ (ax0 * 83492791) ^ ay0);
  const unit = estimateGrainSigma(grain, GRAIN_TILE, GRAIN_TILE);
  const gain = grainGain({ target, fill, unit });
  const report = { target: +target.toFixed(2), fill: +fill.toFixed(2), gain: +gain.toFixed(2), ring: ring.length, core: core.length };
  if (gain === 0) { endSpan({ ...report, skipped: 'already-matched' }); return; }

  // Add the grain over the soft mask's bounding box, strip by strip.
  const px0 = Math.max(0, Math.floor(ax0 * sx)), py0 = Math.max(0, Math.floor(ay0 * sy));
  const px1 = Math.min(W, Math.ceil((ax1 + 1) * sx)), py1 = Math.min(H, Math.ceil((ay1 + 1) * sy));
  const bw = px1 - px0;
  const rows = Math.max(16, Math.floor(STRIP_PIXELS / bw));
  const strip = makeCanvas(bw, Math.min(rows, py1 - py0));
  const stripCtx = strip.getContext('2d', { willReadFrequently: true });
  stripCtx.imageSmoothingEnabled = true;
  for (let y = py0; y < py1; y += rows) {
    const h = Math.min(rows, py1 - y);
    // the soft mask, scaled up to this strip, gives the per-pixel weight
    stripCtx.clearRect(0, 0, bw, h);
    stripCtx.drawImage(soft, px0 / sx, y / sy, bw / sx, h / sy, 0, 0, bw, h);
    const maskData = stripCtx.getImageData(0, 0, bw, h).data;
    const weights = new Uint8Array(bw * h);
    for (let i = 0; i < weights.length; i++) weights[i] = maskData[i * 4 + 3];
    const pixels = outCtx.getImageData(px0, y, bw, h);
    addGrain(pixels.data, weights, bw, h, { grain, tile: GRAIN_TILE, originX: px0, originY: y, gain });
    outCtx.putImageData(pixels, px0, y);
  }
  free(strip);
  endSpan(report);
}
