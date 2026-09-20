import { buildSoftMask } from './softMask';
import { fitColourTransform, applyColourTransform, IDENTITY_TRANSFORM } from './colorFit';
import { diagSpan } from './perfDiagnostics';

// Exclude the repainted area from the fit with the same reach the model has
// beyond the painted strokes (measured: meaningful change to ~16–24 px, back
// to the noise floor by ~32 px, at the inpaint resolution).
const EXCLUDE_GROW_PX = 40;
// Same cut-off uploadMask() uses, so "painted" means what it meant to the model.
const MASK_ALPHA_THRESHOLD = 128;

/**
 * Undo the colour loss of the inpaint round trip, in place on `generated`.
 *
 * `reference` is the exact image that was uploaded and `inpaintMask` the mask
 * that went with it — all three are at the inpaint resolution (≤ 2 MP), so
 * reading their pixels is cheap. Everything outside the (grown) mask is a
 * before/after pair; the fitted transform is then applied to the WHOLE frame,
 * fill included, because the fill was generated to match the dulled
 * surroundings. Nothing else about the result changes: no compositing, no
 * change to which pixels are kept. See colorFit.js for the maths + guards.
 *
 * @returns {HTMLCanvasElement} `generated` (mutated)
 */
export function colourFitInpaint({ generated, reference, inpaintMask }) {
  const endSpan = diagSpan('colour-fit');
  const { width, height } = generated;
  if (reference.width !== width || reference.height !== height || inpaintMask.width !== width || inpaintMask.height !== height) {
    endSpan({ skipped: 'size-mismatch' });
    return generated;
  }
  const painted = inpaintMask.getContext('2d').getImageData(0, 0, width, height).data;
  const binary = new Uint8Array(width * height);
  for (let i = 0; i < binary.length; i++) binary[i] = painted[i * 4 + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
  const exclude = buildSoftMask(binary, width, height, EXCLUDE_GROW_PX, 0);

  const ctx = generated.getContext('2d');
  const result = ctx.getImageData(0, 0, width, height);
  const original = reference.getContext('2d').getImageData(0, 0, width, height).data;
  const transform = fitColourTransform(result.data, original, width, height, exclude);
  if (transform === IDENTITY_TRANSFORM) {
    endSpan({ skipped: 'no-trustworthy-fit' });
    return generated;
  }
  applyColourTransform(result.data, transform);
  ctx.putImageData(result, 0, 0);
  endSpan({ gainR: +transform[0].toFixed(3), gainG: +transform[5].toFixed(3), gainB: +transform[10].toFixed(3) });
  return generated;
}
