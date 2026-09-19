import { buildSoftMask } from './softMask';
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

  free(soft);
  free(layer);
  endSpan();
  return out;
}
